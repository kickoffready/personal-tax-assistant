# Static ledger tool for the tax repo

> **Status:** built. `personal/ledger.html` implements this design; its ledger test suite passes.
> **Written:** 6 August 2026

## Context

The repo currently holds three static documents: a FY2025–26 filing playbook (`personal/index.html`), an abstracted remediation runbook (`personal/runbook.html`), and a bookkeeping system design (`personal/bookkeeping-runbook.html`), plus an SMSF brief (`super/index.html`). All describe a process. None of them *do* anything.

The underlying problem is the shape of a long-running `.xlsx` with one wide sheet per financial year: **nothing persists across tabs except by retyping.** The errors that follow are structural rather than careless, and they recur in workbooks of this kind — assets over $300 expensed immediately because nothing carries depreciation forward; capital losses that never reach the lodged return because carry-forward is manual; currency columns mixing a rate and its reciprocal; capital-gains blocks cloned between year-tabs and never refreshed; a marginal-rate multiplier that omits the Medicare levy. Reorganising the same year-tab layout cannot fix any of them.

**Is the proposed plan a good one? Yes — with one correction.**

The direction is right. Form-label-first entry and year-over-year roll-forward are precisely the two things a year-tab spreadsheet fails at, and multi-year stateful computation is what code does well and spreadsheets do badly.

The correction is to the memory model. "Export so it can resume next year" implies the browser holds state and export is a secondary action. That inverts the durability: `localStorage` is per-browser and per-origin, is wiped by "clear browsing data", behaves inconsistently on `file://` origins across Safari and Chrome, is invisible to inspection, and is in no backup or lodgment snapshot. Records here must survive 5 years from lodgment, 5 years from the *last* decline-in-value claim for a depreciating asset, and 5 years after no CGT event can happen — which for a long-held share parcel is two decades.

So: **the exported file is the system of record, and the browser is a calculator over it.** Open → load ledger → work → save ledger. `localStorage` is demoted to crash-recovery autosave, labelled as such in the UI and never authoritative.

Scope decisions: the tool runs **parallel to the spreadsheet for one income year** before taking over; **v1 covers the full ledger**; export is **JSON + CSV** (no zip writer, no library); the tool is a **separate file**, and `personal/bookkeeping-runbook.html` remains the process guide.

## Architecture

The distributable is a single self-contained `personal/ledger.html`: no runtime dependencies,
no network, and no build step for its user. It opens from `file://` or can be served from GitHub
Pages. For maintainability, its behaviour is edited in `personal/ledger.js` and inlined into the
tracked HTML artifact by the dependency-free `personal/build-ledger.js`; there are still no
modules, imports, bundler or package dependencies. It remains scoped to the individual return —
the SMSF is a separate area with its own records and reporting.

**Store inputs, derive outputs.** Persist only what a human typed. Everything computed — depreciation rows, `claimed` amounts, AUD conversions, pool balances, lodgment totals — is recalculated on load. A bug fix or schema change then corrects historical years automatically instead of leaving stale numbers behind. This is the single most important design rule in the build.

```
ledger.json  (the record — lives in cloud storage alongside the workbook)
   ↓ load                              ↑ save
   personal/ledger.html  (stateless calculator)
   ↓ export
ledger-FY2025-26-{assets,expenses,income,lodgment}.csv  (archive)
```

### Data model (`schema: 5`)

Mirrors the schemas already documented in `personal/bookkeeping-runbook.html` §02, so the doc and the tool stay in agreement — that section becomes the normative spec.

| Collection | Persisted | Notes |
|---|---|---|
| `years[]` | yes | `year`, `marginal_plus_levy`, `estimated`, `assessed`, `variance`, `noa_date`, `cf_capital_loss` |
| `assets[]` | yes | `asset_id`, `item_supplier`, `purchase_date`, `start_date`, `cost`, `treatment`, `effective_life`, `method`, `work_pct{}`, `category`, `disposal_date`, `disposal_proceeds` |
| `expenses[]` | yes | `date`, `supplier`, `amount`, `work_pct`, `label`, `category`, `basis`, `evidence` |
| `income[]` | yes | `date`, `type`, `holding`, `gross_foreign`, `currency`, `fx_rate`, `tax_withheld_aud`, `franked`, `unfranked`, `credit` |
| `depreciation[]` | **no — derived** | one row per asset per year held |
| `pool{}` | **no — derived** | low-value pool balance by year |
| `keep_until` | **no — derived** | from the three retention rules |

`asset_id` (`A-2026-014`) is the join key between register, depreciation and evidence filename. `label` (`D1`–`D15`, income items) is what makes lodgment a filtered sum.

### Calculation engine

- **Prime cost**: `cost × (days from first use ÷ 365) × (100% ÷ effective_life)`; **diminishing value** as the alternative, fixed when chosen.
- **Treatment suggested from cost, not deductible percentage**: ≤$300 immediate-deduction candidate (D5) · under $1,000 pool-eligible (D6) · otherwise an individual schedule (D5). The register explains that cost alone does not prove the conditions, and the suggestion remains editable in Details.
- **Low-value pool**: 18.75% in the year of allocation regardless of date, 37.5% diminishing thereafter. One taxable-use estimate is fixed at allocation. Disposal proceeds at that percentage reduce the closing balance, with any excess reported as income. Enforce the one-way rule — once a pool exists, later low-cost assets must be pooled.
- **CGT ordering**: current-year losses (preferring non-discountable gains) → carried-forward losses oldest-first → *then* the 50% discount.
- **Retention**: `keep_until` = latest of lodgment + 5y, last decline claim + 5y, and for CGT assets disposal + 5y.
- **Roll-forward**: "Start FY2026–27" carries closing → opening, pool balance, and unused capital loss; assets persist untouched.

### What is automated, and what is not

The boundary: **arithmetic and hard rules are computed; judgement stays with the user, but is recorded once and carried forward.** Overstating this is how a tool becomes untrustworthy, so the UI must be explicit about which is which.

| Automatic — rule or arithmetic | Suggested — visible and editable | Manual — always the user's |
|---|---|---|
| Decline in value, prime cost or DV, part-year by days held | Treatment from cost; effective life from the item portion of `item_supplier` | Whether the $300 conditions are met and whether to use the pool |
| Opening/closing balances and roll-forward | Expense Tax purpose from supplier, then remembered per supplier | Deductible % (required explicitly for a new manual row) |
| | | Hours worked from home |
| Pool: 18.75% then 37.5% | | Whether an expense relates to earning income at all |
| `claimed = amount × work_pct` | | |
| `gross_aud = gross_foreign × fx_rate` | | |
| Depreciation label (D5 or D6) from treatment | | |
| `keep_until` from the three retention rules | | |
| Grouping, sorting and **totalling by label** | | |
| CGT ordering — losses before discount | | |
| Marginal rate + 2% Medicare levy | | |

Three consequences worth building for:

- **A scheduled asset's work-use % may change by year.** It carries forward; a change without a corresponding `basis` note raises an integrity warning.
- **A pooled asset has one taxable-use estimate, not yearly work-use inputs.** It is made when the asset enters the pool and cannot be varied later. The register therefore edits the allocation estimate from every year rather than storing percentages that do nothing.
- **Under the 70c fixed rate there are no percentages at all** — hours replace them, and energy, phone, internet and stationery are covered by the rate. The tool must make the fixed-rate/actual-cost choice explicit per year and then hide the irrelevant inputs, rather than asking for both.

### Claim-first asset entry

The default Assets view contains only the everyday inputs and payoff: `Item — Supplier`,
purchase date, cost, Deductible %, how it is claimed and the current-year deduction. The
separate/custom category editor, first-use date, basis, calculation settings, disposal and
retention remain in the expandable asset record because they support lodgment or substantiation, but they do not compete with the claim
inputs. A field that supports neither is not demoted, it is removed: `serial`, `evidence`,
`taxable_income` and `payg_withheld` were stored and then read by nothing, and schema 3 drops
them on load. `status` is not stored for new rows or shown: a disposal date is the single event input.
Opening value, decline and closing value are derived audit output and live in the expanded
schedule rather than being repeated across the main register.

### Views

1. **Lodgment** — the payoff. One line per `D1`–`D15` and income item, showing the single total to type into myTax, with the supporting rows expandable beneath and copy-to-clipboard per line. Lodgment becomes transcription rather than re-derivation.

   ```
   D5  Other work-related expenses      $2,847.20   [copy]
         ├ working from home (fixed rate, 1,043 hrs)
         ├ depreciation — 3 assets
         └ union fees
   D6  Low-value pool                     $412.50   [copy]
   D9  Gifts or donations                 $180.00   [copy]
   ```
2. **Assets** — claim-first register; record-only metadata and the per-year depreciation trace expand beneath each asset.
3. **Expenses** — supplier-led register, grouped by supplier, with a plain-language Tax purpose.
4. **Income** — dividends split franked/unfranked/credit, foreign gross + FITO, disposals.
5. **Year** — reconciliation against the assessment; NOA date drives an amendment-window countdown.
6. **Data** — load, save, CSV export, autosave status, integrity report.

### Supplier-led expenses

An expense is identified by **who you bought from**. "Acme Cloud Plus" then "Cloud Plus storage
(200GB)" is the same fact written twice, so schema 4 drops an expense's `description`
entirely — the supplier leads the table and is required on entry. For a legacy expense with
no supplier, migration first preserves its description as the supplier rather than discarding
the row's only identity. Schema 5 joins an asset's
legacy `description` and `supplier` into one `item_supplier` value displayed as
`Item — Supplier`. The final exact separator preserves the two meanings without making a
person type or reconcile two identity fields: the item side drives effective-life and asset
category hints; the supplier side drives source overlap and conversion to Expenses.

Supplier is not merely a label: it is the group key, the lodgment breakdown line, half the
import identity in `rowKeys()`, and the only input left for guessing a label and a
category. A charge without one is a charge nothing downstream can reason about, so
`addExpense()` refuses it.

Two consequences were paid for deliberately. The work-from-home checks — the 70c
double-dip and the non-qualifying water/rates test — used to match typed description text;
they now read `category + supplier` via `runHay()`, which is a controlled vocabulary
rather than free text, and two categories (`Energy`, `Water and council rates`) exist so
those checks have something to read. And **`basis` has no input**: converters write it,
the → asset move carries it, the CSV exports it, and a new integrity check reports any row
whose basis starts with `review` — naming the reason, not just the count, because "needs a
rate" and "receipt not itemised" want different fixes.

Every row of the table is the same width and every cell holds one control, so the entry
row reads as the first row of the register rather than a form beside it. `ledger.test.js`
asserts the column counts match across the header, add, group and item rows.

Assets and Expenses share the same seven headings: **Item / supplier, Date, Amount,
Deductible %, How claimed, FY deduction and Actions**. For an asset, those core fields are
the item and receipt supplier, purchase date, cost, and one combined asset claim purpose. For
an expense, they are the supplier, charge date, amount of each charge and one Tax purpose.
Both How claimed cells use the same single-selector contract and put the return code first:
`D6 · Peripherals — low-value pool` for an asset follows the same display pattern as
`D5 · Phone, internet and data` for an expense. Every recorded Assets and Expenses row
shows Details, send-to and delete directly. Details holds advanced tax, disposal and
individual-charge editing; it is never a prerequisite for correcting an imported row.

A grouped Expense action applies to the whole visible supplier group. This makes a large
duplicated or wrongly classified JSON import reversible without opening groups one at a time.
Move and delete confirmations name the affected count and amount before changing the ledger.
Expanded individual charges retain their own correction actions for granular cleanup.

The Expenses Date cell also accepts a monthly repeat count. It expands into one ordinary row
per charge rather than storing a recurrence rule, so every charge keeps a real date and the
existing grouping, editing, import identity and lodgment calculations stay unchanged. Each
generated date owns its financial year; repeats crossing 30 June split naturally, while the
view stays put and the confirmation names the affected year or years.

Tax purpose is a plain-language wrapper over the existing expense `category` and `label`.
Choosing one writes both values together without changing the schema; custom categories and
the applicable ATO return-section picker remain available under Advanced tax fields. Supplier hints
are suggestions only. A manual Deductible % is never suggested or defaulted.

The shared selector presentation does not merge the taxonomies. Asset categories such as
Computers, Peripherals and Furniture appear only in Assets. Expense purposes such as
Information services or Donations appear only in Expenses. Assets continue to store category
and treatment separately because both drive calculations; the register combines them only
for a consistent human-readable display. The implementation checker renders both tabs and
fails if their headers, widths, one-field identity, How claimed selector contract or everyday
actions diverge.

Return sections remain visible beside the plain language. Asset treatments show D5 or D6,
and every Expense purpose shows its applicable D-code. The interface may explain a code but
must not hide it, because it is the direct link between the register and myTax.

### Undoing an import

Import is the one place data arrives that nobody typed, and the file can be the wrong account,
the wrong year or the wrong export entirely. Because `applyImport()` only ever pushes — no
existing row is modified, replaced or removed, and a year you already set up is never queued —
undo is the exact inverse: **remove what the import added, and nothing you own**. Rows you
typed, edits you made and year settings you changed all survive it.

`lastImport` records `{at, from, summary, added:{expenses,income,assets,years}}`, holding the
row **ids** captured *after* `applyImport` re-keys any that collided — read them earlier and
undo hunts for rows under names they no longer have. Ids rather than object references also
mean the record survives JSON, so it rides along in the autosave slot and an undo is still
there after a refresh or a crash. Nothing is stamped on the rows themselves: the saved
`ledger.json` is byte-identical before an import and after undoing it.

The control is a banner in the `#recovery` slot, stacking under the recovered-draft banner
rather than replacing it, since crashing straight after a bad import is one situation and not
two. **Keep them** retires the banner, and with it the undo — dismissing is a decision that the
rows are right. Opening a file, `resetAll()` and `discardRecovery()` all clear the record,
because an undo pointing into a ledger that is no longer loaded would be a lie.

The income-year picker in the top bar is not only a filter — `work_pct[activeYear]` and every
field on the Year tab write to whichever year is showing — so it carries a lock. One click
jumps to the **reporting year** and pins the dropdown there.

The reporting year is the one that has *finished*, not the one the calendar is in:
`reportingYear()` = `fyPrev(fyOf(today))`, so from 1 July 2026 it is FY2025-26 — the return
being prepared — even though the date is inside FY2026-27. It is disabled when that year has
nothing recorded in it yet, rather than pinning some other year instead.

The lock persists per-browser with the year it was set on, and is only restored alongside that
year. It never silently re-points: the moves that are announced rather than accidental still
get through — rolling forward carries the lock to the year it creates, opening a file drops it,
and a locked year that disappears drops it.

### Integrity checks

The failure modes above become guardrails, which is how the tool earns trust:

- asset over $300 marked `immediate`
- expense duplicating a category already covered by the 70c fixed rate
- expense outside the five permitted WFH running-expense categories
- `fx_rate` values appearing on both sides of 1.0 (mixed conventions)
- income rows identical across years (stale copy-forward)
- `marginal_plus_levy` that looks like a bare marginal rate
- capital loss in a year with no `cf_capital_loss` recorded
- amendment window closing within 90 days

### Parallel-year reconciliation

A panel in the Year view that accepts the xlsx-derived totals per label and shows the difference against the tool's figures. This is the mechanism that proves the tool before it takes over for FY2026–27.

## Build stages

Each stage leaves the file working and testable.

| Stage | Delivers |
|---|---|
| A | Data model, load/save, autosave, CSV export, Data view — the skeleton that guarantees no data loss |
| B | Assets view, depreciation engine, low-value pool, `keep_until` |
| C | Expenses view, D1–D15 label mapping |
| D | Income view, FX handling, CGT ordering |
| E | Lodgment view, integrity checks, roll-forward |
| F | Reconciliation panel |

## Files

- `personal/ledger.html` — the generated standalone tool users open. Nothing publishable lives at the repo root.
- `personal/ledger.js` — the editable source for the tool's behaviour.
- `personal/build-ledger.js` — inlines that source into the tracked HTML artifact; `--check` detects drift without writing.
- `README.md` and root `index.html` — orientation only; the root index is a directory that links out.
- `.gitignore` — carries `ledger*.json`, `*.csv` and `evidence/`.
- `personal/bookkeeping-runbook.html` §02 is the normative schema the tool implements.

The tool reuses the design tokens shared across the repo (the `--paper`/`--ink`/`--accent` set and
the Iowan/system/mono stack) so it reads as part of the same collection.

## Verification

1. **Correctness against a known case** — enter a set of assets with known-correct schedules and confirm the tool reproduces them, including the carried deductions a year-tab structure discards.
2. **Round-trip** — export JSON, clear all state, re-import, export again; the two files must be identical.
3. **Roll-forward** — create the following year and confirm every opening value equals the prior closing, the pool balance carries, and the unused capital loss carries.
4. **Derivation** — hand-edit a `work_pct` in the JSON, reload, and confirm every dependent figure recomputes rather than persisting stale.
5. **Integrity** — feed each known-bad pattern (over-$300 immediate, mixed FX, duplicated income rows) and confirm the matching warning fires.
6. **Automation boundary** — confirm nothing invents a Deductible %; blank and out-of-range manual values are rejected; suggestions stay editable; a % set once carries forward across years; changing it without a `basis` note warns; and selecting the fixed rate for a year hides the per-category percentage inputs rather than asking for both.
7. **Generated artifact** — run `node personal/build-ledger.js --check`; the test suite also compares the embedded script with `personal/ledger.js` and rejects missing, duplicate or unsafe build markers.
8. **Lodgment totals** — every label total must equal the sum of its expanded supporting rows, and match a hand-check for at least one label.
9. **Durability** — open from `file://` in both Safari and Chrome; confirm load, save and CSV download work in both, and that clearing site data loses nothing that isn't already in the saved file.
10. **Reconciliation** — run the spreadsheet's totals for the parallel year through the panel and account for every difference before the tool takes over.
