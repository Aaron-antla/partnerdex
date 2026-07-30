# PartnerDex

Self-hosted analytics for your Shopify apps. Pulls your Partner API history into a local SQLite store and reconstructs **MRR, ARR, gross earnings, ARPU, LTV, trials, churn, and active subscribers as of any past date**.

Nothing leaves your machine, and no app IDs, app names, or organization IDs live in the code — everything is configuration.

<!-- Add a screenshot here once you have one you're happy with. -->

---

## 1. Introduction

PartnerDex provides a privacy-first, fully customizable, self-hosted analytics dashboard designed specifically for Shopify app developers. Instead of relying on external services or static pre-computed snapshots, PartnerDex builds its entire reporting suite directly from raw event history. Every historical point in every timeseries is reconstructed dynamically by determining subscription statuses at that specific instant.

### Key Features
- **Deterministic Historical Metrics:** MRR, ARR, and subscriber counts as of any past date remain perfectly consistent. Late-arriving cancellations or retroactively issued refunds automatically correct historical calculations on the subsequent sync.
- **Self-Hosted & Private:** All fetched data is stored in a local SQLite database on your own infrastructure. No third-party servers are involved.
- **Comprehensive Lifecycle Insights:** Reconstructs detailed customer lifecycles, uninstall timelines, trials, churn, App Store reviews, and revenue analytics.
- **Slack Notifications:** Real-time, deduplicated alerts for subscription events (starts, upgrades, churn) and App Store review changes.
- **CLI & HTTP API:** Query metrics directly from the command line, export custom intervals, or connect your own reporting tools.

---

## 2. Get started locally

### Prerequisites
- Node.js 20+
- A Shopify Partner API client with **View financials** and **Manage apps** permissions (located in the Shopify Partners Dashboard → Settings → Partner API clients).

### Setup and Installation

1. **Clone the repository and install dependencies:**
   ```bash
   npm install
   ```

2. **Configure environment variables:**
   ```bash
   cp .env.example .env
   ```
   Fill in the following variables in `.env`:
   - `PARTNER_API_TOKEN`: The access token of your Partner API client.
   - `PARTNER_ORGANIZATION_ID`: Your Shopify Partners Dashboard Organization ID (found in the URL: `partners.shopify.com/<id>/...`).
   - `PARTNER_API_VERSION`: A supported Shopify API version (e.g., `2026-07`).
   - `DASHBOARD_PASSWORD`: Set a password (at least 8 characters) to secure the dashboard. If left empty, no login is required (localhost default).

3. **Verify API connectivity and pull your history:**
   - Run the diagnostic utility to verify setup:
     ```bash
     npm run doctor
     ```
   - Sync your historical data:
     ```bash
     npm run sync
     ```
     *Note: The first sync backfills historical data starting from `SYNC_START_DATE` and may take a few minutes. Subsequent syncs are incremental and fast.*

4. **Build and start the application:**
   ```bash
   npm run build
   npm start
   ```
   Open your browser and navigate to `http://localhost:8787`.

### Local Development
To run the server with hot-reloading for both the API and the frontend dashboard (using Vite):
```bash
npm run dev
```

### Running Tests
To run the automated test suite:
```bash
npm test
```

---

## 3. Deploy on production

PartnerDex is designed to run as a single-node process on a single machine with a persistent volume for the SQLite database.

For quick and easy production deployment using Fly.io, refer to the detailed guide in [DEPLOY.md](DEPLOY.md).

---

## 4. Details and customizations

### Sync Cadence
When running `npm start`, the background loop syncs the SQLite database every 5 minutes by default.
- You can change this interval by setting `SYNC_INTERVAL_MINUTES` in your `.env`. Set it to `0` to disable background syncing and run syncs manually.
- Failed syncs implement a geometric backoff up to a maximum of 30 minutes, with the status reported in the dashboard footer.
- Sync operations are designed with file locking to ensure runs never overlap.

### Scope and Filtering (Choosing Apps)
To configure which Shopify apps are included in the reports, set the `PARTNER_APP_IDS` variable in `.env`:
- **When set:** Includes only the comma-separated list of specified Shopify App IDs. Useful for separating production apps from development or test instances.
- **When empty:** Automatically resolves to every app that has ever appeared on a transaction.
- *Note: Test charges and test shops are automatically excluded from metrics.*

### Dashboard Security and Lockout
If `DASHBOARD_PASSWORD` is configured (minimum 8 characters), the application secures the web UI and JSON endpoints behind a cookie-based login.
- **Session Lifetimes:** Selecting "Remember me" creates a persistent cookie lasting 30 days. Otherwise, the session expires in 12 hours or when the browser closes.
- **Throttling:** Brute-force protection locks out client IPs for 1 minute after 5 failed login attempts, with increasing delays for subsequent attempts.
- **SSL/TLS:** The auth mechanism relies on plain HTTP cookies for simplicity. Always terminate TLS/SSL in front of PartnerDex when deploying to an untrusted network.

### Metric Definitions

| Metric | Definition |
|---|---|
| **MRR** | Normalized monthly amounts of live paid subscriptions. Annual plans contribute 1/12 of their price; 30-day plans contribute their full price. Active trials contribute zero until the first paid charge settles. Frozen subscriptions contribute zero. |
| **ARR** | MRR × 12. Represents an instantaneous run rate. |
| **Gross earnings** | Actual cash collected inside the period, less refunds and credits. Includes subscription, one-time, and usage charges. Before Shopify's revenue share. |
| **ARPU** | MRR divided by active paying population. `METRICS_BY_SHOP` determines whether population is counted by subscribers or individual subscriptions. |
| **LTV** | ARPU divided by the monthly subscription churn rate. Represents an instantaneous, forward-looking cohort value. |
| **MRR growth** | Percentage change in MRR compared to the start of the period. |
| **MRR contribution by app** | MRR split by app. If there are more than four apps, the tail is grouped under "Other". |
| **Trials** | Count of trials started in the period, split into converted and cancelled. |
| **On trial** | Instantaneous count of active trials at that exact point in time. |
| **New subscriptions** | Subscriptions starting their first paid cycle in the period, excluding plan upgrades or downgrades. |
| **Subscription growth** | Percentage change in live paid subscriptions over the period. |
| **Churn** | Rolling 30-day loss rate. The denominator is the live population at the start of the window. |
| **Revenue / subscription churn** | MRR lost versus subscription contracts lost. |
| **Logo churn** | Uninstalls net of reinstalls divided by active installs at the start of the window. Includes free installs. |
| **Subscribers** | Unique shop-and-app pairs with a live paid subscription. |
| **Active subscriptions / installs** | Live counts at that instant. Installs includes all active merchant shops (paying and non-paying). |

### Under-the-Hood Inferences
1. **Inferred Trials:** Trial periods are detected based on the gap between subscription activation and the first paid charge transaction. `TRIAL_MIN_GAP_DAYS` (default `2`) defines this threshold.
2. **Billing Dates as Fallbacks:** Late-settling payout transactions are accounted for dynamically. Subscriptions with active billing dates that have not received cancellation events are assumed active to prevent artificial drops.
3. **Plan Upgrades/Downgrades:** Shopify models plan changes by cancelling the old subscription and creating a new one. PartnerDex correlates these events within `PLAN_CHANGE_WINDOW_DAYS` to avoid reporting upgrades as churn.

### Customer Lifecycles and Events
The Partner API event stream is compiled into a high-level customer lifecycle state machine in the `customer_events` table:
- **Account:** `installed`, `reinstalled`, `uninstalled`, `deactivated`, `reactivated`
- **Subscription:** `subscribed`, `resubscribed`, `upgraded`, `downgraded`, `unsubscribed`, `subscription_frozen`, `subscription_unfrozen`, `charge_abandoned`
- **Trial:** `trial_started`, `trial_converted`, `trial_expired`
- **Money:** `payment`, `refund`

The delta change in monthly MRR is recorded in the `net_change` field, ensuring that the sum of all historical events perfectly matches the reconstructed state:
$$\sum \text{net\_change} = \text{MRR reconstructed as of now}$$

You can rebuild the derived event tables from scratch at any time:
```bash
npm run rebuild
```

### App Store Reviews Tracking
Since the Partner API does not include review data, PartnerDex crawls the public Shopify App Store listing.
- **Setup:** Map your apps to their listing URLs in the **App listings** settings page in the dashboard.
- **Syncing:** Crawling is sequential, rate-limited, and obeys `robots.txt`. Gaps in reviews (indicating a deleted or removed review) are detected via daily deep sweeps (`REVIEW_SWEEP_HOURS`).
- **Attribution:** Reviews are matched to customer database entries by unique installer store name. Unmatched reviews can be linked manually via the UI.

### Slack Notifications
Configure an incoming Slack webhook under the **Notifications** tab to receive alerts for subscription and review changes.
- **Subscription events:** Subscriptions started, restarted, upgraded, downgraded, frozen, and cancelled.
- **Review events:** New reviews, updated ratings, and removals.
- **Deduplication:** Alerts are tracked in `notification_deliveries` to ensure no notification is sent twice, even after full database rebuilds.

### Querying from the Command Line
Use the built-in CLI to pull raw metrics:
```bash
# Query MRR for the last 12 months in monthly intervals
npx partnerdex query mrr --period=last_12_months --interval=month

# Query MRR as it stood on a specific historical date
npx partnerdex query mrr --period=last_12_months --asOf=2024-06-30
```

### HTTP JSON API
The server exposes several endpoints (requires session authentication if `DASHBOARD_PASSWORD` is set):
- `GET /api/overview`: Retrieve configured metrics.
- `GET /api/metrics/:metric`: Retrieve details and historical timeseries for a specific metric.
- `GET /api/customers`: Search and list customer profiles and timelines.
- `GET /api/reviews`: List reviews, ratings, and linking statuses.
- `GET /api/status`: System counts, sync logs, and background worker state.

### Codebase Organization
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

- `src/partner/`: GraphQL client and API integration.
- `src/sync/`: Ingestion, pagination, and write-time normalization.
- `src/metrics/`: Core metric reports and timeseries range calculations.
- `src/appstore/`: Web scraper for App Store listings and reviews.
- `src/notifications/`: Slack webhook dispatcher and templates.
- `web/`: Frontend dashboard single page application (Vite/React).

### Database Validation and Integrity
Run the built-in integrity validator to cross-examine and reconcile internal datasets:
```bash
npm run validate
```
This utility checks source transaction parity, cross-foots reconstructed metrics against database sums, and detects retroactive history drift.

### Limitations
- **Single Currency:** Transactions are summed as-is. Mixed currency billing is not converted.
- **App Store Redesigns:** The review crawler parses raw HTML. Structural modifications by Shopify can affect review collection.
- **Store Name Matching:** Matching App Store review authors with Shopify merchants is a best-effort heuristic based on store names.
- **LTV Calculation:** Periods with zero churn will report an LTV of zero.

---

## License

PartnerDex is licensed under the GNU General Public License v3.0. See the [LICENSE](LICENSE) file for details.
