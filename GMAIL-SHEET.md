# Gmail receipts → ledger JSON + review sheet

Use `gmail-to-ledger-sheet.gs` when you want one run to produce both the JSON the ledger imports
and a spreadsheet tab you can review or download as CSV. It is a self-contained Google Apps
Script file; do not paste `gmail-to-ledger.gs` beside it.

The script is bound to a Google Sheet. It reads Gmail, writes a stamped schema-6 JSON file to
Drive, and replaces only the generated `Gmail invoice review` tab. It never clears the sheet or
any other tab.

## Setup, once

1. Open the Google Sheet you want to use for review.
2. Choose **Extensions ▸ Apps Script**.
3. Replace everything in `Code.gs` with the contents of `gmail-to-ledger-sheet.gs`.
4. Check the configuration at the top:

   ```js
   var CONFIG = {
     label: "invoice",
     financialYear: "2025-26",
     driveFolder: "",
     reviewSheetName: "Gmail invoice review"
   };
   ```

   `label` must exactly match the Gmail label. Set `financialYear` to the year you are working
   on, or leave it as `""` to use the most recently completed financial year automatically.
   `driveFolder: ""` writes JSON to the Drive root; otherwise give a folder name.
5. In the editor toolbar, open the function dropdown and **pick `main`** (or the compatible name
   `extractFYInvoices`), then click **Run**. The dropdown defaults to the first function in the
   file — `toNumber`, a one-line helper — and running that produces no JSON, no review tab and a
   log that looks like nothing happened. Selecting `main` is what generates results.
6. Review the permission request before accepting it. The script needs Gmail access to read
   labelled messages, Drive access to create JSON, and access to its bound spreadsheet.
7. Open the execution log. It names the JSON file, Drive URL, review tab, row counts, skipped
   messages, and total parsed value.

The dropdown resets to the first function whenever the editor is reloaded, so check it says
`main` before every run. If a run finishes instantly with no file and no updated tab, that is
almost always the reason.

Create the Apps Script project from **Extensions ▸ Apps Script** inside the Sheet. A standalone
project created directly at script.google.com has no active spreadsheet for the review output.

## What one run produces

### Ledger JSON

The stamped file in Drive is the import file:

```text
ledger-import-gmail-2025-26-YYYYMMDD-HHMMSS.json
```

Open the ledger and choose **Data ▸ Import rows…**. Preview the additions and skips before
confirming. Re-running is safe because every parsed row carries its Gmail message ID.

### Review sheet and CSV

The generated tab contains:

```text
Status · Collection · Date · Supplier or item · Issuer · Amount AUD · Work use %
Return label · Review reason · Gmail link · Message ID
```

It contains parsed Expenses and Assets plus messages skipped because no payable AUD amount was
found. It deliberately excludes full email bodies; open the Gmail link when the row needs review.

To create a CSV, make the generated tab active and choose **File ▸ Download ▸ Comma-separated
values (.csv)**. That CSV is for review and reconciliation. Import the JSON—not the CSV—into the
ledger.

## Financial-year selection

For `label: "invoice"` and `financialYear: "2025-26"`, the script searches:

```text
label:"invoice" after:2025/06/30 before:2026/07/01
```

Gmail returns conversations, so the script checks every message again and keeps only dates from
1 July 2025 through 30 June 2026. Search results are read in bounded pages, so a large label does
not depend on Gmail returning every thread in one call.

The label still represents a human decision: only label receipts worth reviewing for tax. The
date filter chooses the year; it does not decide whether a purchase is deductible.

## Safety rules

- Every Expense and Asset starts at 0% work use. Set the percentage in the ledger after review.
- A service remains an Expense. A receipt over $300 that looks like a lasting item—or cannot be
  classified safely—goes to Assets for review.
- A message with no payable AUD amount appears as `Skipped` in the review tab and is omitted from
  JSON.
- The script writes no empty JSON file when every message is skipped.
- The review tab is generated output. Each run replaces that tab only; other tabs are untouched.

## Optional weekly run

Run `installTrigger()` once to schedule `main()` for about 07:00 each Monday. A scheduled run
updates both the Drive JSON and the review tab. Leave `financialYear: ""` if the schedule should
roll to the newly completed financial year after 1 July.

Run `removeTriggers()` to stop the schedule.

## Editing and testing

The repository file is the source of truth. Change it here, run the tests, then paste the whole
file over `Code.gs` again:

```sh
node gmail-to-ledger-sheet.test.js
```

The standalone JSON-only alternative remains `gmail-to-ledger.gs`; its setup is in
[GMAIL.md](GMAIL.md).
