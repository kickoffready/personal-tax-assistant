# The low-value pool: what the rules say, and where the ledger departs from them

> **Status:** implemented. All four defects below are fixed and covered by tests.
> **Verified against ato.gov.au on 10 August 2026.** Reverify each tax time.

## Context

This started as a retention question — can a row ever be dropped once its five years are up — and
turned up four defects instead. Two of them changed the figures on a return, both in the direction
that over-claims.

## The rules, as verified

| Rule | Status in the ledger |
| --- | --- |
| 18.75% of taxable-use cost in the year an asset is allocated, no part-year apportionment | correct (`POOL_FIRST_YEAR`) |
| 37.5% diminishing on the opening pool balance thereafter | correct (`POOL_ONGOING`) |
| Once one low-cost asset is allocated, every later one must be | enforced by an integrity check |
| A balancing adjustment event reduces the **closing** balance by termination value × taxable use % | correct (was missing entirely) |
| If that exceeds the closing balance, the balance goes to nil and the excess is assessable at **item 24** | correct (was missing entirely) |
| No write-off of a small closing balance for individuals | correct — the pool runs indefinitely |

That last row matters more than it looks. Small business entities can write off a pool balance under
a threshold; an individual running a low-value pool cannot. The only route to nil is the balancing
adjustment excess. So a pool opened once keeps producing deductions forever, in ever-smaller
amounts, and the row that started it keeps mattering forever.

## Defect 1 — disposing of a pooled asset did nothing at all

**This was not a gap in the spec — it was code diverging from one.** `RULES.md` and `PLAN.md` both
described the behaviour as built, in the words above, while `derive()` did not read
`disposal_date` for a pooled row at all.

The pool block read only `treatment === "pool"` and the allocation year. It never looked at
`disposal_date` or `disposal_proceeds`, unlike the scheduled branch directly above it, which
computes a balancing adjustment and routes it to D5 or I24 through `buildLodgment()`.

The asset detail panel *offers* disposal fields for every asset, pooled included, so the sale was
enterable, accepted and silently ignored. `derived.dep` holds scheduled rows only, so the
balancing-adjustment filter in `buildLodgment()` never saw a pooled row.

A $600 dock pooled in FY2024-25, then sold for $400 in FY2025-26 — the two runs are identical:

```
                       before the sale        after entering the sale
FY2025-26  deduction        182.81                   182.81
           closing          304.69                   304.69      (ATO: nil)
FY2026-27  deduction        114.26                   114.26      (ATO: nothing)
FY2027-28  deduction         71.41                    71.41
I24 other income              none                     none      (ATO: $95.31)
```

It over-claimed in perpetuity **and** omitted assessable income. The most serious of the four.

Note the deduction itself is right to stay at $182.81 in the disposal year: the pool deduction is
charged on the **opening** balance, so a mid-year sale does not reduce it. Only the closing balance
moves.

## Defect 2 — a year with no rows breaks scheduled depreciation

Not a pool defect, but the same chaining logic, and worth recording together.

`derive()` carries each asset's adjustable value forward by walking the derived year list in order.
`enteredYears()` adds only the purchase year and start year for an asset, so a scheduled asset
creates none of its own intervening years. Where nothing else anchors them the chain skips, the
value never declines through them, and the next year present takes a full year's decline:

```
gap (only 2024-25 and 2030-31 exist):
  2024-25=1245.21   2030-31=1500.00     ← claims $1,500 four years after it was written off

contiguous:
  2024-25=1245.21   2025-26=1500.00   2026-27=254.79   = $3,000 of $3,000 cost
```

Pools are already immune: `allYears()` gap-fills between the first pool year and the last.
Scheduled assets have no equivalent.

## Defect 3 — "Keep records until" reads as permission to delete a row it is not

`derived.keep` is correct as tax advice — the latest of five years from the last claim, from
disposal, or from the notice of assessment. For a pooled asset it runs from the end of the year of
allocation, which is its own rule and not five years from the pool's last deduction.

But the pool balance is **recomputed from the asset rows every time and never stored**. Deleting a
pooled row silently erases every later year's D6. A pooled asset from FY2015-16, checked on
10 August 2026:

```
keep records until        : 2021-06-30   ← lapsed five years ago
still in M.assets         : 1 row
still claiming in 2025-26 : $3.99
present in exported JSON  : true
```

The row outlived its stated obligation by five years and was still generating a deduction four years
after the date the ledger said you could stop keeping it.

Both things are true and they are different obligations. The ATO rule is about keeping the
**evidence** — the receipt. The ledger separately needs the **row**, indefinitely, or its own
arithmetic changes. A field labelled "Keep records until", sitting in the asset detail panel beside
that row's own data, does not say that.

### Nothing is dropped, ever

`derived.keep` is referenced in exactly two places in the whole app: the read-only display field and
a CSV export column. It never filters, deletes or archives. `saveFile()` writes the entire model
unfiltered by age. The only removals are explicit user actions — `removeRow()` behind a confirm, and
the move-to-expenses path.

### What is actually droppable

| Row type | Effect on a later year | Droppable once retention passes |
| --- | --- | --- |
| **Pooled asset** | keeps setting the pool balance forever | **No** |
| Scheduled asset | none once fully depreciated | Yes |
| Immediate asset (≤$300) | none | Yes |
| Ordinary expense | none | Yes |
| Capital disposal / loss | none — the carry-forward is the typed `cf_capital_loss` on the year record, not derived from the row | Yes |

## Defect 4 — the diminishing-value formula had no tests

`ledger.js` computes `opening × (days/365) × (2/life)`, matching `RULES.md`, and it hand-checks
against a four-year run including a 366-day leap financial year. But the suite contained **zero**
occurrences of `diminishing` against twelve of `prime_cost`: a user-selectable calculation that
changes every figure on a return, exercised by nothing.

It is now pinned by a four-year table — `3000 → 1200 / 720 / 433.18 / 258.73` at a five-year life —
including the leap year, the contrast with prime cost's flat fifth of cost, and that decline never
exceeds what is left to write off.

## The fix, as implemented

### 1. Pool disposals

In the pool block of `derive()`, total the disposals landing in the year — `disposal_proceeds ×
taxable use %` for pooled assets whose `disposal_date` falls in it — then:

```js
const closingBeforeDisposals = opening + additions - deduction;
const excess = Math.max(0, disposals - closingBeforeDisposals);
closing = Math.max(0, closingBeforeDisposals - disposals);
```

`excess` goes to **I24** in `buildLodgment()`, beside the existing balancing-adjustment lines.
`poolAssetClaim()` stops projecting a per-asset share once the asset is disposed of, so the
register no longer shows a contribution for something sold.

### 2. Extend a scheduled asset across its effective life

`allYears()` now derives a scheduled asset's own effective-life years, stopping at a disposal —
the same thing it already did for a pool. This closes the gap without touching the chaining logic.

### 3. Retention honesty

The detail field is now **"Keep evidence until"**, and a pooled asset carries a second read-only
line saying the row stays while the pool has a balance. `removeRow()` asks a question naming the
consequence when the row is load-bearing — every later year's D6 is recomputed without it — and
still allows it. This is a record the user owns.

### 4. Integrity check

A **high** finding fires for any pooled asset carrying a disposal date, naming the asset via
`assetLabel()`: the pool balance and every later year's D6 now reflect the sale, and a year already
lodged on the old figures needs checking. This is the disclosure for defect 1 changing numbers in
years that may already have been lodged.

### 5. The pool is no longer the default

`treatmentFor(cost, poolOpen)` suggests an individual schedule in the low-cost band until a pool has
actually been opened, and the pool once it has — where it is compulsory. `poolIsOpen()` reads the
election off the assets. The optional second argument keeps the rule a pure function of cost in
tests. See the *Treatment suggestion from cost* row in `RULES.md` for the reasoning.

## Verification

Tests belong in the pool section of `personal/ledger.test.js`, near the existing
*a pooled asset claims at D6, and says so* block.

- **Disposal arithmetic:** $600 pooled at 100%, sold for $400 the next year — deduction still
  $182.81, closing **nil**, excess **$95.31** at I24, and the following year claims **nothing**.
  Against the current source this yields $114.26, so the test discriminates.
- A termination value below the closing balance reduces it and produces no I24 line.
- Two pooled assets, one sold: the pool continues on the survivor's share.
- A pooled asset with no disposal behaves exactly as today.
- **Year gap:** the 2-year-life case above must total $3,000 across contiguous years and claim
  nothing in a distant one.
- **Retention:** `removeRow` on a pooled asset with a live balance asks the specific question.
- **Check:** a disposed pooled asset raises the high finding and names the asset, not its ID.

```
node personal/build-ledger.js         # ledger.html is generated — never hand-edit
node personal/ledger.test.js          # expect > 641 passed, 0 failed
node personal/build-ledger.js --check # expect "in sync"
```

## Sources

- [Low-value pool](https://www.ato.gov.au/businesses-and-organisations/income-deductions-and-concessions/depreciation-and-capital-expenses-and-allowances/general-depreciation-rules-capital-allowances/low-value-assets-pool) — the rates, the balancing adjustment, and the excess to item 24
- [D6 Low-value pool deduction 2026](https://www.ato.gov.au/forms-and-instructions/individual-tax-return-2026-instructions/deduction-questions-d1-d10-individual-tax-return-2026/d6-low-value-pool-deduction-2026)
- [Keeping records for depreciating assets](https://www.ato.gov.au/individuals-and-families/income-deductions-offsets-and-records/deductions-you-can-claim/work-related-deductions/tools-computers-and-items-you-use-for-work/depreciating-assets-you-use-for-work/keeping-records-for-depreciating-assets)
