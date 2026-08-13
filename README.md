# personal-tax-assistant

**→ [kickoffready.github.io/personal-tax-assistant](https://kickoffready.github.io/personal-tax-assistant/)**

A ledger for an Australian individual tax return. It keeps the record across income years and
derives what goes on each return label, so the figures you transcribe into myTax come from
something that carried forward rather than something you retyped.

`ledger.html` is the whole tool — one file, no dependencies, no build step to *use*. Open it in a
browser, load your ledger JSON, work, save. Your data never leaves the machine: there is no
account, no upload and no server, and nothing here can receive your figures.

`ledger.html` in this repository fetches nothing — no dependencies, no analytics, no network of any
kind. A test enforces it. The [hosted copy](https://kickoffready.github.io/personal-tax-assistant/)
carries a Google Analytics tag, injected at deploy by `.github/workflows/pages.yml` and never
committed, which measures the visit and never reads the ledger. Take the file from here and you
have the untagged one.

## The problem it exists for

A long-running spreadsheet with one wide sheet per financial year has a structural flaw: **nothing
persists across tabs except by retyping.** The errors that follow are not carelessness, and they
repeat in workbooks of this kind —

- assets over $300 expensed on the spot, because nothing carries depreciation forward
- capital losses that never reach a return, because carry-forward is manual
- currency columns mixing a rate with its reciprocal
- capital-gains blocks cloned between year-tabs and never refreshed
- a marginal-rate multiplier that quietly omits the Medicare levy

Rearranging the same year-tab layout fixes none of them. `PLAN.md` is the argument for building
this instead.

## What it does

**Store inputs, derive outputs.** Only what a human typed is persisted. Depreciation schedules,
pool balances, AUD conversions, CGT ordering and every lodgment total are recalculated on load — so
a bug fix corrects historical years instead of leaving stale numbers behind. That is the single
most important rule in the design.

Six views: **Assets**, **Expenses**, **Income**, **Lodgment**, **Year**, **Data**.

Covering, among others: decline in value on both methods with part-year apportionment and balancing
adjustments on disposal · the low-value pool, including its one-way rule and disposals out of it ·
capital gains with losses applied before the discount, in the order that costs you least · working
from home at the fixed rate · franking credits and the foreign income tax offset, both reaching the
return from companies *and* trusts · managed fund distributions broken out fund by fund the way
myTax asks for them · integrity checks that name what looks wrong and let you proceed anyway.

The Lodgment view opens on the **Personalise** checklist, because a return label is unusable until
the box that reveals it is ticked — the D-codes never appear in myTax, and the fields they name do
not exist on screen until you have been through that first. `PERSONALISE.md` is the mapping.

Every rate and rule it encodes is listed in **`RULES.md`** with its ato.gov.au source. When a rate
changes, that file changes with the constant, and a test fails until both move together.

## Working on it

```
node build-ledger.js               # regenerate ledger.html from ledger.js
node build-ledger.js --check       # verify the artifact is current; writes nothing
node ledger.test.js                # 675 passed, 0 failed
node gmail-to-ledger.test.js       #  74 passed, 0 failed
node gmail-to-ledger-sheet.test.js #  95 passed, 0 failed
```

**`ledger.html` is generated. Never hand-edit it.** `ledger.js` is the editable source;
`build-ledger.js` inlines it between two markers in the HTML. The test suite independently
re-checks that the artifact embeds the source exactly, so a stale `ledger.html` fails the tests as
well as `--check`.

No framework, no dependencies, no install. The tests are plain Node and run the source in a `vm`
with just enough DOM stubbed for the engine to work.

## Feeding it from somewhere else

Rows can be typed by hand or imported. **`IMPORT-FORMAT.md`** is the contract any converter must
satisfy — the field shapes, and the two identities (`issuer`, and `source` + `source_ref`) that let
the ledger recognise the same purchase arriving through a different channel without claiming it
twice. Import merges and never overwrites; every import is previewed with counts while cancelling
is still free.

The format is converter-agnostic. Anything that can emit the shape can feed it.

### The Gmail converter

One worked implementation of that contract ships here, as Google Apps Script:

| | |
| --- | --- |
| `GMAIL-INTRO.md` | **Start here.** Labels and filters — how a receipt becomes something the ledger can use. |
| `gmail-to-ledger.gs` | Gmail label → import file. `GMAIL.md` covers setup and supplier rules. |
| `gmail-to-ledger-sheet.gs` | The same, bound to a Sheet, writing JSON plus a review tab. `GMAIL-SHEET.md`. |

It lives beside the ledger rather than in its own repo for one reason: its tests feed generated
output through the **real `planImport()`** read out of `ledger.html`, so the converter and the
importer are tested against each other rather than against assumptions about the contract. Every
change to the import format has historically had to touch both at once, and a boundary that a test
already reaches across is a boundary in the wrong place.

## The rest of the documents

| | |
| --- | --- |
| `RULES.md` | Every rate and rule, with its source. Start here to audit the arithmetic. |
| `PLAN.md` | Why the tool is built this way. Written before it existed, kept as written. |
| `bookkeeping-runbook.html` | §02 is the normative record schema this implements. |
| `LOW-VALUE-POOL.md` | The pool rules, and where the ledger departed from them. |
| `CRASH-RECOVERY.md` | What the autosave is, and what it is not. |
| `D6-LODGMENT.md` | How D6 transcribes into the three boxes myTax requires. |
| `PERSONALISE.md` | Which myTax checkbox reveals each label, and the three that are wrong in the obvious reading. |

## Warning

This is a record-keeping tool, not tax advice, and it is not a substitute for a registered tax
agent. It implements rules as documented in `RULES.md`; you remain responsible for what you lodge.
Verify anything you act on against ato.gov.au — the sources are linked throughout.

## Licence

Public domain, under the Unlicense. See `LICENSE`.
