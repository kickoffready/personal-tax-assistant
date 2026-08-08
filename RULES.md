# Rules the ledger encodes

`ledger.html` hardcodes a small number of values that are **law, not preference**. This file
is the spec for them: what each one is, which income years it applies to, where it came from,
and what to do when it changes.

Making them configurable would only let you quietly get them wrong, so they are constants.
The cost of that choice is this document — when a rate changes, three things must move
together, and a test is there to stop you moving only one.

> **Verified against ato.gov.au on 8 August 2026.** Reverify each tax time.

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
| Pooled taxable use | `poolTaxablePct()` / `setAssetWorkPct()` | A pooled asset uses one reasonable taxable-use estimate made when it is allocated, covering its effective life. It cannot vary by year. The pool control always edits that allocation estimate and removes redundant later percentages. |
| One service, one percentage | `setField()` / `setGroupField()` | Setting work use on any expense applies it to every charge from the same supplier in that year. Apportionment is a property of the service, not the charge. |
| Treatment from cost | `treatmentFor()` | ≤$300 immediate · $301–999 pool · ≥$1,000 individual schedule. The test is the item's **cost**, never the work-use share. |
| Prime cost | `derive()` | `cost × (days held ÷ 365) × (100% ÷ effective life)` |
| Diminishing value | `derive()` | `opening × (days held ÷ 365) × (200% ÷ effective life)` |
| CGT ordering | `computeCGT()` | Current-year losses first, applied to gains **not** eligible for the discount before those that are; then carried-forward losses; then the 50% discount. Order matters: a dollar of loss offsets a full dollar of undiscounted gain but effectively only 50c of a discounted one. |
| Balancing adjustment | `derive()` | On disposal, proceeds against remaining adjustable value. Above it is assessable at item 24, below it is deductible at D5. |
| Pooled disposal | `derive()` / `buildLodgment()` | In the disposal year, taxable-use percentage × termination value reduces the closing pool balance after the year's deduction. The pool cannot go below zero; any excess is assessable at item 24. |
| Retention | `derive()` | The later of: 5 years from lodgment, 5 years from the **last claim for decline in value**, and for a CGT asset 5 years after no CGT event can happen. |
| Retention, pooled assets | `derive()` | Its own rule: 5 years from the **end of the income year the asset was allocated to the pool** — not from the purchase date, and not from the pool's last deduction. A pool keeps deducting for a decade; the record obligation for one asset in it does not. The same end-of-year base is used for immediate write-offs, which also produce no per-asset claim row. |
| Import identity | `rowKeys()` | A row carries two identities: `source`+`source_ref` when a converter supplies them, and a hash of the fields that define the charge (date · supplier · amount). A match on **either** is a duplicate, so converters that do and do not emit transaction IDs still recognise the same charge. `gmail` is the first such source, using the Gmail message ID — unique and permanent within an account, so re-running the converter cannot double-claim. The fallback can only err toward treating two identical same-day charges as one — under-claiming is recoverable, double-claiming is an amendment. The `source`+`source_ref` key is checked against the **whole ledger**, not one collection: a charge that arrived as an expense and was corrected into an asset keeps its `source_ref`, and the converter's next run must recognise it where it now lives. Checking per collection re-added it, and the ledger claimed one purchase twice under two labels. |
| Moving a row between collections | `sendToAssets()` / `sendToExpenses()` | The collection decides *which year* the money is claimed. The move exists to correct rows a **converter** classified by rule — `IMPORT-FORMAT.md` sends anything over $300 it cannot resolve to `assets`, and that bias is only defensible because this undoes it. It belongs to recorded rows, not to entry: the buttons sit on the table row, never on the entry row, because someone typing by hand has already chosen the tab. **Every row is correctable, both ways, without expanding anything** — including a group of several charges, which moves as one asset row per charge because the $300 test applies to each item and not to the receipt. The size of a group is not evidence: twelve $25 charges are a phone plan, two $29 charges are two cables, and nothing in the data distinguishes them. The tool suggests at import and never overrules the correction. Three things are **re-derived, never carried**, because they mean different things on either side: `treatment` (computed from cost by `treatmentFor()`), `category` (the taxonomies are disjoint — see the row below), and the shape of `work_pct` (a bare number on an expense, an object keyed by financial year on an asset — and an asset missing it is read as **100%**). Everything that identifies or substantiates the row survives: date, amount, supplier, issuer, source, source_ref, work use, basis. A **disposed** asset refuses to move — its balancing adjustment is computed from fields an expense row cannot hold. An already-assessed year and a pooled asset leaving the pool are flagged with their consequence, then allowed, as everywhere else. |
| Category taxonomy is split by kind | `CATEGORY_HINTS` / `suggestCategory(…, kind)` | Expenses and assets draw from **separate** category lists and separate pickers. An expense is a service consumed in a period; an asset is a thing that still works next year. A phone bill can never be *Computers*, a laptop can never be an *Information service*. Precedence: whatever you called that supplier last time, then the hint table for that kind, then nothing. |
| Asset entered as an expense | `runChecks()` / `ASSET_SHAPED` | An expense carrying a thing-shaped category (computers, peripherals, furniture, tools…) above the $300 immediate threshold is flagged. It reads like a depreciating asset in the wrong collection, where it claims its whole cost this year instead of being pooled or scheduled. The split taxonomy is what makes this detectable. |
| D6 attribution | `derive()` / `buildLodgment()` / `poolAssetClaim()` | The pool deduction splits in two for lodgment. The **first-year 18.75%** is each asset's own — cost × work use × 18.75% — so it reports by category. The **ongoing 37.5%** is legally charged on the combined balance and reports as one line, *pool balance brought forward*; it is not split into invented return categories. The Assets view may still show each row's mathematical contribution by rolling its original addition forward at the same rates. Those row values reconcile to, but never replace, the one D6 total. |
| Pool year population | `allYears()` | Allocating an asset to the pool automatically derives the allocation year and the following four income years. These five years make the pool roll-forward visible without five manual "Start FY" actions; they are calculated output and are not persisted as year records. |
| Category vs label | `categoryOf()` / `suggestCategory()` | The **label** (D5, D6…) is the ATO's and decides which question the money answers. The **category** is yours and decides how the line reads — suppliers roll into a category, categories are what the return shows. Free text, seeded from `CATEGORY_HINTS` and from whatever you called that supplier last time. A row with no category reports under its supplier, so an old ledger is unchanged. Supplier subtotals stay visible beneath each category line: a total nobody can decompose is a total nobody can defend. |
| Cross-source duplicates | `supplierIndex()` / `runChecks()` | The same spending from two sources cannot be matched at field level: a card statement carries different merchant text, a different date, and often a different shape (one grouped row against twelve monthly ones). So the **overlap itself** is the signal — a supplier with rows from more than one source in a year raises a high warning, and the import preview says so while cancelling is still free. Suppliers are compared normalised, so `Optus` and `OPTUS PTY LTD` are one. Rows entered by hand count as their own source. The rule this enforces: **one source per supplier**. |
| Import never replaces | `planImport()` / `applyImport()` | **Open** replaces the ledger; **Import** merges. Existing rows are never overwritten, colliding `id`/`asset_id` values are re-keyed, and a year record you have already set up is left alone. Every import is previewed with counts before it is applied. |
| Pool is one-way | `runChecks()` | Once a pool exists, later low-cost assets must be pooled. Flagged, not silently corrected. |
| Financial year | `fyOf()` | 1 July to 30 June. A 30 June transaction belongs to the year ending that day. |
| A blank work-use box is not a zero | `entryPct()` | The entry rows default work use to 100%, so the box has to distinguish *empty* from *typed 0*. `num(v) \|\| 100` cannot — it read an explicit `0` as absent and filed the row at 100%, claiming the whole amount for something the user had just said was not work-related. The default applies only to an empty box. |
| Converters route on the $300 hinge | `personal/IMPORT-FORMAT.md` | A converter chooses `assets` or `expenses`, and that choice decides *which year* the money is claimed. Below $300 both collections claim the whole amount in the same year, so the question does not arise and the row goes to `expenses`. Above $300 a **thing** goes to `assets`, and so does a row the converter **cannot classify** — a thing wrongly expensed claims its full cost this year (an over-claim, and an amendment), while a service wrongly capitalised only under-claims and is fixed by moving the row. The issuer never decides the kind: Apple bills both a cloud plan and a MacBook. |
| Imported assets must carry `work_pct` | `workPctFor()` | An asset with no `work_pct` is read as **100%**, the only default in the ledger that errs toward over-claiming, and an import is the way it is reached — `addAsset()` always sets one, a converter may not. Asset `work_pct` is an object keyed by financial year (`{"2025-26": 0}`), unlike an expense's bare number. Converters emit `0`, as everywhere else: a parse result is not a claim decision. |

### Interface rules that are load-bearing

These change no number, but each was a defect before it was a rule, and each has a test.

| Rule | Where | What it does |
| --- | --- | --- |
| An action label names the destination, never the count | `TO_ASSETS` / `TO_EXPENSES` / `DELETE_LABEL` | Six call sites wrote these strings by hand, and the group button pluralised itself by group size — `→ asset` on a one-charge group, `→ assets` on the next. A column of identical actions then looks ragged, which reads as a fault rather than as information; the count is already in the `× N` beside the supplier, in the tooltip and in the confirmation. They are constants so a column cannot go ragged one call site at a time, and `ledger.test.js` asserts the distinct vocabulary of each action column: Expenses `del` + `→ Assets`, Assets `del` + `→ Expenses`, Income `del`. |
| Every row offers every action it can | `groupHTML()` / `renderAssets()` | An action reachable only by expanding a group is an action most people never find — putting the move on detail rows alone left every collapsed header with an empty cell and the tab looking as though it had none. Group headers carry the same actions as the charges behind them, scoped to the whole group, and the tests assert no row is left without one. |
| Handler arguments are escaped for JavaScript **before** HTML | `jsStr()` | `esc(x).replace(/'/g,"\\'")` is the wrong order and was used at five call sites: `esc()` turns `'` into `&#39;` first, so the replace matches nothing, and the browser hands a bare quote back to the parser when it decodes the attribute. A supplier called `Dan's Cafe` broke the work-use box, both pickers and the expand toggle on its own row. Escape for JS, then for HTML. |

### Deliberately not encoded

Marginal rates and the Medicare levy are **entered per year**, not hardcoded, because the
correct rate depends on taxable income and brackets change. The ledger only checks that the
figure you enter looks like it includes the 2% levy — a bare `0.30` or `0.37` raises a warning.

**Sets and substantially identical items are not detected, and this over-claims.** Both
thresholds above are defeated when an item is one of a set, or one of several substantially
identical items begun to be held in the same income year, whose **total** cost crosses the
line. `treatmentFor()` only ever sees one item's cost, so:

| Twelve $29 USB-C cables, same day | Total | Claimed year one |
| --- | --- | --- |
| what the ledger does | $348.00 | **$348.00** at D5, no warning |
| what the rule requires | $348.00 | **$65.25** at D6, pooled |

A $282.75 over-claim, silently. Two cables at $58 are genuinely fine — the rule only bites
once the aggregate passes $300. The comment at `ledger.html:299` has always stated the rule;
nothing acts on it. Until something does, check any repeat purchase of identical items by
hand before lodging.

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
