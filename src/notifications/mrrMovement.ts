import { getConfig } from '../config.js';
import type { Db } from '../db/index.js';
import { asOfPredicate } from '../metrics/asof.js';
import { PLAN_CHANGE_WINDOW_SECONDS } from '../sync/derive.js';
import { resolveScopedAppIds } from '../sync/index.js';

/**
 * Which shops moved MRR between two daily reports, and why.
 *
 * MRR is a sum over lines: one per live subscription charge at its normalized
 * monthly amount, plus each shop's trailing-30-day usage. Diffing yesterday's
 * lines against today's names every dollar of the change; each line's cause
 * is then read off the stored subscription record and raw Partner API events,
 * never guessed. The narrator only rephrases what this returns.
 *
 * Yesterday has two versions. The *posted* one is what the channel was told.
 * The *recomputed* one is the same instant rebuilt from today's data, which
 * differs when Shopify reported something late — a cancel or freeze dated
 * before yesterday's send, or a payment that never settled. The change splits
 * exactly into posted→recomputed (restated) plus recomputed→today (movement).
 */

const MS_PER_DAY = 86_400_000;

export interface MrrLine {
  /** Charge id, or `usage:<app>:<shop>` for trailing-30-day usage. */
  key: string;
  appId: string;
  shopId: string;
  planName: string | null;
  amount: number;
}

/** The lines MRR sums as-of an instant, built from the same predicate the metric uses. */
export function mrrLinesAt(db: Db, asOf: Date): MrrLine[] {
  const { reporting } = getConfig();
  const appIds = resolveScopedAppIds(db);
  const predicate = asOfPredicate(
    { appIds, includeAnnual: reporting.includeAnnual, includeTrials: reporting.includeTrials },
    '@asOf',
  );
  const lines = db
    .prepare(
      `SELECT s.charge_id AS key, s.app_id AS appId, s.shop_id AS shopId,
              s.plan_name AS planName, s.monthly_amount AS amount
       FROM subscriptions s
       WHERE ${predicate.sql}`,
    )
    .all({ ...predicate.params, asOf: asOf.toISOString() }) as MrrLine[];

  if (reporting.includeUsage) {
    // Mirrors usageSeries: (asOf − 30 days, asOf], inclusive at the end.
    const params: Record<string, unknown> = {
      asOf: asOf.toISOString(),
      from: new Date(asOf.getTime() - 30 * MS_PER_DAY).toISOString(),
    };
    const names = appIds.map((id, index) => {
      params[`u${index}`] = id;
      return `@u${index}`;
    });
    const usage = db
      .prepare(
        `SELECT 'usage:' || t.app_id || ':' || t.shop_id AS key, t.app_id AS appId,
                t.shop_id AS shopId, NULL AS planName, SUM(t.gross_amount) AS amount
         FROM transactions t
         WHERE t.type = 'AppUsageSale'
           AND t.created_at <= @asOf
           AND t.created_at > @from
           ${names.length > 0 ? `AND t.app_id IN (${names.join(', ')})` : ''}
         GROUP BY t.app_id, t.shop_id`,
      )
      .all(params) as MrrLine[];
    lines.push(...usage);
  }

  return lines.filter((line) => line.amount !== 0);
}

export type MrrCause =
  | 'new_paid'
  | 'plan_change'
  | 'canceled'
  | 'uninstalled'
  | 'store_closed'
  | 'frozen'
  | 'unfrozen'
  | 'not_collected'
  | 'usage'
  | 'price_corrected'
  | 'other';

export interface MrrItem {
  cause: MrrCause;
  /** Corrects yesterday's posted figure (late data), rather than happening since. */
  restated: boolean;
  shop: string;
  app: string;
  plan: string | null;
  delta: number;
  /** Dated facts from the stored records that establish the cause. */
  evidence: string[];
  /** No payment has ever settled on this charge. */
  neverPaid: boolean;
}

export interface MrrAttribution {
  /** Whether `previous` is what was posted yesterday or a recomputation of it. */
  baseline: 'posted' | 'recomputed';
  previous: number;
  current: number;
  change: number;
  /** Largest move first. */
  items: MrrItem[];
  /** `change` minus the items. Zero unless the lines and the metric disagree. */
  unexplained: number;
}

interface SubRow {
  charge_id: string;
  app_id: string;
  shop_id: string;
  plan_name: string | null;
  is_test: number;
  activated_at: string | null;
  conversion_at: string | null;
  churn_at: string | null;
  churn_reason: string | null;
  frozen_at: string | null;
  unfrozen_at: string | null;
  paid_sale_count: number;
  first_sale_at: string | null;
  last_sale_at: string | null;
  billing_on: string | null;
  deactivated_at: string | null;
  replaces_plan: string | null;
  previous_paid_end: string | null;
}

const round = (value: number) => Math.round(value * 100) / 100;

function when(iso: string): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: getConfig().runtime.dailyReportTimeZone,
  }).format(new Date(iso));
}

function day(iso: string): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(iso));
}

function loadSubscription(db: Db, chargeId: string): SubRow | undefined {
  return db
    .prepare(
      `SELECT s.charge_id, s.app_id, s.shop_id, s.plan_name, s.is_test, s.activated_at,
              s.conversion_at, s.churn_at, s.churn_reason, s.frozen_at, s.unfrozen_at,
              s.paid_sale_count, s.first_sale_at, s.last_sale_at,
              (SELECT e.billing_on FROM app_events e
                WHERE e.charge_id = s.charge_id AND e.billing_on IS NOT NULL
                ORDER BY e.occurred_at DESC LIMIT 1) AS billing_on,
              (SELECT MAX(e.occurred_at) FROM app_events e
                WHERE e.app_id = s.app_id AND e.shop_id = s.shop_id
                  AND e.type = 'RELATIONSHIP_DEACTIVATED') AS deactivated_at,
              (SELECT p.plan_name FROM subscriptions p
                WHERE p.app_id = s.app_id AND p.shop_id = s.shop_id
                  AND p.charge_id <> s.charge_id AND p.is_plan_change = 1
                  AND s.activated_at IS NOT NULL
                  AND abs(julianday(s.activated_at) - julianday(p.churn_at)) * 86400.0 < @window
                LIMIT 1) AS replaces_plan,
              (SELECT MAX(p.churn_at) FROM subscriptions p
                WHERE p.app_id = s.app_id AND p.shop_id = s.shop_id
                  AND p.charge_id <> s.charge_id AND p.is_plan_change = 0
                  AND p.conversion_at IS NOT NULL AND p.conversion_at < p.churn_at
                  AND p.churn_at < s.activated_at) AS previous_paid_end
       FROM subscriptions s
       WHERE s.charge_id = @chargeId`,
    )
    .get({ chargeId, window: PLAN_CHANGE_WINDOW_SECONDS }) as SubRow | undefined;
}

function frozenAt(sub: SubRow, before: string): boolean {
  return Boolean(
    sub.frozen_at &&
      sub.frozen_at < before &&
      !(sub.unfrozen_at && sub.unfrozen_at > sub.frozen_at && sub.unfrozen_at < before),
  );
}

function paymentFacts(sub: SubRow): string[] {
  return sub.paid_sale_count === 0
    ? ['no payment has ever settled on this charge']
    : [`last payment settled ${when(sub.last_sale_at!)}`];
}

const CHURN_CAUSE: Record<string, MrrCause> = {
  canceled: 'canceled',
  uninstalled: 'uninstalled',
  deactivated: 'store_closed',
  plan_change: 'plan_change',
};

const CHURN_VERB: Record<string, string> = {
  canceled: 'subscription canceled',
  uninstalled: 'app uninstalled',
  deactivated: 'store deactivated (closed or paused)',
  plan_change: 'plan changed',
};

/** Why a subscription line that counted earlier no longer counts at `before`. */
function whyRemoved(sub: SubRow | undefined, before: string): { cause: MrrCause; evidence: string[] } {
  if (!sub) return { cause: 'other', evidence: ['charge no longer appears in the Partner API data'] };
  if (sub.is_test) return { cause: 'other', evidence: ['charge is now marked as a test charge'] };

  if (sub.churn_at && sub.churn_at < before) {
    const reason = sub.churn_reason ?? 'canceled';
    return {
      cause: CHURN_CAUSE[reason] ?? 'other',
      evidence: [`${CHURN_VERB[reason] ?? reason} ${when(sub.churn_at)}`, ...paymentFacts(sub)],
    };
  }

  if (frozenAt(sub, before)) {
    const evidence = [`Shopify froze the charge ${when(sub.frozen_at!)}`];
    if (
      sub.deactivated_at &&
      sub.deactivated_at <= sub.frozen_at! &&
      Date.parse(sub.frozen_at!) - Date.parse(sub.deactivated_at) < MS_PER_DAY
    ) {
      evidence.push(`store deactivated (closed or paused) ${when(sub.deactivated_at)}`);
    }
    if (sub.billing_on && sub.frozen_at! < sub.billing_on) {
      evidence.push(`frozen before its billing date of ${day(sub.billing_on)}`);
    }
    evidence.push(...paymentFacts(sub));
    return { cause: 'frozen', evidence };
  }

  if (!sub.conversion_at || sub.conversion_at >= before) {
    return {
      cause: 'not_collected',
      evidence: ['no longer counted as paid', ...paymentFacts(sub)],
    };
  }

  return { cause: 'other', evidence: ['no longer in reporting scope'] };
}

/** Why a subscription line started counting by `before` (and not before `since`). */
function whyAdded(
  sub: SubRow | undefined,
  since: string | null,
  before: string,
): { cause: MrrCause; evidence: string[] } {
  if (!sub) return { cause: 'other', evidence: [] };
  const inWindow = (at: string | null) => Boolean(at && at < before && (!since || at >= since));

  if (sub.frozen_at && sub.unfrozen_at && sub.unfrozen_at > sub.frozen_at && inWindow(sub.unfrozen_at)) {
    return { cause: 'unfrozen', evidence: [`Shopify unfroze the charge ${when(sub.unfrozen_at)}`] };
  }

  if (inWindow(sub.conversion_at)) {
    // Mirrors how derive set conversion_at: the first settled sale, else a
    // charge taken at activation, else a billing date that passed uncanceled.
    let evidence: string[];
    if (sub.paid_sale_count > 0) {
      evidence = [`first payment settled ${when(sub.first_sale_at!)}`];
    } else if (sub.conversion_at === sub.activated_at) {
      evidence = [
        sub.billing_on
          ? `charged at activation (next billing date ${day(sub.billing_on)} is a full cycle away)`
          : 'charged at activation',
        'no payment has settled yet',
      ];
    } else {
      evidence = [
        `billing date ${day(sub.conversion_at!)} passed without a cancellation`,
        'no payment has settled yet',
      ];
    }
    if (sub.activated_at) evidence.unshift(`activated ${when(sub.activated_at)}`);
    if (sub.previous_paid_end) {
      evidence.push(`returning merchant; previous paid subscription ended ${when(sub.previous_paid_end)}`);
    }
    if (sub.replaces_plan) {
      return { cause: 'plan_change', evidence: [`moved from plan ${sub.replaces_plan}`, ...evidence] };
    }
    return { cause: 'new_paid', evidence };
  }

  return { cause: 'other', evidence: [] };
}

function labels(db: Db, appId: string, shopId: string): { shop: string; app: string } {
  const row = db
    .prepare(
      `SELECT (SELECT COALESCE(myshopify_domain, name) FROM shops WHERE id = @shopId) AS shop,
              (SELECT name FROM apps WHERE id = @appId) AS app`,
    )
    .get({ appId, shopId }) as { shop: string | null; app: string | null };
  return { shop: row.shop ?? shopId, app: row.app ?? appId };
}

function diff(
  db: Db,
  from: MrrLine[],
  to: MrrLine[],
  since: string | null,
  before: string,
  money: (value: number) => string,
): MrrItem[] {
  const start = new Map(from.map((line) => [line.key, line]));
  const after = new Map(to.map((line) => [line.key, line]));
  const items: MrrItem[] = [];

  for (const key of new Set([...start.keys(), ...after.keys()])) {
    const old = start.get(key);
    const now = after.get(key);
    const delta = round((now?.amount ?? 0) - (old?.amount ?? 0));
    if (delta === 0) continue;
    const line = (now ?? old)!;
    const { shop, app } = labels(db, line.appId, line.shopId);
    const restated = since === null;

    if (key.startsWith('usage:')) {
      items.push({
        cause: 'usage',
        restated,
        shop,
        app,
        plan: null,
        delta,
        neverPaid: false,
        evidence: [
          `usage billed in the trailing 30 days went from ${money(old?.amount ?? 0)} to ${money(now?.amount ?? 0)}`,
        ],
      });
      continue;
    }

    const sub = loadSubscription(db, key);
    let why: { cause: MrrCause; evidence: string[] };
    if (old && now) {
      why = {
        cause: 'price_corrected',
        evidence: [`monthly amount recorded as ${money(old.amount)}, now ${money(now.amount)}`],
      };
    } else if (old) {
      why = whyRemoved(sub, before);
    } else {
      why = whyAdded(sub, since, before);
    }

    items.push({
      ...why,
      restated,
      shop,
      app,
      plan: line.planName,
      delta,
      neverPaid: Boolean(sub && sub.paid_sale_count === 0),
    });
  }

  // A plan change is one charge ending and its replacement starting; report
  // the shop's net move once.
  const merged: MrrItem[] = [];
  const changes = new Map<string, MrrItem>();
  const paired = new Set<MrrItem>();
  for (const item of items) {
    if (item.cause !== 'plan_change') {
      merged.push(item);
      continue;
    }
    const key = `${item.app} ${item.shop}`;
    const existing = changes.get(key);
    if (!existing) {
      changes.set(key, item);
      merged.push(item);
      continue;
    }
    paired.add(existing);
    const [ended, started] = existing.delta < 0 ? [existing, item] : [item, existing];
    existing.delta = round(existing.delta + item.delta);
    existing.plan = `${ended.plan ?? '?'} → ${started.plan ?? '?'}`;
    existing.evidence = [...new Set([...ended.evidence, ...started.evidence])];
    existing.neverPaid = started.neverPaid;
  }

  // A replacement plan that starts counting here while the plan it replaced
  // stopped counting earlier is a payment starting, not a plan change today.
  for (const item of changes.values()) {
    if (!paired.has(item) && item.delta > 0) item.cause = 'new_paid';
  }

  return merged.filter((item) => item.delta !== 0);
}

/**
 * Attribute `current.value − previous.value` to shops.
 *
 * Without stored lines for yesterday, the baseline is yesterday recomputed
 * from today's data and nothing can be called a restatement.
 */
export function attributeMrrChange(
  db: Db,
  input: {
    previous: { asOf: Date; value: number; lines: MrrLine[] | null };
    current: { asOf: Date; value: number; lines: MrrLine[] };
    money: (value: number) => string;
  },
): MrrAttribution {
  const { previous, current, money } = input;
  const recomputed = mrrLinesAt(db, previous.asOf);
  const p = previous.asOf.toISOString();
  const c = current.asOf.toISOString();

  const items = [
    ...(previous.lines ? diff(db, previous.lines, recomputed, null, p, money) : []),
    ...diff(db, recomputed, current.lines, p, c, money),
  ].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  const change = round(current.value - previous.value);
  const explained = round(items.reduce((sum, item) => sum + item.delta, 0));
  return {
    baseline: previous.lines ? 'posted' : 'recomputed',
    previous: previous.value,
    current: current.value,
    change,
    items,
    unexplained: round(change - explained),
  };
}
