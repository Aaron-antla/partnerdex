import { getDb, type Db } from '../db/index.js';

/**
 * The Mixpanel service account, and the cost model the Multipliers page prices
 * usage with.
 *
 * The secret follows the BigQuery key's rule: it is written by
 * `saveConnection`, read only by the client that calls Mixpanel, and described
 * to the dashboard by `describe`, which returns the username and nothing else.
 */

export class MixpanelError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = 'MixpanelError';
  }
}

export const REGIONS = ['US', 'EU', 'IN'] as const;
export type Region = (typeof REGIONS)[number];

export interface MixpanelConnection {
  projectId: string;
  region: Region;
  username: string;
  secret: string;
  checkedAt: string | null;
  lastError: string | null;
  updatedAt: string;
}

/** Everything about the connection that is safe to send to a browser. */
export type MixpanelConnectionView = Omit<MixpanelConnection, 'secret'>;

interface ConnectionRow {
  project_id: string;
  region: string;
  username: string;
  secret: string;
  checked_at: string | null;
  last_error: string | null;
  updated_at: string;
}

export function readConnection(db: Db = getDb()): MixpanelConnection | null {
  const row = db
    .prepare(`SELECT * FROM mixpanel_connection WHERE id = 'default'`)
    .get() as ConnectionRow | undefined;
  if (!row) return null;
  return {
    projectId: row.project_id,
    region: (REGIONS as readonly string[]).includes(row.region) ? (row.region as Region) : 'US',
    username: row.username,
    secret: row.secret,
    checkedAt: row.checked_at,
    lastError: row.last_error,
    updatedAt: row.updated_at,
  };
}

export function describe(connection: MixpanelConnection): MixpanelConnectionView {
  const { secret: _secret, ...rest } = connection;
  return rest;
}

export interface SaveConnectionInput {
  projectId: string;
  region: string;
  username: string;
  /** Absent on an edit that keeps the stored secret. */
  secret?: string;
}

export function saveConnection(input: SaveConnectionInput, db: Db = getDb()): MixpanelConnection {
  const existing = readConnection(db);
  const projectId = input.projectId.trim();
  const region = input.region.trim().toUpperCase();
  const username = input.username.trim();
  const secret = input.secret?.trim() || existing?.secret || '';

  if (!/^\d+$/.test(projectId)) {
    throw new MixpanelError(`The project id is the number in your Mixpanel URL, got "${projectId}".`);
  }
  if (!(REGIONS as readonly string[]).includes(region)) {
    throw new MixpanelError(`Region must be one of ${REGIONS.join(', ')}, got "${input.region}".`);
  }
  if (!username) throw new MixpanelError('The service account username is required.');
  if (!secret) throw new MixpanelError('Paste the service account secret to connect Mixpanel.');

  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO mixpanel_connection (
       id, project_id, region, username, secret, checked_at, last_error, created_at, updated_at
     ) VALUES ('default', @projectId, @region, @username, @secret, NULL, NULL, @now, @now)
     ON CONFLICT(id) DO UPDATE SET
       project_id = excluded.project_id,
       region = excluded.region,
       username = excluded.username,
       secret = excluded.secret,
       -- A saved change may be what broke it; the old check no longer applies.
       checked_at = NULL,
       last_error = NULL,
       updated_at = excluded.updated_at`,
  ).run({ projectId, region, username, secret, now });

  return readConnection(db)!;
}

export function removeConnection(db: Db = getDb()): boolean {
  return db.prepare(`DELETE FROM mixpanel_connection WHERE id = 'default'`).run().changes > 0;
}

export function recordCheck(error: string | null, db: Db = getDb()): void {
  db.prepare(
    `UPDATE mixpanel_connection SET checked_at = @at, last_error = @error WHERE id = 'default'`,
  ).run({ at: new Date().toISOString(), error });
}

/* ----------------------------------------------------------- cost model */

export interface MultiplierSettings {
  /** What one billable generation costs you, in the reporting currency. */
  costPerGeneration: number;
  /** Fixed monthly cost of serving one paying shop (infrastructure). */
  costPerPayingShop: number;
  /** Mixpanel event names that each represent one billable generation. */
  generationEvents: string[];
  /** Internal and test stores kept out of every Multipliers figure. */
  excludedDomains: string[];
  updatedAt: string | null;
}

interface SettingsRow {
  cost_per_generation: number;
  cost_per_paying_shop: number;
  generation_events: string;
  excluded_domains: string;
  updated_at: string;
}

function lines(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[\n,]/)
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ];
}

export function readSettings(db: Db = getDb()): MultiplierSettings {
  const row = db
    .prepare(`SELECT * FROM multiplier_settings WHERE id = 'default'`)
    .get() as SettingsRow | undefined;
  return {
    costPerGeneration: row?.cost_per_generation ?? 0,
    costPerPayingShop: row?.cost_per_paying_shop ?? 0,
    generationEvents: lines(row?.generation_events ?? ''),
    excludedDomains: lines(row?.excluded_domains ?? ''),
    updatedAt: row?.updated_at ?? null,
  };
}

export interface SaveSettingsInput {
  costPerGeneration?: number;
  costPerPayingShop?: number;
  generationEvents?: string[] | string;
  excludedDomains?: string[] | string;
}

export function saveSettings(input: SaveSettingsInput, db: Db = getDb()): MultiplierSettings {
  const current = readSettings(db);
  const money = (value: number | undefined, fallback: number, field: string): number => {
    if (value === undefined) return fallback;
    if (!Number.isFinite(value) || value < 0) {
      throw new MixpanelError(`${field} must be a number of zero or more.`);
    }
    return value;
  };
  const list = (value: string[] | string | undefined, fallback: string[]): string[] =>
    value === undefined ? fallback : lines(Array.isArray(value) ? value.join('\n') : value);

  const next = {
    costPerGeneration: money(input.costPerGeneration, current.costPerGeneration, 'Cost per generation'),
    costPerPayingShop: money(input.costPerPayingShop, current.costPerPayingShop, 'Cost per paying shop'),
    generationEvents: list(input.generationEvents, current.generationEvents),
    excludedDomains: list(input.excludedDomains, current.excludedDomains).map((entry) =>
      entry.toLowerCase(),
    ),
  };

  db.prepare(
    `INSERT INTO multiplier_settings (
       id, cost_per_generation, cost_per_paying_shop, generation_events, excluded_domains, updated_at
     ) VALUES ('default', @costPerGeneration, @costPerPayingShop, @generationEvents, @excludedDomains, @now)
     ON CONFLICT(id) DO UPDATE SET
       cost_per_generation = excluded.cost_per_generation,
       cost_per_paying_shop = excluded.cost_per_paying_shop,
       generation_events = excluded.generation_events,
       excluded_domains = excluded.excluded_domains,
       updated_at = excluded.updated_at`,
  ).run({
    costPerGeneration: next.costPerGeneration,
    costPerPayingShop: next.costPerPayingShop,
    generationEvents: next.generationEvents.join('\n'),
    excludedDomains: next.excludedDomains.join('\n'),
    now: new Date().toISOString(),
  });

  return readSettings(db);
}

/**
 * Whether a myshopify domain is on the exclusion list.
 *
 * `*` matches any run of characters, and an entry without a dot is read as the
 * store handle, so `antla-*` and `womensuits-dev` both work as typed.
 */
export function isExcluded(domain: string | null, patterns: string[]): boolean {
  if (!domain) return false;
  const value = domain.toLowerCase();
  return patterns.some((pattern) => {
    const full = pattern.includes('.') ? pattern : `${pattern}.myshopify.com`;
    const source = full
      .split('*')
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*');
    return new RegExp(`^${source}$`).test(value);
  });
}
