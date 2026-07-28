import { EVENT_PRESENTATION } from './topics.js';

/**
 * The Slack half: one lifecycle event rendered as a Block Kit message, and the
 * POST that delivers it.
 *
 * Everything here is a pure function of the event except `postToSlack`, which is
 * the only thing in this project that talks to a host the user chose. That
 * separation is what lets the message format be tested without a webhook.
 */

/** How long to wait on a webhook before calling it a failed attempt. */
const REQUEST_TIMEOUT_MS = 10_000;

export interface SubscriptionNotice {
  eventId: string;
  type: string;
  occurredAt: string;
  shopId: string;
  shopName: string | null;
  shopDomain: string | null;
  appId: string;
  appName: string | null;
  planName: string | null;
  /** The price as billed — 299 on an annual plan, not the normalized 24.92. */
  amount: number | null;
  billingInterval: string | null;
  currency: string | null;
  /** Signed monthly MRR delta, on the same gate MRR itself uses. */
  netChange: number | null;
  /** The plan the shop moved off, on an upgrade or downgrade. */
  previousPlanName: string | null;
  previousAmount: number | null;
  previousBillingInterval: string | null;
  /** Set when a paid subscription opened with a free period. */
  trialEndsAt: string | null;
}

export function formatMoney(amount: number | null, currency: string | null): string {
  if (amount === null || !Number.isFinite(amount)) return '—';
  try {
    return new Intl.NumberFormat('en-US', {
      style: currency ? 'currency' : 'decimal',
      currency: currency ?? undefined,
      currencyDisplay: 'narrowSymbol',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    // An unrecognized currency code is not a reason to drop the notification.
    return `${amount.toFixed(2)}${currency ? ` ${currency}` : ''}`;
  }
}

/** Shopify bills app subscriptions every 30 days or annually; nothing else. */
export function cadenceLabel(billingInterval: string | null): string {
  return billingInterval === 'ANNUAL' ? '/yr' : '/mo';
}

function planLine(
  planName: string | null,
  amount: number | null,
  billingInterval: string | null,
  currency: string | null,
): string {
  const price =
    amount === null ? null : `${formatMoney(amount, currency)}${cadenceLabel(billingInterval)}`;
  if (planName && price) return `${planName} — ${price}`;
  return planName ?? price ?? '—';
}

/**
 * The MRR movement, signed and explicit.
 *
 * A trial start and a freeze both move nothing, and saying so plainly is the
 * point: the subscription is real, the revenue is not there yet. Rendering that
 * as a blank would leave a reader guessing which of the two it was.
 */
function mrrLine(notice: SubscriptionNotice): string {
  const change = notice.netChange;
  if (change === null || change === 0) return 'No change';
  const sign = change > 0 ? '+' : '−';
  return `${sign}${formatMoney(Math.abs(change), notice.currency)}/mo`;
}

function shopLabel(notice: SubscriptionNotice): string {
  return notice.shopName ?? notice.shopDomain ?? `Shop ${notice.shopId}`;
}

/** Slack renders `<url|text>`; `*` and `_` in a merchant's name must not. */
function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function field(label: string, value: string): { type: 'mrkdwn'; text: string } {
  return { type: 'mrkdwn', text: `*${label}*\n${escapeMrkdwn(value)}` };
}

export interface SlackMessage {
  text: string;
  blocks: unknown[];
}

export function buildMessage(notice: SubscriptionNotice): SlackMessage {
  const presentation = EVENT_PRESENTATION[notice.type] ?? {
    headline: notice.type,
    emoji: ':bell:',
    tone: 'neutral' as const,
  };

  const shop = shopLabel(notice);
  const plan = planLine(notice.planName, notice.amount, notice.billingInterval, notice.currency);

  const fields = [
    field('Shop', notice.shopDomain ? `${shop}\n${notice.shopDomain}` : shop),
    field('App', notice.appName ?? notice.appId),
    field('Plan', plan),
    field('MRR', mrrLine(notice)),
  ];

  const blocks: unknown[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${presentation.emoji} *${presentation.headline}* — ${escapeMrkdwn(shop)}`,
      },
    },
    { type: 'section', fields },
  ];

  // A tier move is the one case where the new plan alone does not say what
  // happened; the interesting fact is what it replaced.
  if (notice.previousPlanName || notice.previousAmount !== null) {
    const before = planLine(
      notice.previousPlanName,
      notice.previousAmount,
      notice.previousBillingInterval,
      notice.currency,
    );
    blocks.push({
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: `Was on ${escapeMrkdwn(before)} → now ${escapeMrkdwn(plan)}` },
      ],
    });
  }

  if (notice.trialEndsAt) {
    blocks.push({
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: `Trial ends ${escapeMrkdwn(notice.trialEndsAt.slice(0, 10))}` },
      ],
    });
  }

  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        // Slack renders this in the reader's own timezone, which is the only
        // one they can check against their clock.
        text: `<!date^${Math.floor(
          new Date(notice.occurredAt).getTime() / 1000,
        )}^{date_short_pretty} at {time}|${notice.occurredAt}>`,
      },
    ],
  });

  return {
    // The fallback line is what a phone's lock screen and the sidebar show, so
    // it carries the whole headline rather than "New message".
    text: `${presentation.headline}: ${shop} — ${plan}`,
    blocks,
  };
}

export interface PostResult {
  ok: boolean;
  /**
   * True when retrying would fail the same way — a revoked webhook, a malformed
   * payload. The caller records these so they stop being retried; everything
   * else is left pending for the next sync.
   */
  permanent: boolean;
  error: string | null;
}

export async function postToSlack(url: string, message: SlackMessage): Promise<PostResult> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (cause) {
    // DNS, TLS, timeout: all things that can be true now and false in five
    // minutes, so none of them retire the event.
    const message = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, permanent: false, error: `Could not reach the webhook: ${message}` };
  }

  if (response.ok) return { ok: true, permanent: false, error: null };

  // Slack answers failures with a bare token — `no_service`, `invalid_payload`,
  // `channel_is_archived` — which is the most useful thing to show a reader.
  const body = await response.text().catch(() => '');
  const detail = body.trim().slice(0, 200) || response.statusText;

  // 429 is Slack asking for patience, not refusing; everything else in the 4xx
  // range is a webhook that will never accept this message.
  const permanent = response.status >= 400 && response.status < 500 && response.status !== 429;
  return { ok: false, permanent, error: `Slack replied ${response.status}: ${detail}` };
}

/** The message the "Send a test" button delivers. */
export function buildTestMessage(channelName: string): SlackMessage {
  return {
    text: `partnerdex is connected to ${channelName}.`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:white_check_mark: *partnerdex is connected.*\nThis is a test message for *${escapeMrkdwn(
            channelName,
          )}*. Subscription events will arrive here after the next sync.`,
        },
      },
    ],
  };
}
