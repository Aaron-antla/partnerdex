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
  installed: { headline: 'App installed', emoji: ':package:', tone: 'good' },
  reinstalled: { headline: 'App reinstalled', emoji: ':repeat:', tone: 'good' },
  uninstalled: { headline: 'App uninstalled', emoji: ':door:', tone: 'bad' },
  subscribed: { headline: 'Subscription started', emoji: ':tada:', tone: 'good' },
  resubscribed: { headline: 'Subscription restarted', emoji: ':repeat:', tone: 'good' },
  trial_started: { headline: 'Trial started', emoji: ':seedling:', tone: 'good' },
  // The two ways a trial ends, kept apart because they call for opposite
  // reactions. `trial_expired` is the third: a trial that ran its full window
  // and simply lapsed, which nobody needs woken up for.
  trial_converted: { headline: 'Trial converted', emoji: ':moneybag:', tone: 'good' },
  trial_abandoned: { headline: 'Trial cancelled', emoji: ':leaves:', tone: 'bad' },
  trial_expired: { headline: 'Trial ended without converting', emoji: ':hourglass:', tone: 'bad' },
  charge_abandoned: { headline: 'Charge never approved', emoji: ':grey_question:', tone: 'neutral' },
  upgraded: { headline: 'Subscription upgraded', emoji: ':arrow_up:', tone: 'good' },
  downgraded: { headline: 'Subscription downgraded', emoji: ':arrow_down:', tone: 'bad' },
  unsubscribed: { headline: 'Subscription cancelled', emoji: ':wave:', tone: 'bad' },
  subscription_frozen: { headline: 'Subscription frozen', emoji: ':snowflake:', tone: 'bad' },
  subscription_unfrozen: { headline: 'Subscription unfrozen', emoji: ':sunny:', tone: 'good' },

  // Reviews are the one family whose tone is not fixed by the event type — a new
  // review is excellent or awful depending on a number the type does not carry —
  // so these are the defaults and `slack.ts` re-reads the rating over the top.
  review_posted: { headline: 'New review', emoji: ':star:', tone: 'neutral' },
  review_edited: { headline: 'Review edited', emoji: ':pencil2:', tone: 'neutral' },
  review_removed: { headline: 'Review removed', emoji: ':ghost:', tone: 'neutral' },
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

export const APP_INSTALL_EVENTS: NotificationTopic = {
  key: 'app_install_events',
  label: 'Installs',
  description: 'A merchant added the app. The plan they signed up to is included when it happened in the same moment.',
  eventTypes: ['installed', 'reinstalled'],
  covers: ['App installed', 'App reinstalled'],
};

export const APP_UPGRADE_EVENTS: NotificationTopic = {
  key: 'app_upgrade_events',
  label: 'Upgrades',
  description: 'A merchant moved to a higher plan, or to a more expensive billing cadence.',
  eventTypes: ['upgraded'],
  covers: ['Subscription upgraded'],
};

export const APP_DOWNGRADE_EVENTS: NotificationTopic = {
  key: 'app_downgrade_events',
  label: 'Downgrades',
  description: 'A merchant moved to a lower plan, or to a cheaper billing cadence.',
  eventTypes: ['downgraded'],
  covers: ['Subscription downgraded'],
};

export const APP_UNINSTALL_EVENTS: NotificationTopic = {
  key: 'app_uninstall_events',
  label: 'Uninstalls',
  description: 'A merchant removed the app. Cancelling a subscription while keeping the app is a different toggle.',
  eventTypes: ['uninstalled'],
  covers: ['App uninstalled'],
};

/**
 * Trials, freezes, first paid starts, and subscription cancels that are not an
 * uninstall. Used to live on `app_subscription_events` with upgrades and
 * downgrades; that key is rewritten on read (see `migrateLegacySubscriptionTopics`).
 */
export const APP_SUBSCRIPTION_EVENTS: NotificationTopic = {
  key: 'app_other_subscription_events',
  label: 'Other subscription events',
  description:
    'Trials, freezes, a first paid start, and a subscription cancelled while the app is still installed.',
  eventTypes: [
    'subscribed',
    'resubscribed',
    'trial_started',
    'trial_converted',
    'trial_abandoned',
    'unsubscribed',
    'subscription_frozen',
    'subscription_unfrozen',
  ],
  covers: [
    'Subscription started (including trial started)',
    'Trial converted to paid',
    'Trial cancelled before it converted',
    'Subscription cancelled',
    'Subscription frozen',
    'Subscription unfrozen',
  ],
};

/** Pre-split topic. Expanded once into installs-off, upgrades, downgrades, and other. */
export const LEGACY_APP_SUBSCRIPTION_TOPIC = 'app_subscription_events';

/**
 * Reviews, which the Partner API knows nothing about.
 *
 * The removal line is worded the way it is on purpose. A review that vanishes
 * from the listing could have been purged by Shopify, deleted by the merchant,
 * or taken down with a closed store, and the page shows the same nothing in all
 * three cases. Promising "Shopify removed a review" in a toggle description
 * would be committing to a distinction we cannot observe.
 */
export const APP_REVIEW_EVENTS: NotificationTopic = {
  key: 'app_review_events',
  label: 'App Store Reviews',
  description:
    'Reviews appearing on your App Store listing, being rewritten by the merchant, or disappearing from it.',
  eventTypes: ['review_posted', 'review_edited', 'review_removed'],
  covers: [
    'New review posted',
    'Review edited by the merchant (including a changed rating)',
    'Review no longer on the listing',
  ],
};

export const TOPICS: NotificationTopic[] = [
  APP_INSTALL_EVENTS,
  APP_UPGRADE_EVENTS,
  APP_DOWNGRADE_EVENTS,
  APP_UNINSTALL_EVENTS,
  APP_SUBSCRIPTION_EVENTS,
  APP_REVIEW_EVENTS,
];

export function topicByKey(key: string): NotificationTopic | undefined {
  return TOPICS.find((topic) => topic.key === key);
}
