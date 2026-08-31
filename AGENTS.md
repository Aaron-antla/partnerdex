# AGENTS.md

## Cursor Cloud specific instructions

PartnerDex is a single Node.js/TypeScript app (npm, Node >= 20): an Express API + Vite/React dashboard that reconstructs Shopify app SaaS metrics (MRR, ARR, gross earnings, one-time charges, churn, trials, …) from data stored in a local SQLite file (`better-sqlite3`, embedded — no DB server). Standard commands live in `package.json` scripts and `README.md`; the notes below only cover non-obvious things.

### Running / caveats
- `serve`, `sync`, `doctor`, and `query` throw a `ConfigError` at startup unless `PARTNER_API_TOKEN` and `PARTNER_ORGANIZATION_ID` are set (see `src/config.ts`). For local dev without live Shopify access, put dummy values in `.env` (gitignored) and set `SYNC_INTERVAL_MINUTES=0` so the background loop never tries to reach the real Partner API. The test suite is unaffected — it sets its own env in `test/helpers.ts`.
- `npm run dev` runs two processes via `concurrently`: the API (`tsx watch src/cli.ts serve`) on port `8787`, and the Vite dev server on port `5173` which proxies `/api` → `localhost:8787` (`vite.config.ts`). Open the dashboard at `http://localhost:5173`. In production the web bundle is built and served directly by the API on `8787`.
- Leaving `DASHBOARD_PASSWORD` empty disables the login gate (localhost default); set it (min 8 chars) to require auth.
- SQLite lives at `DATABASE_PATH` (default `./data/partnerdex.db`, auto-created). `data/`, `*.db`, and `.env` are gitignored.

### Seeding data offline (for a working dashboard without the Partner API)
A freshly-booted instance has an empty DB, so all metrics read zero. To populate realistic data without the live Partner API, insert `AppEventNode`s / `TransactionNode`s through the app's real ingest+derive path and the metrics compute normally:
`insertAppEvents(db, appId, events)` + `insertTransactions(db, txns)` + `rebuildDerivedTables(db)` (all in `src/sync/ingest.ts` / `src/sync/derive.ts`). `test/helpers.ts` `seed(...)` shows the exact node shapes (subscription activate/cancel, relationship install/uninstall, subscription sales). `seedOneTimeCharges(...)` seeds `AppOneTimeSale` rows the same way; they count in `one_time_charges` and `gross_earnings` and never become MRR. Anchor fixture dates relative to "now" or the default "last 12 months" window shows nothing.

### Adding a dashboard chart
Metrics are one implementation with three registrations. Implement the report in `src/metrics/reports/*.ts` (`kind: 'stock'` for as-of levels like MRR, `kind: 'flow'` for period sums like earnings), register it in `src/metrics/registry.ts`, then add a card in `web/src/pages.ts`. Overview stays the five headline figures; Revenue is where cash breakdowns (gross earnings, one-time charges) live. Do not fold one-time or usage cash into MRR.

### Lint / test / build
- Lint / static check: `npm run typecheck` (there is no ESLint config; this is the only static check).
- Tests: `npm test` (Node's built-in runner over `test/*.test.ts`, in-memory SQLite, no external services).
- Build: `npm run build` (`tsc` server → `dist/`, `vite build` web → `dist/web`); run with `npm start`. GitHub Workers Builds uses `npm run build` then `npx wrangler deploy`. Keep `wrangler.jsonc` (assets `dist/web`) so CI does not run interactive autoconfig and fail. The Worker is the dashboard shell only — `/api` is 503 JSON. Production metrics stay on Fly / `npm start`.
- `better-sqlite3` is a native module (prebuilt binary on install). If the Node version changes, reinstall deps so its binary matches.

### Go live / push to production
Merging or pushing `main` is go-live for **both** hosts:
- **Fly.io** (`https://partnerdex-antla.fly.dev`) is the real product: Express API, SQLite on the `partnerdex_data` volume, Partner sync, dashboard. After CI on `main` succeeds, `.github/workflows/fly.yml` runs `flyctl deploy` for app `partnerdex-antla`. Confirm Trialing / MRR movement (and anything else you shipped) there, not on the Worker.
- **Cloudflare Worker** is the static dashboard shell only. Workers Builds already deploys it from `main`. `/api` on that host is 503 JSON by design.

Do not deploy to `partnerdex.fly.dev` (upstream). Do not run `fly launch`, do not create a second machine, and do not create a new volume. `fly.toml` stays gitignored. App `partnerdex-antla`, region `fra`, one machine, volume `partnerdex_data`. Partner token and dashboard password are Fly secrets, not in `fly.toml`.

Cloud agents already have the deploy token as env `Flyio` (a `FlyV1` token). On go-live, do not wait for a GitHub secret:

```
export FLY_API_TOKEN="$Flyio"
flyctl config save --app partnerdex-antla --yes
flyctl deploy --remote-only --ha=false --app partnerdex-antla
```

Never print `Flyio` or `fly.toml`. The GitHub Action `.github/workflows/fly.yml` is the same deploy for merges without an agent; it needs repo secret `FLY_API_TOKEN` (same token). If that GitHub secret is missing, the Action fails closed — still deploy from here with `Flyio`.
