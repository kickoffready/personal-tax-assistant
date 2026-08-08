# Import format — what a converter must emit

> Every converter writes this shape: `paypal-to-ledger`, `gmail-to-ledger`, the Apple
> receipts parser, and whatever comes next. The ledger reads nothing else.

## Why `issuer` exists

The same bill reaches you through several channels, wearing a different name each time.
Twelve Optus phone bills, paid by PayPal, funded by a credit card, receipted by email:

| Source | What it calls the supplier | Shape |
| --- | --- | --- |
| PayPal export | `Optus` | one row, $300, summed for the year |
| Gmail receipts | `PayPal` | twelve rows, $25 each |
| Card statement | `PAYPAL *OPTUS` | twelve rows, $25, dated a day later |

Nothing there matches. Not the name, not the date, not the shape. Import two of them and
you claim the phone twice, and no automatic check can see it — this was demonstrated
against the real files, and the duplicate warning stayed silent.

**`issuer` is the fix.** It names *who issued the invoice*, canonically, whatever the record
travelled through. All three rows above carry `issuer: "optus"`, so the ledger can tell they
are the same obligation even when nothing else about them agrees.

## The rule that makes it work

> **The issuer is who you bought from. Never how you paid, and never where the record
> came from.**

PayPal is a payment channel. A credit card is a funding instrument. Gmail is a transport.
None of them ever issue an invoice, so none of them is ever an `issuer`.

| Record | `issuer` | `source` |
| --- | --- | --- |
| Optus bill paid via PayPal | `optus` | `paypal` |
| Same bill, receipt emailed | `optus` | `gmail` |
| Same bill on the card statement | `optus` | `card` |
| Dell dock bought direct | `dell` | `gmail` |
| A genuine PayPal fee | `paypal` | `paypal` |

That last row is the test of whether you have understood it: PayPal charging *you* a fee is
PayPal issuing an invoice, and only then is it the issuer.

## Fields — an expense row

| Field | Required | Notes |
| --- | --- | --- |
| `issuer` | **yes** | Canonical, lowercase, no punctuation or company suffix: `optus`, `dell`, `cloudflare`, `apple`. Stable forever — it is the join key across sources. |
| `supplier` | yes | Display name, spelled how you want to read it: `Optus`, `Dell Australia`. Cosmetic. |
| `source` | **yes** | The converter that produced the row: `paypal`, `gmail`, `card`, `apple-receipts`. |
| `source_ref` | **yes** | Unique and permanent *within that source*: a PayPal transaction ID, a Gmail message ID. Never a row number — a re-export renumbers those and every row imports again. |
| `date` | yes | `YYYY-MM-DD`. For a grouped row, the last charge in the group. |
| `amount` | **yes** | **The amount actually paid, GST inclusive.** AUD, net of refunds. See below — this is the field most easily got wrong. |
| `gst` | no | The GST component, where the document states it. Recorded, never subtracted. |
| `work_pct` | yes | **Always `0`.** See below. |
| `label` | yes | The ATO label — `D5`, `D6`, `D10`. See `RULES.md`. |
| `category` | no | How the line reads on the return: `Information services`. Omit rather than guess. |
| `basis` | no | Why this row exists and what a human still has to decide. |
| `evidence` | no | A link or path back to the original document. |

Plus the file wrapper: `{ "schema": 2, "years": [], "assets": [], "expenses": [], "income": [] }`.

An **asset** row is shaped differently and is described under *Assets or expenses* below.

## Which number is the amount

Every row must carry a **payment amount**, and an invoice offers several numbers that are
not it. A real receipt:

```
Subtotal              A$30.91
Total excluding tax   A$30.91
GST - Australia (10%)  A$3.09
Total                 A$34.00
Amount paid           A$34.00     <- this one
```

**Take what was paid, GST inclusive.** In order of preference:

1. an explicit *Amount paid* / *Amount charged* / *Paid*
2. failing that, *Total* — the one that includes GST
3. failing that, the row does not have a payment amount and **must not be emitted**

Never a subtotal, never a total excluding tax, and never "the largest number in the body" —
that is a guess dressed as a rule. It happens to land on $34.00 above; on a receipt listing
an account balance or a next-invoice estimate it will not.

### Why GST-inclusive, specifically

For someone not registered for GST, the cost of an asset **is** the GST-inclusive price, and
that is the figure the $300 immediate-deduction threshold tests. The difference decides the
tax treatment:

| Figure taken | Cost recorded | Treatment | Claimed in year one |
| --- | --- | --- | --- |
| ex-GST subtotal | $282.11 | immediate write-off | **$282.11** |
| GST-inclusive paid | $310.32 | low-value pool | **$58.19** |

Same purchase, one wrong number, a $224 overclaim and an asset that never enters the pool.
That is your Dell dock.

### Unpaid, part-paid, refunded

- An invoice issued but not paid is not a row. It becomes one when it is paid.
- Part-paid: the row is the payment, for what was paid, dated when it was paid.
- A refund nets against the charge it reverses, inside the same row, and `basis` says so.
- Foreign currency: convert it yourself, emit AUD, and record the rate and date in `basis`.
  A row in another currency is not a payment amount.

## Assets or expenses

The wrapper has two arrays and every row has to go in one of them. This is not filing —
it decides *when* the money is claimed:

| A $900 dock emitted into | Year one | Year two | Year three |
| --- | --- | --- | --- |
| `expenses` | **$900.00** | — | — |
| `assets` (pooled at 18.75%, then 37.5%) | **$168.75** | $274.22 | $171.39 |

The same $900 either way. Only one of them is the right year, and a converter that
guesses wrong writes an over-claim into a file someone will import without re-reading.

### The two questions, in order

**1. Is it a thing, or a service?** A service is consumed inside a period — a month of
phone, a year of a licence, an hour of an accountant. A thing is still working after
30 June.

**2. Does it cost more than $300?** Below the threshold both collections claim the whole
amount in the same year, so the answer to question 1 changes nothing. Above it, everything
changes.

|  | ≤ $300 | > $300 |
| --- | --- | --- |
| clearly a service | `expenses` | `expenses` |
| clearly a thing | `expenses` | **`assets`** |
| **cannot tell** | `expenses` | **`assets`** |

**That last cell is the rule.** An unresolved row over $300 goes to `assets`, because the
two errors are not symmetrical:

- a thing wrongly in `expenses` claims its **whole cost this year** — an over-claim, and an
  amendment to undo
- a service wrongly in `assets` spreads a cost that was deductible at once — an under-claim,
  and you fix it by moving the row

Same reasoning as `work_pct`, applied to the collection instead of the percentage.

### Signals a converter can actually read

**Says service:**

- **recurrence** — the same `issuer` charging on a monthly or yearly rhythm. A subscription
  is never an asset at any price. This is the strongest signal available and it costs
  nothing, because a converter holds the whole file and can see the pattern a single
  receipt cannot.
- a billing period on the document: `1 Aug – 31 Aug`, `renews on`, `your plan`, `next invoice`
- the issuer matches the expense taxonomy in `ledger.html` (`CATEGORY_HINTS.expenses`)

**Says thing:**

- **shipping, delivery, freight, or a pickup address** — nobody ships a subscription
- a serial number, a model number, or `quantity × unit price`
- warranty or returns-period wording
- the line matches the asset taxonomy (`CATEGORY_HINTS.assets`: laptop, monitor, dock,
  keyboard, desk, chair, camera…)

### Signals that look decisive and are not

- **The issuer.** Apple bills a cloud plan at $19 a month and a MacBook at $3,499 from the same
  address. Amazon, Officeworks, JB Hi-Fi and Harvey Norman all sell both. The issuer decides
  the row's *name*; it never decides its *kind*. `gmail-to-ledger.gs` currently makes exactly
  this mistake — `{ match: /officeworks|jb ?hi-?fi|apple ?store/i, name: "Equipment supplier",
  label: "D5" }` sends every Apple Store receipt, laptop or not, to `expenses` as D5.
- **One-off versus recurring, judged from one document.** An annual renewal looks like a
  one-off. Recurrence is a property of the file, not of the receipt.
- **A large total.** A $700 Adobe plan is a service. A $310 dock is a thing.
- **The word "purchase".** Every receipt says it.

### Fields — an asset row

| Field | Required | Notes |
| --- | --- | --- |
| `issuer`, `source`, `source_ref` | **yes** | Exactly as for an expense. Identity does not change with the collection. |
| `description` | **yes** | The item, specific enough to imply an effective life: `14-inch MacBook Pro`, not `computer gear`. The ledger reads this to guess the life when you do not supply one. |
| `supplier` | yes | Display name. |
| `purchase_date` | **yes** | `YYYY-MM-DD`. Replaces `date`. |
| `cost` | **yes** | Replaces `amount`. The paid, GST-inclusive figure — same rule, and the one the $300 test is applied to. |
| `work_pct` | **yes** | `{"2025-26": 0}` — **an object keyed by financial year**, not a bare number. See the warning below. |
| `category` | no | From the asset taxonomy only — `Computers`, `Peripherals`, `Furniture`. Never an expense category. |
| `basis` | no | As for an expense. |
| `treatment` | **never** | Derived from cost. Emitting it lets a converter overrule the $300 and $1,000 tests. |
| `effective_life` | no | Omit unless the document states it; the ledger falls back to the description. |
| `asset_id` | **never** | Allocated on import, and a supplied one collides. |

> **`work_pct` on an asset must be present and must be FY-keyed.** An asset whose `work_pct`
> is missing is read as **100%** — `workPctFor()` returns 100 for `undefined`. It is the only
> default in the ledger that errs toward over-claiming, and an imported asset is exactly how
> you reach it. Emit `{"<fy of purchase_date>": 0}`, never `0`, never nothing.

### One receipt is not one row

A $2,400 Officeworks receipt holding a $1,800 laptop, a $310 dock and $40 of paper is three
rows across two collections. **Emit the lines, not the total.**

Where the document does not itemise, no routing is correct — a single $2,400 asset
depreciates on a schedule, which claims *more* in year one than the three real rows do, so
even `assets` is not the safe side here. Emit one row to `assets` with
`basis: "receipt not itemised — split before lodging"` and treat the flag, not the routing,
as the output. This is a row a person has to finish.

### What the ledger does with it afterwards

- **Treatment follows cost**, not use: $300 or under written off at once, under $1,000 pooled,
  $1,000 and over on an individual schedule.
- **The pool is a one-way door.** Once anything is allocated to a low-value pool, every later
  asset under $1,000 must be pooled too. A converter that misroutes a $600 item in the year a
  pool opens does not just misstate that year.
- **The review only catches one direction.** `ASSET_SHAPED` raises a high warning for an
  expense over $300 carrying an asset-shaped *category*. A laptop sitting in `expenses` under
  a blank category, or under `Software and subscriptions`, is invisible to it. So the category
  and the collection must agree: **never put an asset-taxonomy category on an expense row**,
  and never the reverse.

### Worked

| Row | Cost | Read as | Goes to | Why |
| --- | --- | --- | --- | --- |
| Optus, monthly | $25.00 | service | `expenses` | recurs |
| Adobe CC, annual | $700.00 | service | `expenses` | billing period, renews |
| Cloud Plus 2TB | $19.05 | service | `expenses` | recurs |
| Anthropic | $34.00 | service | `expenses` | recurs |
| USB-C cable, shipped | $29.00 | thing | `expenses` | under $300 — same claim either way |
| Dell dock, shipped | $310.32 | thing | **`assets`** | over $300 → pooled, $58.19 in year one |
| MacBook Pro, Apple Store | $3,499.00 | thing | **`assets`** | description decides it, not the issuer → scheduled |
| Officeworks, no detail | $187.00 | unknown | `expenses` | under $300 — the question does not arise |
| Officeworks, no detail | $640.00 | unknown | **`assets`** | over $300 and unresolved → the recoverable side |

## `work_pct` is always 0

A converter never sets a work-use percentage. Not when the supplier rule matched, not when
the amount parsed cleanly, not ever.

This was got wrong once and is worth stating plainly: `gmail-to-ledger.gs` used
`work_pct: confident ? 100 : 0`, which reads a **parse** result as a **claim** decision.
Sixteen cleanly-parsed telco rows would have arrived claiming 100% work use. A telco bill
parsing perfectly says nothing whatever about how much of your phone is work.

Under-claiming is recoverable. Over-claiming is an amendment. The percentage is the one
number that must come from a person.

## Grouping is optional, and that is why `issuer` is required

A converter may emit one row per charge, or one row per issuer per year with the charges
summed. Both are valid — twelve $25 rows and one $300 row describe the same obligation.

Because both are valid, **shape can never be an identity**. `issuer` can.

## How the ledger uses it

1. **Same file re-imported** — matched on `source` + `source_ref`. Exact, always right.
2. **Same charge from a different converter** — matched on `issuer` + `date` + `amount`.
3. **Overlapping coverage** — an issuer holding rows from more than one `source` in one year
   raises a warning. It cannot know which to keep, so it says so rather than choosing.

Layer 3 is the one that catches the Optus case, and it only works because every source
agrees on `issuer`.

## Writing a converter

- Decide the collection before anything else — see *Assets or expenses*. Route on the item,
  never on the issuer, and send an unresolved row over $300 to `assets`.
- Emit `issuer` for everything. If you cannot determine it, emit the row with
  `basis: "issuer unknown"` rather than guessing — a wrong issuer silently merges two
  unrelated suppliers, which is worse than a missing one.
- Net refunds against the charge they reverse, in the same row.
- Never emit rows with no payment amount. A row that claims nothing and says nothing is
  noise in a register someone has to read — 20 of 58 rows in the first Gmail export were
  exactly this, and were dropped rather than imported.
- Prefer an explicit *Amount paid* over pattern-matching for money. Where a supplier's
  receipts have a stable wording, give that supplier its own amount rule; the largest
  number in the body is the fallback of last resort, and it should be recorded in
  `basis` when it was used.
- Re-running must be safe. That is what `source_ref` is for.

## One source per issuer

The ledger warns; it does not choose. For anything funded through a payment channel, prefer
the channel's own export — it names the real merchant, where a card statement shows only
`PAYPAL *…`. Then exclude those top-ups from the card import.
