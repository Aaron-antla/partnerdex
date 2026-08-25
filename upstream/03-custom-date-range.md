# Custom date range on the dashboard

## Why

`resolveWindow` already accepts `period=custom` plus `start`/`end` as `YYYY-MM-DD`. The CLI and HTTP API could ask for an arbitrary span; the dashboard Range control could not. The only choices were the six presets.

## What changed

The API is unchanged. The Range control is a preset dropdown with a date pair always visible underneath. Last 12 months, Yesterday, and Today sit at the top of the list. Editing either date becomes `period=custom`.

- `today` is midnight-to-now. `yesterday` is the previous local day and does not include today.
- The To date cannot be after today; if From and To cross, the other bound moves with the one the reader just edited.
- `toSearchParams` sends `start`/`end` only for `period=custom`, so the named presets still measure backwards from now.
- The Funnel page uses the same bounds.

## How to verify

```bash
npx tsx --test --test-name-pattern='period resolution' test/metrics.test.ts
```

In the dashboard: Range → Custom → pick two days. Overview, Revenue, and Funnel should all rebuild for that span.
