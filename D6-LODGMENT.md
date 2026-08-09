# D6: one figure here, three boxes on the return

> **Status:** implemented. `poolFields()` in `personal/ledger.js` renders the split; the Lodgment tab shows it.
> **Verified against ato.gov.au on 9 August 2026.** Reverify each tax time.

## Context

The ledger computes one low-value pool deduction per year. myTax will not accept one figure. It
asks for three, and **all three are required**:

- Low value pool deduction relating to financial investment
- Low value pool deduction relating to rental property
- Remaining low value pool deduction

They are not three deductions. They are one deduction split by what the assets serve.

## "Remaining" means remaining purpose, not remaining years

This is the trap, and the word invites the wrong reading. *Remaining* is the residual **bucket**,
not a residual **balance** — it is this year's pool deduction minus the investment and rental
slices. Nothing on a tax return forecasts future claims; a return reports the year it covers.

The split exists because the first two amounts leave D6 and reappear in the income tests. The ATO's
IT6 instructions state the direction plainly:

> "The total of the low-value pool deductions relating to your rental properties should be written
> from question D6"

So the rental slice is carried to **IT6 Net rental property loss**, the investment slice to **IT5
Net financial investment loss**, and what is left over is *Remaining*. Those income-test figures
feed things like the Medicare levy surcharge and HELP repayment income, which is why they cannot be
folded into a single total.

```
this year's pool deduction
├── serving financial investments  → this box, and carried to IT5
├── serving a rental property      → this box, and carried to IT6
└── everything else                → "Remaining"
```

## Finding it in myTax

It is not under work-related expenses, and it is invisible in a default return. It has to be
switched on first:

1. At **Personalise return**, select **"Other deductions"**. Until this is ticked the item does not
   appear anywhere.
2. At **Prepare return**, select **Add/Edit** on the *Deductions* banner.
3. Enter the three figures, **Save**, then **Save and continue**.

The `D6` code itself never appears on screen. It is the paper-return item number, which is why this
ledger uses it as the stable identifier — see the mapping note in `bookkeeping-runbook.html`.

## The arithmetic, and what carries forward

Two rates, both in `RULES.md`: **18.75%** on the taxable-use cost of assets allocated during the
year, and **37.5%** on the pool's opening balance thereafter. The first-year rate is half the
ongoing rate and applies regardless of when in the year the asset was bought — no part-year
apportionment.

Each year reports **its own** deduction. What persists between years is the balance, not the claim.
Worked from two assets allocated in FY2025-26 — a $310.32 dock at 100% work use and a $420 keyboard
at 80%, so $646.32 into the pool:

| Year | Opening | Deduction | Closing |
| --- | --- | --- | --- |
| 2025-26 | 0.00 | **121.19** (18.75% of 646.32) | 525.13 |
| 2026-27 | 525.13 | **196.93** (37.5% of opening) | 328.21 |
| 2027-28 | 328.21 | **123.08** | 205.13 |
| 2028-29 | 205.13 | **76.92** | 128.21 |
| 2029-30 | 128.21 | **48.08** | 80.13 |

The ongoing deduction is 37.5% of the **opening balance**, never 37.5% of the previous deduction.
Getting that wrong understates the claim badly — 37.5% of the FY2025-26 deduction would suggest
$45.45 for FY2026-27 against a true $196.93.

The Assets tab shows this run forward as a projection. It is a forecast of future returns, not part
of the current one.

## What the ledger does today

Every asset it models is work-related. There is no rental or investment-use dimension on an asset,
and no rent income anywhere in the model — `INCOME_LABELS` covers interest, dividends, trusts,
capital gains, foreign and other income, and nothing else. So the first two boxes are **structurally
zero rather than unknown**, and the whole computed deduction is *Remaining*.

The zeros are printed rather than omitted, because the fields are required and "leave it blank" is
not an option on that screen.

`poolFields(total)` is the only place the split is expressed:

```js
function poolFields(total){
  return [
    ["Low value pool deduction relating to financial investment", 0],
    ["Low value pool deduction relating to rental property", 0],
    ["Remaining low value pool deduction", total]
  ];
}
```

The D6 row on the Lodgment tab opens without being clicked — every other label collapses, but a
collapsed row here is a figure you do not know you still owe, and myTax rejects the section until
all three are filled. Each box carries its own copy button, because you are typing three numbers.

## If an asset ever gains a "relates to"

`poolFields()` is the single function that has to learn to split, and one invariant governs it: the
three boxes must always add back to the D6 total. A test pins that, and it has to survive whatever
the split becomes — otherwise the return disagrees with the ledger.

Splitting properly would also mean a stored field on assets (work / financial investment / rental
property), a schema bump and migration, and entry plus register UI. A rental would need more than
that, being outside what this ledger models at all.

## Sources

- [D6 Low-value pool deduction 2026](https://www.ato.gov.au/forms-and-instructions/individual-tax-return-2026-instructions/deduction-questions-d1-d10-individual-tax-return-2026/d6-low-value-pool-deduction-2026)
- [myTax 2026 Low-value pool deduction](https://www.ato.gov.au/individuals-and-families/your-tax-return/instructions-to-complete-your-tax-return/mytax-instructions/2026/deductions/other-deductions/low-value-pool-deduction)
- [IT6 Net rental property loss 2026](https://www.ato.gov.au/forms-and-instructions/tax-return-for-individuals-2026/income-test-it1-it8-individual-tax-return-2026/it6-net-rental-property-loss-2026)
- [IT5 Net financial investment loss](https://www.ato.gov.au/forms-and-instructions/individual-tax-return-2025-instructions/income-test-it1-it8-individual-tax-return-2025/it5-net-financial-investment-loss-2025)
