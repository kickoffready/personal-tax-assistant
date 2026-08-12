/**
 * gmail-to-ledger-sheet.gs — turn a Gmail label into JSON plus a review sheet
 *
 * Open a Google Sheet, choose Extensions ▸ Apps Script, paste this over Code.gs,
 * set CONFIG, then run `main()` or `extractFYInvoices()`.
 * The ledger-ready JSON lands in Drive and the parsed rows are also written to
 * the dedicated review tab named by CONFIG.reviewSheetName.
 *
 * This is a converter, not an end-to-end pipeline. You decide what is worth
 * reviewing by labelling it; the script only fetches, parses and formats.
 * Every row arrives at 0% work use. Parsing a receipt successfully says nothing
 * about how much of it relates to earning income, so the script never turns a
 * parsing result into a claim decision.
 *
 * Identity for de-duplication is the Gmail message ID, emitted as `source_ref`.
 * It is unique and permanent within the account, so re-running this is safe —
 * the ledger recognises rows it already has and skips them.
 *
 * The source of truth for this file is the repository, not the Apps Script
 * editor. Edit it here, test it, then paste it into the Sheet-bound project.
 */

/* ============================================================
   CONFIG — the things you are expected to change
   ============================================================ */

var CONFIG = {
  // The Gmail label you attach to receipts as they arrive. The financial-year
  // date bounds are added by the script, so one stable label can span years.
  //
  // A stable label such as "invoice" needs no annual change because the query is
  // date-bounded. Existing per-year labels may still use {fy}, which is replaced.
  label: "invoice",

  // Income year used for the Gmail search and filename. Leave "" to use the year
  // currently open for lodgment, which is what you want on a schedule.
  financialYear: "",

  // Where the JSON file lands. A Drive folder name, or "" for the Drive root.
  driveFolder: "",

  // This tab is generated output. Each run replaces only this tab's contents.
  reviewSheetName: "Gmail invoice review"
};

/* ============================================================
   SUPPLIER RULES — the part that earns its keep over time
   ============================================================

   Each entry gives a recognised sender a stable issuer and display name. Add
   one the first time a supplier appears and never think about it again.

     match   tested against "<from> <subject>"
     issuer  stable lowercase identity shared with every other converter
     name    what goes in the supplier column, spelled how you want it
     label   the return label — see RULES.md for the full map
     kind    optional "service" for a supplier that only sells services. Omit
             it for mixed retailers such as Apple, Officeworks and JB Hi-Fi.
     amount  optional. A regex whose first capture group is the amount.
             Omit it and the largest AUD figure in the body is used.

   A rule match gives a row a trusted issuer. Without one, the row still
   arrives at 0% work use with a review note and a blank issuer.
*/

var SUPPLIERS = [
  { match: /openai|chatgpt/i, issuer: "openai", name: "OpenAI", label: "D5", kind: "service" },
  { match: /adobe/i, issuer: "adobe", name: "Adobe", label: "D5", kind: "service" },
  { match: /atlassian/i, issuer: "atlassian", name: "Atlassian", label: "D5", kind: "service" },
  { match: /github/i, issuer: "github", name: "GitHub", label: "D5", kind: "service" },
  { match: /google.*workspace|workspace.*google/i, issuer: "google", name: "Google Workspace", label: "D5", kind: "service" },
  { match: /dreamhost/i, issuer: "dreamhost", name: "DreamHost", label: "D5", kind: "service" },
  { match: /godaddy/i, issuer: "godaddy", name: "GoDaddy", label: "D5", kind: "service" },
  { match: /namecheap/i, issuer: "namecheap", name: "Namecheap", label: "D5", kind: "service" },
  { match: /crazy ?domains/i, issuer: "crazy-domains", name: "Crazy Domains", label: "D5", kind: "service" },
  { match: /telstra/i, issuer: "telstra", name: "Telstra", label: "D5", kind: "service" },
  { match: /optus/i, issuer: "optus", name: "Optus", label: "D5", kind: "service" },
  { match: /vodafone/i, issuer: "vodafone", name: "Vodafone", label: "D5", kind: "service" },
  { match: /belong/i, issuer: "belong", name: "Belong", label: "D5", kind: "service" },
  { match: /amaysim/i, issuer: "amaysim", name: "Amaysim", label: "D5", kind: "service" },
  { match: /aussie ?broadband/i, issuer: "aussie-broadband", name: "Aussie Broadband", label: "D5", kind: "service" },
  { match: /officeworks/i, issuer: "officeworks", name: "Officeworks", label: "D5" },
  { match: /jb ?hi-?fi/i, issuer: "jb-hi-fi", name: "JB Hi-Fi", label: "D5" },
  { match: /apple/i, issuer: "apple", name: "Apple", label: "D5" },
  { match: /h&r ?block/i, issuer: "h-r-block", name: "H&R Block", label: "D10", kind: "service" }
];

/* ============================================================
   PURE CORE — no Gmail, no Drive. This is what the tests exercise.
   ============================================================ */

/** Amounts written the Australian way. The leading guard stops US$ matching. */
var AUD_AMOUNT = /(?:^|[^A-Za-z])(?:AUD|AU\$|A\$|\$)\s?(\d{1,3}(?:,\d{3})+(?:\.\d{2})?|\d+(?:\.\d{2})?)/g;

/** A currency symbol or code attached to a number, not merely mentioned. */
var FOREIGN_AMOUNT = /(?:USD|US\$|EUR|GBP|NZD|NZ\$|SGD|SG\$|JPY|CAD|CA\$|[€£¥])\s?\d/i;
var THING_SIGNAL = /\b(ship(?:ped|ping)?|delivery|freight|pick[ -]?up|serial|model(?:\s+(?:number|no\.?))?|quantity|qty|warranty|returns? period|laptop|macbook|computer|monitor|dock|keyboard|mouse|desk|chair|camera|tablet|printer|headset|microphone|router|hard drive|ssd)\b/i;
var SERVICE_SIGNAL = /\b(billing period|renews?|renewal|subscription|your plan|next invoice|membership|hosting|domain|internet|mobile plan|cloud|software|licen[cs]e)\b/i;

function toNumber(s) { return Number(String(s).replace(/,/g, "")); }

/** Every AUD amount in the text, largest first. */
function findAmounts(text) {
  var out = [], m;
  var re = new RegExp(AUD_AMOUNT.source, "g");
  while ((m = re.exec(text)) !== null) out.push(toNumber(m[1]));
  return out.sort(function (a, b) { return b - a; });
}

/** True when the text prices something in a currency that is not AUD. */
function hasForeignCurrency(text) { return FOREIGN_AMOUNT.test(text); }

function matchSupplier(from, subject) {
  var hay = String(from || "") + " " + String(subject || "");
  for (var i = 0; i < SUPPLIERS.length; i++) {
    if (SUPPLIERS[i].match.test(hay)) return SUPPLIERS[i];
  }
  return null;
}

/** Calendar date in local time. Never toISOString — that shifts a day in AEST. */
// The financial year currently open for lodgment: the last one that ENDED, never
// the one we are living in. On 8 August 2026 that is 2025-26 — the year whose
// return is due — not 2026-27, which cannot be lodged for another eleven months.
// RULES.md carries the same rule for the ledger itself.
function filingFY(today) {
  var d = today || new Date();
  var fy = fyOf(isoDate(d));
  var start = Number(fy.slice(0, 4)) - 1;
  return start + "-" + String(start + 1).slice(2);
}
// CONFIG with {fy} substituted and a year chosen, so nothing downstream has to
// care whether it was set by hand or worked out.
function resolvedConfig(today) {
  var fy = CONFIG.financialYear || filingFY(today);
  financialYearBounds(fy); // validate before Gmail or Sheets is touched
  return {
    label: String(CONFIG.label).replace(/\{fy\}/g, fy),
    financialYear: fy,
    driveFolder: CONFIG.driveFolder,
    reviewSheetName: String(CONFIG.reviewSheetName || "Gmail invoice review")
  };
}

function isoDate(d) {
  return d.getFullYear() + "-" +
    String(d.getMonth() + 1).padStart(2, "0") + "-" +
    String(d.getDate()).padStart(2, "0");
}

function fyOf(dateStr) {
  var p = String(dateStr).split("-");
  var y = Number(p[0]), m = Number(p[1]);
  var start = m >= 7 ? y : y - 1;
  return start + "-" + String(start + 1).slice(2);
}

/** Inclusive 1 July start and exclusive following 1 July end for a YYYY-YY FY. */
function financialYearBounds(financialYear) {
  var m = /^(\d{4})-(\d{2})$/.exec(String(financialYear || ""));
  if (!m) throw new Error('Financial year must look like "2025-26".');
  var startYear = Number(m[1]), endYear = startYear + 1;
  if (String(endYear).slice(-2) !== m[2])
    throw new Error('Financial year end does not follow its start: "' + financialYear + '".');
  return {
    start: startYear + "-07-01",
    end: endYear + "-07-01",
    after: startYear + "/06/30",
    before: endYear + "/07/01"
  };
}

function gmailSearchQuery(label, financialYear) {
  var name = String(label || "").trim();
  if (!name) throw new Error("CONFIG.label cannot be blank.");
  if (/[\r\n]/.test(name)) throw new Error("CONFIG.label must be one line.");
  var b = financialYearBounds(financialYear);
  var quoted = name.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return 'label:"' + quoted + '" after:' + b.after + ' before:' + b.before;
}

function messageFallsInFY(message, financialYear) {
  return fyOf(isoDate(message.date)) === financialYear;
}

/** Sender display name, falling back to the domain. */
function senderName(from) {
  var s = String(from || "");
  var named = s.match(/^\s*"?([^"<]+?)"?\s*</);
  if (named && named[1].trim()) return named[1].trim();
  var domain = s.match(/@([\w.-]+)/);
  return domain ? domain[1].replace(/\.(com|net|org)(\.au)?$/i, "") : "unknown sender";
}

/** Evidence in the message may identify a lasting item or a consumed service. */
function messageKind(msg, rule) {
  var hay = String(msg.subject || "") + " " + String(msg.body || "");
  var thing = THING_SIGNAL.test(hay), service = SERVICE_SIGNAL.test(hay);
  if (thing && !service) return "thing";
  if (service && !thing) return "service";
  return rule && rule.kind === "service" ? "service" : "unknown";
}

function itemName(msg) {
  var subject = String(msg.subject || "").trim().slice(0, 120);
  return THING_SIGNAL.test(subject) ? subject : "Review item";
}

/**
 * One message in, one import row out. Rows over $300 may be routed to Assets.
 * msg: { id, from, subject, body, date }
 */
function buildRow(msg) {
  var rule = matchSupplier(msg.from, msg.subject);
  var foreign = hasForeignCurrency(msg.body);
  var amounts = findAmounts(msg.body);

  var amount = 0;
  if (rule && rule.amount) {
    var m = msg.body.match(rule.amount);
    if (m && m[1]) amount = toNumber(m[1]);
  }
  if (!amount && amounts.length) amount = amounts[0];

  // Review reasons record parsing ambiguity without deciding work use.
  var reasons = [];
  if (!rule) {
    reasons.push("no supplier rule matched");
    reasons.push("issuer unknown");
  }
  if (foreign) reasons.push("prices in a currency other than AUD — needs a rate");
  if (!amount) reasons.push("no AUD amount found");
  else if (amounts.length > 1 && !(rule && rule.amount))
    reasons.push(amounts.length + " amounts in the body, largest taken");

  var date = isoDate(msg.date);
  var supplier = rule ? rule.name : senderName(msg.from);
  var issuer = rule ? rule.issuer : "";
  var kind = messageKind(msg, rule);
  var paid = Number(amount.toFixed(2));
  var common = {
    issuer: issuer,
    basis: "",
    evidence: "https://mail.google.com/mail/u/0/#all/" + msg.id,
    source: "gmail",
    source_ref: msg.id
  };

  // Over $300, a lasting item or an unresolved receipt goes to Assets. A service
  // wrongly routed there under-claims and is easy to move; a lasting item left in
  // Expenses can over-claim its whole cost immediately.
  if (paid > 300 && kind !== "service") {
    reasons.push(kind === "thing"
      ? "over $300 and appears to be a lasting item; confirm item identity and first-use date"
      : "over $300 and item/service unresolved; routed to Assets for review");
    return Object.assign(common, {
      item_supplier: itemName(msg) + " — " + supplier,
      purchase_date: date,
      cost: paid,
      work_pct: (function () { var x = {}; x[fyOf(date)] = 0; return x; })(),
      basis: "review — " + reasons.join("; ")
    });
  }

  if (kind === "thing") reasons.push("item at or below $300; confirm immediate deduction conditions");
  return Object.assign(common, {
    date: date,
    supplier: supplier,
    amount: paid,
    // Always 0. A clean parse is not evidence of the user's work-use percentage.
    work_pct: 0,
    label: rule ? rule.label : "D5",
    basis: reasons.length ? "review — " + reasons.join("; ") : ""
  });
}

/** One flat, CSV-friendly view of a parsed or skipped converter row. */
function reviewRecord(row, skipped) {
  var asset = !!row.purchase_date;
  var date = row.date || row.purchase_date;
  var amount = row.amount === undefined ? row.cost : row.amount;
  return {
    status: skipped ? "Skipped" : (/^review\b/i.test(row.basis || "") ? "Review" : "Parsed"),
    collection: skipped ? "Skipped" : (asset ? "Asset" : "Expense"),
    date: date,
    identity: asset ? row.item_supplier : row.supplier,
    issuer: row.issuer || "",
    amount: skipped ? "" : amount,
    workPct: asset ? row.work_pct[fyOf(date)] : row.work_pct,
    returnLabel: asset ? "" : (row.label || ""),
    basis: row.basis || "",
    evidence: row.evidence || "",
    sourceRef: row.source_ref || ""
  };
}

function sheetLiteral(value) {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string") return value;
  return /^[=+\-@]/.test(value) ? "'" + value : value;
}

function reviewSheetValues(review) {
  var header = ["Status", "Collection", "Date", "Supplier or item", "Issuer",
    "Amount AUD", "Work use %", "Return label", "Review reason", "Gmail link", "Message ID"];
  var rows = review.slice().sort(function (a, b) {
    return a.date === b.date
      ? String(a.sourceRef).localeCompare(String(b.sourceRef))
      : String(a.date).localeCompare(String(b.date));
  });
  return [header].concat(rows.map(function (r) {
    return [r.status, r.collection, r.date, r.identity, r.issuer, r.amount,
      r.workPct, r.returnLabel, r.basis, r.evidence, r.sourceRef].map(sheetLiteral);
  }));
}

/** Rows plus the counts and review records worth reporting. */
function buildImportFile(messages, financialYear) {
  var expenses = [], assets = [], review = [], outsideYear = 0, needsReview = 0, skippedNoAmount = 0;
  for (var i = 0; i < messages.length; i++) {
    var row = buildRow(messages[i]);
    var amount = row.amount === undefined ? row.cost : row.amount;
    if (!(amount > 0)) {
      skippedNoAmount++;
      review.push(reviewRecord(row, true));
      continue;
    }
    var date = row.date || row.purchase_date;
    if (financialYear && fyOf(date) !== financialYear) outsideYear++;
    if (/^review\b/i.test(row.basis || "")) needsReview++;
    if (row.purchase_date) assets.push(row); else expenses.push(row);
    review.push(reviewRecord(row, false));
  }
  var rows = expenses.concat(assets);
  return {
    file: {
      schema: 6,
      generated: isoDate(new Date()),
      source: "gmail",
      years: [],
      assets: assets,
      expenses: expenses,
      income: []
    },
    review: review,
    summary: {
      messages: messages.length,
      total: rows.length,
      clean: rows.length - needsReview,
      needsReview: needsReview,
      skippedNoAmount: skippedNoAmount,
      outsideYear: outsideYear,
      value: rows.reduce(function (s, r) { return s + (r.amount === undefined ? r.cost : r.amount); }, 0)
    }
  };
}

/* ============================================================
   GMAIL — everything below here only runs inside Apps Script
   ============================================================ */

function readFinancialYearMessages(cfg) {
  var label = GmailApp.getUserLabelByName(cfg.label);
  if (!label) throw new Error(
    'No Gmail label named "' + cfg.label + '".\n' +
    "Create it, apply it to the receipts you intend to claim, then run this again.");

  var query = gmailSearchQuery(cfg.label, cfg.financialYear);
  var out = [], start = 0, pageSize = 100;
  for (;;) {
    // The unbounded search can fail for a large result set, so page explicitly.
    var threads = GmailApp.search(query, start, pageSize);
    if (!threads.length) break;
    for (var t = 0; t < threads.length; t++) {
      var messages = threads[t].getMessages();
      for (var m = 0; m < messages.length; m++) {
        var msg = messages[m];
        var date = msg.getDate();
        // Gmail searches return conversations. A matching thread may contain
        // messages outside the requested dates, so enforce the FY per message.
        if (!messageFallsInFY({ date: date }, cfg.financialYear)) continue;
        var body = "";
        try { body = msg.getPlainBody(); } catch (e) { body = ""; }
        if (!body) body = String(msg.getBody() || "").replace(/<[^>]+>/g, " ");
        out.push({
          id: msg.getId(),
          from: msg.getFrom(),
          subject: msg.getSubject(),
          body: body,
          date: date
        });
      }
    }
    start += threads.length;
    if (threads.length < pageSize) break;
  }
  return { messages: out, query: query };
}

// Drive is happy to hold fifty files with one name, which is exactly what a weekly
// trigger would produce and exactly what makes it impossible to tell which is
// current. Every write is stamped, matching how the ledger names its own saves.
function stampName(fy, d) {
  var x = d || new Date(), p = function (n) { return String(n).padStart(2, "0"); };
  return "ledger-import-gmail-" + fy + "-" + x.getFullYear() + p(x.getMonth() + 1) +
    p(x.getDate()) + "-" + p(x.getHours()) + p(x.getMinutes()) + p(x.getSeconds()) + ".json";
}
function writeToDrive(name, content, folderName) {
  var blob = Utilities.newBlob(content, "application/json", name);
  if (!folderName) return DriveApp.createFile(blob);
  var folders = DriveApp.getFoldersByName(folderName);
  var folder = folders.hasNext() ? folders.next() : DriveApp.createFolder(folderName);
  return folder.createFile(blob);
}

function writeReviewSheet(review, sheetName) {
  var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) throw new Error(
    "No active spreadsheet. Open the Google Sheet, choose Extensions ▸ Apps Script, and run this bound copy.");
  var sheet = spreadsheet.getSheetByName(sheetName) || spreadsheet.insertSheet(sheetName);
  var values = reviewSheetValues(review);
  sheet.clearContents();
  sheet.getRange(1, 1, values.length, values[0].length).setValues(values);
  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, values[0].length);
  return sheet;
}

/** Run this one. */
function main() {
  var cfg = resolvedConfig();
  var found = readFinancialYearMessages(cfg);
  var messages = found.messages;
  var built = buildImportFile(messages, cfg.financialYear);
  writeReviewSheet(built.review, cfg.reviewSheetName);
  if (!messages.length) {
    Logger.log('No messages matched ' + found.query + '. The review tab was refreshed; no JSON was written.');
    return;
  }

  if (!built.summary.total) {
    Logger.log(messages.length + " message(s) read, but none contained a payable AUD amount. " +
      "The review tab was refreshed; no JSON was written.");
    return;
  }
  var name = stampName(cfg.financialYear);
  var file = writeToDrive(name, JSON.stringify(built.file, null, 2), cfg.driveFolder);
  var s = built.summary;

  Logger.log([
    name + "  \u2192  " + file.getUrl(),
    "Review tab: " + cfg.reviewSheetName,
    "",
    s.messages + " message(s) read; " + s.total + " row(s) written, $" + s.value.toFixed(2) + " total",
    "  " + s.clean + " parsed and classified without a warning",
    "  " + s.needsReview + " carry a review note",
    s.skippedNoAmount ? "  " + s.skippedNoAmount + " skipped because no payable AUD amount was found" : "",
    s.outsideYear ? "  " + s.outsideYear + " dated outside " + cfg.financialYear : "",
    "",
    "Download it, then: Ledger \u25b8 Data \u25b8 Import rows…",
    "Rows already in the ledger are skipped, so running this again is safe.",
    "",
    "Every row is imported at 0% work use. Set the percentage yourself after",
    "checking the receipt; the script never converts a clean parse into a claim."
  ].filter(String).join("\n"));
}

/** Compatibility name for the previous spreadsheet extractor. */
function extractFYInvoices() { return main(); }

/* ============================================================
   AUTOMATION — run it on a schedule instead of by hand
   ============================================================

   Apps Script runs the trigger on Google's machines, so nothing of yours needs
   to be awake and there are no credentials to hold. Run installTrigger() once
   from the Sheet-bound editor and approve the permission prompt.

   What automation does NOT do, deliberately: import the file, or decide a
   work-use percentage. The file lands in Drive; you still import it and set the
   percentages. A script that guessed those would be guessing at your return.
   ============================================================ */

function installTrigger() {
  var removed = removeTriggers();
  ScriptApp.newTrigger("main")
    .timeBased().everyWeeks(1).onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(7).create();
  Logger.log([
    (removed ? "Replaced " + removed + " existing trigger(s). " : "") +
      "main() now runs every Monday at about 07:00.",
    "",
    "It reads " + gmailSearchQuery(resolvedConfig().label, resolvedConfig().financialYear) +
      ", writes a stamped file to " + (CONFIG.driveFolder || "your Drive root") +
      ", and refreshes the " + resolvedConfig().reviewSheetName + " tab.",
    "The label and year follow the financial year automatically, so this keeps",
    "working after 1 July without being touched.",
    "",
    "Run removeTriggers() to stop it."
  ].join("\n"));
}

function removeTriggers() {
  var all = ScriptApp.getProjectTriggers(), n = 0;
  for (var i = 0; i < all.length; i++) {
    if (all[i].getHandlerFunction() === "main") { ScriptApp.deleteTrigger(all[i]); n++; }
  }
  return n;
}
