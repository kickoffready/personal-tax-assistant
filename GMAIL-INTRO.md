# Getting receipts out of your inbox

**Start here.** This is about your mailbox — how a receipt becomes something the ledger can use.
Once that habit is running, [GMAIL-SHEET.md](GMAIL-SHEET.md) covers the script that reads it —
one run writes the ledger JSON and a review tab you can read or download as CSV. If you want JSON
and nothing else, [GMAIL.md](GMAIL.md) is the standalone version.

## The problem this solves

Receipts arrive by email and are never opened again. At lodgment you reconstruct the year from
card statements — which the ATO does not accept as written evidence, because a statement is not
from the supplier and lacks the required elements. So you either under-claim what you cannot
prove, or claim what you cannot support.

The fix is not a better memory. It is one label, applied when the receipt arrives, while you
still know what it was for.

## One label carries one decision

The label means: **I believe this is deductible.** That is the only judgement the system asks of
you, and it is the one you are accountable for. Everything after it is arithmetic.

Use a label per income year so a year can be closed and left alone:

```
tax/2025-26
tax/2026-27
```

Nested labels use a slash. Create them in Gmail under **Settings ▸ Labels ▸ Create new label**,
or from the ⋮ menu on any message.

## Stop relying on memory: filters

The habit is the weak link. Filters remove most of it.

**For a supplier you already know**, create the filter from a real email — fastest and least
error-prone:

1. Open a receipt from that sender.
2. ⋮ (More) ▸ **Filter messages like these**.
3. Trim the criteria to just `From:` — usually `billing@supplier.com` or `@supplier.com`.
4. **Create filter** ▸ tick **Apply the label** ▸ choose `tax/2025-26`.
5. Tick **Also apply to matching conversations** to sweep up what is already there.

**For everything else**, a catch-all filter into a staging label you review rather than trust:

```
Has the words:  invoice OR receipt OR "tax invoice" OR "your order"
Has attachment: ✓
Apply label:    tax/inbox-review
```

Review that label occasionally and promote the real ones to `tax/2025-26`. Keeping it separate
matters — a staging label that feeds the script directly would import guesses.

## What to label, and what not to

| Label it | Leave it |
| --- | --- |
| A supplier's invoice or receipt for something you use for work | Anything your employer reimbursed — you did not incur it |
| Subscriptions and licences used in your job | Quotes, order confirmations, shipping notices — not evidence of payment |
| Professional memberships, union fees | Personal purchases, even from a supplier you also use for work |
| Tools and equipment, any price — the ledger decides the treatment | Bank or card statements — not written evidence on their own |
| Donations to Australian DGRs | Overseas charity receipts — generally not deductible |
| Your tax agent's invoice | Renewal reminders for things you cancelled |

**One email, one charge.** A monthly summary covering several charges parses badly — the script
takes the largest amount and flags it for review. Label the individual receipts where a supplier
sends both.

If you are unsure whether something is deductible, label it anyway. It arrives in the ledger
where you can look at it properly, and an unreviewed row claims nothing.

## Catching up on a year already underway

Gmail search finds what you never labelled. Run these, select all, apply the label:

```
from:adobe.com after:2025/07/01 before:2026/07/01
subject:(invoice OR receipt) after:2025/07/01 before:2026/07/01
filename:pdf (invoice OR receipt) after:2025/07/01 before:2026/07/01
has:attachment larger:100k after:2025/07/01 before:2026/07/01
```

Dates in Gmail search are `YYYY/MM/DD`, and the income year runs 1 July to 30 June. Work through
one supplier at a time rather than trying to catch everything at once.

## On 1 July

1. Create `tax/2026-27`.
2. Edit your filters to point at the new label — **Settings ▸ Filters and Blocked Addresses**,
   then Edit on each.
3. Leave the old label alone. It is the record of what you claimed, and the script can be re-run
   against it if you ever need to reconstruct a year.

## When something does not show up

| Symptom | Cause |
| --- | --- |
| Script reports "no Gmail label named…" | The label name in `CONFIG.label` must match exactly, including the `tax/` prefix and the hyphen in `2025-26`. |
| A receipt you labelled is missing | It is on a thread whose other messages are labelled, but not that message. Gmail labels threads; the script reads messages. Open the specific message and label it. |
| A labelled receipt is counted as “skipped because no payable AUD amount was found” | The invoice is probably behind a link rather than in the body. Open it and enter the charge manually; the converter does not create zero-value register rows. |
| Row arrives at 0% | Expected for every imported row. Parsing a receipt cannot determine your work-use percentage; set it in the ledger after review. |
| Charge appears twice | It should not — the ledger dedupes on the Gmail message ID. If a supplier genuinely sent two identical emails for one charge, delete the row you do not want. |

## What this does not do

It does not keep the invoice. The label points at a message in Gmail, and the ledger row carries
a permalink to it — but the ATO requires the supplier's document for **five years from
lodgment**, and a mailbox is not a records system. If you want that gap closed, save the actual
files into `records/2025-26/07-work-expenses/` as they arrive.

Nor does it decide anything. It has no view on whether an expense relates to earning your income,
and it will not tell you that a claim is wrong. That remains yours.

---

Next: [GMAIL-SHEET.md](GMAIL-SHEET.md) — setting up the script that reads the label and builds
the review tab. For JSON only, [GMAIL.md](GMAIL.md).

*General research only. Not personal tax, financial or legal advice. Confirm anything you act on
against [ato.gov.au](https://www.ato.gov.au) or a registered tax agent.*
