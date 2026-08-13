# Personalise: the screen that decides what the return even has

> **Status:** implemented. `PERSONALISE` and `personaliseChecklist()` in `ledger.js` hold the
> mapping; `renderPersonalise()` puts it at the top of the Lodgment tab, above the label detail.
> **Wording taken from a live myTax 2025-26 Personalise screen on 13 August 2026**, except the two
> rows marked *unconfirmed* below. Reverify each tax time — myTax rewords these boxes between years.

## Context

The Lodgment tab reports `D3`, `D5`, `D6`, `10`, `11`, `20`. Those are the paper-return item
numbers, and they are the right stable identifier for a ledger that has to survive myTax's wording
changing from year to year. They are also, on their own, unusable by anyone who has not lodged this
way before — because **the codes never appear in myTax at all**, and the fields they name do not
exist on screen until a checkbox is ticked two screens earlier.

So the failure this fixes is precise. You read `D5 · Other work-related expenses · $1,500`. You open
myTax. There is no such field, no such heading, and no search box that finds it. The figure is
correct and you cannot spend it.

`D6-LODGMENT.md` already recorded this for one label — "At **Personalise return**, select **Other
deductions**. Until this is ticked the item does not appear anywhere" — but that was one label, in a
document, and nowhere in the tool. This generalises it: every label the ledger derives now names the
box that reveals it, and the boxes come first because that is the order you meet them in.

## What the ledger shows

A block above the deduction and income detail, listing the boxes this year's figures require, each
naming the labels ticking it makes reachable. Then one folded line naming every box that was
considered and is not needed — the same principle the fund blocks apply to nil components:

> which labels came out nil is worth knowing — it is the difference between a component that was
> considered and one that was never transcribed

A box you were told to leave alone is not the same as a box nobody looked at.

## The mapping

myTax's own screen order. Groups are the bold parent checkboxes; indented rows are sub-checkboxes.
Blank in the third column means this ledger can never require it.

| Group | Box | Ticked when | Reveals |
| --- | --- | --- | --- |
| Salary, wages or other income on an income statement/payment summary… | Salary, wages, allowances, tips, bonuses etc. | any of D1–D5 | D1–D5 |
| " | Australian Government payments · ETP · foreign employment income on a payment summary · attributed PSI · FHSS | | |
| Income from Australian superannuation or annuity funds | *(the group is the box)* | | |
| Australian interest, or other Australian income or losses from investments or property | Interest | label 10 has a figure | 10 |
| " | Dividends | label 11 has a figure | 11 |
| " | Rent (Australian properties) | | |
| " | Capital gains or losses that are **not** from a managed fund or trust distribution | label 18 has a figure — which requires a disposal you made yourself | 18 |
| " | Unapplied net capital losses from earlier years to carry forward but no CGT event this year | a loss carried in, and no CGT event at all this year | *nothing* |
| Managed fund or trust distributions (including where distribution has capital gains and foreign income) | *(the group is the box)* | any fund block, or label 13 | the fund's own non-nil codes — 13U, 13C, 18A, 20E… |
| Sole trader, business income or losses, partnership distributions | *(the group is the box)* | | |
| Foreign income | Other foreign income | label 20 has a figure | 20 |
| " | Foreign pensions or annuities · foreign employment income NOT on a payment summary · foreign entities | | |
| Other income not listed above (including employee share schemes) | *(the group is the box)* | label 24 has a figure | 24 |
| Deductions you want to claim | Work-related expenses — You must have salary or wages income | any of D1–D5 | D1–D5 |
| " | Gifts, donations, interest, dividends, and the cost of managing your tax affairs | any of D7, D8, D9, D10 | those |
| " | Personal superannuation contributions *(wording unconfirmed)* | D12 | D12 |
| " | Other deductions *(wording unconfirmed)* | D6 or D15 | D6, D15 |

The two *unconfirmed* rows sit below the fold of the screenshot this was built from. The boxes exist
and the mapping is right; only the exact on-screen wording is unverified. Confirm both the next time
a return is open and drop the marker.

## The three that are wrong in the obvious reading

**Foreign income inside a fund does not tick "You had foreign income".** myTax's fund box is worded
*"including where distribution has capital gains and foreign income"* — it carries them. Tick the
foreign box as well and myTax opens a second entry screen for figures you have already typed into
the fund block, and there is nothing correct to put in it. Only foreign income you hold **directly**
— label 20 — ticks that box. The ledger distinguishes them: fund foreign income leaves through
`out.funds`, direct foreign income through `out.income.I20`, and only the second one is consulted.

**A capital gain inside a fund does not tick the capital gains box.** Same reason, stated in the
box's own wording: *"not from a managed fund or trust distribution"*. This one the engine already
got right for a different purpose — `buildLodgment()` only writes label 18 when
`M.income.some(i => i.type === "disposal")`, because a trust's gain is entered as that fund's 18A
and 18H. The checklist inherits that guard rather than re-deriving it.

**A carried-forward capital loss with no CGT event has its own box, and reports no figure.** It
produces no label, so nothing else on the Lodgment tab would ever mention it — and without it the
loss simply does not reach the return. That is one of the structural spreadsheet failures this tool
was built against: *capital losses that never reach a return, because carry-forward is manual*. The
condition is narrow and has to be: a loss brought forward **and** no gains, no losses and no
disposals this year. With any CGT event the loss is applied through label 18 instead, and this is
the wrong box.

## Salary and wages, which the ledger does not hold

myTax gates work-related expenses on it, in the checkbox's own text: *"You must have salary or wages
income"*. Untick salary and the work-related box cannot be ticked at all.

This ledger records no salary — it arrives by pre-fill and should never be typed from here. But
deriving strictly from what the ledger holds would leave a first-time lodger at a checkbox they
cannot tick, with nothing anywhere explaining why. So the block names it whenever any of D1–D5
exist, and says both things: tick it, and do not type the figure.

## If a box ever gains a condition

`PERSONALISE` in `ledger.js` is the single table. Each entry's `when` receives the year's lodgment
and CGT working and returns a boolean; a missing `when` means the box is one this ledger can never
require, and it goes to the folded line instead. Every entry lands in exactly one of the two lists,
and a test pins that — so adding a box without deciding its condition fails rather than silently
disappearing from both.

## Sources

- [myTax 2026 Personalise your return](https://www.ato.gov.au/individuals-and-families/your-tax-return/instructions-to-complete-your-tax-return/mytax-instructions/2026/personalise-your-tax-return)
- [myTax 2026 Deductions](https://www.ato.gov.au/individuals-and-families/your-tax-return/instructions-to-complete-your-tax-return/mytax-instructions/2026/deductions)
- [myTax 2026 Managed fund distributions](https://www.ato.gov.au/individuals-and-families/your-tax-return/instructions-to-complete-your-tax-return/mytax-instructions/2026/income/managed-fund-distributions)
- [myTax 2026 Capital gains or losses](https://www.ato.gov.au/individuals-and-families/your-tax-return/instructions-to-complete-your-tax-return/mytax-instructions/2026/income/capital-gains-or-losses)
- [myTax 2026 Low-value pool deduction](https://www.ato.gov.au/individuals-and-families/your-tax-return/instructions-to-complete-your-tax-return/mytax-instructions/2026/deductions/other-deductions/low-value-pool-deduction)
