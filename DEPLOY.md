# Deploying partnerdex to Fly.io

PartnerDex is a single Node process: an Express server that serves the API and
the built dashboard, plus a background sync loop, over a local SQLite file. That
shape decides the whole deployment — **one machine, one volume, always on**. The
volume attaches to a single machine, and a second machine would run a second
sync loop against its own copy of the database.

Files this depends on, all in the repo root: `Dockerfile`, `.dockerignore`, and
`fly.toml` — which is **gitignored**. `fly.example.toml` is the committed
template; `fly.toml` is yours, holding the real app name, region, and org id.

That split has one consequence worth knowing up front: `fly deploy` reads
`fly.toml` and a fresh clone will not have one. Anyone deploying — including CI —
has to copy the template and fill it in first, or pass `fly deploy --config`
explicitly.

## 0. Prerequisites

Install flyctl and log in:

```bash
brew install flyctl && fly auth login
```

You also need a Partner API client from **Partners Dashboard → Settings →
Partner API clients**, with the *View financials* and *Manage apps* permissions.

## 1. Create your fly.toml

```bash
cp fly.example.toml fly.toml
```

Fill in `app`, `primary_region`, and `PARTNER_ORGANIZATION_ID` (the number in
your Partners Dashboard URL). `fly platform regions` lists the regions.

Do not run `fly launch` — it rewrites `fly.toml` from its own scan of the repo
and would drop the volume mount, the health check, and the single-machine
settings. Create the app directly:

```bash
fly apps create <your-app-name>
```

When you add a setting later, add it to `fly.example.toml` too. The template is
the only record of the config that survives a fresh clone.

## 2. Create the volume

The database lives on a volume mounted at `/data`. Without it, every deploy
starts from an empty database and re-runs the full backfill.

```bash
fly volumes create partnerdex_data --size 1 --region <your-region> --yes
```

The region must match `primary_region` in your `fly.toml`, or the machine will
have no volume to attach to. 1 GB is generous — the database is a
few MB per year of history for a typical org. The name must match `source` under
`[mounts]` in `fly.toml`.

## 3. Fill in the credentials

Everything, credentials included, lives in `[env]` in `fly.toml` — there is no
separate `fly secrets` step. Fill in the last two keys:

```toml
  PARTNER_API_TOKEN = "..."
  DASHBOARD_PASSWORD = "..."
```

**`DASHBOARD_PASSWORD` is not optional here.** Left empty, PartnerDex runs with
no login at all — the localhost default. On Fly the app is on the public
internet, so an empty password means your revenue data is too. Use something
long; 8 characters is the floor the config enforces, not a recommendation.

Because the credentials sit in a plaintext file rather than Fly's encrypted
store, three things are worth knowing:

- The gitignore is the only thing keeping them out of the repo. `git add -f`,
  a `git stash` you later push, an editor backup, or a `tar` of the directory
  all route around it.
- `fly config show` prints them, and so does the machine metadata that anyone
  with access to the app can read.
- `fly.toml` is now the only copy of your deploy config that is not in git.
  Lose the file, lose the config — keep it somewhere you back up.

To rotate a credential, edit `fly.toml` and redeploy. Changing
`DASHBOARD_PASSWORD` signs everyone out, since the session cookie is derived
from it.

## 4. Deploy

```bash
fly deploy
```

The Dockerfile builds the server with `tsc` and the dashboard with Vite, then
resolves production dependencies in a separate stage so the runtime image has no
compiler in it. `better-sqlite3` is a native module, which is why that stage
installs `python3`/`make`/`g++` — it needs them whenever no prebuilt binary
matches the platform.

First boot starts with an empty database and begins backfilling from
`SYNC_START_DATE`. Depending on how much history the org has, the dashboard may
be sparse for the first few minutes. Watch it:

```bash
fly logs
```

## 5. Seed the history (optional, for a large backfill)

The background loop backfills on its own, but if you would rather run the first
sync in the foreground and see it finish:

```bash
fly ssh console -C "node /app/dist/cli.js sync"
```

`doctor` and `validate` run the same way and are the first things to reach for
if numbers look wrong:

```bash
fly ssh console -C "node /app/dist/cli.js doctor"
```

## 6. Verify

```bash
curl https://<your-app-name>.fly.dev/api/health
```

The health probe is deliberately outside the auth wall, which is what lets the
Fly health check in `fly.toml` use it. Every other `/api` route needs the session
cookie. Then open `https://<your-app-name>.fly.dev` and log in.

## Operating notes

**Backups.** A Fly volume is a single disk, not a replicated store, and Fly's
own snapshots are the only safety net configured here. To pull a copy down:

```bash
fly ssh sftp get /data/partnerdex.db ./partnerdex-backup.db
```

Do that on a schedule if the history matters to you. `fly volumes snapshots list
<volume-id>` shows what Fly has retained.

**Redeploys.** The machine stops and restarts, which interrupts an in-flight
sync. Nothing is corrupted — syncs are incremental and re-read a 3-day overlap
behind the last watermark, so the next run picks the gap back up.

**The sync runs in a child process.** `rebuildDerivedTables` is several seconds
of synchronous SQLite work, and better-sqlite3 has no async mode, so running it
in the server process froze every request — including `/api/health`, which made
Fly report a healthy machine as down on every sync. It is forked instead (see
`src/sync/worker.ts`), which keeps the request thread free and returns the
sync's memory to the OS when the child exits.

**Scaling.** Don't. `fly scale count 2` would give the second machine its own
volume, its own database, and its own sync loop hammering the Partner API. If
you need more headroom, scale up (`fly scale vm shared-cpu-2x --memory 1024`),
not out.

**Cost.** One `shared-cpu-1x`/512MB machine that never auto-stops, plus 1 GB of
volume. `auto_stop_machines = false` is intentional — a stopped machine runs no
sync loop, so the data would go stale until someone loaded the page.

**`TRUST_PROXY` is not optional on Fly.** Fly terminates TLS at its proxy and
forwards plain HTTP, so without it Express reads `request.protocol` as `"http"`
and issues the session cookie with no `Secure` flag, and `request.ip` is the
proxy's address rather than the client's — which collapses the login lockout in
[src/server/auth.ts](src/server/auth.ts) into a single shared bucket for the
whole internet. `TRUST_PROXY = "true"` is already set in `fly.toml`.

The inverse is just as important: leave it **off** whenever the port is reachable
directly, as it is in local development. With nothing in front to overwrite them,
`X-Forwarded-For` and `X-Forwarded-Proto` are whatever the client typed, and a
forged IP per request walks straight around the lockout.
