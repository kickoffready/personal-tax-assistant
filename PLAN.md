# Static ledger tool for the tax repo

> **Status:** built. `ledger.html` implements this design; 40 engine tests pass.
> **Written:** 6 August 2026

## Context

The repo currently holds three static documents: a FY2025–26 filing playbook (`personal/index.html`), an abstracted remediation runbook (`personal/runbook.html`), and a bookkeeping system design (`bookkeeping-runbook.html`), plus an SMSF brief (`super/index.html`). All describe a process. None of them *do* anything.

The underlying problem is the shape of a long-running `.xlsx` with one wide sheet per financial year: **nothing persists across tabs except by retyping.** The errors that follow are structural rather than careless, and they recur in workbooks of this kind — assets over $300 expensed immediately because nothing carries depreciation forward; capital losses that never reach the lodged return because carry-forward is manual; currency columns mixing a rate and its reciprocal; capital-gains blocks cloned between year-tabs and never refreshed; a marginal-rate multiplier that omits the Medicare levy. Reorganising the same year-tab layout cannot fix any of them.

**Is the proposed plan a good one? Yes — with one correction.**

The direction is right. Form-label-first entry and year-over-year roll-forward are precisely the two things a year-tab spreadsheet fails at, and multi-year stateful computation is what code does well and spreadsheets do badly.

The correction is to the memory model. "Export so it can resume next year" implies the browser holds state and export is a secondary action. That inverts the durability: `localStorage` is per-browser and per-origin, is wiped by "clear browsing data", behaves inconsistently on `file://` origins across Safari and Chrome, is invisible to inspection, and is in no backup or lodgment snapshot. Records here must survive 5 years from lodgment, 5 years from the *last* decline-in-value claim for a depreciating asset, and 5 years after no CGT event can happen — which for a long-held share parcel is two decades.

So: **the exported file is the system of record, and the browser is a calculator over it.** Open → load ledger → work → save ledger. `localStorage` is demoted to crash-recovery autosave, labelled as such in the UI and never authoritative.

Scope decisions: the tool runs **parallel to the spreadsheet for one income year** before taking over; **v1 covers the full ledger**; export is **JSON + CSV** (no zip writer, no library); the tool is a **separate file**, and `bookkeeping-runbook.html` remains the process guide.

## Architecture

Single self-contained `ledger.html`. No build step, no dependencies, no network. Opens from `file://` or served from GitHub Pages.

**Store inputs, derive outputs.** Persist only what a human typed. Everything computed — depreciation rows, `claimed` amounts, AUD conversions, pool balances, lodgment totals — is recalculated on load. A bug fix or schema change then corrects historical years automatically instead of leaving stale numbers behind. This is the single most important design rule in the build.

```
ledger.json  (the record — lives in cloud storage alongside the workbook)
   ↓ load                              ↑ save
        ledger.html  (stateless calculator)
   ↓ export
ledger-FY2025-26-{assets,expenses,income,lodgment}.csv  (archive)
```

### Data model (`schema: 1`)

Mirrors the schemas already documented in `bookkeeping-runbook.html` §02, so the doc and the tool stay in agreement — that section becomes the normative spec.

| Collection | Persisted | Notes |
|---|---|---|
| `years[]` | yes | `year`, `taxable_income`, `payg_withheld`, `marginal_plus_levy`, `estimated`, `assessed`, `variance`, `noa_date`, `cf_capital_loss` |
| `assets[]` | yes | `asset_id`, `description`, `serial`, `supplier`, `purchase_date`, `cost_incl`, `evidence`, `treatment`, `effective_life`, `method`, `work_pct{}` by year, `status`, `disposal_date`, `disposal_proceeds` |
| `expenses[]` | yes | `date`, `description`, `supplier`, `amount`, `work_pct`, `label`, `basis`, `evidence` |
| `income[]` | yes | `date`, `type`, `holding`, `gross_foreign`, `currency`, `fx_rate`, `tax_withheld_aud`, `franked`, `unfranked`, `credit` |
| `depreciation[]` | **no — derived** | one row per asset per year held |
| `pool{}` | **no — derived** | low-value pool balance by year |
| `keep_until` | **no — derived** | from the three retention rules |

`asset_id` (`A-2026-014`) is the join key between register, depreciation and evidence filename. `label` (`D1`–`D15`, income items) is what makes lodgment a filtered sum.

### Calculation engine

- **Prime cost**: `cost × (days_held ÷ 365) × (100% ÷ effective_life)`; **diminishing value** as the alternative, fixed at acquisition.
- **Treatment from cost, not work-use**: ≤$300 immediate (D5) · $301–999 pool-eligible (D6) · ≥$1,000 individual schedule (D5).
- **Low-value pool**: 18.75% in the year of allocation regardless of date, 37.5% diminishing thereafter. Enforce the one-way rule — once a pool exists, later low-cost assets must be pooled.
- **CGT ordering**: current-year losses (preferring non-discountable gains) → carried-forward losses oldest-first → *then* the 50% discount.
- **Retention**: `keep_until` = latest of lodgment + 5y, last decline claim + 5y, and for CGT assets disposal + 5y.
- **Roll-forward**: "Start FY2026–27" carries closing → opening, pool balance, and unused capital loss; assets persist untouched.

### What is automated, and what is not

The boundary: **arithmetic and hard rules are computed; judgement stays with the user, but is recorded once and carried forward.** Overstating this is how a tool becomes untrustworthy, so the UI must be explicit about which is which.

| Automatic — rule or arithmetic | Suggested — confirm once | Manual — always the user's |
|---|---|---|
| Treatment from cost (≤$300 / $301–999 / ≥$1,000) | Effective life, from description keywords | Work-use % on devices and mixed-use expenses |
| Decline in value, prime cost or DV, part-year by days held | Expense label from supplier, then remembered per supplier | The `basis` note explaining the % |
| Opening/closing balances and roll-forward | | Hours worked from home |
| Pool: 18.75% then 37.5% | | Whether an expense relates to earning income at all |
| `claimed = amount × work_pct` | | |
| `gross_aud = gross_foreign × fx_rate` | | |
| Depreciation label (D5 or D6) from treatment | | |
| `keep_until` from the three retention rules | | |
| Grouping, sorting and **totalling by label** | | |
| CGT ordering — losses before discount | | |
| Marginal rate + 2% Medicare levy | | |

Two consequences worth building for:

- **Work-use % is entered per asset, not per year.** It carries forward; a change between years without a corresponding `basis` note raises an integrity warning.
- **Under the 70c fixed rate there are no percentages at all** — hours replace them, and energy, phone, internet and stationery are covered by the rate. The tool must make the fixed-rate/actual-cost choice explicit per year and then hide the irrelevant inputs, rather than asking for both.

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
2. **Assets** — register, decision rule applied from cost, per-year depreciation trace per asset.
3. **Expenses** — entry with label picker and basis field.
4. **Income** — dividends split franked/unfranked/credit, foreign gross + FITO, disposals.
5. **Year** — reconciliation against the assessment; NOA date drives an amendment-window countdown.
6. **Data** — load, save, CSV export, autosave status, integrity report.

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

- `ledger.html` — the tool, repo root, self-contained. No build step, no dependencies, no network.
- `README.md` and root `index.html` — orientation; both state that ledger data and evidence never enter the repo.
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
6. **Automation boundary** — confirm nothing invents a work-use %; that a % set once carries forward across years; that changing it without a `basis` note warns; and that selecting the fixed rate for a year hides the per-category percentage inputs rather than asking for both.
7. **Lodgment totals** — every label total must equal the sum of its expanded supporting rows, and match a hand-check for at least one label.
8. **Durability** — open from `file://` in both Safari and Chrome; confirm load, save and CSV download work in both, and that clearing site data loses nothing that isn't already in the saved file.
9. **Reconciliation** — run the spreadsheet's totals for the parallel year through the panel and account for every difference before the tool takes over.
