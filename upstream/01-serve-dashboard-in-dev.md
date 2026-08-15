# Serve the dashboard from :8787 in `npm run dev`

## Why

`npm start` (the compiled server) serves `dist/web`. `npm run dev` runs the API through `tsx` from `src/server`, so `path.resolve(here, '../web')` points at `src/web`, which does not exist.

Opening `http://localhost:8787` — the URL the README tells you to use — then returns Express's `Cannot GET /`. Vite on `:5173` is fine; `:8787` is a blank error page.

## What changed

`src/server/index.ts` now looks for a built dashboard in both places:

- `dist/server` → `../web` (production)
- `src/server` → `../../dist/web` (`tsx` in development)

If neither `index.html` is present, `/` redirects to `http://localhost:5173` instead of 404ing.

## How to verify

```bash
npm run build:web
npm run dev
curl -sI http://localhost:8787/   # 200, text/html
```

Without a web build, `/` should 302 to `:5173`.
