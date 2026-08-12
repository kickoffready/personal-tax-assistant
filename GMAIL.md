# Gmail receipts → ledger

`gmail-to-ledger.gs` turns a Gmail label into a file the ledger can import. It runs inside
Google, so there is no OAuth code to write, no cloud project to create, and no credential stored
on your machine.

This page is for the standalone JSON-only script. If you want the same JSON plus a review tab
that can be downloaded as CSV, follow [GMAIL-SHEET.md](GMAIL-SHEET.md) and use
`gmail-to-ledger-sheet.gs` instead. Paste only one complete script into an Apps Script project.

**New to this? Read [GMAIL-INTRO.md](GMAIL-INTRO.md) first** — it covers the mailbox side:
labels, filters so you stop relying on memory, what to label, and catching up on a year already
underway. This page is the script.

**It is a converter, not an automation.** You decide what is deductible by labelling it. The
script fetches, parses and formats — nothing else.

```
you label the email        JUDGEMENT   is this deductible at all?
      ↓
gmail-to-ledger.gs         automated   runs at Google, writes JSON to Drive
      ↓
Ledger ▸ Data ▸ Import     CHECKPOINT  preview shows add/skip, you confirm
      ↓
you set the work use %     JUDGEMENT   every row arrives at 0%
```

## Setup, once

1. **Make the label and its filters** — see [GMAIL-INTRO.md](GMAIL-INTRO.md).
2. Go to [script.google.com](https://script.google.com) → **New project**.
3. Paste the contents of `gmail-to-ledger.gs` over the empty `Code.gs`.
4. Set `CONFIG.label` and `CONFIG.financialYear` at the top.
5. In the editor toolbar, open the function dropdown and **pick `main`**, then **Run** and
   authorise when asked. The dropdown defaults to the first function in the file — `toNumber`, a
   one-line helper — and running that writes no file and logs nothing useful. Selecting `main` is
   what generates results. Google will warn that the script is unverified because it is your own
   project. Review the code before accepting: Apps Script's built-in Gmail service requests
   Google's broad Gmail scope even though this script only calls message-reading methods; it also
   needs Drive access to create the JSON file.
6. Check the execution log. It reports what it found and where the file went.

Editing happens **in this repository**, not in the Apps Script editor. Change it here, paste it
there. Otherwise the version you rely on exists in one place with no history.

## Each time

Label receipts as they arrive — filters do most of it for you. Then whenever you like, run
`main`, download the file from Drive, and import it. The function dropdown resets to the first
function each time the editor is reloaded, so check it says `main` before clicking Run.

```
Ledger ▸ Data ▸ Import rows…
```

**Running it repeatedly is safe.** Every row carries its Gmail message ID as `source_ref`, which
is unique and permanent within your account, so the ledger recognises rows it already holds and
skips them. The preview tells you what it will add and what it will skip before anything changes.

## Why every row arrives at 0%

Every row carries `work_pct: 0`, even when its supplier and amount parsed perfectly. Parsing
confidence is not a work-use decision: a correctly read phone bill still says nothing about
what percentage of the service relates to earning income. Set the percentage in the ledger
after checking the receipt.

Rows the parser could not resolve also carry a `basis` review note explaining why:

| Note | Meaning |
| --- | --- |
| `no supplier rule matched` | The sender is not in the rules table. Add one, or set the row by hand. |
| `prices in a currency other than AUD — needs a rate` | Converting it silently would be a guess. |
| `no AUD amount found` | The message is omitted from the JSON and counted in the execution log. The invoice is probably behind a link; enter it manually. |
| `N amounts in the body, largest taken` | Subtotal, GST and total all present. The largest is usually right, but check. |

A row at 0% appears in Assets or Expenses and **contributes nothing to any lodgment total**
until you set it. That is deliberate: under-claiming is recoverable, double-claiming is an
amendment.

The converter also chooses the safer collection. A clearly recurring service remains an
Expense at any price. A receipt over $300 that looks like a lasting item—or cannot be resolved
from the email—goes to Assets with a review note. Moving it later is easy; immediately expensing
a lasting item could over-claim its whole cost.

## Adding a supplier rule

The rules table is the part that pays off over time. Add one entry per supplier:

```js
{ match: /adobe/i, issuer: "adobe", name: "Adobe", label: "D5", kind: "service" },
```

- `match` is tested against `"<from> <subject>"`
- `issuer` is the stable lowercase identity shared with other converters
- `name` is what you want in the supplier column
- `label` is the return label — see [RULES.md](RULES.md) for the map
- `kind: "service"` is optional and only for suppliers that do not sell lasting items; omit
  it for mixed retailers such as Apple, Officeworks and JB Hi-Fi
- `amount` is optional. Give it a regex whose **first capture group** is the amount when a
  supplier's emails contain several figures and the largest is not the one you pay:

```js
{ match: /acme/i, name: "Acme", label: "D5", amount: /Amount due:\s*\$([\d,.]+)/ },
```

Change it here, run the tests, then paste into Apps Script.

```
node gmail-to-ledger.test.js
```

## The evidence gap, stated plainly

This produces JSON only. **An email is not written evidence.** The ATO wants the supplier's
document showing cost, supplier, nature of the expense, date paid and date prepared, and it must
survive five years from lodgment.

So the obligation rests on those messages staying in your Gmail for that long — which holds until
an account closes, a mailbox is purged, or a sender's hosted-invoice link expires. Every row
carries a Gmail permalink in `evidence`, so a row always points at where its invoice lives.

If you want that risk closed, save the actual invoices into
`records/2025-26/07-work-expenses/` as they arrive. The script can be extended to capture
attachments without changing the file format.

---

*General research only. Not personal tax, financial or legal advice. Confirm anything you act on
against [ato.gov.au](https://www.ato.gov.au) or a registered tax agent.*
