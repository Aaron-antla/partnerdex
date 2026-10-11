import { getDb, readSyncState, writeSyncState, type Db } from '../db/index.js';
import {
  MixpanelError,
  readConnection,
  readSettings,
  recordCheck,
  type MixpanelConnection,
  type Region,
} from './connection.js';

/**
 * Pulling per-shop usage out of Mixpanel.
 *
 * The cost side of the Multipliers page. Shopify knows what each merchant pays;
 * only the product's own analytics knows how much they use, and usage is what
 * costs money here — every generation is a model call.
 *
 * Two reads per sync, both with the service account:
 *
 *   - user profiles (`/api/query/engage`), to learn which shop each distinct id
 *     belongs to. Events carry a distinct id like `Club21.com-[950]`; the
 *     profile carries the myshopify `domain`, which is what the Partner API
 *     knows the shop by.
 *   - the raw event export (`/api/2.0/export`), for the configured generation
 *     events only, aggregated to one row per shop per UTC day as it streams.
 *
 * The Insights and Segmentation APIs are not used: Segmentation is in
 * maintenance mode, both cap at 60 queries an hour, and neither can break a
 * count down by a profile property for every shop in one call.
 */

const SYNC_KEY = 'mixpanel:usage';

/** How far back a first sync, or a full one, reaches. A little past the 30-day window. */
export const BACKFILL_DAYS = 35;

/**
 * How many days behind its own watermark each run re-reads. Mixpanel accepts
 * events up to days late from mobile and server SDKs, and re-reading is an
 * idempotent replace of those days.
 */
const LOOKBACK_DAYS = 2;

/**
 * The background loop runs every few minutes; the export is a full day of raw
 * events. Once an hour is plenty for a 30-day figure and stays well inside
 * Mixpanel's 60-queries-an-hour limit.
 */
const MIN_INTERVAL_MS = 60 * 60_000;

/** Every attempt, failed or not, so a failing sync is throttled like a working one. */
const ATTEMPT_KEY = 'mixpanel:attempt';

/**
 * Set when Mixpanel answers 429, to the instant it said (or an hour). Every
 * call — background, Sync now, Test — waits it out, because each one made
 * while limited is counted against the same hourly quota and keeps it shut.
 */
const BLOCKED_KEY = 'mixpanel:blocked';

/** Profiles change when a shop installs; re-reading them every hour buys nothing. */
const IDENTITY_TTL_MS = 24 * 60 * 60_000;

/** A runaway pager is the one way this sync could spend the quota by itself. */
const MAX_PROFILE_PAGES = 50;

const MS_PER_DAY = 86_400_000;

const HOSTS: Record<Region, { query: string; export: string }> = {
  US: { query: 'https://mixpanel.com', export: 'https://data.mixpanel.com' },
  EU: { query: 'https://eu.mixpanel.com', export: 'https://data-eu.mixpanel.com' },
  IN: { query: 'https://in.mixpanel.com', export: 'https://data-in.mixpanel.com' },
};

type Fetch = typeof fetch;
let fetchImpl: Fetch = (...args) => fetch(...args);

/** Test seam: replace the HTTP client. */
export function useMixpanelFetch(next: Fetch | null): void {
  fetchImpl = next ?? ((...args) => fetch(...args));
}

function authHeader(connection: MixpanelConnection): string {
  const token = Buffer.from(`${connection.username}:${connection.secret}`).toString('base64');
  return `Basic ${token}`;
}

async function call(connection: MixpanelConnection, url: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetchImpl(url, {
    ...init,
    headers: { ...(init.headers ?? {}), authorization: authHeader(connection), accept: '*/*' },
  });
  if (response.ok) return response;

  let detail = '';
  try {
    const body = await response.text();
    detail = (JSON.parse(body) as { error?: string }).error ?? body.slice(0, 200);
  } catch {
    // Keep the status line alone.
  }
  if (response.status === 401 || response.status === 403) {
    throw new MixpanelError(
      `Mixpanel refused the service account (${response.status}). Check the username and secret, ` +
        `that the account is a member of project ${connection.projectId}, and that the region is right.` +
        (detail ? ` Mixpanel said: ${detail}` : ''),
    );
  }
  if (response.status === 429) {
    const seconds = Number(response.headers.get('retry-after'));
    const api = url.includes('/api/2.0/export') ? 'Export API' : 'Query API';
    const error = new MixpanelError(
      `Mixpanel's ${api} is rate limiting this project${detail ? ` (${detail})` : ''}. ` +
        'Its quota is shared by everything that queries the project — reports, other tools, other ' +
        'service accounts — not only this dashboard.',
      429,
    );
    (error as MixpanelError & { retryAfterMs?: number }).retryAfterMs =
      Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : MIN_INTERVAL_MS;
    throw error;
  }
  throw new MixpanelError(`Mixpanel answered ${response.status}${detail ? `: ${detail}` : ''}.`, 502);
}

function day(instant: Date): string {
  return instant.toISOString().slice(0, 10);
}

/** A profile property value that is a myshopify domain, lower-cased, or null. */
export function shopDomain(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(trimmed) ? trimmed : null;
}

/* ------------------------------------------------------------- profiles */

interface EngagePage {
  page: number;
  page_size: number;
  session_id?: string;
  results: Array<{ $distinct_id: string | number; $properties?: Record<string, unknown> }>;
}

/** distinct id → myshopify domain, from every user profile in the project. */
export async function fetchIdentities(connection: MixpanelConnection): Promise<Map<string, string>> {
  const identities = new Map<string, string>();
  const url = `${HOSTS[connection.region].query}/api/query/engage?project_id=${connection.projectId}`;
  let page = 0;
  let sessionId: string | undefined;

  for (;;) {
    const body = new URLSearchParams({ output_properties: JSON.stringify(['domain', '$name']) });
    if (sessionId) {
      body.set('session_id', sessionId);
      body.set('page', String(page));
    }
    const response = await call(connection, url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    const result = (await response.json()) as EngagePage;

    for (const profile of result.results ?? []) {
      const properties = profile.$properties ?? {};
      // `domain` is the property the app sets; `$name` is the fallback because
      // the profile's display name is the same domain on this project.
      const domain = shopDomain(properties.domain) ?? shopDomain(properties.$name);
      if (domain) identities.set(String(profile.$distinct_id), domain);
    }

    const received = result.results?.length ?? 0;
    if (!result.session_id || received === 0 || received < (result.page_size || 1000)) break;
    if (page + 1 >= MAX_PROFILE_PAGES) break;
    sessionId = result.session_id;
    page = (result.page ?? page) + 1;
  }

  return identities;
}

/* --------------------------------------------------------------- export */

export interface UsageAggregate {
  /** `domain|day` → generations. */
  counts: Map<string, number>;
  generations: number;
  /** Generation events whose distinct id has no profile with a shop domain. */
  unattributed: number;
}

/**
 * Folds JSONL export lines into per-shop, per-day counts.
 *
 * Separate from the HTTP call so the attribution rules are testable: an event
 * is counted for the shop its profile names, or for its distinct id when that
 * is itself a myshopify domain, and otherwise counted as unattributed rather
 * than dropped silently.
 */
export function aggregateExport(
  lines: Iterable<string>,
  events: Set<string>,
  identities: Map<string, string>,
): UsageAggregate {
  const counts = new Map<string, number>();
  let generations = 0;
  let unattributed = 0;

  for (const line of lines) {
    if (!line.trim()) continue;
    let parsed: { event?: string; properties?: { distinct_id?: unknown; time?: unknown } };
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!parsed.event || !events.has(parsed.event)) continue;
    const seconds = Number(parsed.properties?.time);
    if (!Number.isFinite(seconds)) continue;

    const distinctId = String(parsed.properties?.distinct_id ?? '');
    const domain = identities.get(distinctId) ?? shopDomain(distinctId);
    generations += 1;
    if (!domain) {
      unattributed += 1;
      continue;
    }
    // Export timestamps are seconds, or milliseconds with `time_in_ms`.
    const millis = seconds > 1e12 ? seconds : seconds * 1000;
    const key = `${domain}|${day(new Date(millis))}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return { counts, generations, unattributed };
}

async function* streamLines(response: Response): AsyncGenerator<string> {
  if (!response.body) return;
  const decoder = new TextDecoder();
  let buffered = '';
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    buffered += decoder.decode(chunk, { stream: true });
    let newline = buffered.indexOf('\n');
    while (newline >= 0) {
      yield buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      newline = buffered.indexOf('\n');
    }
  }
  buffered += decoder.decode();
  if (buffered) yield buffered;
}

async function exportUsage(
  connection: MixpanelConnection,
  from: string,
  to: string,
  events: string[],
  identities: Map<string, string>,
): Promise<UsageAggregate> {
  const params = new URLSearchParams({
    project_id: connection.projectId,
    from_date: from,
    to_date: to,
    event: JSON.stringify(events),
  });
  const response = await call(connection, `${HOSTS[connection.region].export}/api/2.0/export?${params}`);

  // Streamed rather than buffered: a month of raw events with every property
  // attached is tens of megabytes, and only two fields of each are needed.
  const lines: string[] = [];
  const total: UsageAggregate = { counts: new Map(), generations: 0, unattributed: 0 };
  const flush = () => {
    const part = aggregateExport(lines, new Set(events), identities);
    for (const [key, value] of part.counts) total.counts.set(key, (total.counts.get(key) ?? 0) + value);
    total.generations += part.generations;
    total.unattributed += part.unattributed;
    lines.length = 0;
  };
  for await (const line of streamLines(response)) {
    lines.push(line);
    if (lines.length >= 5_000) flush();
  }
  flush();
  return total;
}

/**
 * Replaces every usage row for the days in [from, to] with `counts`.
 *
 * A replace, not an upsert, so a re-read that finds fewer events for a day than
 * last time (Mixpanel deleted some, or a profile moved shop) converges.
 */
export function replaceUsage(db: Db, from: string, to: string, counts: Map<string, number>): void {
  const remove = db.prepare('DELETE FROM shop_usage_daily WHERE day >= ? AND day <= ?');
  const insert = db.prepare(
    `INSERT INTO shop_usage_daily (domain, day, generations) VALUES (@domain, @day, @generations)
     ON CONFLICT(domain, day) DO UPDATE SET generations = excluded.generations`,
  );
  db.transaction(() => {
    remove.run(from, to);
    for (const [key, generations] of counts) {
      const [domain, usageDay] = key.split('|') as [string, string];
      insert.run({ domain, day: usageDay, generations });
    }
  })();
}

function replaceIdentities(db: Db, identities: Map<string, string>): void {
  const now = new Date().toISOString();
  const insert = db.prepare(
    'INSERT INTO mixpanel_identities (distinct_id, domain, updated_at) VALUES (?, ?, ?)',
  );
  db.transaction(() => {
    db.prepare('DELETE FROM mixpanel_identities').run();
    for (const [distinctId, domain] of identities) insert.run(distinctId, domain, now);
  })();
}

/* ----------------------------------------------------------------- sync */

export interface UsageSyncResult {
  /** Why nothing was pulled, when nothing was. */
  skipped: string | null;
  from: string | null;
  to: string | null;
  generations: number;
  unattributed: number;
  shopDays: number;
  profiles: number;
}

/** When Mixpanel last told us to back off, if that is still in force. */
export function blockedUntil(db: Db, now = new Date()): Date | null {
  const { syncedThrough } = readSyncState(db, BLOCKED_KEY);
  if (!syncedThrough) return null;
  const until = new Date(syncedThrough);
  return until.getTime() > now.getTime() ? until : null;
}

function assertNotBlocked(db: Db, now: Date): void {
  const until = blockedUntil(db, now);
  if (until) {
    throw new MixpanelError(
      `Mixpanel rate limited this project. Waiting until ${until.toISOString().slice(11, 16)} UTC ` +
        'before asking again, so the quota can reset.',
      429,
    );
  }
}

/** Records a 429 so every later call waits it out. Other errors pass through. */
function noteRateLimit(db: Db, error: unknown, now: Date): void {
  const retry = (error as { retryAfterMs?: number }).retryAfterMs;
  if (error instanceof MixpanelError && error.status === 429 && retry) {
    writeSyncState(db, BLOCKED_KEY, { syncedThrough: new Date(now.getTime() + retry).toISOString() });
  }
}

function cachedIdentities(db: Db, now: Date): Map<string, string> | null {
  const rows = db.prepare('SELECT distinct_id AS id, domain, updated_at AS at FROM mixpanel_identities').all() as
    Array<{ id: string; domain: string; at: string }>;
  if (rows.length === 0) return null;
  if (now.getTime() - new Date(rows[0]!.at).getTime() > IDENTITY_TTL_MS) return null;
  return new Map(rows.map((row) => [row.id, row.domain]));
}

function skipped(reason: string): UsageSyncResult {
  return { skipped: reason, from: null, to: null, generations: 0, unattributed: 0, shopDays: 0, profiles: 0 };
}

export async function syncUsage(
  db: Db = getDb(),
  options: {
    full?: boolean;
    /** Ignore the hourly throttle, as the "sync now" button does. */
    force?: boolean;
    now?: Date;
    onProgress?: (message: string) => void;
  } = {},
): Promise<UsageSyncResult> {
  const connection = readConnection(db);
  if (!connection) return skipped('Mixpanel is not connected.');
  const { generationEvents } = readSettings(db);
  if (generationEvents.length === 0) return skipped('No generation events are configured.');

  const now = options.now ?? new Date();
  const background = !options.full && !options.force;
  const until = blockedUntil(db, now);
  if (until && background) return skipped(`Rate limited by Mixpanel until ${until.toISOString()}.`);
  assertNotBlocked(db, now);

  // Throttled on the last *attempt*, not the last success: a sync that keeps
  // failing would otherwise retry on every five-minute tick and spend the quota.
  const lastAttempt = readSyncState(db, ATTEMPT_KEY).syncedThrough;
  if (background && lastAttempt && now.getTime() - new Date(lastAttempt).getTime() < MIN_INTERVAL_MS) {
    return skipped('Tried less than an hour ago.');
  }
  writeSyncState(db, ATTEMPT_KEY, { syncedThrough: now.toISOString() });

  const { syncedThrough } = readSyncState(db, SYNC_KEY);
  const to = day(now);
  const backfill = day(new Date(now.getTime() - BACKFILL_DAYS * MS_PER_DAY));
  const resume = syncedThrough
    ? day(new Date(new Date(`${syncedThrough}T00:00:00Z`).getTime() - LOOKBACK_DAYS * MS_PER_DAY))
    : backfill;
  const from = options.full || resume < backfill ? backfill : resume;

  try {
    const cached = options.full ? null : cachedIdentities(db, now);
    let identities = cached;
    if (!identities) {
      options.onProgress?.('Mixpanel: reading user profiles...');
      identities = await fetchIdentities(connection);
    }
    options.onProgress?.(`Mixpanel: exporting generations ${from} to ${to}...`);
    const usage = await exportUsage(connection, from, to, generationEvents, identities);

    if (!cached) replaceIdentities(db, identities);
    replaceUsage(db, from, to, usage.counts);
    writeSyncState(db, SYNC_KEY, { syncedThrough: to });
    recordCheck(null, db);

    return {
      skipped: null,
      from,
      to,
      generations: usage.generations,
      unattributed: usage.unattributed,
      shopDays: usage.counts.size,
      profiles: identities.size,
    };
  } catch (error) {
    noteRateLimit(db, error, now);
    recordCheck((error as Error).message, db);
    throw error;
  }
}

/**
 * Proves the service account can read profiles and export events, without
 * pulling more than one event.
 */
export async function checkConnection(db: Db = getDb()): Promise<{ ok: boolean; error: string | null; profiles: number }> {
  const connection = readConnection(db);
  if (!connection) throw new MixpanelError('Mixpanel is not connected.', 404);
  const now = new Date();
  try {
    assertNotBlocked(db, now);
    const identities = await fetchIdentities(connection);
    const yesterday = day(new Date(Date.now() - MS_PER_DAY));
    const params = new URLSearchParams({
      project_id: connection.projectId,
      from_date: yesterday,
      to_date: yesterday,
      limit: '1',
    });
    await (await call(connection, `${HOSTS[connection.region].export}/api/2.0/export?${params}`)).text();
    recordCheck(null, db);
    return { ok: true, error: null, profiles: identities.size };
  } catch (error) {
    noteRateLimit(db, error, now);
    const message = (error as Error).message;
    recordCheck(message, db);
    return { ok: false, error: message, profiles: 0 };
  }
}
