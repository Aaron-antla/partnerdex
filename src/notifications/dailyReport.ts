import { getConfig } from '../config.js';
import type { Db } from '../db/index.js';
import { runMetric } from '../metrics/registry.js';
import type { MetricResponse } from '../metrics/response.js';
import { addInterval, instantFromWallClock, wallClockIn } from '../metrics/time.js';
import { resolveScopedAppIds } from '../sync/index.js';
import {
  attributeMrrChange,
  mrrLinesAt,
  type MrrAttribution,
  type MrrCause,
  type MrrLine,
} from './mrrMovement.js';
import { narrateMrrChange } from './narrate.js';
import { formatMoney, type SlackMessage } from './slack.js';

export interface DailyLevel {
  value: number;
  /** Vs the previous day's report: as posted when stored, else recomputed. */
  change: number;
}

/** Why MRR moved since the previous report, shown under the figures. */
export interface MrrWhy {
  previous: number;
  /** The model's sentence, already checked against the attribution. Null without one. */
  summary: string | null;
  /** One line per cause, straight from the attribution. */
  lines: string[];
  /** Corrections to the posted figure from late Shopify data. */
  corrections: string[];
}

export interface DailySnapshot {
  /** Calendar day being reported, YYYY-MM-DD in the daily-report timezone. */
  reportDate: string;
  currency: string | null;
  mrr: DailyLevel;
  activeUsers: DailyLevel;
  activeSubscriptions: DailyLevel;
  grossPayments: DailyLevel;
  arpu: DailyLevel;
  /** Decisions that occurred on reportDate, not the cohort of trials that started that day. */
  trialConversions: { converted: number; decided: number };
  /**
   * What the changes are measured against: the previous report as it was
   * posted, or — when none was stored — the previous day rebuilt from today's
   * data, which silently absorbs anything Shopify backdated since.
   */
  baseline: 'posted' | 'recomputed';
  mrrWhy: MrrWhy | null;
}

/** A snapshot plus what it takes to store it as the next day's baseline. */
export interface DailyReport {
  snapshot: DailySnapshot;
  asOf: Date;
  mrrLines: MrrLine[];
  attribution: MrrAttribution;
}

export interface DailyReportSlot {
  reportDate: string;
  start: Date;
  end: Date;
}

function ymd(instant: Date, timeZone: string): string {
  const wall = wallClockIn(instant, timeZone);
  return [wall.year, wall.month, wall.day]
    .map((part, index) => (index === 0 ? String(part) : String(part).padStart(2, '0')))
    .join('-');
}

function startOfDay(instant: Date, timeZone: string): Date {
  const wall = wallClockIn(instant, timeZone);
  return instantFromWallClock({ ...wall, hour: 0, minute: 0, second: 0 }, timeZone);
}

/**
 * Which Israel-local (by default) day the digest is for, and the half-open
 * window metrics should read.
 *
 * From 18:00 local onward that is *today*, as-of now, so an evening send is a
 * wrap of the day that is ending. Before 18:00 it is yesterday, cut at 18:00,
 * so a sync that missed last night still has one message to catch up and does
 * not invent a morning report of a day that has not closed.
 */
export function dueDailyReport(
  now: Date,
  options: { timeZone?: string; hour?: number } = {},
): DailyReportSlot {
  const { runtime } = getConfig();
  const timeZone = options.timeZone ?? runtime.dailyReportTimeZone;
  const hour = options.hour ?? runtime.dailyReportHour;
  const wall = wallClockIn(now, timeZone);
  const todayStart = startOfDay(now, timeZone);

  if (wall.hour >= hour) {
    return { reportDate: ymd(now, timeZone), start: todayStart, end: now };
  }

  const yesterdayStart = addInterval(todayStart, 'day', -1, timeZone);
  const yesterdayWall = wallClockIn(yesterdayStart, timeZone);
  const yesterdayClose = instantFromWallClock(
    { ...yesterdayWall, hour, minute: 0, second: 0 },
    timeZone,
  );
  return {
    reportDate: ymd(yesterdayStart, timeZone),
    start: yesterdayStart,
    end: yesterdayClose,
  };
}

function customQuery(start: Date, end: Date) {
  return {
    period: 'custom',
    start: start.toISOString(),
    end: end.toISOString(),
    interval: 'day',
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function level(current: MetricResponse, previous: number): DailyLevel {
  return {
    value: current.value,
    change: round(current.value - previous),
  };
}

interface Posted {
  snapshot: DailySnapshot;
  asOf: Date;
  lines: MrrLine[];
}

function readPosted(db: Db, reportDate: string): Posted | null {
  const row = db
    .prepare('SELECT snapshot, as_of FROM daily_report_snapshots WHERE report_date = ?')
    .get(reportDate) as { snapshot: string; as_of: string } | undefined;
  if (!row) return null;
  const lines = db
    .prepare(
      `SELECT line_key AS key, app_id AS appId, shop_id AS shopId, plan_name AS planName, amount
       FROM daily_report_mrr_lines WHERE report_date = ?`,
    )
    .all(reportDate) as MrrLine[];
  return { snapshot: JSON.parse(row.snapshot) as DailySnapshot, asOf: new Date(row.as_of), lines };
}

/** The message already posted for `reportDate`, so every channel gets the same one. */
export function readPostedSnapshot(db: Db, reportDate: string): DailySnapshot | null {
  return readPosted(db, reportDate)?.snapshot ?? null;
}

/** Lines are only read back by the next day's report; a week covers a missed send. */
const LINE_RETENTION_DAYS = 7;

/**
 * Keep the report as posted, so tomorrow's changes are measured against what
 * the channel was told. The first post of a day wins.
 */
export function recordPostedReport(db: Db, report: DailyReport, postedAt: Date): void {
  const { reportDate } = report.snapshot;
  db.transaction(() => {
    const inserted = db
      .prepare(
        `INSERT OR IGNORE INTO daily_report_snapshots (report_date, as_of, snapshot, posted_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(reportDate, report.asOf.toISOString(), JSON.stringify(report.snapshot), postedAt.toISOString());
    if (inserted.changes === 0) return;
    const insertLine = db.prepare(
      `INSERT INTO daily_report_mrr_lines (report_date, line_key, app_id, shop_id, plan_name, amount)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const line of report.mrrLines) {
      insertLine.run(reportDate, line.key, line.appId, line.shopId, line.planName, line.amount);
    }
    const cutoff = new Date(`${reportDate}T00:00:00Z`);
    cutoff.setUTCDate(cutoff.getUTCDate() - LINE_RETENTION_DAYS);
    db.prepare('DELETE FROM daily_report_mrr_lines WHERE report_date < ?').run(
      cutoff.toISOString().slice(0, 10),
    );
  })();
}

export function collectDailySnapshot(db: Db, now: Date): DailyReport {
  const timeZone = getConfig().runtime.dailyReportTimeZone;
  const slot = dueDailyReport(now);
  const previousStart = addInterval(slot.start, 'day', -1, timeZone);
  const previousEnd = addInterval(slot.end, 'day', -1, timeZone);
  const posted = readPosted(db, ymd(previousStart, timeZone));

  const currentQuery = customQuery(slot.start, slot.end);
  const previousQuery = customQuery(previousStart, previousEnd);
  const currentOpts = { now };
  const previousOpts = { now: previousEnd };

  const metric = (key: string, query: ReturnType<typeof customQuery>, options: { now: Date }) =>
    runMetric(key, query, options);

  /** Yesterday's figure as posted, or rebuilt from today's data when nothing was stored. */
  const previous = (key: string, pick: (snapshot: DailySnapshot) => DailyLevel): number =>
    posted ? pick(posted.snapshot).value : metric(key, previousQuery, previousOpts).value;

  const mrr = metric('mrr', currentQuery, currentOpts);
  const activeUsers = metric('active_installs', currentQuery, currentOpts);
  const activeSubscriptions = metric('active_subscriptions', currentQuery, currentOpts);
  const grossPayments = metric('gross_earnings', currentQuery, currentOpts);
  const arpu = metric('arpu', currentQuery, currentOpts);

  const appIds = resolveScopedAppIds(db);
  const appFilter =
    appIds.length === 0 ? '' : `AND app_id IN (${appIds.map(() => '?').join(', ')})`;

  const decisions = db
    .prepare(
      `SELECT
         SUM(CASE WHEN type = 'trial_converted' THEN 1 ELSE 0 END) AS converted,
         COUNT(*) AS decided
       FROM customer_events
       WHERE suppressed = 0
         AND occurred_at >= ?
         AND occurred_at < ?
         AND type IN ('trial_converted', 'trial_abandoned', 'trial_expired')
         ${appFilter}`,
    )
    .get(slot.start.toISOString(), slot.end.toISOString(), ...appIds) as {
      converted: number | null;
      decided: number;
    };

  const money = (value: number) => formatMoney(value, mrr.currency);
  const mrrLines = mrrLinesAt(db, slot.end);
  const previousMrr = previous('mrr', (snapshot) => snapshot.mrr);
  const attribution = attributeMrrChange(db, {
    previous: { asOf: posted?.asOf ?? previousEnd, value: previousMrr, lines: posted?.lines ?? null },
    current: { asOf: slot.end, value: mrr.value, lines: mrrLines },
    money,
  });

  const snapshot: DailySnapshot = {
    reportDate: slot.reportDate,
    currency: mrr.currency,
    mrr: level(mrr, previousMrr),
    activeUsers: level(activeUsers, previous('active_installs', (s) => s.activeUsers)),
    activeSubscriptions: level(
      activeSubscriptions,
      previous('active_subscriptions', (s) => s.activeSubscriptions),
    ),
    grossPayments: level(grossPayments, previous('gross_earnings', (s) => s.grossPayments)),
    arpu: level(arpu, previous('arpu', (s) => s.arpu)),
    trialConversions: {
      converted: decisions.converted ?? 0,
      decided: decisions.decided,
    },
    baseline: attribution.baseline,
    mrrWhy: describeMrrChange(attribution, money),
  };

  return { snapshot, asOf: slot.end, mrrLines, attribution };
}

/** The snapshot, with the model's sentence on top of the facts when it has one. */
export async function prepareDailyReport(db: Db, now: Date): Promise<DailyReport> {
  const report = collectDailySnapshot(db, now);
  if (report.snapshot.mrrWhy) {
    report.snapshot.mrrWhy.summary = await narrateMrrChange(
      report.attribution,
      report.snapshot.currency,
    );
  }
  return report;
}

const CAUSE_LABELS: Record<MrrCause, [string, string]> = {
  new_paid: ['new paid subscription', 'new paid subscriptions'],
  plan_change: ['plan change', 'plan changes'],
  canceled: ['cancellation', 'cancellations'],
  uninstalled: ['uninstall', 'uninstalls'],
  store_closed: ['store closed', 'stores closed'],
  frozen: ['charge frozen by Shopify', 'charges frozen by Shopify'],
  unfrozen: ['charge unfrozen', 'charges unfrozen'],
  not_collected: ['payment no longer counted', 'payments no longer counted'],
  usage: ['usage change', 'usage changes'],
  price_corrected: ['price correction', 'price corrections'],
  other: ['other change', 'other changes'],
};

/** Losses where "never paid" is the point worth saying. */
const LOSSES = new Set<MrrCause>(['frozen', 'canceled', 'uninstalled', 'store_closed', 'not_collected']);

const SHOPS_PER_LINE = 3;

/** A residual this small is per-line rounding, not a shop the attribution missed. */
const ROUNDING = 0.05;

function signed(value: number, money: (value: number) => string): string {
  return `${value < 0 ? '−' : '+'}${money(Math.abs(value))}`;
}

function describeMrrChange(
  attribution: MrrAttribution,
  money: (value: number) => string,
): MrrWhy | null {
  const unexplained = Math.abs(attribution.unexplained) >= ROUNDING;
  if (attribution.items.length === 0 && !unexplained) return null;

  const render = (restated: boolean): string[] => {
    const groups = new Map<MrrCause, MrrAttribution['items']>();
    for (const item of attribution.items.filter((entry) => entry.restated === restated)) {
      groups.set(item.cause, [...(groups.get(item.cause) ?? []), item]);
    }
    return [...groups.entries()].map(([cause, items]) => {
      const total = round(items.reduce((sum, item) => sum + item.delta, 0));
      const [one, many] = CAUSE_LABELS[cause];
      const shops = items
        .slice(0, SHOPS_PER_LINE)
        .map((item) => `${item.shop} (${item.plan ? `${item.plan}, ` : ''}${signed(item.delta, money)})`);
      if (items.length > SHOPS_PER_LINE) shops.push(`${items.length - SHOPS_PER_LINE} more`);
      const neverPaid =
        LOSSES.has(cause) && items.every((item) => item.neverPaid)
          ? items.length === 1
            ? ' — never paid'
            : ' — none had ever paid'
          : '';
      return `${signed(total, money)} · ${items.length} ${items.length === 1 ? one : many}${neverPaid}: ${shops.join(', ')}`;
    });
  };

  const lines = render(false);
  if (unexplained) lines.push(`${signed(attribution.unexplained, money)} · not matched to a shop`);
  return {
    previous: attribution.previous,
    summary: null,
    lines,
    corrections: render(true),
  };
}

const count = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

function field(label: string, value: string): { type: 'mrkdwn'; text: string } {
  return { type: 'mrkdwn', text: `*${label}*\n${value}` };
}

function withChange(level: DailyLevel, format: (value: number) => string): string {
  const value = format(level.value);
  if (level.change === 0) return `${value} | ≡ No change`;
  const arrow = level.change > 0 ? '↑' : '↓';
  return `${value} | ${arrow} ${format(Math.abs(level.change))}`;
}

export function buildDailyReportMessage(snapshot: DailySnapshot): SlackMessage {
  const titleDate = new Intl.DateTimeFormat('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${snapshot.reportDate}T00:00:00Z`));
  const money = (value: number) => formatMoney(value, snapshot.currency);
  const conversionRate =
    snapshot.trialConversions.decided === 0
      ? 0
      : (snapshot.trialConversions.converted / snapshot.trialConversions.decided) * 100;

  return {
    text: `Daily report for ${titleDate}`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:printer: *Daily report for ${titleDate}*`,
        },
      },
      {
        type: 'section',
        fields: [
          field('MRR', withChange(snapshot.mrr, money)),
          field('Active users', withChange(snapshot.activeUsers, (value) => count.format(value))),
          field(
            'Active subscriptions',
            withChange(snapshot.activeSubscriptions, (value) => count.format(value)),
          ),
          field('Gross payments', withChange(snapshot.grossPayments, money)),
          field(
            'Trial conversions',
            `${count.format(snapshot.trialConversions.converted)}/${count.format(
              snapshot.trialConversions.decided,
            )} = ${conversionRate.toFixed(2)}%`,
          ),
          field('ARPU', withChange(snapshot.arpu, money)),
        ],
      },
      ...(snapshot.mrrWhy ? [whyBlock(snapshot.mrrWhy, snapshot.baseline, money)] : []),
    ],
  };
}

/** Slack caps a section's text at 3000 characters. */
const SECTION_LIMIT = 3000;

function whyBlock(why: MrrWhy, baseline: DailySnapshot['baseline'], money: (value: number) => string) {
  const against =
    baseline === 'posted'
      ? `vs ${money(why.previous)} posted yesterday`
      : `vs ${money(why.previous)}, yesterday as recomputed today`;
  const parts = [`*Why MRR moved* · ${against}`];
  if (why.summary) parts.push(why.summary);
  parts.push(...why.lines.map((line) => `• ${line}`));
  if (why.corrections.length > 0) {
    parts.push(
      "_Yesterday's posted figure was corrected by Shopify data that arrived after it was sent:_",
      ...why.corrections.map((line) => `• ${line}`),
    );
  }
  let text = parts.join('\n');
  if (text.length > SECTION_LIMIT) text = `${text.slice(0, SECTION_LIMIT - 1)}…`;
  return { type: 'section', text: { type: 'mrkdwn', text } };
}
