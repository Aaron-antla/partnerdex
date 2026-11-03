# Upstream sync report

Behind count / SHAs inspected:
12 behind, 43 ahead of `AdityaMalani/partnerdex` `main` (`c3cb0a2`). Nine of the twelve were triaged in the previous sync (`2afbbb6`, `51be8ab`, `13e7cfc`, `075f004`, `7fc4f9b`, `21848a0`, `0a86353`, `c940f2e`, `dd27d24`). New this round: `32dbca5`, `aaca7cf`, `c3cb0a2`.

KEEP:
- `32dbca5` `trial_restarted` for returning merchants; plan-change pairing fixed at 60 seconds (`PLAN_CHANGE_WINDOW_SECONDS`); an abandoned trial releases the running charge.
- `aaca7cf` "Left a review" as funnel step 6 (App Store crawl, counted in reviews).

SKIP_OTHER:
- `c3cb0a2` duplicate trial-conversion notifications. Already fixed here in `20bdd5e` with the same undated event id. Upstream numbers its delivery migration 3; ours is 4 (our 3 adds the uninstall-reason columns), so taking theirs would collide.

Adaptations:
- `collapse()` keeps our install fold; `trial_restarted` folds into a same-instant reinstall like `trial_started` does.
- Abandoned trials keep our uninstall-survey detail and gain upstream's state release.
- `src/multipliers/index.ts` pairs plan changes with the derive step's 60-second forward window instead of `PLAN_CHANGE_WINDOW_DAYS`.
- Two of our notification tests now cancel the first charge before seeding the second, since a charge opened while another is live is now a plan change. Upstream's mid-trial-upgrade test also enables our separate upgrades topic.

New env vars:
none. `PLAN_CHANGE_WINDOW_DAYS` is removed (also from `fly.example.toml` and test helpers); a value left in a deployed env is ignored.

Schema / migration notes:
none.

Metrics risk (none / low / needs human check):
needs human check. The plan-change window shrinks from ±2 days to 60 seconds forward. A cancel followed by a new charge minutes or days later now counts as churn plus a win-back (`resubscribed`), not a plan change. Expect churn and new subscriptions to rise slightly, and the multipliers churn ceiling to move with them.

Deploy risk:
none. No edits to `worker/`, `wrangler.jsonc`, or `DEPLOY.md`.

Tests run + results:
- `npm test`: 318 pass, 0 fail
- `npm run typecheck`: pass (server, web, worker)
- `npm run build`: pass
- Browser on a seeded scratch DB: Funnel shows six steps, "Left a review" with an App Store pill and counts; GA4 steps show dashes with BigQuery off.

What the human should verify next:
On a copy of the production DB, run `partnerdex sync`, then compare churn, new subscriptions, and the multipliers ceiling for the last few months against the live instance. Differences should be merchants who cancelled and came back more than 60 seconds later.
