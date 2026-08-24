# PartnerDex

Self-hosted Shopify Partner analytics: Express API, SQLite (`better-sqlite3`), Vite/React dashboard.

## Commands

- `npm ci` — install dependencies (compiles the native SQLite binding)
- `npm test` — unit tests; they inject their own env and do not need Partner API credentials
- `npm run typecheck` — TypeScript for the server and the dashboard
- `npm run build` — server to `dist/`, dashboard to `dist/web/`
- `npm run dev` — API on port 8787 and Vite on 5173
- `npm start` — production server from `dist/` (run `npm run build` first)
- `npm run sync` / `npm run doctor` / `npm run validate` — Partner API + local store

## Cursor Cloud specific instructions

Do not commit `.env`. Secrets belong in the Cursor environment Secrets tab, using the names in `.env.example`.

- Tests, typecheck, and `npm run build` work without Shopify credentials. Use those to verify code changes.
- `npm run dev`, `npm start`, `npm run doctor`, and `npm run sync` require `PARTNER_API_TOKEN` and `PARTNER_ORGANIZATION_ID`.
- When those secrets are present and you are iterating, set `SYNC_INTERVAL_MINUTES=0` so the serve loop does not call Shopify on a timer. Run `npm run sync` only when you mean to.
- Health check: `GET http://localhost:8787/api/health`.
- SQLite defaults to `./data/partnerdex.db` (`data/` is gitignored). The server creates the directory.
- Do not deploy (`fly deploy`) or change production as part of agent work.
