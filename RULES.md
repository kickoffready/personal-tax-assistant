# Rules the ledger encodes

`ledger.html` hardcodes a small number of values that are **law, not preference**. This file
is the spec for them: what each one is, which income years it applies to, where it came from,
and what to do when it changes.

Making them configurable would only let you quietly get them wrong, so they are constants.
The cost of that choice is this document — when a rate changes, three things must move
together, and a test is there to stop you moving only one.

> **Verified against ato.gov.au on 6 August 2026.** Reverify each tax time.

## The constants

| Constant | Value | Applies to | Rule |
| --- | --- | --- | --- |
| `WFH_FIXED_RATE` | `0.70` | 2024–25, 2025–26 | 70c per hour worked from home. Covers energy, home and mobile phone, internet and data, stationery and computer consumables — none of which may then be claimed separately. Requires a record of **actual hours across the whole year**, kept as you went. |
| `IMMEDIATE_THRESHOLD` | `300` | ongoing | An item costing $300 or less, used mainly to produce non-business income, is deductible immediately. |
| `POOL_CEILING` | `1000` | ongoing | An item costing under $1,000 is a low-cost asset and may go to the low-value pool. |
| `POOL_FIRST_YEAR` | `0.1875` | ongoing | 18.75% in the year of allocation, **regardless of when in the year it was bought**. No part-year apportionment. |
| `POOL_ONGOING` | `0.375` | ongoing | 37.5% diminishing value thereafter. |
| `EFFECTIVE_LIVES` | 2 / 3 / 4 yrs | ongoing | Commissioner's determinations: laptop and tablet 2, mobile phone 3, desktop 4. Self-assessing a shorter life is permitted but must be justifiable. |
| CGT discount | `0.5` | until 30 Jun 2027 | 50% for assets held at least 12 months by a resident. **Replaced from 1 July 2027** — see below. |

### Rules with no constant, implemented as logic

| Rule | Where | What it does |
| --- | --- | --- |
| Work-use unit | `workPctFor()` / `wpFrac()` | Stored and entered as a **percentage 0–100**, never a fraction. `wpFrac()` converts where the arithmetic needs a multiplier. Schema 1 files stored fractions; `migrate()` multiplies by 100 on load and bumps to schema 2. Note `WFH_FIXED_RATE` (0.70) is **70c per hour**, not a percentage — it must not be converted. |
| Work use before it was recorded | `workPctFor()` | A percentage set in a later year applies backwards to earlier years the asset was held. Falling through to 100% silently claimed the full cost — reachable by moving a purchase date back a year. |
| One service, one percentage | `setField()` / `setGroupField()` | Setting work use on any expense applies it to every charge from the same supplier in that year. Apportionment is a property of the service, not the charge. |
| Treatment from cost | `treatmentFor()` | ≤$300 immediate · $301–999 pool · ≥$1,000 individual schedule. The test is the item's **cost**, never the work-use share. |
| Prime cost | `derive()` | `cost × (days held ÷ 365) × (100% ÷ effective life)` |
| Diminishing value | `derive()` | `opening × (days held ÷ 365) × (200% ÷ effective life)` |
| CGT ordering | `computeCGT()` | Current-year losses first, applied to gains **not** eligible for the discount before those that are; then carried-forward losses; then the 50% discount. Order matters: a dollar of loss offsets a full dollar of undiscounted gain but effectively only 50c of a discounted one. |
| Balancing adjustment | `derive()` | On disposal, proceeds against remaining adjustable value. Above it is assessable at item 24, below it is deductible at D5. |
| Retention | `derive()` | The later of: 5 years from lodgment, 5 years from the **last claim for decline in value**, and for a CGT asset 5 years after no CGT event can happen. |
| Retention, pooled assets | `derive()` | Its own rule: 5 years from the **end of the income year the asset was allocated to the pool** — not from the purchase date, and not from the pool's last deduction. A pool keeps deducting for a decade; the record obligation for one asset in it does not. The same end-of-year base is used for immediate write-offs, which also produce no per-asset claim row. |
| Import identity | `rowKeys()` | A row carries two identities: `source`+`source_ref` when a converter supplies them, and a hash of the fields that define the charge (date · supplier · amount). A match on **either** is a duplicate, so converters that do and do not emit transaction IDs still recognise the same charge. `gmail` is the first such source, using the Gmail message ID — unique and permanent within an account, so re-running the converter cannot double-claim. The fallback can only err toward treating two identical same-day charges as one — under-claiming is recoverable, double-claiming is an amendment. |
| Category taxonomy is split by kind | `CATEGORY_HINTS` / `suggestCategory(…, kind)` | Expenses and assets draw from **separate** category lists and separate pickers. An expense is a service consumed in a period; an asset is a thing that still works next year. A phone bill can never be *Computers*, a laptop can never be an *Information service*. Precedence: whatever you called that supplier last time, then the hint table for that kind, then nothing. |
| Asset entered as an expense | `runChecks()` / `ASSET_SHAPED` | An expense carrying a thing-shaped category (computers, peripherals, furniture, tools…) above the $300 immediate threshold is flagged. It reads like a depreciating asset in the wrong collection, where it claims its whole cost this year instead of being pooled or scheduled. The split taxonomy is what makes this detectable. |
| Category vs label | `categoryOf()` / `suggestCategory()` | The **label** (D5, D6…) is the ATO's and decides which question the money answers. The **category** is yours and decides how the line reads — suppliers roll into a category, categories are what the return shows. Free text, seeded from `CATEGORY_HINTS` and from whatever you called that supplier last time. A row with no category reports under its supplier, so an old ledger is unchanged. Supplier subtotals stay visible beneath each category line: a total nobody can decompose is a total nobody can defend. |
| Cross-source duplicates | `supplierIndex()` / `runChecks()` | The same spending from two sources cannot be matched at field level: a card statement carries different merchant text, a different date, and often a different shape (one grouped row against twelve monthly ones). So the **overlap itself** is the signal — a supplier with rows from more than one source in a year raises a high warning, and the import preview says so while cancelling is still free. Suppliers are compared normalised, so `Optus` and `OPTUS PTY LTD` are one. Rows entered by hand count as their own source. The rule this enforces: **one source per supplier**. |
| Import never replaces | `planImport()` / `applyImport()` | **Open** replaces the ledger; **Import** merges. Existing rows are never overwritten, colliding `id`/`asset_id` values are re-keyed, and a year record you have already set up is left alone. Every import is previewed with counts before it is applied. |
| Pool is one-way | `runChecks()` | Once a pool exists, later low-cost assets must be pooled. Flagged, not silently corrected. |
| Financial year | `fyOf()` | 1 July to 30 June. A 30 June transaction belongs to the year ending that day. |

### Deliberately not encoded

Marginal rates and the Medicare levy are **entered per year**, not hardcoded, because the
correct rate depends on taxable income and brackets change. The ledger only checks that the
figure you enter looks like it includes the 2% levy — a bare `0.30` or `0.37` raises a warning.

## Changing a rate

Three things move together:

1. **This file** — value, income years, and the date you reverified it.
2. **The constant** in `ledger.html`, whose comment cites the same source.
3. **`ledger.test.js`** — a test will already be failing. Update the expected figure only once
   you have confirmed the new value against ato.gov.au, never to make the suite green.

Run `node personal/ledger.test.js` after any change. It exits non-zero on failure.

The suite is mutation-tested: breaking `WFH_FIXED_RATE`, `POOL_FIRST_YEAR` or
`IMMEDIATE_THRESHOLD` each produces failures, so a silent rate drift is not possible.

## Known upcoming changes

Already legislated, and none of it applies to a 2025–26 return.

| From | Change | Effect on the ledger |
| --- | --- | --- |
| 1 Jul 2026 | The 16% marginal rate falls to 15%; 14% from 1 July 2027. | None structural — rates are entered per year. |
| 1 Jul 2026 | **Standard deduction of up to $1,000** for work-related expenses. Optional: if actual work expenses exceed $1,000, claim them the usual way instead. Investment expenses, donations, union fees and income protection premiums remain claimable **on top**. | Significant. The lodgment view will need to compare the standard deduction against itemised work expenses and recommend the better path, while keeping the claimable-on-top categories separate. |
| 1 Jul 2026 | Medicare levy surcharge and private health rebate thresholds rise. | None — not modelled. |
| 1 Jul 2027 | **The 50% CGT discount is replaced** for individuals with cost base indexation plus a 30% minimum tax on real gains. Gains accrued before that date keep the discount. | Significant. `computeCGT()` will need to split a gain at 1 July 2027 and apply different treatment either side. |

The 2027 CGT change is the one to plan for. It is not a rate tweak — it changes the shape of
the calculation, and the transitional split means an asset held across the date needs both
methods applied to different portions of the same gain.

---

*General research only, current to August 2026 and specific to Australian resident individuals.
Not personal tax, financial or legal advice. Confirm anything you act on against
[ato.gov.au](https://www.ato.gov.au) or a registered tax agent.*
