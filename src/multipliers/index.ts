import { getConfig } from '../config.js';
import { getDb, readSyncState, type Db } from '../db/index.js';
import {
  asOfPredicate,
  churnSeries,
  newSubscriptionSeries,
  type AsOfOptions,
} from '../metrics/asof.js';
import { currencyProfile } from '../metrics/context.js';
import type { Bucket } from '../metrics/time.js';
import { isExcluded, readConnection, readSettings, type MultiplierSettings } from '../mixpanel/connection.js';
import { resolveScopedAppIds } from '../sync/index.js';

/**
 * The Multipliers page: two ideas from Jason Cohen's *Hidden Multipliers*,
 * computed from the Partner API and Mixpanel.
 *
 *   - **The profit whale.** Rank every customer by what they pay minus what
 *     they cost to serve, and plot cumulative profit. The curve climbs past
 *     final profit and falls back; the fall is the tail of customers who cost
 *     more than they pay. Peak over final is the whale ratio.
 *   - **The cancellation ceiling.** Acquisition adds a roughly constant number
 *     of customers a month and churn removes a constant *fraction*, so the base
 *     converges on new-per-month ÷ churn rate and stalls there. The same holds
 *     for revenue: Max MRR = new MRR a month ÷ net MRR churn rate, where
 *     upgrades from growing usage offset the churn and can remove the ceiling.
 *
 * Revenue is what a shop actually pays: its live charges at the price of their
 * latest payment where that came in below list (a discount), otherwise at list.
 * Costs are the per-generation cost times Mixpanel generations over the last 30
 * complete days, plus a fixed monthly cost per paying shop.
 */

const MS_PER_DAY = 86_400_000;

/** The trailing window usage and profit are measured over, in complete days. */
export const WINDOW_DAYS = 30;

/** How many 30-day windows the ceiling averages acquisition and churn over. */
export const CEILING_MONTHS = 6;

/** Points on the ceiling-over-time chart, one per 30 days. */
const CEILING_HISTORY = 12;

/** A paying customer keeping less than this share of what they pay is "thin". */
export const THIN_MARGIN = 0.25;

export type MultiplierStatus = 'paying' | 'trialing' | 'free' | 'uninstalled' | 'unmatched';

export interface MultiplierCustomer {
  rank: number;
  shopId: string | null;
  name: string | null;
  domain: string;
  status: MultiplierStatus;
  plan: string | null;
  tier: string | null;
  /** Monthly list price of the live charges. */
  listMrr: number;
  /** What the shop actually pays a month: latest payment where below list. */
  paidMrr: number;
  discounted: boolean;
  /** One-time credit purchases in the window. Cash, not MRR. */
  credits: number;
  /** Paid MRR plus credits: everything the shop paid in the window. */
  revenue: number;
  generations: number;
  usageCost: number;
  fixedCost: number;
  cost: number;
  profit: number;
  /** Profit over revenue. Null for a shop paying nothing. */
  margin: number | null;
  /** Revenue per generation. Null for a shop with no usage. */
  revenuePerGeneration: number | null;
  cumulativeProfit: number;
}

export interface WhaleSummary {
  customers: number;
  /** Paid MRR plus credits. */
  revenue: number;
  paidMrr: number;
  credits: number;
  cost: number;
  finalProfit: number;
  peakProfit: number;
  /** Customers up to and including the crest. */
  peakRank: number;
  /** Peak over final profit. Null when final profit is not positive. */
  whaleRatio: number | null;
  makers: { count: number; profit: number };
  takers: { count: number; profit: number };
  neutral: number;
  /** Profit of the top 20% by rank, as a share of final profit. */
  top20Share: number | null;
  /** Profit of the bottom 20% by rank. */
  bottom20Profit: number;
  thin: number;
  payingWithoutUsage: number;
}

export interface Ceiling {
  key: string;
  label: string;
  /** List prices seen on this tier's charges, low to high. */
  priceRange: [number, number] | null;
  current: number;
  newPerMonth: number;
  lostPerMonth: number;
  /** Monthly churn rate as a fraction. */
  churnRate: number;
  /** Null when nothing churned: no finite ceiling. */
  ceiling: number | null;
  /** Current over ceiling, as a fraction. */
  progress: number | null;
  paidMrr: number;
  /** Mean generations per paying shop over the usage window. */
  generationsPerShop: number | null;
  /** Mean profit per paying shop over the usage window. */
  profitPerShop: number | null;
}

export interface RevenueCeiling {
  listMrr: number;
  paidMrr: number;
  newMrrPerMonth: number;
  /** Churn and contraction net of expansion, per month. Negative means net expansion. */
  netLossPerMonth: number;
  netMrrChurnRate: number;
  /** In list-price terms. Null when expansion outruns churn: no ceiling. */
  maxMrr: number | null;
  /** The same ceiling at today's ratio of paid to list MRR. */
  maxPaidMrr: number | null;
  progress: number | null;
}

export interface MultipliersReport {
  generatedAt: string;
  currency: string | null;
  window: { from: string; to: string; days: number };
  settings: MultiplierSettings;
  usage: {
    connected: boolean;
    lastSyncedThrough: string | null;
    latestDay: string | null;
    shopsWithUsage: number;
    generations: number;
    /** Domains with usage that the Partner API has never reported. */
    unmatchedDomains: string[];
  };
  excluded: number;
  whale: WhaleSummary;
  customers: MultiplierCustomer[];
  ceiling: {
    months: number;
    overall: Ceiling;
    revenue: RevenueCeiling;
    tiers: Ceiling[];
    history: Array<{ date: string; current: number; ceiling: number | null }>;
  };
}

const UUID_TAIL = /-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A charge's plan tier. Catalog plans are their own tier; unique and custom
 * charges (a UUID tail, or `Custom-…`) are negotiated and grouped together,
 * matching how Discounted MRR recognises them.
 */
export function tierOf(planName: string | null): string {
  if (!planName) return 'Unnamed plan';
  if (/^Custom-/i.test(planName) || UUID_TAIL.test(planName)) return 'Custom & negotiated';
  return planName.trim();
}

function round(value: number, places = 2): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function utcDay(instant: Date): string {
  return instant.toISOString().slice(0, 10);
}

interface LiveCharge {
  shopId: string;
  planName: string | null;
  amount: number;
  monthlyAmount: number;
  billingInterval: string;
  lastGross: number | null;
}

/** Charges live at `asOf`, with the gross of their latest payment before it. */
function liveCharges(db: Db, options: AsOfOptions, asOf: Date): LiveCharge[] {
  const predicate = asOfPredicate(options, '@asOf');
  return db
    .prepare(
      `SELECT s.shop_id AS shopId,
              s.plan_name AS planName,
              s.amount AS amount,
              s.monthly_amount AS monthlyAmount,
              s.billing_interval AS billingInterval,
              -- Same reading of "latest payment" as Discounted MRR: the largest
              -- gross at the latest timestamp, so a proration beside a full
              -- charge is not mistaken for a discount.
              (SELECT MAX(t.gross_amount) FROM transactions t
                WHERE t.charge_ref = s.charge_ref
                  AND t.type = 'AppSubscriptionSale'
                  AND t.created_at < @asOf
                  AND t.created_at = (
                    SELECT MAX(t2.created_at) FROM transactions t2
                     WHERE t2.charge_ref = s.charge_ref
                       AND t2.type = 'AppSubscriptionSale'
                       AND t2.created_at < @asOf)) AS lastGross
         FROM subscriptions s
        WHERE ${predicate.sql}`,
    )
    .all({ ...predicate.params, asOf: asOf.toISOString() }) as LiveCharge[];
}

/** What a charge actually brings in a month. */
export function paidMonthly(charge: Pick<LiveCharge, 'monthlyAmount' | 'billingInterval' | 'lastGross'>): number {
  if (charge.lastGross === null) return charge.monthlyAmount;
  const monthly = charge.billingInterval === 'ANNUAL' ? charge.lastGross / 12 : charge.lastGross;
  return Math.max(0, Math.min(charge.monthlyAmount, monthly));
}

interface ShopRow {
  id: string;
  name: string | null;
  domain: string | null;
}

/* ------------------------------------------------------------ the whale */

export function rankCustomers(customers: Omit<MultiplierCustomer, 'rank' | 'cumulativeProfit'>[]): {
  customers: MultiplierCustomer[];
  whale: WhaleSummary;
} {
  const sorted = [...customers].sort(
    (a, b) => b.profit - a.profit || b.revenue - a.revenue || a.domain.localeCompare(b.domain),
  );

  let cumulative = 0;
  let peak = 0;
  let peakRank = 0;
  const ranked = sorted.map((customer, index) => {
    cumulative += customer.profit;
    if (cumulative > peak) {
      peak = cumulative;
      peakRank = index + 1;
    }
    return { ...customer, rank: index + 1, cumulativeProfit: round(cumulative) };
  });

  const finalProfit = cumulative;
  const fifth = Math.ceil(ranked.length * 0.2);
  const top = ranked.slice(0, fifth).reduce((sum, row) => sum + row.profit, 0);
  const bottom = ranked.slice(ranked.length - fifth).reduce((sum, row) => sum + row.profit, 0);
  const makers = ranked.filter((row) => row.profit > 0);
  const takers = ranked.filter((row) => row.profit < 0);

  return {
    customers: ranked,
    whale: {
      customers: ranked.length,
      revenue: round(ranked.reduce((sum, row) => sum + row.revenue, 0)),
      paidMrr: round(ranked.reduce((sum, row) => sum + row.paidMrr, 0)),
      credits: round(ranked.reduce((sum, row) => sum + row.credits, 0)),
      cost: round(ranked.reduce((sum, row) => sum + row.cost, 0)),
      finalProfit: round(finalProfit),
      peakProfit: round(peak),
      peakRank,
      whaleRatio: finalProfit > 0 ? round(peak / finalProfit, 3) : null,
      makers: { count: makers.length, profit: round(makers.reduce((sum, row) => sum + row.profit, 0)) },
      takers: { count: takers.length, profit: round(takers.reduce((sum, row) => sum + row.profit, 0)) },
      neutral: ranked.length - makers.length - takers.length,
      top20Share: finalProfit > 0 ? round(top / finalProfit, 3) : null,
      bottom20Profit: round(bottom),
      thin: ranked.filter((row) => row.status === 'paying' && row.margin !== null && row.margin < THIN_MARGIN)
        .length,
      payingWithoutUsage: ranked.filter((row) => row.status === 'paying' && row.generations === 0).length,
    },
  };
}

/* ---------------------------------------------------------- the ceiling */

/** Steady state of a base gaining `inflow` a month and losing `rate` of itself. */
export function ceilingOf(inflowPerMonth: number, monthlyRate: number): number | null {
  return monthlyRate > 0 ? inflowPerMonth / monthlyRate : null;
}

/** `count` consecutive 30-day windows ending at `end`, oldest first. */
function monthlyBuckets(end: Date, count: number): Bucket[] {
  return Array.from({ length: count }, (_, index) => {
    const bucketEnd = new Date(end.getTime() - (count - 1 - index) * WINDOW_DAYS * MS_PER_DAY);
    return { start: new Date(bucketEnd.getTime() - WINDOW_DAYS * MS_PER_DAY), end: bucketEnd };
  });
}

function overallCeilings(
  db: Db,
  options: AsOfOptions,
  now: Date,
  byShop: boolean,
): { overall: Omit<Ceiling, 'paidMrr' | 'generationsPerShop' | 'profitPerShop'>; history: MultipliersReport['ceiling']['history']; baseMrr: number } {
  const { reporting } = getConfig();
  const span = CEILING_HISTORY + CEILING_MONTHS - 1;
  const buckets = monthlyBuckets(now, span);
  const added = newSubscriptionSeries(db, buckets, options, byShop, reporting.planChangeWindowDays);
  const churn = churnSeries(db, buckets, options, WINDOW_DAYS, byShop);
  const byIdx = new Map(churn.map((point) => [point.idx, point]));

  const at = (endIdx: number) => {
    let inflow = 0;
    let lost = 0;
    let base = 0;
    let baseMrr = 0;
    for (let idx = endIdx - CEILING_MONTHS + 1; idx <= endIdx; idx += 1) {
      inflow += added.get(idx) ?? 0;
      lost += byIdx.get(idx)?.churned ?? 0;
      base += byIdx.get(idx)?.population ?? 0;
      baseMrr += byIdx.get(idx)?.baseMrr ?? 0;
    }
    const rate = base > 0 ? lost / base : 0;
    const newPerMonth = inflow / CEILING_MONTHS;
    return { newPerMonth, lostPerMonth: lost / CEILING_MONTHS, rate, ceiling: ceilingOf(newPerMonth, rate), baseMrr: baseMrr / CEILING_MONTHS };
  };

  // The live base at each point, read with the same predicate as the reports.
  const predicate = asOfPredicate(options, '@asOf');
  const countLive = db.prepare(
    `SELECT ${byShop ? "COUNT(DISTINCT s.app_id || ' ' || s.shop_id)" : 'COUNT(s.charge_id)'} AS n
       FROM subscriptions s WHERE ${predicate.sql}`,
  );
  const live = (instant: Date): number =>
    (countLive.get({ ...predicate.params, asOf: instant.toISOString() }) as { n: number }).n;

  const history = buckets.slice(CEILING_MONTHS - 1).map((bucket, offset) => {
    const point = at(offset + CEILING_MONTHS - 1);
    return {
      date: bucket.end.toISOString(),
      current: live(bucket.end),
      ceiling: point.ceiling === null ? null : round(point.ceiling, 1),
    };
  });

  const latest = at(span - 1);
  const current = live(now);
  return {
    overall: {
      key: 'all',
      label: 'All paying customers',
      priceRange: null,
      current,
      newPerMonth: round(latest.newPerMonth, 1),
      lostPerMonth: round(latest.lostPerMonth, 1),
      churnRate: round(latest.rate, 4),
      ceiling: latest.ceiling === null ? null : round(latest.ceiling, 1),
      progress: latest.ceiling ? round(current / latest.ceiling, 3) : null,
    },
    history,
    baseMrr: latest.baseMrr,
  };
}

/**
 * Max MRR from the MRR ledger: new MRR a month over net MRR churn, where net
 * churn is everything existing customers did — cancel, freeze, downgrade, and
 * upgrade — over the MRR they started from. A usage-based business that sells
 * bigger plans to growing customers can push net churn below zero, and then
 * there is no ceiling at all.
 */
function revenueCeiling(
  db: Db,
  appIds: string[],
  now: Date,
  baseMrr: number,
  listMrr: number,
  paidMrr: number,
): RevenueCeiling {
  const from = new Date(now.getTime() - CEILING_MONTHS * WINDOW_DAYS * MS_PER_DAY).toISOString();
  const apps = appIds.map((_, index) => `@app${index}`);
  const params: Record<string, unknown> = { from, now: now.toISOString() };
  appIds.forEach((id, index) => (params[`app${index}`] = id));

  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN type IN ('subscribed', 'resubscribed', 'trial_converted') THEN net_change END), 0) AS added,
         COALESCE(SUM(CASE WHEN type IN ('unsubscribed', 'subscription_frozen', 'subscription_unfrozen', 'upgraded', 'downgraded') THEN net_change END), 0) AS existing
         FROM customer_events
        WHERE suppressed = 0 AND net_change IS NOT NULL
          AND occurred_at >= @from AND occurred_at < @now
          ${apps.length > 0 ? `AND app_id IN (${apps.join(', ')})` : ''}`,
    )
    .get(params) as { added: number; existing: number };

  const newMrrPerMonth = row.added / CEILING_MONTHS;
  const netLossPerMonth = -row.existing / CEILING_MONTHS;
  const rate = baseMrr > 0 ? netLossPerMonth / baseMrr : 0;
  const maxMrr = ceilingOf(newMrrPerMonth, rate);
  const paidRatio = listMrr > 0 ? paidMrr / listMrr : 1;

  return {
    listMrr: round(listMrr),
    paidMrr: round(paidMrr),
    newMrrPerMonth: round(newMrrPerMonth),
    netLossPerMonth: round(netLossPerMonth),
    netMrrChurnRate: round(rate, 4),
    maxMrr: maxMrr === null ? null : round(maxMrr),
    maxPaidMrr: maxMrr === null ? null : round(maxMrr * paidRatio),
    progress: maxMrr ? round(listMrr / maxMrr, 3) : null,
  };
}

/**
 * The ceiling per plan tier.
 *
 * Unlike the overall figure, moves between tiers count here: a shop upgrading
 * from one tier to the next leaves the first and joins the second, which is
 * exactly how a usage-based plan ladder fills its upper tiers.
 */
function tierCeilings(db: Db, options: AsOfOptions, now: Date): Map<string, Omit<Ceiling, 'paidMrr' | 'generationsPerShop' | 'profitPerShop'>> {
  const from = new Date(now.getTime() - CEILING_MONTHS * WINDOW_DAYS * MS_PER_DAY);
  const apps = options.appIds.map((_, index) => `@app${index}`);
  const params: Record<string, unknown> = { from: from.toISOString(), now: now.toISOString() };
  options.appIds.forEach((id, index) => (params[`app${index}`] = id));
  const appSql = apps.length > 0 ? `AND app_id IN (${apps.join(', ')})` : '';

  const rows = db
    .prepare(
      `SELECT charge_id AS chargeId, app_id AS appId, shop_id AS shopId, plan_name AS planName,
              amount, activated_at AS activatedAt, conversion_at AS conversionAt,
              churn_at AS churnAt, is_plan_change AS isPlanChange
         FROM subscriptions
        WHERE is_test = 0 AND conversion_at IS NOT NULL ${appSql}
          ${options.includeAnnual ? '' : `AND billing_interval <> 'ANNUAL'`}`,
    )
    .all(params) as Array<{
    chargeId: string;
    appId: string;
    shopId: string;
    planName: string | null;
    amount: number;
    activatedAt: string | null;
    conversionAt: string;
    churnAt: string | null;
    isPlanChange: number;
  }>;

  // A plan change that stays inside one tier — a negotiated charge replaced by
  // another, a price edit on the same plan — is neither a loss nor a gain for
  // that tier. Pair each plan-change cancel with its replacement the way the
  // derive step does, and drop both halves when the tier did not change.
  const windowMs = getConfig().reporting.planChangeWindowDays * MS_PER_DAY;
  const skipIn = new Set<string>();
  const skipOut = new Set<string>();
  for (const old of rows) {
    if (!old.isPlanChange || !old.churnAt) continue;
    const churned = new Date(old.churnAt).getTime();
    const next = rows.find(
      (row) =>
        row.chargeId !== old.chargeId &&
        row.appId === old.appId &&
        row.shopId === old.shopId &&
        row.activatedAt !== null &&
        Math.abs(new Date(row.activatedAt).getTime() - churned) <= windowMs,
    );
    if (next && tierOf(next.planName) === tierOf(old.planName)) {
      skipOut.add(old.chargeId);
      skipIn.add(next.chargeId);
    }
  }

  const fromIso = from.toISOString();
  const nowIso = now.toISOString();
  const tiers = new Map<string, { inflow: number; outflow: number; base: number; current: number; prices: number[] }>();
  const tier = (name: string) => {
    let entry = tiers.get(name);
    if (!entry) {
      entry = { inflow: 0, outflow: 0, base: 0, current: 0, prices: [] };
      tiers.set(name, entry);
    }
    return entry;
  };

  for (const row of rows) {
    const entry = tier(tierOf(row.planName));
    entry.prices.push(row.amount);
    if (!skipIn.has(row.chargeId) && row.conversionAt >= fromIso && row.conversionAt < nowIso) {
      entry.inflow += 1;
    }
    if (
      !skipOut.has(row.chargeId) &&
      row.churnAt &&
      row.churnAt >= fromIso &&
      row.churnAt < nowIso &&
      row.conversionAt < row.churnAt
    ) {
      entry.outflow += 1;
    }
  }

  // The base each month's churn is measured against: the live charges per tier
  // at each window start, through the shared as-of predicate.
  for (const bucket of monthlyBuckets(now, CEILING_MONTHS)) {
    for (const charge of liveCharges(db, options, bucket.start)) tier(tierOf(charge.planName)).base += 1;
  }
  for (const charge of liveCharges(db, options, now)) tier(tierOf(charge.planName)).current += 1;

  const result = new Map<string, Omit<Ceiling, 'paidMrr' | 'generationsPerShop' | 'profitPerShop'>>();
  for (const [name, entry] of tiers) {
    if (entry.current === 0 && entry.inflow === 0 && entry.outflow === 0) continue;
    const avgBase = entry.base / CEILING_MONTHS;
    const rate = avgBase > 0 ? entry.outflow / CEILING_MONTHS / avgBase : 0;
    const newPerMonth = entry.inflow / CEILING_MONTHS;
    const ceiling = ceilingOf(newPerMonth, rate);
    const prices = entry.prices.sort((a, b) => a - b);
    result.set(name, {
      key: name,
      label: name,
      priceRange: prices.length > 0 ? [prices[0]!, prices.at(-1)!] : null,
      current: entry.current,
      newPerMonth: round(newPerMonth, 1),
      lostPerMonth: round(entry.outflow / CEILING_MONTHS, 1),
      churnRate: round(rate, 4),
      ceiling: ceiling === null ? null : round(ceiling, 1),
      progress: ceiling ? round(entry.current / ceiling, 3) : null,
    });
  }
  return result;
}

/* ---------------------------------------------------------------- build */

export function multipliersReport(options: { now?: Date; db?: Db } = {}): MultipliersReport {
  const db = options.db ?? getDb();
  const now = options.now ?? new Date();
  const { reporting } = getConfig();
  const settings = readSettings(db);
  const appIds = resolveScopedAppIds(db);
  const asOf: AsOfOptions = { appIds, includeAnnual: reporting.includeAnnual, includeTrials: false };

  // The last 30 complete UTC days. Today is still filling in Mixpanel.
  const to = utcDay(new Date(now.getTime() - MS_PER_DAY));
  const from = utcDay(new Date(now.getTime() - WINDOW_DAYS * MS_PER_DAY));

  const shops = db.prepare('SELECT id, name, myshopify_domain AS domain FROM shops').all() as ShopRow[];
  const shopById = new Map(shops.map((shop) => [shop.id, shop]));
  const shopByDomain = new Map(
    shops.filter((shop) => shop.domain).map((shop) => [shop.domain!.toLowerCase(), shop]),
  );

  // Revenue: live charges now, at what they actually pay.
  const charges = liveCharges(db, asOf, now);
  const revenue = new Map<string, { list: number; paid: number; plans: string[] }>();
  for (const charge of charges) {
    const entry = revenue.get(charge.shopId) ?? { list: 0, paid: 0, plans: [] };
    entry.list += charge.monthlyAmount;
    entry.paid += paidMonthly(charge);
    if (charge.planName) entry.plans.push(charge.planName);
    revenue.set(charge.shopId, entry);
  }

  const appSql = appIds.length > 0 ? `AND app_id IN (${appIds.map(() => '?').join(', ')})` : '';
  const trialing = new Set(
    (
      db
        .prepare(
          `SELECT DISTINCT shop_id AS shopId FROM subscriptions
            WHERE is_test = 0 AND trial_status = 'in_trial' AND churn_at IS NULL ${appSql}`,
        )
        .all(...appIds) as Array<{ shopId: string }>
    ).map((row) => row.shopId),
  );
  const installed = new Set(
    (
      db
        .prepare(`SELECT DISTINCT shop_id AS shopId FROM install_intervals WHERE ended_at IS NULL ${appSql}`)
        .all(...appIds) as Array<{ shopId: string }>
    ).map((row) => row.shopId),
  );

  const usageRows = db
    .prepare(
      `SELECT domain, SUM(generations) AS generations FROM shop_usage_daily
        WHERE day >= ? AND day <= ? GROUP BY domain`,
    )
    .all(from, to) as Array<{ domain: string; generations: number }>;
  const usage = new Map(usageRows.map((row) => [row.domain.toLowerCase(), row.generations]));

  // Credit packs are one-time purchases, so they are never MRR — but they are
  // money a shop paid for usage in this window, and the heavy users on small
  // plans are exactly the ones who buy them. Same window as the usage.
  const creditRows = db
    .prepare(
      `SELECT shop_id AS shopId, SUM(gross_amount) AS amount FROM transactions
        WHERE type = 'AppOneTimeSale' AND created_at >= ? AND created_at < ? ${appSql}
        GROUP BY shop_id`,
    )
    .all(`${from}T00:00:00.000Z`, utcDay(now) + 'T00:00:00.000Z', ...appIds) as Array<{ shopId: string; amount: number }>;
  const credits = new Map(creditRows.map((row) => [row.shopId, row.amount]));

  // Everyone who is a customer today, or cost something in the window.
  type Key = { shop: ShopRow | null; domain: string };
  const population = new Map<string, Key>();
  for (const shopId of new Set([...revenue.keys(), ...credits.keys(), ...trialing, ...installed])) {
    const shop = shopById.get(shopId);
    const domain = (shop?.domain ?? shopId).toLowerCase();
    population.set(domain, { shop: shop ?? null, domain });
  }
  for (const domain of usage.keys()) {
    if (!population.has(domain)) population.set(domain, { shop: shopByDomain.get(domain) ?? null, domain });
  }

  let excluded = 0;
  const rows: Omit<MultiplierCustomer, 'rank' | 'cumulativeProfit'>[] = [];
  for (const { shop, domain } of population.values()) {
    if (isExcluded(domain, settings.excludedDomains)) {
      excluded += 1;
      continue;
    }
    const money = shop ? revenue.get(shop.id) : undefined;
    const generations = usage.get(domain) ?? 0;
    const status: MultiplierStatus = !shop
      ? 'unmatched'
      : money
        ? 'paying'
        : trialing.has(shop.id)
          ? 'trialing'
          : installed.has(shop.id)
            ? 'free'
            : 'uninstalled';
    const paidMrr = money?.paid ?? 0;
    const listMrr = money?.list ?? 0;
    const usageCost = generations * settings.costPerGeneration;
    const fixedCost = status === 'paying' ? settings.costPerPayingShop : 0;
    const cost = usageCost + fixedCost;
    const credit = shop ? credits.get(shop.id) ?? 0 : 0;
    const income = paidMrr + credit;
    const profit = income - cost;
    const plan = money?.plans[0] ?? null;

    rows.push({
      shopId: shop?.id ?? null,
      name: shop?.name ?? null,
      domain,
      status,
      plan,
      tier: plan ? tierOf(plan) : null,
      listMrr: round(listMrr),
      paidMrr: round(paidMrr),
      discounted: paidMrr < listMrr * 0.95,
      credits: round(credit),
      revenue: round(income),
      generations,
      usageCost: round(usageCost),
      fixedCost: round(fixedCost),
      cost: round(cost),
      profit: round(profit),
      margin: income > 0 ? round(profit / income, 3) : null,
      revenuePerGeneration: generations > 0 ? round(income / generations, 4) : null,
    });
  }

  const { customers, whale } = rankCustomers(rows);

  // Ceilings come from the Partner API alone and cover every paying shop.
  const listMrr = charges.reduce((sum, charge) => sum + charge.monthlyAmount, 0);
  const paidMrr = charges.reduce((sum, charge) => sum + paidMonthly(charge), 0);
  const { overall, history, baseMrr } = overallCeilings(db, asOf, now, reporting.byShop);
  const tiers = tierCeilings(db, asOf, now);

  const payingByTier = new Map<string, MultiplierCustomer[]>();
  for (const customer of customers) {
    if (customer.status !== 'paying' || !customer.tier) continue;
    payingByTier.set(customer.tier, [...(payingByTier.get(customer.tier) ?? []), customer]);
  }
  const mean = (values: number[]) =>
    values.length > 0 ? round(values.reduce((a, b) => a + b, 0) / values.length) : null;

  const tierList: Ceiling[] = [...tiers.values()]
    .map((tier) => {
      const paying = payingByTier.get(tier.key) ?? [];
      return {
        ...tier,
        paidMrr: round(
          charges
            .filter((charge) => tierOf(charge.planName) === tier.key)
            .reduce((sum, charge) => sum + paidMonthly(charge), 0),
        ),
        generationsPerShop: mean(paying.map((row) => row.generations)),
        profitPerShop: mean(paying.map((row) => row.profit)),
      };
    })
    .sort((a, b) => (a.priceRange?.[0] ?? 0) - (b.priceRange?.[0] ?? 0));

  const syncState = readSyncState(db, 'mixpanel:usage');
  const latest = db.prepare('SELECT MAX(day) AS day FROM shop_usage_daily').get() as { day: string | null };
  const counted = [...usage].filter(([domain]) => !isExcluded(domain, settings.excludedDomains));

  return {
    generatedAt: now.toISOString(),
    currency: currencyProfile(db, appIds).currency,
    window: { from, to, days: WINDOW_DAYS },
    settings,
    usage: {
      connected: readConnection(db) !== null,
      lastSyncedThrough: syncState.syncedThrough,
      latestDay: latest.day,
      shopsWithUsage: counted.length,
      generations: counted.reduce((sum, [, generations]) => sum + generations, 0),
      unmatchedDomains: counted
        .map(([domain]) => domain)
        .filter((domain) => !shopByDomain.has(domain))
        .sort(),
    },
    excluded,
    whale,
    customers,
    ceiling: {
      months: CEILING_MONTHS,
      overall: {
        ...overall,
        paidMrr: round(paidMrr),
        generationsPerShop: mean(customers.filter((row) => row.status === 'paying').map((row) => row.generations)),
        profitPerShop: mean(customers.filter((row) => row.status === 'paying').map((row) => row.profit)),
      },
      revenue: revenueCeiling(db, appIds, now, baseMrr, listMrr, paidMrr),
      tiers: tierList,
      history,
    },
  };
}
