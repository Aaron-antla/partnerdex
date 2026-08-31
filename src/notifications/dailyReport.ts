import { getConfig } from '../config.js';
import type { Db } from '../db/index.js';
import { runMetric } from '../metrics/registry.js';
import type { MetricResponse } from '../metrics/response.js';
import { wallClockIn } from '../metrics/time.js';
import { resolveScopedAppIds } from '../sync/index.js';
import { formatMoney, type SlackMessage } from './slack.js';

export interface DailyLevel {
  value: number;
  /** Vs the previous calendar day. 0 when comparison is missing or unchanged. */
  change: number;
}

export interface DailySnapshot {
  /** Calendar day being reported, YYYY-MM-DD in REPORTING_TIMEZONE. */
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

const DAILY_QUERY = { period: 'yesterday', interval: 'day' };

function level(metric: MetricResponse): DailyLevel {
  return {
    value: metric.value,
    change: metric.comparison?.change ?? 0,
  };
}

function calendarDate(instant: string, timeZone: string): string {
  const wall = wallClockIn(new Date(instant), timeZone);
  return [wall.year, wall.month, wall.day]
    .map((part, index) => (index === 0 ? String(part) : String(part).padStart(2, '0')))
    .join('-');
}

export function collectDailySnapshot(db: Db, now: Date): DailySnapshot {
  const options = { now };
  const mrr = runMetric('mrr', DAILY_QUERY, options);
  const activeUsers = runMetric('active_installs', DAILY_QUERY, options);
  const activeSubscriptions = runMetric('active_subscriptions', DAILY_QUERY, options);
  const grossPayments = runMetric('gross_earnings', DAILY_QUERY, options);
  const arpu = runMetric('arpu', DAILY_QUERY, options);
  const reportDate = calendarDate(mrr.periodStart, getConfig().runtime.timezone);

  const appIds = resolveScopedAppIds(db);
  const appFilter =
    appIds.length === 0
      ? ''
      : `AND app_id IN (${appIds.map(() => '?').join(', ')})`;

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
    .get(mrr.periodStart, mrr.periodEnd, ...appIds) as {
      converted: number | null;
      decided: number;
    };

  return {
    reportDate,
    currency: mrr.currency,
    mrr: level(mrr),
    activeUsers: level(activeUsers),
    activeSubscriptions: level(activeSubscriptions),
    grossPayments: level(grossPayments),
    arpu: level(arpu),
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
