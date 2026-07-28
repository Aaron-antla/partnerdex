# PartnerDex

Self-hosted analytics for your Shopify apps. Pulls your Partner API history into
a local SQLite store and reconstructs **MRR, ARR, gross earnings, ARPU, LTV,
trials, churn, and active subscribers as of any past date**.

Nothing leaves your machine, and no app ids, app names, or organization ids live
in the code — everything is configuration.

<!-- Add a screenshot here once you have one you're happy with. -->

## Why "as of any past date"

There are no snapshot tables. Every point in every series is rebuilt from the
raw event history by asking *"which subscriptions were live at this instant?"*.

Two things follow. Asking for MRR on 2024-06-30 gives the same number whether
you ask today or asked back then. And when a cancellation lands late, or a
refund is issued against an old charge, every affected point in history corrects
itself on the next sync — no backfill job.

## Requirements

- Node 20+
- A Shopify Partner API client with the **View financials** and **Manage apps**
  permissions (Partners Dashboard → Settings → Partner API clients)

## Setup locally

```bash
npm install
cp .env.example .env   # then fill it in
```

`.env` needs three values to start:

| Variable | Where to find it |
|---|---|
| `PARTNER_API_TOKEN` | The access token of your Partner API client |
| `PARTNER_ORGANIZATION_ID` | The number in your Partners Dashboard URL: `partners.shopify.com/<this>/...` |
| `PARTNER_API_VERSION` | A supported version, e.g. `2026-07` |

Set `DASHBOARD_PASSWORD` too if anything but you can reach the port — see
[Locking the dashboard](#locking-the-dashboard).

Check it works, then pull your history:

```bash
npm run doctor
```

```bash
npm run sync
```

The first sync backfills from `SYNC_START_DATE` and can take a few minutes on a
large account. Later runs are incremental — they resume from a stored watermark
and re-read a short overlap to catch late-arriving records. Re-running is always
safe; every insert is idempotent.

```bash
npm run build && npm start
```

Then open <http://localhost:8787>.

`serve` keeps the store current on its own: it syncs every five minutes in the
background, and the dashboard picks up each run without a reload. Set
`SYNC_INTERVAL_MINUTES=0` to turn the loop off and drive syncing yourself.

Runs never overlap — the next is scheduled once the previous finishes, so a sync
that outlives its interval delays the next tick rather than stacking against it.
A failing run backs off geometrically to a ceiling of 30 minutes, and the
dashboard says so in the footer rather than letting the timestamp drift quietly.
Restarting the server resumes the cadence instead of restarting it, so a
`tsx watch` session does not turn every file save into a Partner API pass.

The dashboard is six pages behind a collapsible rail — **Overview**,
**Customers**, a **Reports** group holding **Revenue**, **Subscriptions** and
**Churn**, and **Notifications** under **Settings**. Each report page is a grid of at most three cards per row, and
each card is one metric read four ways: what it is, what it is now, how that
compares with the period before, and how it got there. The page id lives in the
URL hash, so a report — or a single merchant — can be linked.

For development with hot reload, `npm run dev` runs the API and the Vite dev
server together.

## Locking the dashboard

Set `DASHBOARD_PASSWORD` in `.env` (8 characters or more) and both the dashboard
and the API behind it require a login:

```
DASHBOARD_PASSWORD=something-only-you-know
```

Leave it empty and there is no login at all, which is the localhost default this
tool has always had. There are no accounts — one password, one operator.

Signing in sets an HTTP-only cookie holding a signed expiry and nothing else, so
there is no session table and a restart does not sign you out. **Remember me**
chooses between the two lifetimes: unticked, the cookie dies with the browser
and is good for 12 hours; ticked, it lasts 30 days. **Sign out** sits at the foot
of the navigation rail and clears it. A session that lapses while the page is
open returns you to the login form on its next request rather than leaving stale
figures on screen.

Two consequences worth knowing:

- **Changing the password signs everyone out.** The cookie is signed with a key
  derived from the password, so every cookie issued under the old one stops
  verifying. That is the way to revoke a session you cannot reach.
- **Failed logins are throttled** — five wrong attempts locks that client out for
  a minute, and each further attempt lengthens it. The lockout applies to the
  correct password too, which is what makes it a lockout.

`GET /api/health` stays open, because a liveness probe that needs a password is
not a liveness probe. Everything that reads your data does not.

This is a password on a door, not a security boundary: cookies travel in the
clear over plain HTTP, so put TLS in front of the port before exposing it to a
network you do not control.

## Choosing which apps count

The Partner API has no "list my apps" query, so scope is resolved one of two
ways:

- **`PARTNER_APP_IDS` is set** — exactly those apps. This is how you keep
  development and test apps out of production reporting, and it keeps your app
  ids in `.env` rather than in the repo.
- **`PARTNER_APP_IDS` is empty** — every app that has appeared on a transaction.
  A brand-new app with no charges yet is invisible until its first sale; name it
  explicitly if you need it sooner.

Test charges and test shops are always excluded.

## What each number means

Definitions are the part that makes analytics trustworthy or not, so they are
stated rather than implied.

| Metric | Definition |
|---|---|
| **MRR** | Sum of normalized monthly amounts over subscriptions live at that instant. Annual plans contribute 1/12 of their price; 30-day plans contribute their price unchanged. A subscription counts from its **first paid charge**, not its activation — a trial is live but worth nothing. Frozen subscriptions contribute zero. |
| **ARR** | Latest MRR × 12. A run rate, with no growth or seasonality modelling. |
| **Gross earnings** | What merchants actually paid inside each period, from the transactions feed: subscription, one-time, and usage charges, less refunds and credits. Before Shopify's revenue share — the net figure rides along in `meta.netEarnings`. |
| **ARPU** | MRR ÷ active paying population. `METRICS_BY_SHOP` decides whether that population is subscribers or individual subscriptions. |
| **LTV** | ARPU ÷ monthly churn rate. Instantaneous and forward-looking — what today's cohort is worth if today's churn held forever. Not a cohort measurement of realized revenue. Directional only. |
| **MRR growth** | Percentage change in MRR against the previous bucket. The headline is the whole window: MRR at the end against MRR at the start. A bucket whose predecessor was zero reports 0, not infinity, and the count of those is in `meta`. |
| **MRR contribution by app** | The same MRR reconstruction with one more `GROUP BY`, so the per-app bands sum to the total by construction. Beyond four apps the tail folds into "Other" rather than inventing a fifth colour. |
| **Trials** | Grouped by the period the trial began, split into converted and cancelled. |
| **On trial** | Trials running at that instant — started, and neither converted nor cancelled yet. `Trials` is the flow that feeds this stock. Trials whose outcome was never recorded have no end instant to test and are excluded. |
| **New subscriptions** | Subscriptions that started paying inside each period, excluding plan changes. The inflow to the ledger churn reads the outflow of, gated on the same instant, so a bucket's net movement is new minus churned. |
| **Subscription growth** | Percentage change in live subscriptions, derived the same way as MRR growth. |
| **Churn** | Rolling 30-day rate. The denominator is the population live at the **start** of the window, never the end. |
| **Revenue / subscription churn** | The same loss over two denominators: MRR lost, contracts lost. Revenue churn runs above subscription churn when the customers leaving are the expensive ones. |
| **Logo churn** | Uninstalls net of reinstalls over the installs active at the window start — the only churn rate read from the install ledger rather than the subscription index. It counts free installs, so it usually sits well below the other two, and a shop that cancels but leaves the app installed is not a lost logo until it uninstalls. A deactivation counts as an uninstall, a reactivation as a return, so the rate can go negative in a month when returns outrun departures. |
| **Subscribers** | Shop-and-app pairs with a live paid subscription. A merchant running two of your apps counts twice, matching how each app reports its own numbers — and so that dropping one app registers as churn instead of hiding behind the other. |
| **Active subscriptions / installs** | Live counts at that instant. Installs counts every shop with the app, paying or not. |

### Four inferences worth knowing about

**Trials are inferred.** The Partner API does not report trial length. A trial is
detected from the gap between a subscription activating and its first paid
charge landing: no gap means the merchant paid immediately, a gap means they
were trialling. `TRIAL_MIN_GAP_DAYS` (default 2) sets the threshold and also
absorbs the lag between a charge and its transaction being recorded.

**`billingOn` is the next billing date, not the trial end.** The same field means
three different things, and only the first is a trial:

| Gap from activation to `billingOn` | Meaning |
|---|---|
| A part cycle (e.g. 14 of 30 days) | Trialling — earns nothing yet |
| A full cycle (within a day of 30 or 365) | Billed at activation — paying |
| Whatever remained of a paid cycle | Mid-cycle plan change — paying |

A charge that replaces one ending at the same moment is a continuation, so it is
never treated as a fresh trial. One ambiguity survives: a trial whose length
equals the billing cycle (a 30-day trial on a 30-day plan) is indistinguishable
from a charge billed at activation, and reads as paying.

**Transactions settle late, so the billing date is a fallback.** Partner
transactions carry the date they landed in a payout batch, not the date the
merchant was charged, and payouts run twice a month. Two consequences are handled
explicitly: a subscription whose billing date has passed with no cancellation
counts as paying even before its transaction shows up (otherwise every shop that
converted in the last fortnight reads as unpaid), and a sale posting within
21 days of a cancellation is treated as settlement of the final charge rather
than proof the subscription survived.

**Plan changes are not churn.** Shopify models an upgrade as *cancel the old
charge, create a new one*. Counting raw cancellations would report every upgrade
as a lost customer. A cancellation followed by a new charge for the same shop
within `PLAN_CHANGE_WINDOW_DAYS` is classified as a plan change and excluded
from churn. An uninstall only ends a subscription when it is the uninstall the
shop never returned from — merchants routinely uninstall and reinstall while
their charge keeps billing.

## Customer events

The Partner API's event feed is a firehose of low-level facts, not a lifecycle.
The same merchant action arrives as several events, an upgrade shows up as
*cancel the old charge, activate a new one*, and nothing at all fires when a
trial ends. Sync compiles that stream into the events a customer timeline and a
churn number actually want, in `customer_events`:

| Family | Types |
|---|---|
| Account | `installed`, `reinstalled`, `uninstalled`, `deactivated`, `reactivated` |
| Subscription | `subscribed`, `resubscribed`, `upgraded`, `downgraded`, `unsubscribed`, `subscription_frozen`, `subscription_unfrozen`, `charge_abandoned` |
| Trial | `trial_started`, `trial_converted`, `trial_expired` |
| Money | `payment`, `refund` |

The compiler is a per-install fold over one merged timeline: the raw feed plus
the movements it never sends — a trial converting, a loss the merchant expressed
by uninstalling. An activation cannot be classified in isolation, because
whether it is a subscribe, a win-back, an upgrade or a downgrade depends on what
the shop was paying a moment earlier.

**A lone cancel is not churn.** Shopify models a plan change as cancel-then-
activate, so the naive reading reports every upgrade as a lost customer. The
verdict on which cancels were plan changes already exists — it is what the churn
metrics read — so the compiler consumes it rather than deriving a second copy
with its own window. That is the difference between a timeline and a chart that
agree about a merchant and two that quietly don't. Suppressed cancels stay on
the record and are filtered out of every default read.

**`net_change` is the signed monthly MRR delta**, gated where MRR is gated: at
the first paid charge, not at activation. A subscription that opens a trial
carries a zero delta, and the money arrives on `trial_converted`. Annual plans
contribute a twelfth of their price.

Which means the two halves of this project have to agree:

```
sum(net_change)  ==  MRR reconstructed as-of now
```

The left side accumulates forward from events; the right rebuilds backwards from
subscription state. `npm run validate` checks it per install (see below), and
`npm test` asserts it against the MRR report itself.

Re-deriving is cheap and safe — event ids are deterministic, so a rebuild
converges rather than duplicating:

```bash
npm run rebuild
```

## Slack notifications

The **Notifications** page turns the event stream above into messages. Add a
Slack [incoming webhook](https://api.slack.com/messaging/webhooks), switch on
**App Subscription Events**, and every change to what a merchant pays you
arrives in the channel:

| Reported as | Compiled from |
|---|---|
| Subscription started | `subscribed`, or `trial_started` when it opens with a free period |
| Subscription restarted | `resubscribed` — a win-back, not a first sale |
| Subscription upgraded / downgraded | `upgraded`, `downgraded` |
| Subscription cancelled | `unsubscribed` |
| Subscription frozen / unfrozen | `subscription_frozen`, `subscription_unfrozen` |

Each message carries the shop and its myshopify domain, the app, the plan and
its price, and the signed MRR movement. The price is the one the merchant is
billed — a $299/year plan reads as `$299.00/yr`, with the normalized
`+$24.92/mo` on the MRR line rather than in place of it.

Messages are sent after each sync, so they land within a few minutes of the
merchant action. `serve` does this from its background loop; `partnerdex sync`
does it too, so a cron-driven setup with `SYNC_INTERVAL_MINUTES=0` still
notifies.

### Three rules that keep it trustworthy

**Nothing is replayed.** A toggle records the instant you switched it on and
only reports what happens after it. Otherwise enabling one would empty years of
history into a channel. Switching a topic off and on again does the same thing
deliberately: the quiet stretch stays quiet.

**Nothing is said twice.** `customer_events` is dropped and rewritten on every
sync, so "rows I have not seen" is every row, every time. What survives a
rebuild is the event id — it is deterministic — so the ids already sent are
recorded in `notification_deliveries` and checked before the next send. A
rebuild converges rather than re-announcing your whole customer base.

**An upgrade is not a cancellation.** Shopify models a plan change as *cancel
the old charge, activate a new one*. The notifier reads the compiled events, not
the raw feed, so the cancel half is already marked as not-churn and the move
announces itself once, as an upgrade, with the plan it replaced.

One more collapse happens at send time. A subscription that opens with a trial
produces `subscribed` and `trial_started` at the same instant — both correct,
and the ledger needs both — but it is one thing the merchant did, so it is one
message.

### Handling failures

A webhook that times out or answers 5xx or 429 leaves its events pending and
stops that channel's run, so messages keep arriving in the order they happened.
A webhook Slack has revoked answers 404 forever, so those events are recorded as
undeliverable instead of blocking everything behind them. Either way the page
says what went wrong, and **Send a test** answers on the spot rather than
leaving a broken webhook to be discovered by the first event it loses.

A backlog is capped at 50 messages per channel per sync. The rest stay pending
rather than being dropped.

> **Webhook URLs are credentials** — anyone holding one can post into your
> channel. They are stored in the local SQLite file and the API never reads one
> back: every response identifies a channel by name and a masked hint. Treat
> `data/partnerdex.db` accordingly.

| Endpoint | Purpose |
|---|---|
| `GET /api/notifications` | Topics, and the channels with their toggles |
| `POST /api/notifications/channels` | Add a channel: `{ name, webhookUrl }` |
| `PATCH /api/notifications/channels/:id` | Rename, or point at a new webhook |
| `DELETE /api/notifications/channels/:id` | Remove it, and its delivery ledger |
| `PUT /api/notifications/channels/:id/topics/:topic` | `{ enabled }` |
| `POST /api/notifications/channels/:id/test` | Send a test message |
| `POST /api/notifications/dispatch` | Send what is owing now, without waiting for a sync |

## Querying from the command line

```bash
npx partnerdex query mrr --period=last_12_months --interval=month
```

```bash
npx partnerdex query mrr --period=last_12_months --asOf=2024-06-30
```

`--asOf` anchors the whole window, so presets compose with it: *last 12 months,
as it stood on that date*.

## HTTP API

| Endpoint | Purpose |
|---|---|
| `GET /api/auth/session` | Whether a login is required, and whether you have one |
| `POST /api/auth/login` | `{ password, remember }` — sets the session cookie |
| `POST /api/auth/logout` | Clears it |
| `GET /api/metrics` | List available metrics |
| `GET /api/metrics/:metric` | One metric |
| `GET /api/overview` | A page's worth of metrics in one call; `metrics=a,b,c` selects them |
| `GET /api/customers` | Merchant list; `q=` searches name and myshopify domain, with `sort`, `limit`, `offset` |
| `GET /api/customers/:shopId` | One merchant: live subscriptions, lifetime money, event timeline |
| `GET /api/apps` | Apps in reporting scope |
| `GET /api/status` | Row counts, last sync time, and the background loop's state under `sync` |

Query parameters: `period`, `start`, `end`, `interval`, `appIds`,
`includeAnnual`, `includeUsage`, `includeTrials`, `byShop`, `nocache`.

`interval` overrides the automatic granularity. The dashboard never sends it:
the ladder in `time.ts` picks **daily** buckets up to 90 days and **monthly**
beyond, so the axis can never disagree with the figures beside it. `hour` and
`week` remain available to API and CLI callers that ask for them.

Every metric answers with the same envelope:

```json
{
  "metric": "mrr",
  "value": 12480.5,
  "format": "money",
  "currency": "USD",
  "period": "last_12_months",
  "periodStart": "2025-07-01T00:00:00.000Z",
  "periodEnd": "2026-07-01T00:00:00.000Z",
  "timeSeriesInterval": "month",
  "timeSeries": [{ "value": 11900, "change": 340, "periodStart": "...", "periodEnd": "..." }],
  "series": [{ "key": "monthly", "name": "Monthly plans", "data": [] }],
  "comparison": {
    "previousValue": 10960,
    "change": 1520.5,
    "changePercent": 13.87,
    "periodStart": "2024-07-01T00:00:00.000Z",
    "periodEnd": "2025-07-01T00:00:00.000Z"
  }
}
```

`value` is the **last point** for level metrics like MRR and the **sum** for flow
metrics like gross earnings. The newest bucket is marked `provisional` — it is
still filling.

`comparison` re-runs the metric over the equal-length span immediately before
the window, which is what makes "up 13.9% on the previous 12 months" a true
statement rather than a comparison of the last two buckets. It is absent when
that span would start before `SYNC_START_DATE`, and `changePercent` is `null`
when the previous period was zero. Each metric therefore costs two
reconstructions, which is why `/api/overview` takes a `metrics=` list.

> **The API is unauthenticated until you set `DASHBOARD_PASSWORD`.** With it set,
> every endpoint above needs the session cookie and answers 401 without one; see
> [Locking the dashboard](#locking-the-dashboard). Either way it is built to run
> on localhost — a password is not a substitute for TLS on a public port.

## Trusting the numbers

Because history is recomputed rather than stored, it can drift silently. `npm run
validate` checks that it hasn't:

- **Source ⇄ index** — re-derives each subscription's normalized amount from the
  raw feeds and diffs it against the derived table.
- **Cross-foot** — reconstructed MRR against a direct sum over the same rows.
- **Event ledger** — the customer-event running balance against the MRR
  reconstruction, per install. This is what catches a misclassified event: a
  cancel wrongly read as churn, a plan change counted twice, a trial credited too
  early. None of those break a query or fail a type; every one of them moves the
  ledger. Compared per install rather than in total, because two opposite errors
  sum to zero.
- **Retroactive drift** — today's view of the last 90 days against the previous
  run's. History is *allowed* to change; a silent change is worth knowing about.

It exits non-zero on a high-severity finding, so it fits a cron job.

## How it fits together

```
Partner API ──┬── app.events ─────┐
              └── transactions ───┤
                                  ▼
                         raw tables (append-only, idempotent)
                                  │  write-time normalization
                                  ▼
                   subscriptions + install_intervals
                                  │            │  per-install fold
                                  │            ▼
                                  │      customer_events ──► Slack notifications
                                  │            │
                                  │  one as-of predicate
                                  ▼            ▼
                      reports ──► HTTP API ──► dashboard
```

`customer_events` sits downstream of `subscriptions` rather than beside it,
which is what keeps the timeline and the churn chart telling the same story —
and, since Slack reads the same table, what keeps a notification from
announcing an upgrade as a lost customer.

| Path | What lives there |
|---|---|
| `src/partner/` | GraphQL documents and a retrying, throttle-aware client |
| `src/sync/` | Pagination, ingest, and the write-time normalization in `derive.ts` |
| `src/sync/events.ts` | The raw feed compiled into clean lifecycle events |
| `src/customers/` | The customer read model, computed at read time |
| `src/notifications/` | Topics, channels, Slack rendering, and the at-most-once dispatcher |
| `src/metrics/asof.ts` | The as-of predicate — defined once, used by every report *and* the validators |
| `src/metrics/time.ts` | Period parsing and the single range→interval ladder |
| `src/metrics/reports/` | One module per metric family |
| `src/validate.ts` | The trust checks |
| `web/` | The dashboard |

Two design rules are worth preserving if you extend this:

1. **Normalize at write time, compare at read time.** Cadence and discount
   handling belong in `derive.ts`. Read-time queries should stay sums and date
   comparisons.
2. **One as-of predicate.** If a report needs "who was live at D", it calls
   `asOfPredicate`. A second copy is how a count and a revenue figure start
   disagreeing about the same instant.

## Limitations

- **Single currency.** Amounts are summed as-is. If your payouts span
  currencies, the reports will add unlike units together.
- **No revenue-share modelling.** `netAmount` is taken from the API rather than
  recomputed, so the threshold where Shopify's share changes is already baked in.
- **Installs predating `SYNC_START_DATE`** have no datable start and are
  excluded from the active-installs series.
- **Subscriptions activated before September 2020** fall back to their activation
  date as the MRR gate, because transactions from before then carry no charge id.
- **LTV is directional.** Buckets with zero churn have no finite LTV and report
  as 0; the count is in `meta.bucketsWithoutChurn`.

## Testing

```bash
npm test
```

The suite covers the behaviours that are easy to get wrong: cadence
normalization, the as-of gate and its boundaries, backdated cancellations
rewriting history, frozen subscriptions, trial classification, churn
denominators, plan changes, guarded divisions, and scope enforcement.

For the event compiler it walks the cases that produce phantom churn or MRR
drift when they are handled wrongly — a mid-cycle upgrade emitting one move and
zero churn, a trial's money waiting for its first paid charge, a merchant who
uninstalled rather than cancelled being counted as lost exactly once, a win-back
reading as a win-back — and closes with the ledger reconciling against the MRR
report.

## Deploying to production

PartnerDex is built to deploy on Fly.io as a single node process. See [DEPLOY](DEPLOY.md) for exact steps.

## License

PartnerDex is licensed under the GNU General Public License v3.0.

The goal is to build a community-owned toolkit for Shopify app developers that remains free and open for everyone.

See the [LICENSE](LICENSE) file for details.
