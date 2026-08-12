#!/usr/bin/env node
/**
 * Tests for gmail-to-ledger.gs   run:  node gmail-to-ledger.test.js
 *
 * No dependencies. Apps Script cannot run under node, so the converter keeps its
 * parsing core free of GmailApp and DriveApp; this file evaluates the whole
 * script with those stubbed and exercises the core directly.
 *
 * The last section is the one that matters most: it feeds generated output
 * through the real planImport() from ledger.html, so the two files are tested
 * against each other rather than against assumptions about the contract.
 */

const fs = require("fs");
const vm = require("vm");
const path = require("path");

const gsSource = fs.readFileSync(path.join(__dirname, "gmail-to-ledger.gs"), "utf8");
const ledgerSource = fs.readFileSync(path.join(__dirname, "ledger.html"), "utf8")
  .match(/<script>([\s\S]*)<\/script>/)[1];

const R = { pass: 0, fail: 0 };
const near = (a, b, tol = 0.01) => Math.abs(a - b) <= tol;
function t(name, cond, got, want) {
  if (cond) { R.pass++; console.log("  ok   " + name); }
  else { R.fail++; console.log("  FAIL " + name + "\n         got " + got + "  want " + want); }
}
const section = s => console.log("\n" + s);

/* ---- the converter, with Apps Script globals stubbed out ---- */
const G = { console, Logger: { log(){} }, GmailApp: {}, DriveApp: {}, Utilities: {} };
vm.createContext(G);
vm.runInContext(gsSource, G);

/** A message as readLabel() would hand it over. */
const msg = (o = {}) => Object.assign({
  id: "18f2c9a4b7e0" + Math.floor(Math.random() * 1e4),
  from: "Billing <billing@example.com>",
  subject: "Your receipt",
  body: "Thanks. Total $10.00",
  date: new Date(2026, 2, 14)          // 14 March 2026, local
}, o);

/* ============================================================ */
section("— amounts, written the Australian way");
[["Total $89.00", 89], ["Total A$89.00", 89], ["Total AU$1,234.56", 1234.56],
 ["AUD 45.50 charged", 45.5], ["$1,000", 1000]]
  .forEach(([body, want]) =>
    t(JSON.stringify(body), near(G.findAmounts(body)[0], want), G.findAmounts(body)[0], want));

t("US$ is not read as AUD", G.findAmounts("Total US$89.00").length === 0,
  G.findAmounts("Total US$89.00"), "[]");
t("largest amount wins when several appear",
  near(G.findAmounts("Sub $80.00 GST $8.00 Total $88.00")[0], 88),
  G.findAmounts("Sub $80.00 GST $8.00 Total $88.00")[0], 88);

section("— foreign currency is detected, not converted");
[["Total US$89.00", true], ["Charged USD 89.00", true], ["Total €45", true],
 ["Total £45", true], ["Total $89.00", false], ["We also bill in USD for US customers", false]]
  .forEach(([body, want]) =>
    t(JSON.stringify(body.slice(0, 34)), G.hasForeignCurrency(body) === want,
      G.hasForeignCurrency(body), want));

section("— dates are calendar dates");
t("no UTC day-shift", G.isoDate(new Date(2026, 5, 30)) === "2026-06-30",
  G.isoDate(new Date(2026, 5, 30)), "2026-06-30");
t("30 June is the prior income year", G.fyOf("2026-06-30") === "2025-26", G.fyOf("2026-06-30"), "2025-26");
t("1 July starts the next", G.fyOf("2026-07-01") === "2026-27", G.fyOf("2026-07-01"), "2026-27");

section("— supplier names");
t("display name preferred", G.senderName('"Adobe Systems" <no-reply@adobe.com>') === "Adobe Systems",
  G.senderName('"Adobe Systems" <no-reply@adobe.com>'), "Adobe Systems");
t("falls back to the domain", G.senderName("<billing@acmeco.com.au>") === "acmeco",
  G.senderName("<billing@acmeco.com.au>"), "acmeco");
t("every configured rule has a canonical issuer",
  G.SUPPLIERS.every(s => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s.issuer)),
  G.SUPPLIERS.map(s => s.issuer).join(","), "canonical issuers");

section("— large Gmail labels are read in bounded pages");
{
  const starts = [];
  const threads = Array.from({ length:101 }, (_, i) => ({ getMessages:() => [{
    getId:() => "msg-" + i, getFrom:() => "Adobe <x@adobe.com>",
    getSubject:() => "receipt", getPlainBody:() => "Total $10.00",
    getBody:() => "", getDate:() => new Date(2026, 2, 14)
  }] }));
  G.GmailApp.getUserLabelByName = () => ({
    getThreads(start, max) { starts.push(start + "/" + max); return threads.slice(start, start + max); }
  });
  const read = G.readLabel("tax/2025-26");
  t("every labelled thread is read", read.length === 101, read.length, 101);
  t("getThreads uses documented bounded ranges", starts.join(",") === "0/100,100/100",
    starts.join(","), "0/100,100/100");
}

section("— a recognised supplier produces an identified row");
let r = G.buildRow(msg({ from: "Adobe <no-reply@adobe.com>", subject: "Your Creative Cloud invoice",
  body: "Total charged: $89.00" }));
t("supplier from the rule, not the sender", r.supplier === "Adobe", r.supplier, "Adobe");
t("the rule emits a cross-converter issuer", r.issuer === "adobe", r.issuer, "adobe");
t("label from the rule", r.label === "D5", r.label, "D5");
t("amount parsed", near(r.amount, 89), r.amount, 89);
t("a clean parse still arrives at 0% work use", r.work_pct === 0, r.work_pct, 0);
t("no review note", r.basis === "", r.basis, '""');
t("schema 6 output has no expense description", !("description" in r), Object.keys(r).join(","), "no description");
t("carries the Gmail identity", r.source === "gmail" && !!r.source_ref, r.source + "/" + r.source_ref, "gmail/<id>");
t("evidence links back to the message", /mail\.google\.com/.test(r.evidence), r.evidence, "a permalink");

r = G.buildRow(msg({ from: "OpenAI <noreply@tm.openai.com>", subject: "Your ChatGPT receipt",
  body: "Total $30.00" }));
t("OpenAI receipts have one stable identity", r.supplier === "OpenAI" && r.issuer === "openai",
  r.supplier + "/" + r.issuer, "OpenAI/openai");

section("— anything unconfirmed claims nothing");
r = G.buildRow(msg({ from: "Someone <hi@unknown-vendor.io>", subject: "Payment received", body: "Total $250.00" }));
t("unmatched supplier lands at 0%", r.work_pct === 0, r.work_pct, 0);
t("and says why", /no supplier rule matched/.test(r.basis), r.basis, "a reason");
t("an unknown issuer stays blank rather than being guessed",
  r.issuer === "" && /issuer unknown/.test(r.basis), r.issuer + "/" + r.basis, "blank/review");
t("but is still recorded in full", near(r.amount, 250), r.amount, 250);

r = G.buildRow(msg({ from: "Adobe <no-reply@adobe.com>", subject: "invoice", body: "Total US$89.00" }));
t("foreign currency lands at 0% even with a rule match", r.work_pct === 0, r.work_pct, 0);
t("and names the rate problem", /needs a rate/.test(r.basis), r.basis, "a reason");

r = G.buildRow(msg({ from: "Adobe <no-reply@adobe.com>", subject: "invoice", body: "no figures here" }));
t("no amount found lands at 0%", r.work_pct === 0 && r.amount === 0, r.work_pct + "/" + r.amount, "0/0");

r = G.buildRow(msg({ from: "Adobe <no-reply@adobe.com>", subject: "invoice",
  body: "Sub $80.00 GST $8.00 Total $88.00" }));
t("ambiguous totals flagged though largest is taken",
  r.work_pct === 0 && near(r.amount, 88), r.work_pct + "/" + r.amount, "0/88");

section("— collection routing errs toward under-claiming");
const annualService = G.buildRow(msg({ from:"Adobe <x@adobe.com>", subject:"Annual software subscription",
  body:"Total $700.00" }));
t("a service over $300 remains an expense",
  annualService.amount === 700 && !annualService.purchase_date, JSON.stringify(annualService), "expense");
const shippedDock = G.buildRow(msg({ from:"Officeworks <x@officeworks.com.au>",
  subject:"Dell dock order shipped", body:"Total $310.00" }));
t("a shipped item over $300 is routed to Assets",
  shippedDock.cost === 310 && shippedDock.purchase_date === "2026-03-14",
  shippedDock.cost + "/" + shippedDock.purchase_date, "310/2026-03-14");
t("the imported asset carries a reviewable identity and canonical issuer",
  /Dell dock order shipped — Officeworks$/.test(shippedDock.item_supplier) && shippedDock.issuer === "officeworks",
  shippedDock.item_supplier + "/" + shippedDock.issuer, "item — Officeworks/officeworks");
t("an imported asset always carries FY-keyed 0% work use",
  shippedDock.work_pct["2025-26"] === 0, JSON.stringify(shippedDock.work_pct), '{"2025-26":0}');
t("the converter cannot override asset treatment",
  !("treatment" in shippedDock) && !("label" in shippedDock) && !("description" in shippedDock),
  Object.keys(shippedDock).join(","), "no treatment, label or description");
const unresolvedLarge = G.buildRow(msg({ from:"Unknown <x@unknown.test>", subject:"Your receipt",
  body:"Total $640.00" }));
t("an unresolved row over $300 also goes to Assets",
  unresolvedLarge.cost === 640 && /item\/service unresolved/.test(unresolvedLarge.basis),
  unresolvedLarge.cost + "/" + unresolvedLarge.basis, "asset/review");

const routed = G.buildImportFile([
  msg({ from:"Adobe <x@adobe.com>", subject:"Annual subscription", body:"Total $700.00" }),
  msg({ from:"Officeworks <x@officeworks.com.au>", subject:"Dell dock shipped", body:"Total $310.00" })
], "2025-26");
t("one import file can safely contain both collections",
  routed.file.expenses.length === 1 && routed.file.assets.length === 1,
  routed.file.expenses.length + "/" + routed.file.assets.length, "1/1");

section("— the file as a whole");
let built = G.buildImportFile([
  msg({ from: "Adobe <x@adobe.com>", subject: "invoice", body: "Total $89.00" }),
  msg({ from: "GitHub <x@github.com>", subject: "receipt", body: "Total $12.00" }),
  msg({ from: "Nobody <x@nowhere.test>", subject: "thing", body: "Total $5.00" }),
  msg({ from: "Adobe <x@adobe.com>", subject: "old", body: "Total $7.00", date: new Date(2024, 8, 1) }),
  msg({ from: "Adobe <x@adobe.com>", subject: "missing amount", body: "Open your invoice online" })
], "2025-26");
t("current schema declared", built.file.schema === 6, built.file.schema, 6);
t("one row per message", built.file.expenses.length === 4, built.file.expenses.length, 4);
t("rows without a payable amount are omitted", built.summary.messages === 5 && built.summary.skippedNoAmount === 1,
  built.summary.messages + "/" + built.summary.skippedNoAmount, "5/1");
t("counts what needs review", built.summary.needsReview === 1, built.summary.needsReview, 1);
t("counts what falls outside the year", built.summary.outsideYear === 1, built.summary.outsideYear, 1);
t("totals the value", near(built.summary.value, 113), built.summary.value, 113);
t("every generated expense starts at 0%",
  built.file.expenses.every(e => e.work_pct === 0),
  built.file.expenses.map(e => e.work_pct).join(","), "all 0");
t("the complete schema-6 wrapper is emitted",
  Array.isArray(built.file.years) && Array.isArray(built.file.assets) && Array.isArray(built.file.income),
  Object.keys(built.file).join(","), "all collections");
t("new converter output contains no retired descriptions",
  built.file.expenses.every(e => !("description" in e)),
  built.file.expenses.map(e => Object.keys(e).join(",")).join(" / "), "no descriptions");

/* ============================================================
   The contract — generated output through the ledger's own importer
   ============================================================ */
section("— output satisfies the ledger's importer");

function ledger() {
  const stub = () => ({ innerHTML:"", textContent:"", value:"", className:"", hidden:false,
    disabled:false, classList:{ toggle(){}, add(){}, remove(){} }, addEventListener(){},
    setAttribute(){}, children:[],
    click(){}, appendChild(){}, removeChild(){}, closest(){ return null; } });
  const ctx = { console, setTimeout,
    document:{ querySelector: stub, querySelectorAll:()=>[], createElement: stub,
      body:{ appendChild(){}, removeChild(){} }, addEventListener(){} },
    window:{ addEventListener(){} },
    localStorage:{ getItem:()=>null, setItem(){}, removeItem(){} },
    navigator:{}, alert:()=>{}, confirm:()=>true,
    URL:{ createObjectURL:()=>"", revokeObjectURL(){} },
    Blob:function(){}, FileReader:function(){} };
  vm.createContext(ctx);
  vm.runInContext(ledgerSource, ctx);
  return ctx;
}

const L = ledger();
const importFileJson = JSON.parse(JSON.stringify(built.file));

let plan = vm.runInContext("planImport(" + JSON.stringify(importFileJson) + ")", L);
t("accepted, nothing rejected", plan.add.expenses.length === 4, plan.add.expenses.length, 4);
t("nothing skipped on a clean ledger", plan.skip.expenses.length === 0, plan.skip.expenses.length, 0);

vm.runInContext("applyImport(" + JSON.stringify(plan) + ")", L);
t("rows landed in the ledger", vm.runInContext("M.expenses.length", L) === 4,
  vm.runInContext("M.expenses.length", L), 4);

const LRouted = ledger();
const routedPlan = vm.runInContext("planImport(" + JSON.stringify(routed.file) + ")", LRouted);
t("the real importer accepts routed expenses and assets",
  routedPlan.add.expenses.length === 1 && routedPlan.add.assets.length === 1,
  routedPlan.add.expenses.length + "/" + routedPlan.add.assets.length, "1/1");
vm.runInContext("applyImport(" + JSON.stringify(routedPlan) + ")", LRouted);
t("the imported asset still claims 0%",
  vm.runInContext("workPctFor(M.assets[0], '2025-26')", LRouted) === 0,
  vm.runInContext("workPctFor(M.assets[0], '2025-26')", LRouted), 0);

section("— running it twice claims nothing twice");
plan = vm.runInContext("planImport(" + JSON.stringify(importFileJson) + ")", L);
t("second import adds nothing", plan.add.expenses.length === 0, plan.add.expenses.length, 0);
t("and recognises every row", plan.skip.expenses.length === 4, plan.skip.expenses.length, 4);

section("— identity crosses over between hand entry and import");
const L2 = ledger();
// a row typed by hand: no source_ref, so only the date/supplier/amount hash exists
vm.runInContext(`M.expenses.push({ id:"e1", date:"2026-03-14", supplier:"Adobe",
  amount:89, work_pct:100, label:"D5" });`, L2);
const one = { schema:5, expenses:[ built.file.expenses.find(e => e.supplier === "Adobe" && e.amount === 89) ] };
plan = vm.runInContext("planImport(" + JSON.stringify(one) + ")", L2);
t("an imported row matches the same charge entered by hand",
  plan.skip.expenses.length === 1 && plan.add.expenses.length === 0,
  "add " + plan.add.expenses.length + " skip " + plan.skip.expenses.length, "add 0 skip 1");

section("— unattended runs: the year has to follow the calendar");
{
  const d = s => new Date(s + "T12:00:00");
  t("after 1 July, the filing year is the one that just ended",
    G.filingFY(d("2026-08-08")) === "2025-26", G.filingFY(d("2026-08-08")), "2025-26");
  t("on 1 July it has already rolled",
    G.filingFY(d("2026-07-01")) === "2025-26", G.filingFY(d("2026-07-01")), "2025-26");
  t("in June it is still the year before, because this one has not ended",
    G.filingFY(d("2026-06-15")) === "2024-25", G.filingFY(d("2026-06-15")), "2024-25");
  t("it is never the year we are living in",
    G.filingFY(d("2026-08-08")) !== G.fyOf("2026-08-08"), "differs", "differs");

  const before = G.CONFIG.label, beforeFY = G.CONFIG.financialYear;
  G.CONFIG.label = "tax/{fy}"; G.CONFIG.financialYear = "";
  t("{fy} in the label is filled in",
    G.resolvedConfig(d("2026-08-08")).label === "tax/2025-26",
    G.resolvedConfig(d("2026-08-08")).label, "tax/2025-26");
  t("and it moves with the year",
    G.resolvedConfig(d("2027-08-08")).label === "tax/2026-27",
    G.resolvedConfig(d("2027-08-08")).label, "tax/2026-27");
  G.CONFIG.financialYear = "2019-20";
  t("an explicit year still wins",
    G.resolvedConfig(d("2026-08-08")).financialYear === "2019-20",
    G.resolvedConfig(d("2026-08-08")).financialYear, "2019-20");
  G.CONFIG.label = before; G.CONFIG.financialYear = beforeFY;
}

section("— the weekly trigger declares its frequency");
{
  const calls = [];
  const chain = {
    timeBased(){ calls.push("timeBased"); return this; },
    everyWeeks(n){ calls.push("everyWeeks:" + n); return this; },
    onWeekDay(day){ calls.push("onWeekDay:" + day); return this; },
    atHour(hour){ calls.push("atHour:" + hour); return this; },
    create(){ calls.push("create"); return {}; }
  };
  G.ScriptApp = {
    WeekDay:{ MONDAY:"MONDAY" },
    getProjectTriggers:() => [],
    newTrigger:name => { calls.push("newTrigger:" + name); return chain; }
  };
  G.installTrigger();
  t("installTrigger creates one explicit weekly schedule",
    calls.join(",") === "newTrigger:main,timeBased,everyWeeks:1,onWeekDay:MONDAY,atHour:7,create",
    calls.join(","), "weekly Monday at 7");
}

section("— every write is distinguishable, because Drive will not stop you");
{
  const d = s => new Date(s + "T12:00:00");
  const a = G.stampName("2025-26", d("2026-08-08"));
  t("the name carries the year and a timestamp",
    a === "ledger-import-gmail-2025-26-20260808-120000.json", a,
    "ledger-import-gmail-2025-26-20260808-120000.json");
  t("two runs a second apart do not collide",
    G.stampName("2025-26", new Date(2026,7,8,12,0,0)) !== G.stampName("2025-26", new Date(2026,7,8,12,0,1)),
    "differ", "differ");
}

section("— a row at 0% contributes nothing to the lodgment total");
const L3 = ledger();
const zeroOnly = { schema:5,
  years:[{ year:"2025-26", wfh_method:"actual", marginal:32 }],
  expenses:[ built.file.expenses.find(e => e.work_pct === 0) ] };
plan = vm.runInContext("planImport(" + JSON.stringify(zeroOnly) + ")", L3);
vm.runInContext("applyImport(" + JSON.stringify(plan) + "); activeYear='2025-26';", L3);
const claimed = vm.runInContext(
  "(derive().lodgment['2025-26'].deductions.D5||{total:0}).total", L3);
t("imported but unreviewed, so it claims $0", near(claimed, 0), claimed, 0);

console.log("\n" + R.pass + " passed, " + R.fail + " failed\n");
process.exit(R.fail ? 1 : 0);
