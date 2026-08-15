# shadcn/ui preview (experiment branch)

This is a **looks-only trial** on `experiment/shadcn-ui`. Metrics, sync, and APIs are unchanged. To go back to the original dashboard:

```bash
git checkout main
```

To drop this experiment entirely: `git branch -D experiment/shadcn-ui`.

Source: [ui.shadcn.com/docs](https://ui.shadcn.com/docs) and the [component catalogue](https://ui.shadcn.com/docs/components).

## Mapping

| Dashboard surface | Current implementation | shadcn component | Used in this preview? |
|---|---|---|---|
| Left rail | Custom `.nav` in `Nav.tsx` | [Sidebar](https://ui.shadcn.com/docs/components/base/sidebar) (`SidebarProvider`, `Sidebar`, `SidebarMenu`, `SidebarGroup`) | Yes |
| Collapse toggle | Custom button | `SidebarTrigger` + `collapsible="offcanvas"` | Yes |
| Metric tiles | Custom `.card` + Recharts | [Card](https://ui.shadcn.com/docs/components/base/card) + [Chart](https://ui.shadcn.com/docs/components/base/chart) (`ChartContainer`, `ChartTooltip`) | Yes |
| Line / area / bar plots | `Chart.tsx` Recharts wrappers | Same Recharts primitives inside `ChartContainer` — shadcn does not wrap Recharts | Yes |
| Range + dates | Native `<select>` + `<input type="date">` | Compact preset menu + [Calendar](https://ui.shadcn.com/docs/components/base/calendar) range | Yes |
| App / trials / rating filters | Native `<select>` | `Select` | Yes (filter bar) |
| Loading placeholders | `.skeleton` CSS | [Skeleton](https://ui.shadcn.com/docs/components/base/skeleton) | Yes |
| Customers / reviews tables | Custom tables | [Table](https://ui.shadcn.com/docs/components/base/table) | Not this pass |
| Login | Custom form | [Card] + [Input] + [Button] + [Checkbox] | Not this pass |
| Notices / empty states | `.notice` | [Alert](https://ui.shadcn.com/docs/components/base/alert) / [Empty](https://ui.shadcn.com/docs/components/base/empty) | Not this pass |
| Theme toggle | Custom button | [Toggle](https://ui.shadcn.com/docs/components/base/toggle) | Left as-is (already works) |
| Funnel matrix | Custom table + SVG | Chart + Table | Not this pass |
| Dialogs (review link, listings) | Custom overlays | [Dialog](https://ui.shadcn.com/docs/components/base/dialog) | Not this pass |

## What we wanted

1. See whether shadcn's Sidebar, Chart, and Date Picker feel better than the current custom CSS.
2. Put Last 12 months / Yesterday / Today **in the same popover as a calendar**, which a native `<select>` cannot do.
3. Keep it throwaway — one branch, no metric-engine changes.

## What we can do

- **Can:** swap chrome (nav, cards, plots, filters) because those are presentational. shadcn Chart is Recharts with their tooltip/legend, and we already depend on Recharts.
- **Can:** use Date Picker range mode + preset list. That is the documented composition: `Popover` → presets + `Calendar mode="range"`.
- **Cannot without more work:** restyle Customers, Reviews, Funnel, Login, settings forms. Those are custom layouts, not missing a 1:1 shadcn primitive.
- **Cost:** Tailwind has to sit next to the existing `styles.css`. The experiment imports both. The original CSS still styles pages we did not touch.
