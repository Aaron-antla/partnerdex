import { getConfig } from '../config.js';
import { getDb, type Db } from '../db/index.js';
import { asOfPredicate, type AsOfOptions } from '../metrics/asof.js';
import { resolveScopedAppIds } from '../sync/index.js';

/**
 * The customer read model.
 *
 * Deliberately computed at read time rather than kept as a rollup table. The
 * store is one merchant per row over a few tens of thousands of rows, and
 * SQLite answers these in single-digit milliseconds — so paying for a snapshot
 * table would buy nothing and cost the thing this project is built on: a figure
 * that can silently disagree with the reports beside it.
 *
 * Liveness comes from `asOfPredicate`, the same predicate every MRR and churn
 * chart uses. A customer's MRR on their own page is therefore the same number
 * that customer contributes to the MRR series, by construction rather than by
 * coincidence.
 */

/** "Live right now", read through the shared as-of predicate. */
function liveOptions(appIds: string[]): AsOfOptions {
  const { reporting } = getConfig();
  return {
    appIds,
    includeAnnual: reporting.includeAnnual,
    includeTrials: reporting.includeTrials,
  };
}

function scope(db: Db, appIds: string[]): string[] {
  return appIds.length > 0 ? appIds : resolveScopedAppIds(db);
}

export type CustomerStatus = 'paying' | 'trialing' | 'installed' | 'churned' | 'gone';

export interface CustomerSummary {
  shopId: string;
  name: string | null;
  domain: string | null;
  status: CustomerStatus;
  mrr: number;
  currency: string | null;
  activeSubscriptions: number;
  activeInstalls: number;
  lifetimeGross: number;
  lifetimeNet: number;
  firstSeenAt: string | null;
  lastEventAt: string | null;
}

export interface CustomerListResult {
  customers: CustomerSummary[];
  total: number;
  limit: number;
  offset: number;
  query: string;
}

interface SummaryRow {
  shopId: string;
  name: string | null;
  domain: string | null;
  mrr: number;
  currency: string | null;
  activeSubscriptions: number;
  onTrial: number;
  activeInstalls: number;
  lifetimeGross: number;
  lifetimeNet: number;
  firstSeenAt: string | null;
  lastEventAt: string | null;
}

function statusOf(row: SummaryRow, everSubscribed: number): CustomerStatus {
  if (row.activeSubscriptions > 0) return 'paying';
  if (row.onTrial > 0) return 'trialing';
  if (row.activeInstalls > 0) return 'installed';
  // No install and no live subscription. Distinguish a merchant who left after
  // paying from one who only ever installed, because they are different losses.
  return everSubscribed > 0 ? 'churned' : 'gone';
}

/**
 * Builds the per-shop aggregate. One statement rather than a query per shop,
 * because the list page renders a page of them at a time.
 *
 * `search` matches the merchant's display name or their myshopify domain, which
 * is how a support ticket or a Partner dashboard link identifies them.
 */
function summarySql(appIds: string[], searching: boolean): { sql: string; params: Record<string, unknown> } {
  const live = asOfPredicate(liveOptions(appIds), '@now');
  const appList = appIds.map((_, i) => `@sapp${i}`).join(', ');
  const appParams: Record<string, unknown> = {};
  appIds.forEach((id, i) => {
    appParams[`sapp${i}`] = id;
  });
  const inScope = appIds.length > 0 ? `IN (${appList})` : 'IS NOT NULL';

  return {
    params: { ...live.params, ...appParams },
    sql: `
      WITH matched AS (
        SELECT id, name, myshopify_domain
        FROM shops
        ${searching ? 'WHERE name LIKE @q OR myshopify_domain LIKE @q OR id = @exact' : ''}
      ),
      live_subs AS (
        SELECT s.shop_id AS shop_id,
               COALESCE(SUM(s.monthly_amount), 0) AS mrr,
               COUNT(s.charge_id) AS n,
               MAX(s.currency) AS currency
        FROM subscriptions s
        WHERE ${live.sql}
        GROUP BY s.shop_id
      ),
      trialing AS (
        SELECT shop_id, COUNT(*) AS n
        FROM subscriptions
        WHERE is_test = 0 AND app_id ${inScope}
          AND trial_status = 'in_trial'
          AND (churn_at IS NULL OR churn_at > @now)
        GROUP BY shop_id
      ),
      ever_subs AS (
        SELECT shop_id, COUNT(*) AS n
        FROM subscriptions
        WHERE is_test = 0 AND app_id ${inScope} AND conversion_at IS NOT NULL
        GROUP BY shop_id
      ),
      installs AS (
        SELECT shop_id, COUNT(DISTINCT app_id) AS n
        FROM install_intervals
        WHERE app_id ${inScope}
          AND started_at <= @now
          AND (ended_at IS NULL OR ended_at > @now)
        GROUP BY shop_id
      ),
      paid AS (
        SELECT shop_id,
               COALESCE(SUM(gross_amount), 0) AS gross,
               COALESCE(SUM(net_amount), 0) AS net,
               MAX(currency) AS currency
        FROM transactions
        WHERE app_id ${inScope}
        GROUP BY shop_id
      ),
      seen AS (
        SELECT shop_id, MIN(occurred_at) AS first_at, MAX(occurred_at) AS last_at
        FROM customer_events
        WHERE suppressed = 0 AND app_id ${inScope}
        GROUP BY shop_id
      )
      SELECT m.id AS shopId,
             m.name AS name,
             m.myshopify_domain AS domain,
             COALESCE(ls.mrr, 0) AS mrr,
             COALESCE(ls.currency, p.currency) AS currency,
             COALESCE(ls.n, 0) AS activeSubscriptions,
             COALESCE(t.n, 0) AS onTrial,
             COALESCE(i.n, 0) AS activeInstalls,
             COALESCE(p.gross, 0) AS lifetimeGross,
             COALESCE(p.net, 0) AS lifetimeNet,
             COALESCE(es.n, 0) AS everSubscribed,
             se.first_at AS firstSeenAt,
             se.last_at AS lastEventAt
      FROM matched m
      LEFT JOIN live_subs ls ON ls.shop_id = m.id
      LEFT JOIN trialing t ON t.shop_id = m.id
      LEFT JOIN ever_subs es ON es.shop_id = m.id
      LEFT JOIN installs i ON i.shop_id = m.id
      LEFT JOIN paid p ON p.shop_id = m.id
      LEFT JOIN seen se ON se.shop_id = m.id
      -- A shop the feed never mentioned in scope is not a customer of these
      -- apps; it arrived on some other app's transaction.
      WHERE se.shop_id IS NOT NULL OR i.shop_id IS NOT NULL OR p.shop_id IS NOT NULL
    `,
  };
}

export type CustomerSort = 'mrr' | 'lifetime' | 'recent' | 'name';

const ORDER_BY: Record<CustomerSort, string> = {
  mrr: 'mrr DESC, lifetimeGross DESC, name ASC',
  lifetime: 'lifetimeGross DESC, mrr DESC, name ASC',
  recent: 'lastEventAt DESC, mrr DESC',
  name: 'name ASC, domain ASC',
};

export function listCustomers(options: {
  search?: string;
  limit?: number;
  offset?: number;
  sort?: CustomerSort;
  appIds?: string[];
} = {}): CustomerListResult {
  const db = getDb();
  const appIds = scope(db, options.appIds ?? []);
  const search = (options.search ?? '').trim();
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const offset = Math.max(options.offset ?? 0, 0);
  const sort = ORDER_BY[options.sort ?? 'mrr'] ? (options.sort ?? 'mrr') : 'mrr';

  const built = summarySql(appIds, search.length > 0);
  const params: Record<string, unknown> = {
    ...built.params,
    now: new Date().toISOString(),
  };
  if (search.length > 0) {
    params.q = `%${search}%`;
    // A pasted shop id should find exactly one merchant, not every id containing it.
    params.exact = search;
  }

  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM (${built.sql})`).get(params) as { n: number }
  ).n;

  const rows = db
    .prepare(`${built.sql} ORDER BY ${ORDER_BY[sort]} LIMIT @limit OFFSET @offset`)
    .all({ ...params, limit, offset }) as Array<SummaryRow & { everSubscribed: number }>;

  return {
    customers: rows.map((row) => ({
      shopId: row.shopId,
      name: row.name,
      domain: row.domain,
      status: statusOf(row, row.everSubscribed),
      mrr: row.mrr,
      currency: row.currency,
      activeSubscriptions: row.activeSubscriptions,
      activeInstalls: row.activeInstalls,
      lifetimeGross: row.lifetimeGross,
      lifetimeNet: row.lifetimeNet,
      firstSeenAt: row.firstSeenAt,
      lastEventAt: row.lastEventAt,
    })),
    total,
    limit,
    offset,
    query: search,
  };
}

export interface CustomerSubscription {
  chargeId: string;
  appId: string;
  appName: string | null;
  planName: string | null;
  amount: number;
  monthlyAmount: number;
  currency: string | null;
  billingInterval: string;
  status: 'active' | 'trialing' | 'frozen' | 'churned' | 'replaced' | 'pending';
  activatedAt: string | null;
  conversionAt: string | null;
  churnAt: string | null;
  churnReason: string | null;
  trialStatus: string;
  trialEndsAt: string | null;
  paidSaleCount: number;
  lastSaleAt: string | null;
}

export interface CustomerEventRecord {
  eventId: string;
  type: string;
  occurredAt: string;
  appId: string;
  appName: string | null;
  chargeId: string;
  planName: string | null;
  planAmount: number | null;
  billingInterval: string | null;
  currency: string | null;
  netChange: number | null;
  amount: number | null;
  detail: Record<string, unknown> | null;
}

export interface CustomerDetail {
  shopId: string;
  name: string | null;
  domain: string | null;
  status: CustomerStatus;
  mrr: number;
  currency: string | null;
  lifetimeGross: number;
  lifetimeNet: number;
  paymentCount: number;
  firstSeenAt: string | null;
  lastEventAt: string | null;
  subscriptions: CustomerSubscription[];
  events: CustomerEventRecord[];
  apps: Array<{ appId: string; appName: string | null; installedAt: string | null }>;
}

interface SubDetailRow {
  chargeId: string;
  appId: string;
  appName: string | null;
  planName: string | null;
  amount: number;
  monthlyAmount: number;
  currency: string | null;
  billingInterval: string;
  activatedAt: string | null;
  conversionAt: string | null;
  churnAt: string | null;
  churnReason: string | null;
  frozenAt: string | null;
  unfrozenAt: string | null;
  trialStatus: string;
  trialEndsAt: string | null;
  paidSaleCount: number;
  lastSaleAt: string | null;
  isPlanChange: number;
}

function subscriptionStatus(
  row: SubDetailRow,
  isLive: boolean,
  now: string,
): CustomerSubscription['status'] {
  // A subscription the merchant swapped out of is not a subscription they
  // cancelled. Showing both as "cancelled" makes an afternoon of tier-shopping
  // read as four lost customers.
  if (row.isPlanChange === 1) return 'replaced';
  if (row.churnAt && row.churnAt <= now) return 'churned';
  const frozen =
    row.frozenAt && row.frozenAt <= now && (!row.unfrozenAt || row.unfrozenAt <= row.frozenAt);
  if (frozen) return 'frozen';
  if (isLive) return 'active';
  if (row.trialStatus === 'in_trial') return 'trialing';
  // Activated but never billed and never cancelled: it has not started earning.
  return 'pending';
}

export function getCustomer(
  shopId: string,
  options: { appIds?: string[]; eventLimit?: number } = {},
): CustomerDetail | null {
  const db = getDb();
  const appIds = scope(db, options.appIds ?? []);
  const now = new Date().toISOString();
  const eventLimit = Math.min(Math.max(options.eventLimit ?? 500, 1), 2000);

  const shop = db
    .prepare('SELECT id, name, myshopify_domain AS domain FROM shops WHERE id = ?')
    .get(shopId) as { id: string; name: string | null; domain: string | null } | undefined;
  if (!shop) return null;

  const appList = appIds.map((_, i) => `@dapp${i}`).join(', ');
  const appParams: Record<string, unknown> = {};
  appIds.forEach((id, i) => {
    appParams[`dapp${i}`] = id;
  });
  const inScope = appIds.length > 0 ? `IN (${appList})` : 'IS NOT NULL';

  // Liveness is decided by the shared as-of predicate rather than by re-reading
  // the dates here, so a subscription shown as active on this page is exactly a
  // subscription counted in MRR. Read as its own set instead of as a correlated
  // subquery, because the predicate is written against one fixed table alias.
  const live = asOfPredicate(liveOptions(appIds), '@now');
  const liveCharges = new Set(
    (
      db
        .prepare(
          `SELECT s.charge_id AS id FROM subscriptions s WHERE ${live.sql} AND s.shop_id = @shopId`,
        )
        .all({ ...live.params, shopId, now }) as Array<{ id: string }>
    ).map((row) => row.id),
  );

  const subs = db
    .prepare(
      `SELECT s.charge_id AS chargeId,
              s.app_id AS appId,
              a.name AS appName,
              s.plan_name AS planName,
              s.amount AS amount,
              s.monthly_amount AS monthlyAmount,
              s.currency AS currency,
              s.billing_interval AS billingInterval,
              s.activated_at AS activatedAt,
              s.conversion_at AS conversionAt,
              s.churn_at AS churnAt,
              s.churn_reason AS churnReason,
              s.frozen_at AS frozenAt,
              s.unfrozen_at AS unfrozenAt,
              s.trial_status AS trialStatus,
              s.trial_ends_at AS trialEndsAt,
              s.paid_sale_count AS paidSaleCount,
              s.last_sale_at AS lastSaleAt,
              s.is_plan_change AS isPlanChange
       FROM subscriptions s
       LEFT JOIN apps a ON a.id = s.app_id
       WHERE s.shop_id = @shopId AND s.is_test = 0 AND s.app_id ${inScope}
       ORDER BY COALESCE(s.activated_at, s.accepted_at) DESC`,
    )
    .all({ ...appParams, shopId }) as SubDetailRow[];

  const events = db
    .prepare(
      `SELECT e.event_id AS eventId,
              e.type AS type,
              e.occurred_at AS occurredAt,
              e.app_id AS appId,
              a.name AS appName,
              e.charge_id AS chargeId,
              e.plan_name AS planName,
              e.plan_amount AS planAmount,
              e.billing_interval AS billingInterval,
              e.currency AS currency,
              e.net_change AS netChange,
              e.amount AS amount,
              e.detail AS detail
       FROM customer_events e
       LEFT JOIN apps a ON a.id = e.app_id
       WHERE e.shop_id = @shopId AND e.suppressed = 0 AND e.app_id ${inScope}
       ORDER BY e.occurred_at DESC
       LIMIT @eventLimit`,
    )
    .all({ ...appParams, shopId, eventLimit }) as Array<
    Omit<CustomerEventRecord, 'detail'> & { detail: string | null }
  >;

  const money = db
    .prepare(
      `SELECT COALESCE(SUM(gross_amount), 0) AS gross,
              COALESCE(SUM(net_amount), 0) AS net,
              COUNT(*) AS n,
              MAX(currency) AS currency
       FROM transactions
       WHERE shop_id = @shopId AND app_id ${inScope}`,
    )
    .get({ ...appParams, shopId }) as {
    gross: number;
    net: number;
    n: number;
    currency: string | null;
  };

  const apps = db
    .prepare(
      `SELECT i.app_id AS appId, a.name AS appName, MIN(i.started_at) AS installedAt
       FROM install_intervals i
       LEFT JOIN apps a ON a.id = i.app_id
       WHERE i.shop_id = @shopId AND i.app_id ${inScope}
         AND i.started_at <= @now AND (i.ended_at IS NULL OR i.ended_at > @now)
       GROUP BY i.app_id, a.name
       ORDER BY a.name`,
    )
    .all({ ...appParams, shopId, now }) as CustomerDetail['apps'];

  const detailed: CustomerSubscription[] = subs.map((row) => ({
    chargeId: row.chargeId,
    appId: row.appId,
    appName: row.appName,
    planName: row.planName,
    amount: row.amount,
    monthlyAmount: row.monthlyAmount,
    currency: row.currency,
    billingInterval: row.billingInterval,
    status: subscriptionStatus(row, liveCharges.has(row.chargeId), now),
    activatedAt: row.activatedAt,
    conversionAt: row.conversionAt,
    churnAt: row.churnAt,
    churnReason: row.churnReason,
    trialStatus: row.trialStatus,
    trialEndsAt: row.trialEndsAt,
    paidSaleCount: row.paidSaleCount,
    lastSaleAt: row.lastSaleAt,
  }));

  const mrr = subs.reduce(
    (sum, row) => sum + (liveCharges.has(row.chargeId) ? row.monthlyAmount : 0),
    0,
  );
  const activeSubscriptions = detailed.filter((row) => row.status === 'active').length;
  const onTrial = detailed.filter((row) => row.status === 'trialing').length;
  const everSubscribed = subs.filter((row) => row.conversionAt !== null).length;

  // Read the extremes from the whole history rather than from the capped page
  // of events, so a long-lived merchant does not appear to have arrived
  // whenever their 500th-most-recent event happened to land.
  const span = db
    .prepare(
      `SELECT MIN(occurred_at) AS firstAt, MAX(occurred_at) AS lastAt
       FROM customer_events
       WHERE shop_id = @shopId AND suppressed = 0 AND app_id ${inScope}`,
    )
    .get({ ...appParams, shopId }) as { firstAt: string | null; lastAt: string | null };

  return {
    shopId: shop.id,
    name: shop.name,
    domain: shop.domain,
    status: statusOf(
      {
        shopId: shop.id,
        name: shop.name,
        domain: shop.domain,
        mrr,
        currency: null,
        activeSubscriptions,
        onTrial,
        activeInstalls: apps.length,
        lifetimeGross: money.gross,
        lifetimeNet: money.net,
        firstSeenAt: null,
        lastEventAt: null,
      },
      everSubscribed,
    ),
    mrr,
    currency: subs[0]?.currency ?? money.currency,
    lifetimeGross: money.gross,
    lifetimeNet: money.net,
    paymentCount: money.n,
    firstSeenAt: span.firstAt,
    lastEventAt: span.lastAt,
    subscriptions: detailed,
    events: events.map((event) => ({
      ...event,
      detail: event.detail ? (JSON.parse(event.detail) as Record<string, unknown>) : null,
    })),
    apps,
  };
}
