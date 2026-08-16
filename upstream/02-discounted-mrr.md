# Discounted MRR

## Why

Headline MRR is reconstructed from Partner API `charge.amount`. That field is the contracted price. It is correct, and it hides three kinds of shop inside the total:

1. Unique / negotiated charges. Shopify apps name these by appending a UUID (`Unlimited Plan-<uuid>`, `Custom-2000-<uuid>`).
2. Beta / internal stores on those same charge shapes.
3. Catalog plans billed below list. The Partner API has no discount field; the only evidence is `AppSubscriptionSale.grossAmount` coming in under the contracted amount (typically a partner discount code).

Partners who do a lot of custom pricing cannot see that slice without exporting the database.

## Definition

**Discounted MRR** is the subset of headline MRR whose charge, as of that instant, is either:

- a non-catalog plan name (`Custom-%`, or a name ending in a UUID), or
- a catalog plan whose *latest* `AppSubscriptionSale` before that instant has `gross_amount < amount * 0.95`.

The figure uses the same `monthly_amount` as headline MRR, so it is a subset, not a second definition of revenue. A 50% off $299.99 catalog plan contributes $299.99 to both cards.

When two sales share a timestamp (proration + full charge on an upgrade), the larger gross is the one compared to list. A $16 proration sitting next to a $49.99 sale is not a discount.

## What changed

| File | Role |
|---|---|
| `src/metrics/asof.ts` | `discountedOnly` on the as-of predicate; `discountedStockSeries` |
| `src/metrics/reports/revenue.ts` | `discountedMrrReport` |
| `src/metrics/registry.ts` | metric key `discounted_mrr` |
| `src/server/index.ts` | included in the overview catalogue |
| `web/src/pages.ts` | cards on Overview and Revenue |
| `test/helpers.ts` | `planName`, `firstSaleGross` on fixtures |
| `test/metrics.test.ts` | four cases: list-price catalog, UUID + Custom-, late discount, same-second proration |

## How to verify

```bash
npx tsx --test --test-name-pattern='discounted MRR' test/metrics.test.ts
npx tsx src/cli.ts query discounted_mrr --period=last_12_months
```

The response `series` splits unique/custom plans from catalog-below-list.
