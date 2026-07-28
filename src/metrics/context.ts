import { getConfig, normalizeAppId } from '../config.js';
import { getDb, type Db } from '../db/index.js';
import { resolveScopedAppIds } from '../sync/index.js';
import type { AsOfOptions } from './asof.js';
import { resolveWindow, type Window } from './time.js';

export class MetricRequestError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = 'MetricRequestError';
  }
}

/** Raw query-string shape. Values arrive as strings and are validated here. */
export interface RawMetricQuery {
  period?: string;
  start?: string;
  end?: string;
  interval?: string;
  appIds?: string;
  includeAnnual?: string;
  includeUsage?: string;
  includeTrials?: string;
  byShop?: string;
  nocache?: string;
}

function flag(raw: string | undefined, fallback: boolean, name: string): boolean {
  if (raw === undefined || raw === '') return fallback;
  const value = raw.toLowerCase();
  if (['1', 'true', 'yes'].includes(value)) return true;
  if (['0', 'false', 'no'].includes(value)) return false;
  throw new MetricRequestError(`${name} must be true or false, got "${raw}".`);
}

export interface MetricContext {
  db: Db;
  window: Window;
  /** Apps this request reports on, already intersected with the org scope. */
  appIds: string[];
  asOf: AsOfOptions;
  includeUsage: boolean;
  byShop: boolean;
  churnWindowDays: number;
  planChangeWindowDays: number;
  currency: string | null;
  /** Visible buckets preceded by the hidden leading bucket. */
  bucketsWithLead: Window['buckets'];
}

/**
 * The dominant currency across recorded transactions. Partner payouts are
 * normally single-currency; if an org mixes them the reports would be summing
 * unlike units, so the mix is surfaced in `meta` rather than silently converted.
 */
export function currencyProfile(
  db: Db,
  appIds: string[],
): { currency: string | null; mixed: boolean } {
  const params: Record<string, unknown> = {};
  const names = appIds.map((id, index) => {
    params[`c${index}`] = id;
    return `@c${index}`;
  });
  const filter = names.length > 0 ? `AND app_id IN (${names.join(', ')})` : '';

  const rows = db
    .prepare(
      `SELECT currency, COUNT(*) AS n
       FROM transactions
       WHERE currency <> '' ${filter}
       GROUP BY currency
       ORDER BY n DESC`,
    )
    .all(params) as Array<{ currency: string; n: number }>;

  if (rows.length === 0) return { currency: null, mixed: false };
  return { currency: rows[0]!.currency, mixed: rows.length > 1 };
}

export function buildContext(query: RawMetricQuery, now?: Date): MetricContext {
  const db = getDb();
  const { runtime, scope, reporting } = getConfig();

  const inScope = resolveScopedAppIds(db);
  let appIds = inScope;

  if (query.appIds) {
    const requested = query.appIds
      .split(',')
      .map((part) => normalizeAppId(part))
      .filter(Boolean);
    // Permission gate at the scope layer, not only inside the query: asking for
    // an app outside the configured scope is an error, not an empty result.
    const outside = requested.filter((id) => !inScope.includes(id));
    if (outside.length > 0) {
      throw new MetricRequestError(
        `Requested app id(s) outside the configured reporting scope: ${outside.join(', ')}.`,
        403,
      );
    }
    appIds = requested;
  }

  const window = resolveWindow({
    period: query.period,
    start: query.start,
    end: query.end,
    interval: query.interval,
    timeZone: runtime.timezone,
    allTimeStart: scope.syncStartDate,
    now,
  });

  const asOf: AsOfOptions = {
    appIds,
    includeAnnual: flag(query.includeAnnual, reporting.includeAnnual, 'includeAnnual'),
    includeTrials: flag(query.includeTrials, reporting.includeTrials, 'includeTrials'),
  };

  const { currency } = currencyProfile(db, appIds);

  return {
    db,
    window,
    appIds,
    asOf,
    includeUsage: flag(query.includeUsage, reporting.includeUsage, 'includeUsage'),
    byShop: flag(query.byShop, reporting.byShop, 'byShop'),
    churnWindowDays: reporting.churnWindowDays,
    planChangeWindowDays: reporting.planChangeWindowDays,
    currency,
    bucketsWithLead: [window.leading, ...window.buckets],
  };
}
