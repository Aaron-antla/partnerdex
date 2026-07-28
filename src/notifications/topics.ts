/**
 * What a channel can subscribe to.
 *
 * A topic is a named set of `customer_events` types plus the presentation each
 * one gets in Slack. Keeping it as data rather than as branches in the sender
 * is what makes a second toggle — payments, installs, trials ending — a few
 * lines here and nothing anywhere else.
 *
 * The types are the *compiled* lifecycle vocabulary from `sync/events.ts`, not
 * the raw Partner feed. That matters more than it looks: the raw feed reports a
 * plan change as a cancellation, so a notifier reading it would announce a lost
 * customer every time somebody upgraded.
 */

/** Whether the movement is worth celebrating, mourning, or neither. */
export type EventTone = 'good' | 'bad' | 'neutral';

export interface EventPresentation {
  /** The headline. Written as the thing that happened, not as the event type. */
  headline: string;
  emoji: string;
  tone: EventTone;
}

/**
 * One entry per event type a topic covers.
 *
 * `subscribed` and `resubscribed` are separated because a win-back and a first
 * sale are different news, and a channel that cannot tell them apart loses the
 * one fact that made the message worth reading.
 */
export const EVENT_PRESENTATION: Record<string, EventPresentation> = {
  subscribed: { headline: 'Subscription started', emoji: ':tada:', tone: 'good' },
  resubscribed: { headline: 'Subscription restarted', emoji: ':repeat:', tone: 'good' },
  trial_started: { headline: 'Trial started', emoji: ':seedling:', tone: 'good' },
  upgraded: { headline: 'Subscription upgraded', emoji: ':arrow_up:', tone: 'good' },
  downgraded: { headline: 'Subscription downgraded', emoji: ':arrow_down:', tone: 'bad' },
  unsubscribed: { headline: 'Subscription cancelled', emoji: ':wave:', tone: 'bad' },
  subscription_frozen: { headline: 'Subscription frozen', emoji: ':snowflake:', tone: 'bad' },
  subscription_unfrozen: { headline: 'Subscription unfrozen', emoji: ':sunny:', tone: 'good' },
};

export interface NotificationTopic {
  key: string;
  label: string;
  description: string;
  /** The `customer_events` types this topic reports on. */
  eventTypes: readonly string[];
  /** What the toggle promises, in the reader's words. Shown on the page. */
  covers: readonly string[];
}

export const APP_SUBSCRIPTION_EVENTS: NotificationTopic = {
  key: 'app_subscription_events',
  label: 'App Subscription Events',
  description:
    'Every change to what a merchant is paying you: a subscription starting, ending, pausing, or moving tier.',
  eventTypes: [
    'subscribed',
    'resubscribed',
    'trial_started',
    'unsubscribed',
    'subscription_frozen',
    'subscription_unfrozen',
    'upgraded',
    'downgraded',
  ],
  covers: [
    'Subscription started (including trial started)',
    'Subscription cancelled',
    'Subscription frozen',
    'Subscription unfrozen',
    'Subscription upgraded',
    'Subscription downgraded',
  ],
};

export const TOPICS: NotificationTopic[] = [APP_SUBSCRIPTION_EVENTS];

export function topicByKey(key: string): NotificationTopic | undefined {
  return TOPICS.find((topic) => topic.key === key);
}
