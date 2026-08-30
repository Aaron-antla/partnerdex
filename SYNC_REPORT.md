# Upstream sync report

Behind count / SHAs inspected:
9 behind, 23 ahead. Inspected `2afbbb6`, `51be8ab`, `13e7cfc`, `075f004`, `7fc4f9b`, `21848a0`, `0a86353`, `c940f2e`, `dd27d24`.

KEEP:
- `2afbbb6` `PRAGMA user_version` migration runner (`src/db/migrate.ts`, `test/migrate.test.ts`)
- `51be8ab` `.github/workflows/ci.yml`

SKIP_UI:
- `7fc4f9b` spacing scale and shared CSS
- `21848a0` unused page-action slot
- `dd27d24` 640px table width CSS

SPLIT (what was taken vs left):
- `13e7cfc` took `trialing` report, `MetricContext.now`, `comparison: false`, tests, Subscriptions bar card, README row. Left their MetricCard/pages chrome.
- `c940f2e` took `mrr_movement` report, reconcile tests, Revenue table card, README row. Left `mrr_by_app` cap removal, `seedForApp` amount change, and their Chart restyle.
- `dd27d24` README rewrite of MRR-by-app left (it describes uncapped rows we did not take).

SKIP_OTHER:
- `075f004` CONTRIBUTING.md and README sponsors
- `0a86353` sponsor name edit

New env vars:
none

Schema / migration notes:
Same column fixups we already ran unversioned (BigQuery connection cleanup, `listing_events.user_key`, `install_intervals.started_by`). They now bump `PRAGMA user_version` to 2. Each body is still idempotent, so a database that already holds the columns and still has `user_version = 0` replays as a no-op.

Metrics risk (none / low / needs human check):
low. Historical MRR/ARR formulas are unchanged. `mrr_movement` is a new ledger view. Its tests include an all-history reconcile against reconstructed `mrr` (passed). `trialing` is a new forecast and skips period comparison.

Deploy risk:
none from this batch. No edits to `worker/`, `wrangler.jsonc`, `DEPLOY.md`, `AGENTS.md`, or `.env.example`.

Tests run + results:
- `npm test`: 272 pass, 0 fail (includes migrate runner, trialing forecast, MRR movement suite)
- `npm run typecheck`: pass (server, web, worker)
- `npm run build`: pass
- API smoke on a local copy DB (`data/partnerdex-sync-smoke.db`, not production): `trialing` = $79, `mrr_movement` series keys `added, frozen, unfrozen, churned, upgraded, downgraded, net`, value $109
- Browser at `http://localhost:5173`: Subscriptions shows Trialing $79.00 with a bar chart. Revenue shows MRR movement as a table with Period plus the seven ledger columns. MRR contribution by app stays an area chart. Overview still loads.

What the human should verify next:
Open the PR dashboard on a real Partner-synced window. Confirm Trialing and MRR movement against a known past date. Do not point this sync at the production SQLite file. A safe smoke is: copy the DB, run `partnerdex sync` against the copy, then compare `mrr` for a known past date with the live instance.
