import { getConfig } from '../config.js';
import type { Db } from '../db/index.js';
import { buildCustomerEvents } from './events.js';
import { buildReviewEvents } from '../appstore/events.js';
import { matchReviewsToShops } from '../appstore/match.js';

/**
 * Write-time normalization (spec 1.5). The Partner API hands back a stream of
 * lifecycle events and a stream of money; neither is queryable as "state at a
 * date". This module collapses both into two derived tables whose columns are
 * already normalized, so every read-time query is sums and date comparisons.
 *
 * Rebuilt wholesale after each sync. A full rebuild over a Partner-API-sized
 * dataset is seconds, and it means a late-arriving correction flows into all of
 * history automatically rather than needing a patch path.
 */

/**
 * Transactions recorded before this date carry no chargeId, so a subscription
 * that activated earlier cannot be matched to its first payment. Those fall
 * back to their activation date as the MRR gate.
 */
const CHARGE_ID_AVAILABLE_FROM = '2020-09-01T00:00:00.000Z';

const MS_PER_DAY = 86_400_000;

/**
 * Partner transactions carry the date they were *recorded* into a payout batch,
 * not the date the merchant was charged, and payouts run twice a month. A final
 * sale landing days after a cancellation is therefore normal settlement lag, not
 * evidence the subscription is still alive. Only billing beyond this window
 * proves a charge outlived an event.
 */
const SETTLEMENT_LAG_DAYS = 21;

const CANCEL_TYPES = [
  'SUBSCRIPTION_CHARGE_CANCELED',
  'SUBSCRIPTION_CHARGE_EXPIRED',
  'SUBSCRIPTION_CHARGE_DECLINED',
];

const INSTALL_TYPES = ['RELATIONSHIP_INSTALLED', 'RELATIONSHIP_REACTIVATED'];
const UNINSTALL_TYPES = ['RELATIONSHIP_UNINSTALLED', 'RELATIONSHIP_DEACTIVATED'];

/**
 * Cadence -> monthly (spec 1.5). Shopify bills app subscriptions either every
 * 30 days or annually; the 30-day cycle passes through untouched by convention
 * rather than being scaled by 365/30.
 */
export function monthlyAmountFor(amount: number, billingInterval: string): number {
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return billingInterval === 'ANNUAL' ? amount / 12 : amount;
}

interface ChargeRow {
  charge_id: string;
  app_id: string;
  shop_id: string;
  plan_name: string | null;
  amount: number | null;
  currency: string | null;
  is_test: number;
  accepted_at: string | null;
  activated_at: string | null;
  canceled_at: string | null;
  frozen_at: string | null;
  unfrozen_at: string | null;
  billing_on: string | null;
}

interface SaleRow {
  charge_ref: string;
  first_sale_at: string;
  last_sale_at: string;
  paid_sale_count: number;
  billing_interval: string | null;
}

function daysBetween(from: string, to: string): number {
  return (new Date(to).getTime() - new Date(from).getTime()) / MS_PER_DAY;
}

function buildSubscriptions(db: Db, now: string): number {
  const { reporting } = getConfig();

  const charges = db
    .prepare(
      `SELECT
         charge_id,
         MIN(app_id) AS app_id,
         MAX(shop_id) AS shop_id,
         COALESCE(
           MAX(CASE WHEN type = 'SUBSCRIPTION_CHARGE_ACTIVATED' THEN charge_name END),
           MAX(charge_name)
         ) AS plan_name,
         COALESCE(
           MAX(CASE WHEN type = 'SUBSCRIPTION_CHARGE_ACTIVATED' THEN charge_amount END),
           MAX(charge_amount)
         ) AS amount,
         MAX(charge_currency) AS currency,
         MAX(charge_test) AS is_test,
         MIN(CASE WHEN type = 'SUBSCRIPTION_CHARGE_ACCEPTED' THEN occurred_at END) AS accepted_at,
         MIN(CASE WHEN type = 'SUBSCRIPTION_CHARGE_ACTIVATED' THEN occurred_at END) AS activated_at,
         MIN(CASE WHEN type IN (${CANCEL_TYPES.map(() => '?').join(',')}) THEN occurred_at END) AS canceled_at,
         MAX(CASE WHEN type = 'SUBSCRIPTION_CHARGE_FROZEN' THEN occurred_at END) AS frozen_at,
         MAX(CASE WHEN type = 'SUBSCRIPTION_CHARGE_UNFROZEN' THEN occurred_at END) AS unfrozen_at,
         COALESCE(
           MAX(CASE WHEN type = 'SUBSCRIPTION_CHARGE_ACTIVATED' THEN billing_on END),
           MAX(billing_on)
         ) AS billing_on
       FROM app_events
       WHERE charge_id <> '' AND type LIKE 'SUBSCRIPTION_CHARGE_%'
       GROUP BY charge_id`,
    )
    .all(...CANCEL_TYPES) as ChargeRow[];

  const sales = db
    .prepare(
      `SELECT charge_ref,
              MIN(created_at) AS first_sale_at,
              MAX(created_at) AS last_sale_at,
              COUNT(*) AS paid_sale_count,
              MAX(billing_interval) AS billing_interval
       FROM transactions
       WHERE type = 'AppSubscriptionSale' AND charge_ref <> '' AND gross_amount > 0
       GROUP BY charge_ref`,
    )
    .all() as SaleRow[];

  const salesByRef = new Map(sales.map((row) => [row.charge_ref, row]));

  /**
   * The uninstall a shop has *not* come back from, per app+shop: the latest
   * uninstall with no later install or reactivation.
   *
   * Only this final uninstall may end a subscription. Merchants routinely
   * uninstall and reinstall while their charge keeps billing, so treating any
   * uninstall as churn silently kills long-running paying customers. A genuine
   * mid-history cancellation still arrives as its own
   * SUBSCRIPTION_CHARGE_CANCELED event and is handled above.
   *
   * Read straight from the events rather than from install_intervals, so an
   * uninstall whose matching install predates SYNC_START_DATE still counts.
   */
  const finalUninstall = new Map<string, string>();
  if (reporting.churnOnUninstall) {
    const rows = db
      .prepare(
        `SELECT u.app_id AS app_id, u.shop_id AS shop_id, MAX(u.occurred_at) AS ended_at
         FROM app_events u
         WHERE u.type IN (${UNINSTALL_TYPES.map(() => '?').join(',')}) AND u.shop_id <> ''
         GROUP BY u.app_id, u.shop_id
         HAVING MAX(u.occurred_at) > COALESCE((
           SELECT MAX(i.occurred_at) FROM app_events i
           WHERE i.app_id = u.app_id AND i.shop_id = u.shop_id
             AND i.type IN (${INSTALL_TYPES.map(() => '?').join(',')})
         ), '')`,
      )
      .all(...UNINSTALL_TYPES, ...INSTALL_TYPES) as Array<{
      app_id: string;
      shop_id: string;
      ended_at: string;
    }>;
    for (const row of rows) {
      finalUninstall.set(`${row.app_id} ${row.shop_id}`, row.ended_at);
    }
  }

  interface Derived extends ChargeRow {
    charge_ref: string;
    billing_interval: string;
    monthly_amount: number;
    conversion_at: string | null;
    churn_at: string | null;
    churn_reason: string | null;
    trial_started_at: string | null;
    trial_ends_at: string | null;
    trial_status: string;
    is_plan_change: number;
    paid_sale_count: number;
    first_sale_at: string | null;
    last_sale_at: string | null;
  }

  // Sibling charges per shop+app, so a charge can tell whether it continues an
  // existing relationship or starts a new one.
  const siblings = new Map<string, ChargeRow[]>();
  for (const charge of charges) {
    const key = `${charge.app_id} ${charge.shop_id}`;
    const list = siblings.get(key);
    if (list) list.push(charge);
    else siblings.set(key, [charge]);
  }

  const derived: Derived[] = [];

  for (const charge of charges) {
    const chargeRef = charge.charge_id.split('/').pop() ?? '';
    const sale = salesByRef.get(chargeRef);
    const amount = charge.amount ?? 0;
    const billingInterval = sale?.billing_interval ?? 'EVERY_30_DAYS';
    const activatedAt = charge.activated_at;

    // Churn: an explicit cancel, or the merchant walking away entirely.
    let churnAt = charge.canceled_at;
    let churnReason: string | null = churnAt ? 'canceled' : null;
    if (reporting.churnOnUninstall && activatedAt) {
      const goneAt = finalUninstall.get(`${charge.app_id} ${charge.shop_id}`);
      // Billing that continued past the uninstall means the charge outlived it
      // (the merchant reinstalled, or event ordering is noisy), so the uninstall
      // is not what ended this subscription.
      const outlivedByBilling = Boolean(
        sale && goneAt && daysBetween(goneAt, sale.last_sale_at) > SETTLEMENT_LAG_DAYS,
      );
      if (goneAt && goneAt > activatedAt && !outlivedByBilling && (!churnAt || goneAt < churnAt)) {
        churnAt = goneAt;
        churnReason = 'uninstalled';
      }
    }

    /**
     * `billing_on` is the charge's *next* billing date, which means two very
     * different things and must not be read as "trial ends here":
     *
     *  - on a fresh trial it is the trial end, a part-cycle away;
     *  - on a charge that was billed at activation it is a full cycle away;
     *  - on a mid-cycle plan change it is whatever remained of the cycle the
     *    merchant already paid for.
     *
     * Only the first is a trial. The other two are paying customers, and
     * treating them as trials understates paying shops and MRR.
     */
    // `billing_on` is a calendar date at midnight while activation carries a
    // time of day, so a full cycle measures slightly short of its nominal
    // length. One day of tolerance absorbs that; real trials sit far below it.
    const cycleDays = (billingInterval === 'ANNUAL' ? 365 : 30) - 1;
    const billingGapDays =
      activatedAt && charge.billing_on ? daysBetween(activatedAt, charge.billing_on) : null;

    // A charge that replaces one which ended at the same moment continues an
    // existing relationship rather than starting a trial.
    const continuesPriorCharge = Boolean(
      activatedAt &&
        (siblings.get(`${charge.app_id} ${charge.shop_id}`) ?? []).some(
          (other) =>
            other.charge_id !== charge.charge_id &&
            other.canceled_at !== null &&
            Math.abs(new Date(other.canceled_at).getTime() - new Date(activatedAt).getTime()) <=
              reporting.planChangeWindowDays * MS_PER_DAY,
        ),
    );

    const billedAtActivation =
      !churnAt &&
      Boolean(activatedAt) &&
      (continuesPriorCharge || (billingGapDays !== null && billingGapDays >= cycleDays));

    // The MRR gate is the first real payment, not activation: a subscription in
    // trial is live but worth nothing.
    let conversionAt: string | null;
    if (amount <= 0) {
      conversionAt = activatedAt;
    } else if (sale) {
      conversionAt = sale.first_sale_at;
    } else if (activatedAt && activatedAt < CHARGE_ID_AVAILABLE_FROM) {
      conversionAt = activatedAt;
    } else if (billedAtActivation) {
      conversionAt = activatedAt;
    } else if (charge.billing_on && charge.billing_on <= now && !churnAt) {
      // The billing date passed with no cancellation, so the merchant was
      // charged; the transaction simply has not settled into the payout feed
      // yet. Without this, every shop that converted in the last couple of
      // weeks reads as unpaid.
      conversionAt = charge.billing_on;
    } else {
      conversionAt = null;
    }

    let trialStatus = 'none';
    let trialEndsAt: string | null = null;
    if (amount > 0 && activatedAt) {
      if (sale) {
        if (daysBetween(activatedAt, sale.first_sale_at) > reporting.trialMinGapDays) {
          trialStatus = 'converted';
          trialEndsAt = sale.first_sale_at;
        }
      } else if (churnAt) {
        trialStatus = 'canceled';
        trialEndsAt = charge.billing_on ?? churnAt;
      } else if (billedAtActivation) {
        // Paid up front or mid-cycle on a plan change; never trialling.
        trialStatus = 'none';
      } else if (charge.billing_on && charge.billing_on > now) {
        trialStatus = 'in_trial';
        trialEndsAt = charge.billing_on;
      } else if (charge.billing_on) {
        // Past its billing date with no cancellation: it converted, and the
        // transaction is still in flight (see SETTLEMENT_LAG_DAYS).
        trialStatus =
          daysBetween(activatedAt, charge.billing_on) > reporting.trialMinGapDays
            ? 'converted'
            : 'none';
        trialEndsAt = charge.billing_on;
      } else {
        // Activated, never billed, never cancelled, and no billing date to go
        // on: a genuine data gap rather than a trial outcome.
        trialStatus = 'unknown';
      }
    }

    derived.push({
      ...charge,
      charge_ref: chargeRef,
      billing_interval: billingInterval,
      monthly_amount: monthlyAmountFor(amount, billingInterval),
      conversion_at: conversionAt,
      churn_at: churnAt,
      churn_reason: churnReason,
      trial_started_at: trialStatus === 'none' ? null : activatedAt,
      trial_ends_at: trialEndsAt,
      trial_status: trialStatus,
      is_plan_change: 0,
      paid_sale_count: sale?.paid_sale_count ?? 0,
      first_sale_at: sale?.first_sale_at ?? null,
      last_sale_at: sale?.last_sale_at ?? null,
    });
  }

  // A cancel immediately followed by a new charge on the same shop is an
  // upgrade or downgrade, not churn. Shopify models plan changes as a new
  // subscription, so without this every upgrade would read as a lost customer.
  const activationsByShop = new Map<string, string[]>();
  for (const row of derived) {
    if (!row.activated_at) continue;
    const key = `${row.app_id} ${row.shop_id}`;
    const list = activationsByShop.get(key);
    if (list) list.push(row.activated_at);
    else activationsByShop.set(key, [row.activated_at]);
  }

  const windowMs = reporting.planChangeWindowDays * MS_PER_DAY;
  for (const row of derived) {
    if (!row.churn_at) continue;
    const key = `${row.app_id} ${row.shop_id}`;
    const churnMs = new Date(row.churn_at).getTime();
    const replaced = (activationsByShop.get(key) ?? []).some((at) => {
      if (at === row.activated_at) return false;
      const delta = Math.abs(new Date(at).getTime() - churnMs);
      return delta <= windowMs;
    });
    if (replaced) {
      row.is_plan_change = 1;
      row.churn_reason = 'plan_change';
    }
  }

  const statement = db.prepare(
    `INSERT INTO subscriptions (
       charge_id, charge_ref, app_id, shop_id, plan_name, amount, currency,
       billing_interval, monthly_amount, is_test, accepted_at, activated_at,
       conversion_at, churn_at, churn_reason, frozen_at, unfrozen_at,
       trial_started_at, trial_ends_at, trial_status, is_plan_change,
       paid_sale_count, first_sale_at, last_sale_at
     ) VALUES (
       @charge_id, @charge_ref, @app_id, @shop_id, @plan_name, @amount, @currency,
       @billing_interval, @monthly_amount, @is_test, @accepted_at, @activated_at,
       @conversion_at, @churn_at, @churn_reason, @frozen_at, @unfrozen_at,
       @trial_started_at, @trial_ends_at, @trial_status, @is_plan_change,
       @paid_sale_count, @first_sale_at, @last_sale_at
     )`,
  );

  const write = db.transaction((rows: Derived[]) => {
    db.prepare('DELETE FROM subscriptions').run();
    for (const row of rows) {
      statement.run({
        charge_id: row.charge_id,
        charge_ref: row.charge_ref,
        app_id: row.app_id,
        shop_id: row.shop_id,
        plan_name: row.plan_name,
        amount: row.amount ?? 0,
        currency: row.currency,
        billing_interval: row.billing_interval,
        monthly_amount: row.monthly_amount,
        is_test: row.is_test ? 1 : 0,
        accepted_at: row.accepted_at,
        activated_at: row.activated_at,
        conversion_at: row.conversion_at,
        churn_at: row.churn_at,
        churn_reason: row.churn_reason,
        frozen_at: row.frozen_at,
        unfrozen_at: row.unfrozen_at,
        trial_started_at: row.trial_started_at,
        trial_ends_at: row.trial_ends_at,
        trial_status: row.trial_status,
        is_plan_change: row.is_plan_change,
        paid_sale_count: row.paid_sale_count,
        first_sale_at: row.first_sale_at,
        last_sale_at: row.last_sale_at,
      });
    }
  });

  write(derived);
  return derived.length;
}

function buildInstallIntervals(db: Db): number {
  const rows = db
    .prepare(
      `SELECT app_id, shop_id, type, occurred_at
       FROM app_events
       WHERE type IN (${[...INSTALL_TYPES, ...UNINSTALL_TYPES].map(() => '?').join(',')})
         AND shop_id <> ''
       ORDER BY app_id, shop_id, occurred_at`,
    )
    .all(...INSTALL_TYPES, ...UNINSTALL_TYPES) as Array<{
    app_id: string;
    shop_id: string;
    type: string;
    occurred_at: string;
  }>;

  interface Interval {
    app_id: string;
    shop_id: string;
    started_at: string;
    ended_at: string | null;
  }

  const intervals: Interval[] = [];
  let open: Interval | null = null;
  let currentKey = '';

  for (const row of rows) {
    const key = `${row.app_id} ${row.shop_id}`;
    if (key !== currentKey) {
      if (open) intervals.push(open);
      open = null;
      currentKey = key;
    }

    if (INSTALL_TYPES.includes(row.type)) {
      // Repeat installs without an intervening uninstall keep the first start.
      if (!open) open = { app_id: row.app_id, shop_id: row.shop_id, started_at: row.occurred_at, ended_at: null };
    } else if (open) {
      open.ended_at = row.occurred_at;
      intervals.push(open);
      open = null;
    }
    // An uninstall with no open interval means the install predates
    // SYNC_START_DATE; there is no start to attribute, so it is dropped.
  }
  if (open) intervals.push(open);

  const statement = db.prepare(
    `INSERT INTO install_intervals (app_id, shop_id, started_at, ended_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(app_id, shop_id, started_at) DO UPDATE SET ended_at = excluded.ended_at`,
  );

  const write = db.transaction((batch: Interval[]) => {
    db.prepare('DELETE FROM install_intervals').run();
    for (const interval of batch) {
      statement.run(interval.app_id, interval.shop_id, interval.started_at, interval.ended_at);
    }
  });

  write(intervals);
  return intervals.length;
}

export function rebuildDerivedTables(db: Db): {
  subscriptions: number;
  installs: number;
  customerEvents: number;
  reviewEvents: number;
} {
  const now = new Date().toISOString();
  const subscriptions = buildSubscriptions(db, now);
  const installs = buildInstallIntervals(db);
  // Strictly after the subscription index: the lifecycle compiler reads it as
  // the authority on normalized money and on which cancels were plan changes.
  const customerEvents = buildCustomerEvents(db);

  // Reviews come last, and in this order for two reasons: the matcher searches
  // shops that installed the app, which `install_intervals` has only just
  // finished rebuilding, and `buildCustomerEvents` clears the table these are
  // then appended to.
  matchReviewsToShops(db);
  const reviewEvents = buildReviewEvents(db);

  db.prepare('DELETE FROM metric_cache').run();
  return { subscriptions, installs, customerEvents, reviewEvents };
}
