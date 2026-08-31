import { getConfig } from '../config.js';
import type { Db } from '../db/index.js';
import { runMetric } from '../metrics/registry.js';
import type { MetricResponse } from '../metrics/response.js';
import { addInterval, instantFromWallClock, wallClockIn } from '../metrics/time.js';
import { resolveScopedAppIds } from '../sync/index.js';
import { formatMoney, type SlackMessage } from './slack.js';

export interface DailyLevel {
  value: number;
  /** Vs the same clock window on the previous calendar day. */
  change: number;
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

function level(current: MetricResponse, previous: MetricResponse): DailyLevel {
  return {
    value: current.value,
    change: round(current.value - previous.value),
  };
}

export function collectDailySnapshot(db: Db, now: Date): DailySnapshot {
  const slot = dueDailyReport(now);
  const previousStart = addInterval(slot.start, 'day', -1, getConfig().runtime.dailyReportTimeZone);
  const previousEnd = addInterval(slot.end, 'day', -1, getConfig().runtime.dailyReportTimeZone);

  const currentQuery = customQuery(slot.start, slot.end);
  const previousQuery = customQuery(previousStart, previousEnd);
  const currentOpts = { now };
  const previousOpts = { now: previousEnd };

  const metric = (key: string, query: ReturnType<typeof customQuery>, options: { now: Date }) =>
    runMetric(key, query, options);

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

  return {
    reportDate: slot.reportDate,
    currency: mrr.currency,
    mrr: level(mrr, metric('mrr', previousQuery, previousOpts)),
    activeUsers: level(activeUsers, metric('active_installs', previousQuery, previousOpts)),
    activeSubscriptions: level(
      activeSubscriptions,
      metric('active_subscriptions', previousQuery, previousOpts),
    ),
    grossPayments: level(
      grossPayments,
      metric('gross_earnings', previousQuery, previousOpts),
    ),
    arpu: level(arpu, metric('arpu', previousQuery, previousOpts)),
    trialConversions: {
      converted: decisions.converted ?? 0,
      decided: decisions.decided,
    },
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
    ],
  };
}
