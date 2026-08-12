#!/usr/bin/env node
/**
 * Tests for the personal ledger           run:  node ledger.test.js
 *
 * No dependencies, no framework. The tests run the editable ledger.js source in
 * a vm with just enough DOM stubbed for the engine to work, and also verify that
 * the standalone ledger.html artifact embeds that source exactly. Exits non-zero
 * on any failure.
 *
 * These assertions are the reason to trust the arithmetic. Every rule they check
 * is sourced in RULES.md — when a rate changes, update it there, update
 * the constant, and expect a test here to fail until you update it too.
 */

const fs = require("fs");
const vm = require("vm");
const path = require("path");
const {
  END_MARKER,
  START_MARKER,
  extractGeneratedSource,
  normaliseNewlines,
  normaliseSource,
  renderLedgerHtml,
  validateSource
} = require("./build-ledger.js");

const html = fs.readFileSync(path.join(__dirname, "ledger.html"), "utf8");
const code = fs.readFileSync(path.join(__dirname, "ledger.js"), "utf8");
const ACK_STORAGE_KEY = "tax-ledger-acknowledgement";
const ACK_VERSION = "2026-08-09.1";

const R = { pass: 0, fail: 0 };
const near = (a, b, tol = 0.01) => Math.abs(a - b) <= tol;
function assert(name, cond, got, want) {
  if (cond) { R.pass++; console.log("  ok   " + name); }
  else { R.fail++; console.log("  FAIL " + name + "\n         got " + got + "  want " + want); }
}

function stubEl() {
  return { innerHTML:"", textContent:"", value:"", className:"", hidden:false, disabled:false,
    checked:false, inert:false,
    classList:{ toggle(){}, add(){}, remove(){} }, addEventListener(){}, setAttribute(){},
    children:[], click(){}, focus(){}, appendChild(){}, removeChild(){}, closest(){ return null; },
    querySelectorAll(){ return []; } };
}

/**
 * A fresh page load. `store` persists across boots to simulate a reload.
 * `memoDom` returns the same stub for a given selector every time, so a test can read
 * back what a render function wrote. Off by default — most tests want a blank element.
 */
function boot(store = {}, refuseStorage = false, memoDom = false, acknowledged = true) {
  // Existing engine tests model a returning user. Gate-specific cases opt out below so the
  // first-use path can be tested without making every arithmetic test acknowledge first.
  if (acknowledged && !(ACK_STORAGE_KEY in store)) store[ACK_STORAGE_KEY] = ACK_VERSION;
  const els = {};
  const pick = sel => memoDom ? (els[sel] = els[sel] || stubEl()) : stubEl();
  const ctx = {
    console, setTimeout, t: assert, near, DOM: els,
    document: { querySelector: pick, querySelectorAll: () => [], createElement: stubEl,
      body: { appendChild(){}, removeChild(){} }, activeElement:null, addEventListener(){} },
    window: { addEventListener(){} },
    localStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { if (refuseStorage) throw new Error("QuotaExceededError"); store[k] = v; },
      removeItem: k => { delete store[k]; }
    },
    navigator: {},
    // Dialogs are recorded so a test can read what the page said, and answered from the
    // context so a test can decline one. CONFIRM_REPLY defaults to true — the behaviour
    // every existing test was written against.
    ALERTS: [], CONFIRMED: [], PROMPTED: [], CONFIRM_REPLY: true,
    alert: m => { ctx.ALERTS.push(String(m)); },
    confirm: m => { ctx.CONFIRMED.push(String(m)); return ctx.CONFIRM_REPLY; },
    // Set PROMPT_REPLY from inside a test to answer the next prompt(); reading it off
    // the context is what lets an engine test drive a dialog the page opens.
    PROMPT_REPLY: "", prompt: m => { ctx.PROMPTED.push(String(m)); return ctx.PROMPT_REPLY; },
    URL: { createObjectURL: () => "", revokeObjectURL(){} },
    Blob: function(){}, FileReader: function(){}
  };
  vm.createContext(ctx);
  return ctx;
}

/* ============================================================
   Engine — assertions run inside the ledger's own scope so they
   can reach its functions directly.
   ============================================================ */
const ENGINE_TESTS = `
function setModel(m){ M = Object.assign(emptyModel(), m); }

console.log('\\n— financial year helpers');
t('30 Jun is prior FY', fyOf('2026-06-30')==='2025-26', fyOf('2026-06-30'),'2025-26');
t('1 Jul starts new FY', fyOf('2026-07-01')==='2026-27', fyOf('2026-07-01'),'2026-27');
t('full year = 365 days', daysHeldIn('2025-26','2020-01-01',null)===365, daysHeldIn('2025-26','2020-01-01',null),365);
t('bought 1 Jan = 181 days', daysHeldIn('2025-26','2026-01-01',null)===181, daysHeldIn('2025-26','2026-01-01',null),181);
t('not yet owned = 0', daysHeldIn('2025-26','2027-01-01',null)===0, daysHeldIn('2025-26','2027-01-01',null),0);
t('disposed mid-year apportions', daysHeldIn('2025-26','2020-01-01','2025-12-31')===184, daysHeldIn('2025-26','2020-01-01','2025-12-31'),184);
t('next FY', fyNext('2025-26')==='2026-27', fyNext('2025-26'),'2026-27');
t('previous FY', fyPrev('2025-26')==='2024-25', fyPrev('2025-26'),'2024-25');

// The year you report on is the one that has finished, not the one you are standing in.
t('in August you are lodging the year that just closed',
  reportingYear('2026-08-09')==='2025-26', reportingYear('2026-08-09'),'2025-26');
t('1 July flips it over', reportingYear('2026-07-01')==='2025-26', reportingYear('2026-07-01'),'2025-26');
t('30 June is one day too early', reportingYear('2026-06-30')==='2024-25', reportingYear('2026-06-30'),'2024-25');
t('and it keeps rolling', reportingYear('2027-09-01')==='2026-27', reportingYear('2027-09-01'),'2026-27');

console.log('\\n— treatment decided by cost, not work use');
[[300,'immediate'],[301,'pool'],[999,'pool'],[1000,'schedule'],[1890,'schedule']]
  .forEach(([c,w])=>t('$'+c+' → '+w, treatmentFor(c,true)===w, treatmentFor(c,true), w));

// Running a pool is a choice, and only the low-cost band depends on it. The paperwork the pool
// saves — an effective life to justify, part-year apportionment — is work this tool already
// does, while what it costs is permanent: a balance that never reaches zero and a row that can
// never be dropped. So it is suggested once the choice has been made, not before.
console.log('\\n— the low-cost band follows whether a pool has been opened');
[[300,'immediate'],[301,'schedule'],[999,'schedule'],[1000,'schedule']]
  .forEach(([c,w])=>t('$'+c+' → '+w+' with no pool open', treatmentFor(c,false)===w, treatmentFor(c,false), w));
t('the $300 and $1,000 thresholds do not move either way',
  treatmentFor(300,true)===treatmentFor(300,false) && treatmentFor(1890,true)===treatmentFor(1890,false),
  'unchanged','unchanged');
setModel({years:[{year:'2025-26'}],assets:[]});
t('an empty ledger has no pool open', poolIsOpen()===false, poolIsOpen(), false);
t('so a $500 asset is suggested an individual schedule', treatmentFor(500)==='schedule', treatmentFor(500),'schedule');
M.assets.push({asset_id:'A-P0',item_supplier:'Dock — Dell',purchase_date:'2025-08-01',cost:600,
  treatment:'pool',work_pct:{'2025-26':100}});
t('allocating one low-cost asset opens the pool', poolIsOpen()===true, poolIsOpen(), true);
t('and every later low-cost asset must follow it there', treatmentFor(500)==='pool', treatmentFor(500),'pool');

console.log('\\n— depreciation: 3-year phone at 70%, held full years');
setModel({years:[{year:'2025-26',marginal:0.32},{year:'2026-27'},{year:'2027-28'},{year:'2028-29'}],
  assets:[{asset_id:'A-1',description:'phone',purchase_date:'2025-07-01',cost:2164,
    treatment:'schedule',effective_life:3,method:'prime_cost',work_pct:{'2025-26':70}}]});
activeYear='2025-26'; let D=derive();
let r=D.dep.find(x=>x.year==='2025-26');
t('decline = cost ÷ 3', near(r.decline,721.33,0.5), r.decline.toFixed(2),'721.33');
t('deductible = decline × 70%', near(r.deductible,504.93,0.5), r.deductible.toFixed(2),'504.93');
t('yr2 opening = yr1 closing', near(D.dep.find(x=>x.year==='2026-27').opening, r.closing),
  D.dep.find(x=>x.year==='2026-27').opening.toFixed(2), r.closing.toFixed(2));
t('work % carries forward without retyping', near(D.dep.find(x=>x.year==='2027-28').work_pct,70),
  D.dep.find(x=>x.year==='2027-28').work_pct,'70');
t('stops at zero, no 4th year claim', near(D.dep.filter(x=>x.year==='2028-29').reduce((s,x)=>s+x.decline,0),0),
  D.dep.filter(x=>x.year==='2028-29').reduce((s,x)=>s+x.decline,0).toFixed(2),'0.00');
t('total decline = cost', near(D.dep.reduce((s,x)=>s+x.decline,0),2164,0.5),
  D.dep.reduce((s,x)=>s+x.decline,0).toFixed(2),'2164.00');
t('never goes negative', D.dep.every(x=>x.closing>=-0.01),'','>=0');

console.log('\\n— work use is a percentage (0-100), not a fraction');
t('default is 100%, not 1%', workPctFor({},'2025-26')===100, workPctFor({},'2025-26'),100);
t('an explicit 0 stays 0', workPctFor({work_pct:{'2025-26':0}},'2025-26')===0, workPctFor({work_pct:{'2025-26':0}},'2025-26'),0);
t('70 renders as 70%', pctNum(70)==='70%', pctNum(70),'70%');
t('a fractional rate still renders via pct()', pct(0.32)==='32%', pct(0.32),'32%');
t('wpFrac(70) multiplies as 0.7', near(wpFrac(70),0.7,1e-9), wpFrac(70),0.7);

console.log('\\n— a percentage set later still applies to earlier years');
t('carried back, not defaulted to 100', workPctFor({work_pct:{'2025-26':60}},'2024-25')===60,
  workPctFor({work_pct:{'2025-26':60}},'2024-25'),60);
t('carried forward as before', workPctFor({work_pct:{'2025-26':60}},'2026-27')===60,
  workPctFor({work_pct:{'2025-26':60}},'2026-27'),60);
t('an exact year still wins', workPctFor({work_pct:{'2024-25':50,'2026-27':80}},'2024-25')===50,
  workPctFor({work_pct:{'2024-25':50,'2026-27':80}},'2024-25'),50);

console.log('\\n— schema 1 files still load');
let leg = migrate({schema:1, expenses:[{id:'e',amount:100,work_pct:0.7}],
  assets:[{asset_id:'A',cost:2000,work_pct:{'2024-25':0.8,'2025-26':0.5}},{asset_id:'B',cost:500,work_pct:0.25}]});
t('schema bumped to 6', leg.schema===6, leg.schema, 6);
t('expense 0.7 becomes 70', leg.expenses[0].work_pct===70, leg.expenses[0].work_pct, 70);
t('per-year 0.8 becomes 80', leg.assets[0].work_pct['2024-25']===80, leg.assets[0].work_pct['2024-25'], 80);
t('a scalar 0.25 becomes 25', leg.assets[1].work_pct===25, leg.assets[1].work_pct, 25);
t('migrating twice changes nothing', migrate(leg).expenses[0].work_pct===70, migrate(leg).expenses[0].work_pct, 70);
t('a schema 2 file keeps its percentages', migrate({schema:2,expenses:[{work_pct:70}]}).expenses[0].work_pct===70,
  migrate({schema:2,expenses:[{work_pct:70}]}).expenses[0].work_pct, 70);

// Four fields nothing ever read back. They are dropped on the way in, so a file sheds
// them the first time it is opened and saved — and what did the work is left untouched.
let stripped = migrate({schema:2,
  years:[{year:'2025-26', taxable_income:98000, payg_withheld:24000, marginal:0.32, wfh_hours:800}],
  assets:[{asset_id:'A', cost:1890, serial:'C02X1234', evidence:'evidence/2026/A-invoice.pdf',
    work_pct:{'2025-26':70}, basis:'phone, 70% work'}]});
t('serial is dropped', !('serial' in stripped.assets[0]), Object.keys(stripped.assets[0]).join(','), 'no serial');
t('evidence path is dropped', !('evidence' in stripped.assets[0]), Object.keys(stripped.assets[0]).join(','), 'no evidence');
t('taxable income is dropped', !('taxable_income' in stripped.years[0]), Object.keys(stripped.years[0]).join(','), 'no taxable_income');
t('PAYG withheld is dropped', !('payg_withheld' in stripped.years[0]), Object.keys(stripped.years[0]).join(','), 'no payg_withheld');
t('the claim inputs survive', stripped.assets[0].cost===1890 && stripped.assets[0].work_pct['2025-26']===70,
  stripped.assets[0].cost+'/'+stripped.assets[0].work_pct['2025-26'], '1890/70');
t('the basis note survives', stripped.assets[0].basis==='phone, 70% work', stripped.assets[0].basis, 'phone, 70% work');
t('the year settings survive', stripped.years[0].marginal===0.32 && stripped.years[0].wfh_hours===800,
  stripped.years[0].marginal+'/'+stripped.years[0].wfh_hours, '0.32/800');

// An expense is identified by who you bought from; its description said the same thing
// twice. Assets use one Item / supplier identity, while helpers split its two meanings for
// effective-life suggestions and supplier matching.
let s5 = migrate({schema:3,
  expenses:[{id:'e1',date:'2025-09-01',description:'Cloud Plus storage (200GB)',
    supplier:'Apple',amount:53.88,work_pct:50,label:'D5',basis:'review — needs a rate'},
    {id:'e2',date:'2026-05-06',description:'ChatGPT',amount:30,work_pct:100,label:'D5'}],
  assets:[{asset_id:'A-1',description:'MacBook Pro',supplier:'Apple',cost:2400,
    work_pct:{'2025-26':70}}]});
t('schema bumped to 6 from 3', s5.schema===6, s5.schema, 6);
t('expense descriptions are dropped', s5.expenses.every(e => !('description' in e)),
  s5.expenses.map(e => Object.keys(e).join(',')).join(' / '), 'no descriptions');
t('a legacy description preserves identity when supplier is blank',
  s5.expenses[1].supplier==='ChatGPT', s5.expenses[1].supplier, 'ChatGPT');
t('an existing supplier wins over the legacy description',
  s5.expenses[0].supplier==='Apple', s5.expenses[0].supplier, 'Apple');
t('the asset identity joins item and supplier', s5.assets[0].item_supplier==='MacBook Pro — Apple',
  s5.assets[0].item_supplier, 'MacBook Pro — Apple');
t('the two legacy asset fields are dropped',
  !('description' in s5.assets[0]) && !('supplier' in s5.assets[0]),
  Object.keys(s5.assets[0]).join(','), 'only item_supplier');
t('the final exact separator is the supplier boundary',
  splitAssetIdentity('Monitor — 27-inch — JB Hi-Fi').item === 'Monitor — 27-inch' &&
    splitAssetIdentity('Monitor — 27-inch — JB Hi-Fi').supplier === 'JB Hi-Fi',
  JSON.stringify(splitAssetIdentity('Monitor — 27-inch — JB Hi-Fi')), 'final separator');
t('a repeated supplier name becomes an explicit item review',
  joinAssetIdentity('Dell','Dell') === 'Review item — Dell', joinAssetIdentity('Dell','Dell'), 'Review item — Dell');
t('the expense keeps what identifies it',
  s5.expenses[0].supplier==='Apple' && s5.expenses[0].amount===53.88 && s5.expenses[0].work_pct===50,
  [s5.expenses[0].supplier,s5.expenses[0].amount,s5.expenses[0].work_pct].join('/'), 'Apple/53.88/50');
t('and the review note it arrived with', s5.expenses[0].basis==='review — needs a rate',
  s5.expenses[0].basis, 'review — needs a rate');

console.log('\\n— one service, one percentage');
setModel({years:[{year:'2025-26'}], expenses:[
  {id:'b1',date:'2025-07-20',description:'internet',supplier:'Optus',amount:25,work_pct:0,label:'D5'},
  {id:'b2',date:'2025-08-20',description:'internet',supplier:'Optus',amount:25,work_pct:0,label:'D5'},
  {id:'b3',date:'2025-09-20',description:'internet',supplier:'Optus',amount:25,work_pct:0,label:'D5'},
  {id:'c1',date:'2025-08-15',description:'hosting',supplier:'Cloudflare',amount:19.03,work_pct:0,label:'D5'}]});
activeYear='2025-26'; derive();
setField('expenses','b1','work_pct',70);
t('setting one charge sets every charge from that service',
  M.expenses.filter(e=>e.supplier==='Optus').every(e=>e.work_pct===70), 'all 70','all 70');
t('a different service is untouched', M.expenses.find(e=>e.id==='c1').work_pct===0,
  M.expenses.find(e=>e.id==='c1').work_pct, 0);

console.log('\\n— the form is filled in at section level');
let LD = derive().lodgment['2025-26'];
t('one line per service, not per charge', LD.deductions.D5.lines.length===2, LD.deductions.D5.lines.length, 2);
t('12 charges would be one line, summed', near(LD.deductions.D5.lines.find(l=>l.name==='Optus').amount, 52.50),
  LD.deductions.D5.lines.find(l=>l.name==='Optus').amount.toFixed(2), '52.50');
t('the line carries its charge count', LD.deductions.D5.lines.find(l=>l.name==='Optus').count===3,
  LD.deductions.D5.lines.find(l=>l.name==='Optus').count, 3);

console.log('\\n— the expenses view groups without collapsing the register');
let G = groupExpenses(M.expenses.filter(e=>fyOf(e.date)==='2025-26'));
t('4 charges show as 2 services', G.length===2, G.length, 2);
t('every charge is still a row underneath', G.reduce((s,g)=>s+g.items.length,0)===4,
  G.reduce((s,g)=>s+g.items.length,0), 4);
t('a group agrees on one percentage', G.find(g=>g.key==='Optus').pcts.length===1,
  G.find(g=>g.key==='Optus').pcts.length, 1);
setGroupField('Cloudflare','work_pct',50);
t('editing the group header writes through', M.expenses.find(e=>e.id==='c1').work_pct===50,
  M.expenses.find(e=>e.id==='c1').work_pct, 50);
setField('expenses','b1','work_pct',101);
t('an invalid row edit leaves the recorded percentage alone',
  M.expenses.find(e=>e.id==='b1').work_pct===70, M.expenses.find(e=>e.id==='b1').work_pct, 70);
setGroupField('Cloudflare','work_pct','');
t('an invalid group edit leaves every charge alone',
  M.expenses.find(e=>e.id==='c1').work_pct===50, M.expenses.find(e=>e.id==='c1').work_pct, 50);
M.expenses.find(e=>e.id==='b2').work_pct = 40;
t('a hand-edited charge shows the group as mixed',
  groupExpenses(M.expenses.filter(e=>fyOf(e.date)==='2025-26')).find(g=>g.key==='Optus').pcts.length===2,
  'mixed','mixed');

console.log('\\n— treatment is computed, and only deliberately overridden');
// A-P keeps the pool open independently of A-T, which is the row being toggled — otherwise
// switching A-T to a schedule would close the pool and change what "the computed value" means
// halfway through the test.
setModel({years:[{year:'2025-26'}], assets:[{asset_id:'A-T',description:'dock',
  category:'Peripherals',purchase_date:'2025-08-01',cost:500,treatment:'pool',work_pct:{'2025-26':100}},
  {asset_id:'A-P',description:'hub',purchase_date:'2025-08-01',cost:400,treatment:'pool',work_pct:{'2025-26':100}}]});
activeYear='2025-26'; derive();
t('the asset row uses the same one-selector presentation as Expenses',
  assetPurposeSelect('Peripherals','pool','noop()').includes('class="claim-purpose"') &&
    !assetPurposeSelect('Peripherals','pool','noop()').includes('pill'),'one selector','one selector');
t('the pooled treatment visibly names return section D6',
  assetPurposeSelect('Peripherals','pool','noop()').includes('D6 · Peripherals — low-value pool'),
  assetPurposeSelect('Peripherals','pool','noop()'), 'D6 · Peripherals — low-value pool');
setTreatment('A-T','schedule');
t('an override is recorded as deliberate', M.assets[0].treatment_locked===true, M.assets[0].treatment_locked, true);
t('Details says when the treatment was set by hand', assetDetail(M.assets[0]).includes('Set deliberately'),'flagged','flagged');
t('an individually depreciated asset visibly names D5',
  assetPurposeSelect('Peripherals','schedule','noop()').includes('D5 · Peripherals — depreciate'),
  assetPurposeSelect('Peripherals','schedule','noop()'), 'D5 · Peripherals — depreciate');
resetTreatment('A-T');
t('reset returns to the computed value', M.assets[0].treatment==='pool', M.assets[0].treatment,'pool');
t('reset clears the lock', M.assets[0].treatment_locked===undefined, M.assets[0].treatment_locked,'undefined');
setTreatment('A-T','pool');
t('choosing the computed value is not an override', M.assets[0].treatment_locked===false,
  M.assets[0].treatment_locked, false);
t('cost change moves an un-overridden treatment',
  (setField('assets','A-T','cost',2400), M.assets[0].treatment==='schedule'), M.assets[0].treatment,'schedule');

// Both methods are offered in the register and both change every figure on a return, but the
// suite had twelve prime_cost fixtures and not one diminishing. The formula is
// opening x (days/365) x (200%/life) — note it reads the OPENING adjustable value each year,
// where prime cost reads the original cost, which is the whole difference between them.
console.log('\\n— diminishing value declines on the opening value, not the cost');
setModel({years:['2025-26','2026-27','2027-28','2028-29'].map(y=>({year:y})),
  assets:[{asset_id:'A-DV',item_supplier:'Workstation — Dell',purchase_date:'2025-07-01',cost:3000,
    treatment:'schedule',effective_life:5,method:'diminishing',
    work_pct:{'2025-26':100,'2026-27':100,'2027-28':100,'2028-29':100}}]});
let DV=derive();
[[0,'2025-26',3000,1200],[1,'2026-27',1800,720],[2,'2027-28',1080,433.18],[3,'2028-29',646.82,258.73]]
  .forEach(([i,fy,open,dec])=>{
    t('FY '+fy+' opens at '+open.toFixed(2), near(DV.dep[i].opening,open,0.02), DV.dep[i].opening.toFixed(2), open.toFixed(2));
    t('and declines '+dec.toFixed(2), near(DV.dep[i].decline,dec,0.02), DV.dep[i].decline.toFixed(2), dec.toFixed(2));
  });
// 1 July 2027 to 30 June 2028 spans a leap day. The ATO formula divides by 365 regardless, so a
// full year held in a leap FY is 366/365 of the annual rate — not a rounding error.
t('a leap financial year is 366 days held', daysHeldIn('2027-28','2025-07-01',null)===366,
  daysHeldIn('2027-28','2025-07-01',null), 366);
t('so its decline is slightly above a plain 40%', DV.dep[2].decline > 1080*0.4,
  DV.dep[2].decline.toFixed(2), 'above 432.00');
t('the same asset on prime cost declines a flat fifth of cost', (() => {
    M.assets[0].method='prime_cost'; const P2=derive();
    return near(P2.dep[0].decline,600) && near(P2.dep[1].decline,600);
  })(), 'flat', '600.00 each year');
M.assets[0].method='diminishing'; DV=derive();
t('decline never exceeds what is left to write off',
  DV.dep.every(r => r.decline <= r.opening + 0.005), 'capped', 'capped');

// Which method an unset field means is a decision, not a fallback. It used to be prime cost by
// accident — the unnamed else branch of one if — and prime cost is the slower of the two, so a
// low-cost asset kept out of the pool claimed less than the pool it declined, which itself runs
// at 37.5% diminishing. The default is now diminishing, held right up until the asset is
// switched into the pool. What a default must never do is restate a figure in a year already
// lodged, so schema 6 pins every row that predates the choice to the prime cost it has in fact
// been claiming, in its own record where it is visible and editable.
console.log('\\n— diminishing value is the default, and it is never applied backwards');
t('an unset method resolves to diminishing', depreciationMethod({})==='diminishing',
  depreciationMethod({}), 'diminishing');
t('an explicit prime cost is left alone', depreciationMethod({method:'prime_cost'})==='prime_cost',
  depreciationMethod({method:'prime_cost'}), 'prime_cost');
t('a new ledger is schema 6', emptyModel().schema===6, emptyModel().schema, 6);

setModel({years:[{year:'2025-26'}], assets:[{asset_id:'A-NM',item_supplier:'Dock — Officeworks',
  purchase_date:'2025-07-01',cost:1000,treatment:'schedule',effective_life:4,work_pct:{'2025-26':100}}]});
t('a scheduled asset with no method declines at 2/life, not 1/life',
  near(derive().dep[0].decline, 500), derive().dep[0].decline.toFixed(2), '500.00, not 250.00');

// The pin is the whole reason this is safe to change. A schema 5 file has been claiming prime
// cost, and reopening it must produce the same numbers it produced yesterday.
const pinned = migrate({schema:5, assets:[{asset_id:'A-OLD',item_supplier:'Laptop — Dell',
  purchase_date:'2024-07-01',cost:3000,treatment:'schedule',effective_life:3,work_pct:{'2024-25':100}}]});
t('an existing row is pinned to prime cost on the way in', pinned.assets[0].method==='prime_cost',
  pinned.assets[0].method, 'prime_cost');
setModel({years:[{year:'2024-25'}], assets:pinned.assets});
t('so its figure does not move', near(derive().dep[0].decline, 1000),
  derive().dep[0].decline.toFixed(2), '1000.00, not 2000.00');
t('a file already at schema 6 is not pinned again',
  migrate({schema:6, assets:[{asset_id:'A-6',cost:900,treatment:'schedule'}]}).assets[0].method===undefined,
  migrate({schema:6, assets:[{asset_id:'A-6',cost:900,treatment:'schedule'}]}).assets[0].method, undefined);

// An imported row is new HERE. It has never produced a figure in this ledger, so there is
// nothing to preserve and it takes the current default rather than the migration's pin —
// which matters because a converter never emits a method at all.
setModel({years:[{year:'2025-26'}], assets:[]});
activeYear='2025-26';
applyImport(planImport({schema:5, assets:[{item_supplier:'Dock — Officeworks',
  source:'gmail',source_ref:'dv1',purchase_date:'2025-07-01',cost:1200,work_pct:{'2025-26':100}}]}));
t('an imported asset takes the default, not the pin', M.assets[0].method==='diminishing',
  M.assets[0].method, 'diminishing');
t('a row moved from Expenses sets it fresh, like treatment',
  asAssetRow({id:'e',date:'2025-07-01',supplier:'Dell',amount:900,work_pct:100}).method==='diminishing',
  asAssetRow({id:'e',date:'2025-07-01',supplier:'Dell',amount:900,work_pct:100}).method, 'diminishing');

// Selling a pooled asset used to do nothing at all: the sale was enterable, accepted and
// ignored, so the pool kept deducting on a balance the proceeds should have reduced and the
// excess was never declared. RULES.md described this as built while derive() did not read
// disposal_date for a pooled row at all.
console.log('\\n— selling a pooled asset reduces the pool and can produce income');
const POOLED = (extra='') => ({years:['2024-25','2025-26','2026-27','2027-28'].map(y=>({year:y})),
  assets:[{asset_id:'A-1',item_supplier:'Dock — Officeworks',purchase_date:'2024-09-01',cost:600,
    treatment:'pool',work_pct:{'2024-25':100}, ...JSON.parse(extra||'{}')}]});

setModel(POOLED('{"disposal_date":"2025-11-01","disposal_proceeds":400}'));
activeYear='2025-26'; let PD=derive();
t('the deduction is charged on the opening balance, so a mid-year sale does not reduce it',
  near(PD.pool['2025-26'].deduction,182.81), PD.pool['2025-26'].deduction.toFixed(2),'182.81');
t('proceeds at the taxable-use share come off the closing balance',
  near(PD.pool['2025-26'].disposals,400), PD.pool['2025-26'].disposals,400);
t('which cannot go below nil', PD.pool['2025-26'].closing===0, PD.pool['2025-26'].closing, 0);
t('the amount above the balance is assessable', near(PD.pool['2025-26'].excess,95.31),
  PD.pool['2025-26'].excess.toFixed(2),'95.31');
t('and reaches the return at item 24', near(PD.lodgment['2025-26'].income.I24.total,95.31),
  PD.lodgment['2025-26'].income.I24.total.toFixed(2),'95.31');
t('an emptied pool claims nothing the next year',
  !PD.lodgment['2026-27'].deductions.D6, PD.lodgment['2026-27'].deductions.D6, 'no D6 line');
t('and the sold row stops showing a share it no longer contributes',
  poolAssetClaim(M.assets[0],'2026-27')===null, poolAssetClaim(M.assets[0],'2026-27'), null);
t('the sale is flagged, because a year already lodged now has different figures',
  derive().warnings.some(w=>w.sev==='high' && /sold out of the low-value pool/.test(w.title)),
  derive().warnings.map(w=>w.title).join('|'), 'a high finding');

// Proceeds under the balance reduce it without producing income.
setModel(POOLED('{"disposal_date":"2025-11-01","disposal_proceeds":100}'));
activeYear='2025-26'; let PS=derive();
t('a smaller sale just reduces the balance', near(PS.pool['2025-26'].closing,204.69),
  PS.pool['2025-26'].closing.toFixed(2),'204.69');
t('with nothing assessable', PS.pool['2025-26'].excess===0, PS.pool['2025-26'].excess, 0);
t('and the pool keeps running next year', PS.pool['2026-27'].deduction>0.005,
  PS.pool['2026-27'].deduction.toFixed(2),'a deduction');

// Regression: an undisposed pool is untouched by any of this.
setModel(POOLED());
activeYear='2025-26'; let PU=derive();
t('a pool with no disposal is unchanged', near(PU.pool['2025-26'].deduction,182.81) && PU.pool['2025-26'].excess===0,
  PU.pool['2025-26'].deduction.toFixed(2)+'/'+PU.pool['2025-26'].excess,'182.81/0');

// The retention date is about the evidence. The row is a separate obligation the ledger imposes
// on itself, because the pool balance is recalculated from it and never stored — so deleting one
// rewrites every later year rather than dropping a record.
console.log('\\n— deleting a pooled row is not the same as letting its evidence lapse');
t('the row is load-bearing while the pool has a balance',
  poolRowIsLoadBearing('assets','A-1')===true, poolRowIsLoadBearing('assets','A-1'), true);
CONFIRMED.length = 0;
removeRow('assets','A-1');
t('so the question names what will actually change',
  /pool is recalculated from this row/.test(CONFIRMED.join(' ')), CONFIRMED.join(' ').slice(0,70), 'the specific warning');
t('and says the change reaches years already lodged',
  /already lodged/.test(CONFIRMED.join(' ')), 'mentioned', 'mentioned');
t('the row still goes when you say yes', M.assets.length===0, M.assets.length, 0);
setModel({years:[{year:'2025-26'}],expenses:[{id:'x',date:'2025-09-01',supplier:'Union',amount:600,work_pct:100,label:'D5'}]});
derive(); CONFIRMED.length = 0;
removeRow('expenses','x');
t('an ordinary row keeps the ordinary question',
  /only as good as what stays in it/.test(CONFIRMED.join(' ')), CONFIRMED.join(' ').slice(0,60), 'the generic warning');

console.log('\\n— a pooled asset claims at D6, and says so');
setModel({years:[{year:'2025-26'},{year:'2026-27'}], assets:[{asset_id:'A-D',description:'Dell',
  purchase_date:'2025-11-24',cost:310.32,treatment:'pool',work_pct:{'2025-26':100}}]});
activeYear='2025-26'; let P=derive();
t('year one is 18.75% of what went in', near(P.pool['2025-26'].deduction,58.19), P.pool['2025-26'].deduction.toFixed(2),'58.19');
t('it reaches the return at D6', near(P.lodgment['2025-26'].deductions.D6.total,58.19),
  P.lodgment['2025-26'].deductions.D6.total.toFixed(2),'58.19');
t('the asset row shows its share, not a dash', poolClaimCell(M.assets[0]).includes('58.19'),'58.19','58.19');

// myTax will not take one D6 number: three boxes, all required. However the split is worked
// out, the three have to add back to the D6 total or the return disagrees with the ledger.
const D6F = poolFields(P.lodgment['2025-26'].deductions.D6.total);
t('D6 is presented as the three boxes myTax asks for', D6F.length===3, D6F.length, 3);
t('named exactly as the return names them',
  D6F.map(f=>f[0]).join('|')==='Low value pool deduction relating to financial investment|'+
    'Low value pool deduction relating to rental property|Remaining low value pool deduction',
  D6F.map(f=>f[0]).join('|'), 'the three myTax labels');
t('work-related assets put nothing against investment or rental',
  D6F[0][1]===0 && D6F[1][1]===0, [D6F[0][1],D6F[1][1]].join(','), '0,0');
t('and the three reconcile to the D6 total',
  near(D6F.reduce((s,f)=>s+f[1],0), P.lodgment['2025-26'].deductions.D6.total),
  D6F.reduce((s,f)=>s+f[1],0).toFixed(2), '58.19');
t('year two is 37.5% of the balance', near(P.pool['2026-27'].deduction,94.55), P.pool['2026-27'].deduction.toFixed(2),'94.55');
activeYear='2026-27';
t('later years show the asset contribution as a value', poolClaimCell(M.assets[0]).includes('94.55'),
  poolClaimCell(M.assets[0]), '94.55');
t('the old "in pool" placeholder is gone', !poolClaimCell(M.assets[0]).includes('in pool'),
  poolClaimCell(M.assets[0]), 'a value');
activeYear='2025-26';
M.assets[0].work_pct={'2025-26':0}; P=derive();
t('a 0% asset adds nothing to the pool', P.pool['2025-26'].deduction===0, P.pool['2025-26'].deduction, 0);

console.log('\\n— pooled assets automatically fill five years');
setModel({years:[{year:'2025-26'}], assets:[{asset_id:'A-5Y',description:'dock',
  purchase_date:'2025-11-24',cost:800,treatment:'pool',work_pct:{'2025-26':100}}]});
P=derive();
t('allocation year plus four later years appear automatically',
  P.years.join(',')==='2025-26,2026-27,2027-28,2028-29,2029-30', P.years.join(','),
  '2025-26,2026-27,2027-28,2028-29,2029-30');
t('only the allocation year counts as entered data', enteredYears().join(',')==='2025-26',
  enteredYears().join(','), '2025-26');
t('all five years have pool data', Object.keys(P.pool).length===5, Object.keys(P.pool).length, 5);
t('year five carries the pool forward at 37.5%', near(P.pool['2029-30'].deduction,59.51),
  P.pool['2029-30'].deduction.toFixed(2), '59.51');
t('automatic years are derived, not saved into the ledger', M.years.length===1, M.years.length, 1);
M.income.push({id:'later',date:'2031-08-01',type:'interest',gross_aud:1});
P=derive();
t('a later row cannot make the pool skip intervening years',
  P.years.includes('2030-31') && P.years.includes('2031-32'), P.years.join(','),
  'contains 2030-31 and 2031-32');
t('the later balance has received every annual deduction', near(P.pool['2031-32'].opening,61.989),
  P.pool['2031-32'].opening.toFixed(3), '61.989');

console.log('\\n— retention for assets that never produce a per-asset claim');
setModel({years:[{year:'2025-26'},{year:'2026-27'},{year:'2027-28'}], assets:[
  {asset_id:'K-POOL',description:'Dell',purchase_date:'2025-11-24',cost:310.32,treatment:'pool',work_pct:{'2025-26':100}},
  {asset_id:'K-IMM', description:'cable',purchase_date:'2025-08-01',cost:200,treatment:'immediate',work_pct:{'2025-26':100}},
  {asset_id:'K-SCH', description:'laptop',purchase_date:'2025-07-01',cost:2164,treatment:'schedule',
   effective_life:3,method:'prime_cost',work_pct:{'2025-26':100}}]});
activeYear='2025-26'; let K=derive();
t('pooled: 5 years from the END of the allocation year, not the purchase',
  K.keep['K-POOL']==='2031-06-30', K.keep['K-POOL'], '2031-06-30');
t('pooled retention is not 5 years from purchase', K.keep['K-POOL']!=='2030-11-24', K.keep['K-POOL'], 'not 2030-11-24');
t('pooled retention does not chase the pool to the 2030s', K.keep['K-POOL'] < '2032-01-01', K.keep['K-POOL'], '< 2032');
t('immediate write-off runs from the end of its claim year',
  K.keep['K-IMM']==='2031-06-30', K.keep['K-IMM'], '2031-06-30');
t('a scheduled asset still runs from its last real claim',
  K.keep['K-SCH']==='2033-06-30', K.keep['K-SCH'], '2033-06-30');

console.log('\\n— every save is its own file, not "ledger (2)"');
const T = new Date(2026, 7, 6, 19, 30, 5);            // 6 Aug 2026, 19:30:05 local
t('stamp sorts and reads as a datetime', stamp(T)==='20260806-193005', stamp(T), '20260806-193005');
t('single digits are padded', stamp(new Date(2026,0,2,3,4,5))==='20260102-030405',
  stamp(new Date(2026,0,2,3,4,5)), '20260102-030405');
fileName = null; activeYear = '2025-26';
t('a first save is named from the year', saveFileName(T)==='ledger-2025-26-20260806-193005.json',
  saveFileName(T), 'ledger-2025-26-20260806-193005.json');
fileName = 'ledger-2025-26-20260101-090000.json';
t('saving again re-stamps, it does not stack stamps',
  saveFileName(T)==='ledger-2025-26-20260806-193005.json', saveFileName(T), 'ledger-2025-26-20260806-193005.json');
fileName = 'my-tax-2025.json';
t('a hand-named file keeps its name as the stem',
  saveFileName(T)==='my-tax-2025-20260806-193005.json', saveFileName(T), 'my-tax-2025-20260806-193005.json');
fileName = null; activeYear = null;
t('no year yet still produces a valid name', saveFileName(T)==='ledger-unfiled-20260806-193005.json',
  saveFileName(T), 'ledger-unfiled-20260806-193005.json');
t('two saves a second apart differ',
  saveFileName(new Date(2026,7,6,19,30,5))!==saveFileName(new Date(2026,7,6,19,30,6)), 'differ','differ');

// The browser's own duplicate marker must never become part of the name.
const T2 = new Date(2026, 7, 6, 20, 9, 0);
const WANT = 'ledger-fy2025-26-20260806-200900.json';
[['ledger-fy2025-26 (2).json',                    'a browser duplicate of an unstamped file'],
 ['ledger-fy2025-26 (2)-20260806-200900.json',    'the marker already baked into a stamped name'],
 ['ledger-fy2025-26-20260806-200900 (2).json',    'the marker appended after a stamp'],
 ['ledger-fy2025-26 (12).json',                   'a two-digit marker'],
 ['ledger-fy2025-26 (2) (3).json',                'markers that bred'],
 ['ledger-fy2025-26.json',                        'a clean name is untouched']
].forEach(([given, why]) => {
  fileName = given;
  t(why, saveFileName(T2)===WANT, saveFileName(T2), WANT);
});
fileName = 'ledger-2025.json';
t('a name that merely ends in digits keeps them',
  saveFileName(T2)==='ledger-2025-20260806-200900.json', saveFileName(T2), 'ledger-2025-20260806-200900.json');
fileName = null; activeYear='2025-26';
activeYear='2025-26'; fileName=null;

console.log('\\n— importing merges, and refuses to claim the same row twice');
setModel({years:[{year:'2025-26'}], expenses:[
  {id:'kept',date:'2025-09-01',description:'union fees',supplier:'Union',amount:600,work_pct:100,label:'D5'}]});
activeYear='2025-26'; derive();
const FEED = {schema:2, years:[], assets:[
    {asset_id:'A-2026-001',description:'Dell',supplier:'Dell',purchase_date:'2025-11-24',cost:310.32,
     treatment:'pool',work_pct:{'2025-26':0},source:'paypal',source_ref:'TXN-DELL'}],
  expenses:[
    {id:'e-pp-optus',date:'2026-06-20',description:'internet',supplier:'Optus',amount:300,work_pct:0,
     label:'D5',source:'paypal',source_ref:'TXN-OPTUS'},
    {id:'e-pp-cf',date:'2026-06-27',description:'hosting',supplier:'Cloudflare',amount:81.33,work_pct:0,
     label:'D5',source:'paypal',source_ref:'TXN-CF'}],
  income:[]};

let pl = planImport(JSON.parse(JSON.stringify(FEED)));
t('plans every incoming row', pl.add.expenses.length===2 && pl.add.assets.length===1, 'e2/a1','e2/a1');
applyImport(pl);
t('existing work is kept', M.expenses.some(e=>e.id==='kept'), 'kept','kept');
t('imported rows land beside it', M.expenses.length===3, M.expenses.length, 3);
t('the asset comes through', M.assets.length===1 && M.assets[0].asset_id==='A-2026-001', M.assets.length, 1);
t('imported at 0% it claims nothing yet', derive().lodgment['2025-26'].deductions.D6===undefined,
  'no D6 line','no D6 line');
M.assets[0].work_pct={'2025-26':100};
t('once you set the work %, it reaches the return at D6',
  near(derive().lodgment['2025-26'].deductions.D6.total, 58.19),
  derive().lodgment['2025-26'].deductions.D6.total.toFixed(2), '58.19');
M.assets[0].work_pct={'2025-26':0};

let pl2 = planImport(JSON.parse(JSON.stringify(FEED)));
t('a second import of the same file adds nothing', pl2.add.expenses.length===0 && pl2.add.assets.length===0,
  pl2.add.expenses.length + '/' + pl2.add.assets.length, '0/0');
t('and says what it skipped', pl2.skip.expenses.length===2 && pl2.skip.assets.length===1,
  pl2.skip.expenses.length + '/' + pl2.skip.assets.length, '2/1');
applyImport(pl2);
t('re-importing does not double the claim', M.expenses.length===3, M.expenses.length, 3);

console.log('\\n— identity without a source_ref, and id collisions');
const NOREF = {schema:2, expenses:[
  {id:'x',date:'2026-06-20',description:'internet',supplier:'Optus',amount:300,work_pct:0,label:'D5'}]};
t('an identical charge with no source_ref is caught by its fields',
  planImport(NOREF).add.expenses.length===0, planImport(NOREF).add.expenses.length, 0);
const REVERSE = {schema:2, expenses:[
  {id:'y',date:'2026-06-27',description:'hosting',supplier:'Cloudflare',amount:81.33,work_pct:0,label:'D5',
   source:'other-tool',source_ref:'DIFFERENT-ID'}]};
t('a different source_ref for the same charge is still caught by its fields',
  planImport(REVERSE).add.expenses.length===0, planImport(REVERSE).add.expenses.length, 0);
const DIFFERENT = {schema:2, expenses:[
  {id:'kept',date:'2026-05-05',description:'a real second charge',supplier:'Optus',amount:11,work_pct:0,label:'D5'}]};
let pl3 = planImport(DIFFERENT);
t('a genuinely different charge is imported', pl3.add.expenses.length===1, pl3.add.expenses.length, 1);
applyImport(pl3);
t('a colliding id is re-keyed, not overwritten',
  M.expenses.filter(e=>e.id==='kept').length===1 && M.expenses.length===4, M.expenses.length, 4);
t('the original row survives the collision',
  M.expenses.find(e=>e.id==='kept').amount===600, M.expenses.find(e=>e.id==='kept').amount, 600);

console.log('\\n— an imported schema 1 file is converted on the way in');
let pl4 = planImport({schema:1, expenses:[
  {id:'old',date:'2026-03-03',description:'phone',supplier:'Telco',amount:100,work_pct:0.7,label:'D5'}]});
t('work use converts to a percentage as it arrives', pl4.add.expenses[0].work_pct===70,
  pl4.add.expenses[0].work_pct, 70);

console.log('\\n— a year you have already set up is never overwritten');
M.years[0].marginal = 0.47;
applyImport(planImport({schema:2, years:[{year:'2025-26', marginal:0.32}, {year:'2027-28'}], expenses:[]}));
t('your own year settings stand', M.years.find(y=>y.year==='2025-26').marginal===0.47,
  M.years.find(y=>y.year==='2025-26').marginal, 0.47);
t('a genuinely new year is added', M.years.some(y=>y.year==='2027-28'), 'added','added');

// Import is append-only, so undo is subtraction-only. The test of that is not "the rows
// are gone" but "everything else is exactly as it was" — a wrong file should cost you
// the wrong file, not the afternoon.
console.log('\\n— undoing an import that turned out to be the wrong file');
setModel({years:[{year:'2025-26',marginal:0.47,wfh_method:'fixed',wfh_hours:800}], expenses:[
  {id:'kept',date:'2025-09-01',description:'union fees',supplier:'Union',amount:600,work_pct:100,label:'D5'}]});
activeYear='2025-26';
const before = JSON.stringify(derive().lodgment['2025-26']);
applyImport(planImport(JSON.parse(JSON.stringify(FEED))), 'paypal-2026.json');
t('the import lands', M.expenses.length===3 && M.assets.length===1,
  M.expenses.length+'e/'+M.assets.length+'a', '3e/1a');
t('and is recorded by id, not by row', lastImport.added.assets[0]==='A-2026-001',
  JSON.stringify(lastImport.added.assets), '["A-2026-001"]');
t('with the file it came from', lastImport.from==='paypal-2026.json', lastImport.from,'paypal-2026.json');

t('undo reports success', undoLastImport()===true, 'true','true');
t('the imported expenses are gone', M.expenses.length===1, M.expenses.length, 1);
t('your own row is untouched', M.expenses[0].id==='kept' && M.expenses[0].amount===600,
  M.expenses[0].id+'/'+M.expenses[0].amount, 'kept/600');
t('the imported asset is gone', M.assets.length===0, M.assets.length, 0);
t('every lodgment total is back where it was', JSON.stringify(derive().lodgment['2025-26'])===before,
  JSON.stringify(derive().lodgment['2025-26']), before);
t('and there is nothing left to undo', lastImport===null, lastImport, 'null');
t('undoing twice is not an error', undoLastImport()===false, undoLastImport(),'false');

// A year the import created is the import's to remove. A year you had already set up is
// not — and it never was, since planImport refuses to queue one.
console.log('\\n— undo gives back years the import made, and only those');
setModel({years:[{year:'2025-26',marginal:0.47}], expenses:[
  {id:'mine',date:'2025-09-01',description:'union fees',amount:600,work_pct:100,label:'D5'}]});
activeYear='2025-26';
applyImport(planImport({schema:2, years:[{year:'2025-26',marginal:0.32},{year:'2027-28'}],
  expenses:[{id:'imp',date:'2027-09-01',description:'hosting',supplier:'Cloudflare',amount:90,work_pct:100,label:'D5'}]}));
t('the new year arrives', M.years.some(y=>y.year==='2027-28'), 'added','added');
undoLastImport();
t('the new year goes back out', M.years.some(y=>y.year==='2027-28')===false, 'gone','gone');
t('your year stays, with your rate', M.years.find(y=>y.year==='2025-26').marginal===0.47,
  M.years.find(y=>y.year==='2025-26').marginal, 0.47);
t('and your row stays with it', M.expenses.length===1 && M.expenses[0].id==='mine',
  M.expenses.length+'/'+M.expenses[0].id, '1/mine');

// applyImport re-keys an incoming id that collides. Read the ids before that happens and
// undo hunts for a row under a name it no longer has — deleting the wrong row, or none.
console.log('\\n— a re-keyed row is still found by undo');
setModel({years:[{year:'2025-26'}], expenses:[
  {id:'kept',date:'2025-09-01',description:'union fees',supplier:'Union',amount:600,work_pct:100,label:'D5'}]});
activeYear='2025-26';
applyImport(planImport({schema:2, expenses:[
  {id:'kept',date:'2026-02-02',description:'domain',supplier:'Namecheap',amount:22,work_pct:100,label:'D5'}]}));
t('the collision is re-keyed on the way in', M.expenses.length===2 && M.expenses[1].id!=='kept',
  M.expenses.map(e=>e.id).join(','), 'kept + something else');
t('undo tracked the new id', lastImport.added.expenses[0]===M.expenses[1].id,
  lastImport.added.expenses[0], M.expenses[1].id);
undoLastImport();
t('the re-keyed row is removed', M.expenses.length===1, M.expenses.length, 1);
t('and the original keeps its id and amount', M.expenses[0].id==='kept' && M.expenses[0].amount===600,
  M.expenses[0].id+'/'+M.expenses[0].amount, 'kept/600');

// IMPORT-FORMAT.md tells a converter it never emits asset_id. Honouring a non-colliding one
// made that advisory: an id minted elsewhere promises nothing about the year it encodes or the
// ids this ledger hands out next. Identity across imports is source + source_ref.
console.log('\\n— a supplied asset_id is never trusted');
setModel({years:[{year:'2025-26'}], assets:[]});
activeYear='2025-26';
applyImport(planImport({schema:5, assets:[
  {asset_id:'A-9999-042',item_supplier:'Dell dock — Officeworks',source:'gmail',source_ref:'m1',
   purchase_date:'2025-11-24',cost:310.32,work_pct:{'2025-26':0}}]}));
t('the ledger allocates its own id', M.assets[0].asset_id!=='A-9999-042', M.assets[0].asset_id, 'not A-9999-042');
t('and it encodes the purchase year', /^A-2026-/.test(M.assets[0].asset_id), M.assets[0].asset_id, 'A-2026-nnn');
t('re-importing the same source_ref still skips as a duplicate',
  (applyImport(planImport({schema:5, assets:[
    {asset_id:'A-9999-042',item_supplier:'Dell dock — Officeworks',source:'gmail',source_ref:'m1',
     purchase_date:'2025-11-24',cost:310.32,work_pct:{'2025-26':0}}]})), M.assets.length===1),
  M.assets.length, 1);

// issuer is documented as the join key across sources. It has to actually be one, or it is a
// field nothing consumes — the reason schema 3 dropped serial and evidence.
console.log('\\n— issuer joins two spellings of one merchant');
// Deliberately a pair SUPPLIER_NOISE cannot join: stripping "pty ltd" collapses spellings of
// one name, but "Optus Internet" and "Optus Broadband" stay two keys on the display name
// alone. Only the converter knows they are one merchant, and issuer is how it says so.
setModel({years:[{year:'2025-26'}], expenses:[
  {id:'a',date:'2025-09-01',issuer:'optus',supplier:'Optus Internet',source:'gmail',source_ref:'g1',
   amount:70,work_pct:100,label:'D5',category:'Information services'},
  {id:'b',date:'2025-10-01',issuer:'optus',supplier:'Optus Broadband',source:'paypal',source_ref:'p1',
   amount:70,work_pct:100,label:'D5',category:'Information services'}]});
activeYear='2025-26';
t('the display names alone would not join them',
  normaliseSupplier('Optus Internet')!==normaliseSupplier('Optus Broadband'),
  normaliseSupplier('Optus Internet')+' vs '+normaliseSupplier('Optus Broadband'), 'two keys');
const ixKeys = Object.keys(supplierIndex());
t('two spellings collapse to one issuer key', ixKeys.length===1, ixKeys.join(' | '), 'one key');
t('and both sources hang off it',
  Object.keys(supplierIndex()[ixKeys[0]].sources).sort().join(',')==='gmail,paypal',
  Object.keys(supplierIndex()[ixKeys[0]].sources).sort().join(','), 'gmail,paypal');
t('a hand-entered row with no issuer still keys off its supplier',
  issuerKey({}, 'Optus Pty. Ltd.')==='optus', issuerKey({}, 'Optus Pty. Ltd.'), 'optus');

// You are allowed to keep working while you decide whether the import was right.
console.log('\\n— work done after the import survives the undo');
setModel({years:[{year:'2025-26'}], expenses:[]});
activeYear='2025-26';
applyImport(planImport(JSON.parse(JSON.stringify(FEED))));
M.expenses.push({id:'typed',date:'2025-10-01',description:'stationery',supplier:'Officeworks',
  amount:45,work_pct:100,label:'D5'});
M.years[0].wfh_hours = 900;
undoLastImport();
t('the row you typed is still there', M.expenses.length===1 && M.expenses[0].id==='typed',
  M.expenses.map(e=>e.id).join(',')||'none', 'typed');
t('and the year setting you changed', M.years[0].wfh_hours===900, M.years[0].wfh_hours, 900);

// Re-importing the same file adds nothing. Arming an undo for that would offer to remove
// rows the earlier import owns.
console.log('\\n— an import that adds nothing arms nothing');
setModel({years:[{year:'2025-26'}], expenses:[]});
activeYear='2025-26';
applyImport(planImport(JSON.parse(JSON.stringify(FEED))), 'first.json');
applyImport(planImport(JSON.parse(JSON.stringify(FEED))), 'again.json');
t('the second import is not what undo points at', lastImport.from==='first.json',
  lastImport.from, 'first.json');
undoLastImport();
t('and undo still clears the rows the first one added', M.expenses.length===0 && M.assets.length===0,
  M.expenses.length+'e/'+M.assets.length+'a', '0e/0a');

// A record pointing into a ledger that is no longer loaded would be a lie.
console.log('\\n— replacing the ledger retires the undo');
setModel({years:[{year:'2025-26'}], expenses:[]});
activeYear='2025-26';
applyImport(planImport(JSON.parse(JSON.stringify(FEED))));
resetAll();
t('clearing everything clears the import record', lastImport===null, lastImport,'null');

console.log('\\n— the same supplier under two different names is one supplier');
t('company suffixes are noise', normaliseSupplier('OPTUS PTY LTD')===normaliseSupplier('Optus'),
  normaliseSupplier('OPTUS PTY LTD'), normaliseSupplier('Optus'));
t('punctuation and case are noise', normaliseSupplier('GitHub, Inc.')===normaliseSupplier('github inc'),
  normaliseSupplier('GitHub, Inc.'), normaliseSupplier('github inc'));
t('Dell Australia is Dell', normaliseSupplier('Dell Australia')==='dell', normaliseSupplier('Dell Australia'),'dell');
t('different suppliers stay different', normaliseSupplier('Optus')!==normaliseSupplier('Cloudflare'),
  'differ','differ');

console.log('\\n— PayPal and the card that funded it: the duplicate no key can catch');
setModel({years:[{year:'2025-26'}], expenses:[]});
activeYear='2025-26';
applyImport(planImport({schema:2, expenses:[{id:'pp',date:'2026-06-20',description:'internet',
  supplier:'Optus',amount:300,work_pct:70,label:'D5',source:'paypal',source_ref:'TXN-1'}]}));
t('the grouped PayPal row claims 210.00', near(derive().lodgment['2025-26'].deductions.D5.total,210),
  derive().lodgment['2025-26'].deductions.D5.total.toFixed(2),'210.00');

const card = {schema:2, expenses:['2025-07-21','2025-08-21','2025-09-21','2025-10-21','2025-11-21','2025-12-21',
  '2026-01-21','2026-02-21','2026-03-21','2026-04-21','2026-05-21','2026-06-21'].map((d,i)=>
  ({id:'c'+i,date:d,description:'OPTUS PTY LTD',supplier:'OPTUS PTY LTD',amount:25,work_pct:70,
    label:'D5',source:'card',source_ref:'CARD-'+i}))};
const cp = planImport(card);
t('no key matches them — they are still planned as new', cp.add.expenses.length===12, cp.add.expenses.length, 12);
t('but the overlap is caught and reported', cp.cross.length===1, cp.cross.length, 1);
t('the preview names the source already present', cp.cross[0].existing.includes('paypal'),
  cp.cross[0].existing.join(','), 'paypal');
t('the preview warning is not empty', planSummary(cp).warn.includes('DIFFERENT SOURCE'), 'warned','warned');

console.log('\\n— and if it is imported anyway, lodgment still says so');
applyImport(cp);
t('the claim has doubled, as it must', near(derive().lodgment['2025-26'].deductions.D5.total,420),
  derive().lodgment['2025-26'].deductions.D5.total.toFixed(2),'420.00');
const dupWarn = derive().warnings.find(x=>x.title.indexOf('sources in')>-1);
t('a high warning is raised', !!dupWarn && dupWarn.sev==='high', dupWarn && dupWarn.sev, 'high');
t('it names both sources', dupWarn.detail.indexOf('paypal')>-1 && dupWarn.detail.indexOf('card')>-1,
  'both named','both named');

console.log('\\n— one source per supplier raises nothing');
setModel({years:[{year:'2025-26'}], expenses:[
  {id:'a',date:'2026-06-20',supplier:'Optus',description:'internet',amount:300,work_pct:70,label:'D5',source:'paypal'},
  {id:'b',date:'2026-06-27',supplier:'Cloudflare',description:'hosting',amount:81,work_pct:100,label:'D5',source:'card'}]});
activeYear='2025-26';
t('two suppliers, one source each, no warning',
  derive().warnings.filter(x=>x.title.indexOf('sources in')>-1).length===0,
  derive().warnings.filter(x=>x.title.indexOf('sources in')>-1).length, 0);
M.expenses.push({id:'c',date:'2026-03-01',supplier:'Optus',description:'internet',amount:25,work_pct:70,label:'D5'});
t('a hand-entered row counts as its own source',
  derive().warnings.filter(x=>x.title.indexOf('sources in')>-1).length===1,
  derive().warnings.filter(x=>x.title.indexOf('sources in')>-1).length, 1);

console.log('\\n— categories group suppliers into what you are actually claiming');
t('a telco is an information service', suggestCategory('Optus','mobile')==='Information services',
  suggestCategory('Optus','mobile'), 'Information services');
t('the same words as an asset suggest nothing from the expense list',
  suggestCategory('Optus','mobile','assets')==='', suggestCategory('Optus','mobile','assets'), '(empty)');
t('a CDN is hosting', suggestCategory('Cloudflare Inc','DNS and CDN')==='Hosting and domains',
  suggestCategory('Cloudflare Inc','DNS and CDN'), 'Hosting and domains');
t('a cloud plan is storage', suggestCategory('Acme Cloud Plus','Cloud Plus storage')==='Storage and backup',
  suggestCategory('Acme Cloud Plus','Cloud Plus storage'), 'Storage and backup');
t('an unknown supplier gets none', suggestCategory('Some Shop','thing')==='',
  suggestCategory('Some Shop','thing'), '(empty)');

setModel({years:[{year:'2025-26'}], expenses:[
  {id:'b',date:'2026-06-20',supplier:'Optus',description:'mobile',amount:300,work_pct:100,label:'D5',category:'Information services'},
  {id:'t',date:'2026-06-21',supplier:'Telstra',description:'internet',amount:200,work_pct:100,label:'D5',category:'Information services'},
  {id:'c',date:'2026-06-27',supplier:'Cloudflare',description:'dns',amount:81,work_pct:100,label:'D5',category:'Hosting and domains'},
  {id:'u',date:'2026-05-01',supplier:'Union',description:'fees',amount:600,work_pct:100,label:'D5'}]});
activeYear='2025-26';
let LC = derive().lodgment['2025-26'].deductions.D5;
t('D5 reports one line per category', LC.lines.length===3, LC.lines.length, 3);
const info = LC.lines.find(l=>l.name==='Information services');
t('two telcos roll into one category line', near(info.amount,500), info.amount.toFixed(2), '500.00');
t('the suppliers survive underneath', info.parts.length===2, info.parts.length, 2);
t('and each one keeps its own subtotal',
  near(info.parts.find(p=>p.name==='Optus').amount,300), info.parts.find(p=>p.name==='Optus').amount.toFixed(2),'300.00');
t('a row with no category still reports under its supplier',
  !!LC.lines.find(l=>l.name==='Union'), 'Union','Union');
t('the section total is unchanged by grouping', near(LC.total,1181), LC.total.toFixed(2),'1181.00');

console.log('\\n— setting a category applies to the whole service');
setGroupField('Optus','category','Telecommunications');
t('every charge from that supplier follows',
  M.expenses.filter(e=>e.supplier==='Optus').every(e=>e.category==='Telecommunications'), 'all','all');
t('and the return regroups accordingly',
  !!derive().lodgment['2025-26'].deductions.D5.lines.find(l=>l.name==='Telecommunications'),
  'regrouped','regrouped');

console.log('\\n— an immediate asset reports under its category too');
setModel({years:[{year:'2025-26'}], assets:[{asset_id:'A-C',description:'keyboard',supplier:'Officeworks',
  purchase_date:'2025-08-01',cost:200,treatment:'immediate',work_pct:{'2025-26':100},category:'Computer equipment'}]});
activeYear='2025-26';
const LA = derive().lodgment['2025-26'].deductions.D5;
t('the asset lands under its category', !!LA.lines.find(l=>l.name==='Computer equipment'),
  LA.lines[0].name, 'Computer equipment');

console.log('\\n— the taxonomy knows an asset from an expense');
setModel({years:[{year:'2025-26'}], expenses:[], assets:[]});   // hints only, no prior rows
t('a laptop is a computer, not a service', suggestCategory('Dell','14" laptop','assets')==='Computers',
  suggestCategory('Dell','14" laptop','assets'), 'Computers');
t('a dock is a peripheral', suggestCategory('Dell','usb dock','assets')==='Peripherals',
  suggestCategory('Dell','usb dock','assets'), 'Peripherals');
t('a desk is furniture', suggestCategory('Officeworks','standing desk','assets')==='Furniture',
  suggestCategory('Officeworks','standing desk','assets'), 'Furniture');
t('a laptop suggests nothing from the expense list',
  suggestCategory('Dell','14" laptop','expenses')==='', suggestCategory('Dell','14" laptop','expenses'), '(empty)');
setModel({years:[{year:'2025-26'}], expenses:[], assets:[]});
t('the expense picker offers no hardware',
  knownCategories('expenses').indexOf('Computers')===-1, 'absent','absent');
t('the asset picker offers no services',
  knownCategories('assets').indexOf('Information services')===-1, 'absent','absent');
t('each picker offers its own', knownCategories('assets').indexOf('Computers')>-1 &&
  knownCategories('expenses').indexOf('Information services')>-1, 'both','both');
M.assets.push({asset_id:'A-P',description:'keyboard',supplier:'Officeworks',purchase_date:'2025-08-01',
  cost:200,treatment:'immediate',work_pct:{'2025-26':100},category:'Peripherals'});
t('what you called a supplier last time beats the hint',
  suggestCategory('Officeworks','standing desk','assets')==='Peripherals',
  suggestCategory('Officeworks','standing desk','assets'), 'Peripherals');
t('and it does not leak across kinds',
  suggestCategory('Officeworks','standing desk','expenses')==='',
  suggestCategory('Officeworks','standing desk','expenses'), '(empty)');
const purposeOptions = purposeSelect('Information services','D5','noop()');
t('expense purposes also show their return section without offering asset-only D6',
  purposeOptions.includes('D5 · Phone, internet and data') && purposeOptions.includes('D9 · Gifts and donations') &&
    !purposeOptions.includes('D6 ·'), purposeOptions, 'visible D-codes, no D6');

console.log('\\n— a thing entered as a service is caught');
setModel({years:[{year:'2025-26'}], expenses:[
  {id:'bad',date:'2025-11-24',supplier:'Dell',description:'dock',amount:310.32,work_pct:100,
   label:'D5',category:'Peripherals'},
  {id:'ok',date:'2025-11-24',supplier:'Officeworks',description:'cable',amount:29,work_pct:100,
   label:'D5',category:'Peripherals'},
  {id:'svc',date:'2026-06-20',supplier:'Optus',description:'mobile',amount:300,work_pct:100,
   label:'D5',category:'Information services'}]});
activeYear='2025-26';
const mis = derive().warnings.filter(x=>x.title.indexOf('categorised as')>-1);
t('an over-threshold hardware expense is flagged', mis.length===1, mis.length, 1);
t('it names the amount', mis[0].title.indexOf('310.32')>-1, mis[0].title, 'names 310.32');
t('it is high severity', mis[0].sev==='high', mis[0].sev, 'high');
t('a $29 cable is not flagged', mis.filter(x=>x.title.indexOf('29.00')>-1).length===0, 0, 0);
t('a service is never flagged', mis.filter(x=>x.title.indexOf('Optus')>-1).length===0, 0, 0);

console.log('\\n— the category picker is a dropdown, and reaches both collections');
setModel({years:[{year:'2025-26'}], expenses:[], assets:[]});
const selE = categorySelect('expenses','Information services','noop()');
t('it renders a select, not a text box', selE.indexOf('<select')===0 && selE.indexOf('<input')===-1,
  selE.slice(0,7), '<select');
t('the current value is selected', selE.indexOf('value="Information services" selected')>-1, 'selected','selected');
t('an empty option exists for uncategorised', selE.indexOf('<option value="">')>-1, 'yes','yes');
t('a new category is reachable', selE.indexOf('__new')>-1, 'yes','yes');
t('the expense picker offers no asset categories', selE.indexOf('>Computers<')===-1, 'absent','absent');
const selA = categorySelect('assets','Peripherals','noop()');
t('the asset picker offers asset categories', selA.indexOf('>Computers<')>-1, 'present','present');
t('and no service categories', selA.indexOf('>Information services<')===-1, 'absent','absent');
const selCustom = categorySelect('expenses','Something I invented','noop()');
t('a category not in the list is kept as an option',
  selCustom.indexOf('value="Something I invented" selected')>-1, 'kept','kept');

console.log('\\n— choosing "+ new category"');
setModel({years:[{year:'2025-26'}], expenses:[
  {id:'x',date:'2026-06-20',supplier:'Optus',description:'mobile',amount:300,work_pct:100,label:'D5'}]});
activeYear='2025-26'; derive();
PROMPT_REPLY = 'Telecommunications';
chooseCategory('expenses','x','__new');
t('the typed name is stored', M.expenses[0].category==='Telecommunications', M.expenses[0].category, 'Telecommunications');
PROMPT_REPLY = '';
chooseCategory('expenses','x','__new');
t('cancelling leaves it alone', M.expenses[0].category==='Telecommunications', M.expenses[0].category, 'Telecommunications');
chooseCategory('expenses','x','Information services');
t('an ordinary choice still sets it', M.expenses[0].category==='Information services',
  M.expenses[0].category, 'Information services');

console.log('\\n— an asset carries a category on its own row');
setModel({years:[{year:'2025-26'}], assets:[{asset_id:'A-1',description:'dock',supplier:'Dell',
  purchase_date:'2025-11-24',cost:310.32,treatment:'pool',work_pct:{'2025-26':100}}]});
activeYear='2025-26'; derive();
chooseCategory('assets','A-1','Peripherals');
t('set on the asset itself', M.assets[0].category==='Peripherals', M.assets[0].category, 'Peripherals');
t('and it reaches the return', categoryOf(M.assets[0])==='Peripherals', categoryOf(M.assets[0]), 'Peripherals');

console.log('\\n— lodgment folds: category totals out front, suppliers behind them');
setModel({years:[{year:'2025-26',marginal:0.32}], expenses:[
  {id:'a',date:'2026-06-01',supplier:'Optus',description:'mobile',amount:300,work_pct:100,label:'D5',category:'Information services'},
  {id:'b',date:'2026-06-02',supplier:'Telstra',description:'internet',amount:200,work_pct:100,label:'D5',category:'Information services'},
  {id:'c',date:'2026-06-03',supplier:'Union',description:'fees',amount:600,work_pct:100,label:'D5',category:'Professional memberships'}]});
activeYear='2025-26';
const LL = derive().lodgment['2025-26'].deductions.D5;
const many = LL.lines.find(l=>l.name==='Information services');
const one  = LL.lines.find(l=>l.name==='Professional memberships');

const hm = catHTML(many);
t('the category total is on the head', hm.indexOf('lodge-cat-amt">$500.00')>-1, 'shown','shown');
t('a category with several suppliers can fold', hm.indexOf('can-open')>-1, 'foldable','foldable');
t('it has a caret to say so', hm.indexOf('▸')>-1, 'caret','caret');
t('the suppliers are in the markup', hm.indexOf('Optus')>-1 && hm.indexOf('Telstra')>-1, 'both','both');
t('but inside the folded body', hm.indexOf('lodge-cat-body')>-1 &&
  hm.indexOf('lodge-cat-body') < hm.indexOf('Optus'), 'behind the fold','behind the fold');

const ho = catHTML(one);
t('a single-supplier category does not pretend to fold', ho.indexOf('can-open')===-1, 'plain','plain');
t('and carries no empty body', ho.indexOf('lodge-cat-body')===-1, 'none','none');
t('its total still shows', ho.indexOf('lodge-cat-amt">$600.00')>-1, 'shown','shown');

t('the label total is unchanged by any of this', near(LL.total,1100), LL.total.toFixed(2),'1100.00');

console.log('\\n— D6 shows categories only for the share that is actually attributable');
setModel({years:[{year:'2025-26'},{year:'2026-27'},{year:'2027-28'}], assets:[
  {asset_id:'P-1',description:'dock',supplier:'Dell',purchase_date:'2025-11-24',cost:310.32,
   treatment:'pool',work_pct:{'2025-26':100},category:'Peripherals'},
  {asset_id:'P-2',description:'monitor',supplier:'Dell',purchase_date:'2025-12-01',cost:480,
   treatment:'pool',work_pct:{'2025-26':100},category:'Peripherals'},
  {asset_id:'P-3',description:'chair',supplier:'Officeworks',purchase_date:'2026-09-01',cost:600,
   treatment:'pool',work_pct:{'2026-27':100},category:'Furniture'}]});
activeYear='2025-26'; const DP = derive();

const d6y1 = DP.lodgment['2025-26'].deductions.D6, d6p1 = DP.pool['2025-26'];
t('year one splits by category', d6y1.lines.length===1 && d6y1.lines[0].name==='Peripherals',
  d6y1.lines.map(l=>l.name).join(','), 'Peripherals');
t('each asset keeps its own share underneath', d6y1.lines[0].parts.length===2, d6y1.lines[0].parts.length, 2);
t("the dock's share is its own 18.75%", near(d6y1.lines[0].parts.find(x=>x.name.indexOf('dock')>-1).amount, 58.19),
  d6y1.lines[0].parts.find(x=>x.name.indexOf('dock')>-1).amount.toFixed(2), '58.19');
t('and the lines still sum to the pool deduction', near(d6y1.total, d6p1.deduction),
  d6y1.total.toFixed(2), d6p1.deduction.toFixed(2));
t('nothing is carried forward in year one', near(d6p1.ongoing,0), d6p1.ongoing.toFixed(2),'0.00');

const d6y2 = DP.lodgment['2026-27'].deductions.D6, d6p2 = DP.pool['2026-27'];
t('year two shows the new asset by category',
  !!d6y2.lines.find(l=>l.name==='Furniture'), d6y2.lines.map(l=>l.name).join(','), 'includes Furniture');
t('and the rest as one unattributed line',
  !!d6y2.lines.find(l=>l.name==='pool balance brought forward'), 'present','present');
t('the carried-forward line is the 37.5% charge',
  near(d6y2.lines.find(l=>l.name==='pool balance brought forward').amount, d6p2.ongoing),
  d6y2.lines.find(l=>l.name==='pool balance brought forward').amount.toFixed(2), d6p2.ongoing.toFixed(2));
t('the two halves still reconcile', near(d6y2.total, d6p2.deduction), d6y2.total.toFixed(2), d6p2.deduction.toFixed(2));
t('the asset-row values also reconcile to the pool total',
  near(M.assets.reduce((sum,a) => sum + (poolAssetClaim(a,'2026-27') || 0), 0), d6p2.deduction),
  M.assets.reduce((sum,a) => sum + (poolAssetClaim(a,'2026-27') || 0), 0).toFixed(2), d6p2.deduction.toFixed(2));
t('the old assets are NOT re-attributed in year two',
  !d6y2.lines.find(l=>l.name==='Peripherals'), 'absent','absent');

const d6y3 = DP.lodgment['2027-28'].deductions.D6;
t('a year with no additions is a single honest line',
  d6y3.lines.length===1 && d6y3.lines[0].name==='pool balance brought forward',
  d6y3.lines.map(l=>l.name).join(','), 'pool balance brought forward');

M.assets.forEach(a => a.work_pct = {'2025-26':0,'2026-27':0});
t('a 0% pool claims nothing and shows no D6 at all',
  derive().lodgment['2025-26'].deductions.D6===undefined, 'no line','no line');

console.log('\\n— part-year: bought 1 Jan, 2-year laptop');
setModel({years:[{year:'2025-26'}],assets:[{asset_id:'A-L',description:'laptop',
  purchase_date:'2026-01-01',cost:2000,treatment:'schedule',effective_life:2,method:'prime_cost',work_pct:{'2025-26':100}}]});
D=derive(); r=D.dep[0];
t('181/365 of a half-life year', near(r.decline, 2000*(181/365)*0.5, 0.5), r.decline.toFixed(2), (2000*(181/365)*0.5).toFixed(2));

console.log('\\n— depreciation starts when the asset is used, not when it is bought');
setModel({years:[{year:'2025-26'},{year:'2026-27'}],assets:[{asset_id:'A-START',description:'laptop',
  purchase_date:'2026-06-15',start_date:'2026-07-01',cost:2000,treatment:'schedule',effective_life:2,
  method:'prime_cost',work_pct:{'2026-27':100}}]});
D=derive();
t('nothing is claimed in the purchase year before first use',
  !D.dep.some(x=>x.asset_id==='A-START' && x.year==='2025-26'), 'no row', 'no row');
r=D.dep.find(x=>x.asset_id==='A-START' && x.year==='2026-27');
t('the first-use year begins the schedule', near(r.decline,1000), r.decline.toFixed(2), '1000.00');
t('old rows fall back to purchase date explicitly',
  assetStartDate({purchase_date:'2026-01-01'})==='2026-01-01',
  assetStartDate({purchase_date:'2026-01-01'}), '2026-01-01');
setModel({assets:[{asset_id:'A-DATES',purchase_date:'2026-01-01',start_date:'2026-01-01'}]});
setField('assets','A-DATES','purchase_date','2026-01-02');
t('correcting a purchase date carries a matching first-use date',
  M.assets[0].start_date==='2026-01-02', M.assets[0].start_date, '2026-01-02');
M.assets[0].start_date='2026-02-01';
setField('assets','A-DATES','purchase_date','2026-01-03');
t('a deliberately different first-use date is preserved',
  M.assets[0].start_date==='2026-02-01', M.assets[0].start_date, '2026-02-01');

console.log('\\n— low-value pool: 18.75% then 37.5%');
setModel({years:[{year:'2025-26'},{year:'2026-27'}],
  assets:[{asset_id:'A-2',description:'dock',purchase_date:'2026-06-30',cost:800,treatment:'pool',work_pct:{'2025-26':100}}]});
D=derive();
t('yr1 = 18.75%, no part-year apportionment', near(D.pool['2025-26'].deduction,150), D.pool['2025-26'].deduction.toFixed(2),'150.00');
t('yr2 = 37.5% of closing', near(D.pool['2026-27'].deduction,243.75), D.pool['2026-27'].deduction.toFixed(2),'243.75');
t('pool never negative', D.pool['2026-27'].closing>=0, D.pool['2026-27'].closing.toFixed(2),'>=0');

console.log('\\n— CGT: losses first, against undiscounted gains, discount last');
setModel({years:[{year:'2025-26'}],income:[
  {id:'1',type:'disposal',date:'2026-01-10',acquired:'2020-01-01',proceeds:10000,cost_base:4000},
  {id:'2',type:'disposal',date:'2026-01-10',acquired:'2025-11-01',proceeds:3000,cost_base:1000},
  {id:'3',type:'disposal',date:'2026-02-10',acquired:'2020-01-01',proceeds:1000,cost_base:3000}]});
D=derive(); let c=D.cgt['2025-26'];
t('classifies by 12-month test', near(c.discountable,6000)&&near(c.other,2000),
  'disc '+c.discountable+' other '+c.other,'6000/2000');
t('loss applied to short-held gain first', near(c.netGain,3000), c.netGain.toFixed(2),'3000.00');
setModel({years:[{year:'2025-26',cf_capital_loss:1000}],income:[
  {id:'1',type:'disposal',date:'2026-01-10',acquired:'2020-01-01',proceeds:10000,cost_base:4000}]});
D=derive(); c=D.cgt['2025-26'];
t('carried-forward loss applied before discount', near(c.netGain,2500), c.netGain.toFixed(2),'2500.00');

/* ---- a trust distribution is one payment made of parts ---- */
// An ETF pays cash once and reports it on an AMMA statement as five different things. Entered
// as a single figure it still lodges, which is why getting this wrong is quiet: the return is
// accepted and the credits inside it are simply never claimed.
console.log('\\n— an ETF distribution, broken out');
setModel({years:[{year:'2025-26'}],income:[
  {id:'d1',type:'distribution',date:'2026-06-30',holding:'FUNDA',
   franked:100,unfranked:50,credit:42.86,foreign_aud:200,tax_withheld_aud:30,
   cg_discount:400,cg_other:100}]});
D=derive();
let LG = D.lodgment['2025-26'], LI = LG.income, OFF = LG.offsets;
// myTax takes a distribution fund by fund and derives the labels itself, so a broken-out row
// must NOT also appear as a label total — that is the same money twice, in a shape nobody can
// type, next to a box that invites typing it.
t('a broken-out distribution leaves through the fund block', LG.funds.length===1,
  LG.funds.length, 1);
t('and not through the income labels', LI.I13===undefined && LI.I20===undefined,
  JSON.stringify(Object.keys(LI)), 'no I13 or I20');
const F = LG.funds[0], fld = l => (F.fields.find(x=>x[0]===l)||[])[2];
t('13U carries the unfranked amount', near(fld('13U'),50), fld('13U'),50);
t('13C carries the franked amount', near(fld('13C'),100), fld('13C'),100);
t('13Q carries the franking credit', near(fld('13Q'),42.86), fld('13Q'),42.86);
// 400 grossed up + 100 other = 500 total; net is 400/2 + 100.
t('18H is the grossed-up total', near(fld('18H'),500), fld('18H'),500);
t('18A is that total after the discount', near(fld('18A'),300), fld('18A'),300);
t('20E carries the foreign income', near(fld('20E'),200), fld('20E'),200);
t('20M repeats it rather than adding to it', near(fld('20M'),200), fld('20M'),200);
t('20O carries the foreign tax offset', near(fld('20O'),30), fld('20O'),30);
t('the block totals what myTax will show for the fund', near(F.shareOfIncome,650),
  F.shareOfIncome, 650);
// Offsets still reach the return, because they are claimed once whatever route the income took.
t('the franking credit is still a refundable offset',
  near((OFF.find(o=>/Franking/.test(o.name))||{}).amount, 42.86),
  JSON.stringify(OFF.map(o=>o.name)), 'Franking credits');
t('the foreign tax is still a non-refundable offset',
  near((OFF.find(o=>/Foreign/.test(o.name))||{}).amount, 30),
  JSON.stringify(OFF.map(o=>o.name)), 'Foreign income tax offset');

// Thirteen labels, and a typical distribution leaves most at nil — so the figures actually being
// typed were outnumbered two to one by rows reading $0.00. Folded, not dropped: which labels came
// out nil is the difference between a component considered and one never transcribed, and myTax
// marks the occasional field required, where a zero has to be typed rather than left blank.
console.log('\\n— a fund block shows the figures being typed, not a column of zeros');
const FF = fundFieldsHTML([
  ['13U','Total non-primary production income',0.38],
  ['13C','Total franked distribution',0],
  ['13Q','Total franking credits',0],
  ['','Capital gains - other method',0],
  ['18A','Total net capital gain',43.56]]);
const has = (s,x) => s.indexOf(x) !== -1;
t('a figure keeps its own row and its copy button',
  has(FF,'<b>13U.</b>') && has(FF,'copyVal(0.38)') && has(FF,'copyVal(43.56)'), '', 'both rows');
t('only the figures get rows', FF.split('<li>').length-1===2, FF.split('<li>').length-1, 2);
t('a nil label gets no row of its own', !has(FF,'<b>13C.</b>'), '', 'no 13C row');
t('and nothing offers to copy a zero', !has(FF,'copyVal(0.00)'), '', 'no zero copy');
t('the nil labels are still named, on one line',
  has(FF,'13C, 13Q, Capital gains - other method — nil'), '', 'named together');
t('and it says when a zero must be typed anyway',
  has(FF,'marks the field required'), '', 'the exception');
t('a fund with no nil labels gets no nil line',
  !has(fundFieldsHTML([['13U','Total non-primary production income',12]]), 'class="nil"'),
  '', 'no line');
// The gain is real and still computed — it is just entered as the fund's 18A, not as I18.
t('the capital gain is still worked out', near(D.cgt['2025-26'].netGain,300),
  D.cgt['2025-26'].netGain.toFixed(2),'300.00');
t('but I18 is not offered when nothing was sold', LI.I18===undefined,
  JSON.stringify(Object.keys(LI)), 'no I18');

// Sell something yourself and I18 returns, because now there is a label you do type into.
setModel({years:[{year:'2025-26'}],income:[
  {id:'d1b',type:'distribution',date:'2026-06-30',holding:'FUNDA',cg_discount:400},
  {id:'s0',type:'disposal',date:'2026-01-10',acquired:'2020-01-01',holding:'ABC',
   proceeds:1000,cost_base:600}]});
D=derive();
t('a disposal of your own brings I18 back', D.lodgment['2025-26'].income.I18!==undefined,
  JSON.stringify(Object.keys(D.lodgment['2025-26'].income)), 'has I18');

// The ordering is the whole point. Discount first would give 1000/2 - 400 = 100.
setModel({years:[{year:'2025-26'}],income:[
  {id:'d2',type:'distribution',date:'2026-06-30',holding:'FUNDA',cg_discount:1000},
  {id:'s1',type:'disposal',date:'2026-01-10',acquired:'2025-08-01',proceeds:600,cost_base:1000}]});
D=derive(); c=D.cgt['2025-26'];
t('a trust capital gain meets your losses before the discount, not after',
  near(c.netGain,300), c.netGain.toFixed(2),'300.00');

// Files written before any of this existed still have to lodge the same numbers.
setModel({years:[{year:'2025-26'}],income:[
  {id:'d3',type:'distribution',date:'2026-06-30',holding:'FUNDB',gross_aud:500}]});
D=derive();
t('a distribution with no breakdown still posts its whole value to I13',
  near(D.lodgment['2025-26'].income.I13.total,500),
  D.lodgment['2025-26'].income.I13.total.toFixed(2),'500.00');
t('and says so, because the credits inside it are going unclaimed',
  /single figure with no AMMA breakdown/.test(D.warnings.map(x=>x.title).join('|')),
  D.warnings.map(x=>x.title).join('|')||'none','flag');

/* ---- AMIT cost base: recorded now, felt years later ---- */
const AMIT = net => ({years:[{year:'2025-26'}],income:[
  {id:'d4',type:'distribution',date:'2025-08-01',holding:'FUNDA',amit_cost_base_net:net},
  {id:'s2',type:'disposal',date:'2026-01-10',acquired:'2020-01-01',holding:'FUNDA',
   proceeds:10000,cost_base:4000}]});
setModel(AMIT(0)); D=derive();
t('with no adjustment the gain is the plain one', near(D.cgt['2025-26'].netGain,3000),
  D.cgt['2025-26'].netGain.toFixed(2),'3000.00');
setModel(AMIT(-25)); D=derive();
t('an excess lowers the cost base, so the gain rises', near(D.cgt['2025-26'].netGain,3012.50),
  D.cgt['2025-26'].netGain.toFixed(2),'3012.50');
setModel(AMIT(25)); D=derive();
t('a shortfall raises it, so the gain falls', near(D.cgt['2025-26'].netGain,2987.50),
  D.cgt['2025-26'].netGain.toFixed(2),'2987.50');
t('an AMIT-only row is not income', D.lodgment['2025-26'].income.I13===undefined,
  JSON.stringify(Object.keys(D.lodgment['2025-26'].income)),'no I13');

// A distribution declared after the sale cannot have adjusted what was already sold.
setModel({years:[{year:'2025-26'}],income:[
  {id:'d5',type:'distribution',date:'2026-06-30',holding:'FUNDA',amit_cost_base_net:-25},
  {id:'s3',type:'disposal',date:'2026-01-10',acquired:'2020-01-01',holding:'FUNDA',
   proceeds:10000,cost_base:4000}]});
D=derive();
t('an adjustment dated after the disposal does not reach back', near(D.cgt['2025-26'].netGain,3000),
  D.cgt['2025-26'].netGain.toFixed(2),'3000.00');

// The ledger counts holdings, not units, so it cannot split an adjustment between two sales.
setModel({years:[{year:'2025-26'}],income:[
  {id:'d6',type:'distribution',date:'2025-08-01',holding:'FUNDA',amit_cost_base_net:-25},
  {id:'s4',type:'disposal',date:'2026-01-10',acquired:'2020-01-01',holding:'FUNDA',proceeds:5000,cost_base:2000},
  {id:'s5',type:'disposal',date:'2026-03-10',acquired:'2020-01-01',holding:'FUNDA',proceeds:5000,cost_base:2000}]});
D=derive();
t('two sales of an adjusted holding are flagged rather than guessed at',
  /AMIT cost base adjustments and 2 disposals/.test(D.warnings.map(x=>x.title).join('|')),
  D.warnings.map(x=>x.title).join('|')||'none','flag');

console.log('\\n— lodgment totals');
setModel({years:[{year:'2025-26',wfh_method:'fixed',wfh_hours:1000,marginal:0.32}],
  assets:[{asset_id:'A-3',description:'cable',purchase_date:'2025-08-01',cost:200,treatment:'immediate',work_pct:{'2025-26':100}}],
  expenses:[{id:'e1',date:'2025-09-01',description:'union fees',amount:600,work_pct:100,label:'D5'},
            {id:'e2',date:'2025-09-02',description:'donation',amount:100,work_pct:100,label:'D9'}]});
activeYear='2025-26'; D=derive(); const L=D.lodgment['2025-26'];
t('D5 = 700 wfh + 600 union + 200 immediate', near(L.deductions.D5.total,1500), L.deductions.D5.total.toFixed(2),'1500.00');
t('D9 kept separate', near(L.deductions.D9.total,100), L.deductions.D9.total.toFixed(2),'100.00');
t('every label total = sum of its lines',
  Object.values(L.deductions).every(b=>near(b.total,b.lines.reduce((s,l)=>s+l.amount,0))),'','equal');

console.log('\\n— fixed rate replaces percentages');
setModel({years:[{year:'2025-26',wfh_method:'actual',wfh_hours:1000}]});
D=derive();
t('actual cost claims no hourly amount', !(D.lodgment['2025-26'].deductions.D5),'','absent');

console.log('\\n— integrity checks');
setModel({years:[{year:'2025-26',wfh_method:'fixed',wfh_hours:100,marginal:0.37}],
  assets:[{asset_id:'A-4',description:'laptop',purchase_date:'2025-08-01',cost:1890,treatment:'immediate',work_pct:{'2025-26':70}}],
  expenses:[{id:'e3',date:'2025-09-01',supplier:'Sydney Water',category:'Water and council rates',amount:200,work_pct:20,label:'D5'},
            {id:'e4',date:'2025-09-01',supplier:'telco',category:'Information services',amount:900,work_pct:70,label:'D5'}],
  income:[{id:'i1',type:'foreign',date:'2025-09-01',holding:'X',gross_foreign:100,fx_rate:1.47},
          {id:'i2',type:'foreign',date:'2025-10-01',holding:'Y',gross_foreign:100,fx_rate:0.68}]});
D=derive(); const w=D.warnings.map(x=>x.title).join(' | ');
[[/expensed immediately/,'over-$300 expensed immediately'],
 [/outside the permitted/,'water flagged as non-qualifying'],
 [/covered by the 70c/,'fixed-rate double-dip flagged'],
 [/both sides of 1\\.0/,'mixed FX conventions flagged'],
 [/omits the Medicare levy/,'bare marginal rate flagged']]
 .forEach(([re,name])=>t(name, re.test(w), '', 'flag'));

// A check that says "A-2027-001 is not used mainly to produce assessable income" names a record
// number nobody recognises. The register leads with the identity you typed, so a check has to
// name the asset the same way round and keep the ID only as the locator for finding the row.
// Zero hours claims nothing under the rate, so no running cost can be sitting "on top of" it.
// The check used to read only wfh_method, which every year defaults to "fixed" — so setting the
// hours to 0 to opt out left the warning firing against a rate the return never used.
console.log('\\n— the 70c check follows the deduction, not just the method');
const wfhRows = {years:[{year:'2025-26',wfh_method:'fixed',wfh_hours:0,marginal:0.37}],
  expenses:[{id:'x1',date:'2025-09-01',supplier:'Telstra',category:'Information services',amount:900,work_pct:70,label:'D5'},
            {id:'x2',date:'2025-10-01',supplier:'AGL',category:'Energy',amount:400,work_pct:70,label:'D5'}]};
const d5lines = () => (D.lodgment['2025-26'].deductions.D5?.lines||[]).map(l=>l.name).join('|');
const titles  = () => D.warnings.map(x=>x.title).join('|');
setModel(wfhRows); D=derive();
t('zero hours claims no fixed-rate deduction', !/fixed rate/.test(d5lines()), d5lines()||'none', 'no fixed-rate line');
t('so the double-dip check stays quiet', !/covered by the 70c/.test(titles()), titles()||'none', 'no 70c warning');

setModel(JSON.parse(JSON.stringify(wfhRows))); M.years[0].wfh_hours = 100; D=derive();
t('hours put the fixed-rate line back in D5', /fixed rate, 100 hrs/.test(d5lines()), d5lines(), 'a fixed-rate line');
t('and the warning returns with it', /covered by the 70c/.test(titles()), titles(), 'the 70c warning');
t('and it counts both covered rows', /2 expenses already covered/.test(titles()), titles(), '2 expenses');

setModel(JSON.parse(JSON.stringify(wfhRows))); M.years[0].wfh_method='actual'; M.years[0].wfh_hours=100; D=derive();
t('actual cost never raises the fixed-rate warning', !/covered by the 70c/.test(titles()), titles()||'none', 'no 70c warning');

console.log('\\n— a check names the asset, not just its record ID');
setModel({years:[{year:'2026-27'}],assets:[
  {asset_id:'A-2027-001',item_supplier:'Dell UltraSharp U2723QE — Officeworks',
   purchase_date:'2026-08-01',cost:280,treatment:'immediate',work_pct:{'2026-27':40}},
  {asset_id:'A-2027-004',purchase_date:'2026-09-06',cost:640,treatment:'schedule',
   effective_life:5,method:'prime_cost',work_pct:{'2026-27':90}}]});
D=derive(); const named=D.warnings.map(x=>x.title).join(' | ');
t('the check leads with the item you typed', /Dell UltraSharp U2723QE/.test(named), named, 'the item name');
t('and the supplier it came from', /Officeworks/.test(named), named, 'Officeworks');
t('the record ID is kept as the locator', /\\(A-2027-001\\)/.test(named), named, '(A-2027-001)');
t('the ID never stands on its own',
  !/(^|[|] )A-2027-001 /.test(named), named, 'never a bare leading ID');
t('an unnamed asset still says which row to open',
  assetLabel(M.assets[1])==='Review item (A-2027-004)', assetLabel(M.assets[1]), 'Review item (A-2027-004)');

console.log('\\n— asset treatment is an editable suggestion');
setModel({years:[{year:'2025-26'}],assets:[
  {asset_id:'A-I',description:'keyboard',purchase_date:'2025-08-01',cost:200,treatment:'immediate',work_pct:{'2025-26':100}},
  {asset_id:'A-P',description:'dock',purchase_date:'2025-08-01',cost:500,treatment:'pool',work_pct:{'2025-26':100}}]});
D=derive(); let choiceWarnings=D.warnings.map(x=>x.title).join('|');
t('a suggestion does not manufacture an unconfirmed-choice warning',
  !/immediate-deduction conditions|low-value-pool choice/.test(choiceWarnings), choiceWarnings||'none', 'none');
t('the suggestion explains that the conditions still need review',
  assetDetail(M.assets[0]).includes('Review the immediate-deduction conditions'),
  assetDetail(M.assets[0]), 'review guidance');

// Both work-from-home checks used to read a typed description. They now read the category
// and the supplier, so they fire on what a row IS rather than on whether you happened to
// type the giveaway word.
console.log('\\n— the WFH checks read the category, not free text');
setModel({years:[{year:'2025-26',wfh_method:'fixed',wfh_hours:100}],
  expenses:[{id:'p1',date:'2025-09-01',supplier:'Acme Utilities',category:'Energy',amount:400,work_pct:50,label:'D5'}]});
t('an energy row is caught by its category alone',
  /covered by the 70c/.test(derive().warnings.map(x=>x.title).join('|')), '', 'flag');
setModel({years:[{year:'2025-26',wfh_method:'fixed',wfh_hours:100}],
  expenses:[{id:'p2',date:'2025-09-01',supplier:'SW Corp',category:'Water and council rates',amount:200,work_pct:50,label:'D5'}]});
t('so is a water row under a merchant name that hides it',
  /outside the permitted/.test(derive().warnings.map(x=>x.title).join('|')), '', 'flag');
setModel({years:[{year:'2025-26',wfh_method:'fixed',wfh_hours:100}],
  expenses:[{id:'p3',date:'2025-09-01',supplier:'Union',category:'Professional memberships',amount:600,work_pct:100,label:'D5'}]});
t('and an unrelated row is left alone',
  !/covered by the 70c|outside the permitted/.test(derive().warnings.map(x=>x.title).join('|')), '', 'silent');

// The Basis column is gone, so the converter's review note has to reach you some other
// way. A count alone would not: "needs a rate" and "receipt not itemised" want different
// fixes, so the reason is carried into the warning.
console.log('\\n— imported rows that still need a human');
setModel({years:[{year:'2025-26'}], expenses:[
  {id:'r1',date:'2025-09-01',supplier:'Optus',amount:300,work_pct:0,label:'D5',
   basis:'review — prices in a currency other than AUD; needs a rate'},
  {id:'r2',date:'2025-09-02',supplier:'Coles',amount:88.2,work_pct:0,label:'D5',
   basis:'review — receipt not itemised'},
  {id:'r3',date:'2025-09-03',supplier:'Union',amount:600,work_pct:100,label:'D5',
   basis:'deductible in full, checked 9 Aug'}]});
const rv = derive().warnings.find(x => /still needs? review/.test(x.title));
t('the unreviewed rows are counted', /2 imported expenses still need review/.test(rv ? rv.title : ''),
  rv ? rv.title : 'no warning', '2 imported expenses');
t('each reason survives', /needs a rate/.test(rv.detail) && /receipt not itemised/.test(rv.detail),
  rv.detail, 'both reasons');
t('and the rows are named', /Optus \\$300\\.00/.test(rv.detail) && /Coles \\$88\\.20/.test(rv.detail),
  rv.detail, 'supplier and amount');
t('a basis you wrote yourself is not a review note', !/checked 9 Aug/.test(rv.detail),
  rv.detail, 'Union excluded');

// description used to be the second half of the expense dedupe key. Without it, two
// same-day same-amount charges are told apart by supplier alone — so supplier has to be
// enough, and it is.
console.log('\\n— two charges on one day are still two charges');
setModel({years:[{year:'2025-26'}], expenses:[]});
activeYear='2025-26';
applyImport(planImport({schema:4, expenses:[
  {id:'x1',date:'2025-09-01',supplier:'Optus',amount:25,work_pct:0,label:'D5'},
  {id:'x2',date:'2025-09-01',supplier:'Cloudflare',amount:25,work_pct:0,label:'D5'}]}));
t('different suppliers, same day and amount, both land', M.expenses.length===2,
  M.expenses.length, 2);
applyImport(planImport({schema:4, expenses:[
  {id:'x3',date:'2025-09-01',supplier:'Optus',amount:25,work_pct:0,label:'D5'}]}));
t('and the same supplier again is still a duplicate', M.expenses.length===2,
  M.expenses.length, 2);

console.log('\\n— duplicated income across years');
setModel({years:[{year:'2025-26'},{year:'2026-27'}],income:[
  {id:'a',type:'disposal',date:'2026-01-10',holding:'ABC',proceeds:890.02,cost_base:100},
  {id:'b',type:'disposal',date:'2027-01-10',holding:'ABC',proceeds:890.02,cost_base:100}]});
D=derive();
t('same disposal in two years flagged', /repeated across income years/.test(D.warnings.map(x=>x.title).join('|')),'','flag');

console.log('\\n— clean model raises nothing');
setModel({years:[{year:'2025-26',wfh_method:'fixed',wfh_hours:1000,marginal:0.32}],
  assets:[{asset_id:'A-9',description:'laptop',purchase_date:'2025-08-01',cost:1890,treatment:'schedule',effective_life:2,method:'prime_cost',work_pct:{'2025-26':70}}],
  expenses:[{id:'e9',date:'2025-09-01',description:'union fees',amount:600,work_pct:100,label:'D5'}]});
D=derive();
t('no false positives', D.warnings.length===0, D.warnings.map(x=>x.title).join('|')||'none','none');

console.log('\\n— round trip: export → import → export');
const snap=JSON.stringify(M,null,2);
M=Object.assign(emptyModel(),JSON.parse(snap)); derive();
t('re-serialises identically', JSON.stringify(M,null,2)===snap,'','identical');

console.log('\\n— derived data is never persisted');
t('no depreciation array in the file', !('depreciation' in M),'','absent');
t('no pool balances in the file', !('pool' in M),'','absent');
t('no keep_until in the file', !M.assets.some(a=>'keep_until' in a),'','absent');


console.log('\\n— disposal and balancing adjustment');
setModel({years:[{year:'2025-26'},{year:'2026-27'}],assets:[{asset_id:'A-D',description:'laptop',
  purchase_date:'2025-07-01',cost:2000,treatment:'schedule',effective_life:2,method:'prime_cost',
  work_pct:{'2025-26':100},disposal_date:'2026-12-31',disposal_proceeds:1200,status:'disposed'}]});
activeYear='2026-27'; D=derive();
let y1=D.dep.find(r=>r.year==='2025-26'), y2=D.dep.find(r=>r.year==='2026-27');
t('full first year', near(y1.decline,1000), y1.decline.toFixed(2),'1000.00');
t('disposal year apportioned to 184 days', y2.days_held===184, y2.days_held,184);
t('sold above written-down value → assessable',
  y2.balancing>0 && near(y2.balancing, 1200-y2.closing), y2.balancing.toFixed(2), (1200-y2.closing).toFixed(2));
t('assessable balancing lands at item 24',
  near(D.lodgment['2026-27'].income.I24.total, y2.balancing),
  D.lodgment['2026-27'].income.I24?.total?.toFixed(2),'matches');
setModel({years:[{year:'2025-26'}],assets:[{asset_id:'A-E',description:'laptop',
  purchase_date:'2025-07-01',cost:2000,treatment:'schedule',effective_life:2,method:'prime_cost',
  work_pct:{'2025-26':100},disposal_date:'2026-06-30',disposal_proceeds:100}]});
activeYear='2025-26'; D=derive();
t('sold below written-down value → deductible at D5',
  D.lodgment['2025-26'].deductions.D5.lines.some(l=>/balancing/.test(l.name)),'','present');
t('stops depreciating after disposal',
  D.dep.filter(r=>r.year==='2026-27').length===0, D.dep.filter(r=>r.year==='2026-27').length,0);

console.log('\\n— offsets are surfaced, and distinguished');
setModel({years:[{year:'2025-26'}],income:[
  {id:'d1',type:'dividend',date:'2025-09-01',holding:'ABC',franked:700,credit:300},
  {id:'f1',type:'foreign',date:'2025-10-01',holding:'XYZ',gross_foreign:1000,fx_rate:1.5,tax_withheld_aud:225}]});
activeYear='2025-26'; D=derive(); const O=D.lodgment['2025-26'].offsets;
t('franking credits totalled', near(O.find(o=>/Franking/.test(o.name)).amount,300),
  O.find(o=>/Franking/.test(o.name))?.amount,'300');
t('franking credits marked refundable', O.find(o=>/Franking/.test(o.name)).refundable===true,'','true');
t('foreign withholding becomes a FITO', near(O.find(o=>/Foreign/.test(o.name)).amount,225),
  O.find(o=>/Foreign/.test(o.name))?.amount,'225');
t('FITO marked non-refundable', O.find(o=>/Foreign/.test(o.name)).refundable===false,'','false');
t('foreign income declared gross, not net',
  near(D.lodgment['2025-26'].income.I20.total,1500), D.lodgment['2025-26'].income.I20.total.toFixed(2),'1500.00');

console.log('\\n— low-value pool is a one-way door');
setModel({years:[{year:'2025-26'}],assets:[
  {asset_id:'A-P',description:'dock',purchase_date:'2025-08-01',cost:500,treatment:'pool',work_pct:{'2025-26':100}},
  {asset_id:'A-Q',description:'hub',purchase_date:'2026-02-01',cost:600,treatment:'schedule',effective_life:3,work_pct:{'2025-26':100}}]});
D=derive();
t('escaping the pool after opening one is flagged',
  /must be pooled too/.test(D.warnings.map(x=>x.detail).join('|')),'','flag');
setModel({years:[{year:'2025-26'}],assets:[
  {asset_id:'A-R',description:'laptop',purchase_date:'2025-08-01',cost:1500,treatment:'schedule',effective_life:2,work_pct:{'2025-26':100}}]});
D=derive();
t('no pool, no complaint', !/must be pooled too/.test(D.warnings.map(x=>x.detail).join('|')),'','silent');

// Leaving the pool was the quietest irreversible edit in the ledger: allocating a low-cost
// asset cannot be revoked, and setTreatment() asked nothing at all. Filing and assessment are
// weeks apart, so the year record has to be able to say "lodged" before it can say "assessed" —
// the gap between the two is exactly when a fresh return is most likely to be edited.
console.log('\\n— an asset cannot quietly leave a pool it was filed in');
const POOLED_FILED = (yr={}) => ({years:[Object.assign({year:'2025-26'},yr)],assets:[
  {asset_id:'A-LP',item_supplier:'Dock — Officeworks',purchase_date:'2025-08-01',start_date:'2025-08-01',
   cost:600,treatment:'pool',category:'Computers',work_pct:{'2025-26':100}}]});

setModel(POOLED_FILED()); activeYear='2025-26'; derive(); CONFIRMED.length=0;
setTreatment('A-LP','schedule');
t('leaving a pool always asks', /out of the low-value pool/.test(CONFIRMED.join(' ')),
  CONFIRMED.join(' ').slice(0,50), 'asks');
t('and says the allocation cannot be reversed', /cannot be reversed/.test(CONFIRMED.join(' ')),
  'said', 'said');
t('an unfiled year is not accused of contradicting a return',
  !/already been claimed/.test(CONFIRMED.join(' ')), 'silent', 'silent');
t('and nothing is recorded against the asset', M.assets[0].pool_allocated_fy===undefined,
  String(M.assets[0].pool_allocated_fy), 'undefined');
t('no finding, because the choice was still free',
  runChecks().filter(x=>/allocated to/.test(x.title)).length===0, 'none', 'none');

// Lodged but not yet assessed — the window the ledger could not previously represent at all.
setModel(POOLED_FILED({lodged_date:'2026-08-09'})); activeYear='2025-26'; derive(); CONFIRMED.length=0;
CONFIRM_REPLY=false;
setTreatment('A-LP','schedule');
t('declining leaves the asset in the pool', M.assets[0].treatment==='pool', M.assets[0].treatment, 'pool');
t('and records nothing', M.assets[0].pool_allocated_fy===undefined, String(M.assets[0].pool_allocated_fy), 'undefined');
CONFIRM_REPLY=true; CONFIRMED.length=0;
setTreatment('A-LP','schedule');
t('a lodged year says the allocation is already claimed',
  /was lodged on 2026-08-09/.test(CONFIRMED.join(' ')) && /already been claimed at D6/.test(CONFIRMED.join(' ')),
  CONFIRMED.join(' ').slice(-140), 'names the filing');
t('and the allocation year is recorded on the asset', M.assets[0].pool_allocated_fy==='2025-26',
  String(M.assets[0].pool_allocated_fy), '2025-26');
let LEFT = runChecks().filter(x=>/allocated to/.test(x.title));
t('which raises a high finding naming the asset', LEFT.length===1 && LEFT[0].sev==='high' && /Dock/.test(LEFT[0].title),
  LEFT.length+'/'+(LEFT[0]||{}).sev, '1/high');
t('putting it back clears the finding',
  (setTreatment('A-LP','pool'), runChecks().filter(x=>/allocated to/.test(x.title)).length===0), 'clear', 'clear');

// A move between collections was already warned about on an ASSESSED year. Lodged has to count
// too, or the warning is absent for the several weeks that matter most.
t('a move warns on a year that is lodged but not yet assessed',
  /was lodged on 2026-08-09/.test(moveWarnings('2025-26').join(' ')),
  moveWarnings('2025-26').join(' ').slice(0,60), 'warns');
t('and prefers the NOA once it arrives',
  (M.years[0].noa_date='2026-09-01', /was assessed on 2026-09-01/.test(moveWarnings('2025-26').join(' '))),
  moveWarnings('2025-26').join(' ').slice(0,60), 'assessed');

// Four of the five kinds of D5 claim file by what the thing IS. Depreciation used to file by
// how it is CLAIMED — one lump row, no breakdown — so the same asset landed under Computers
// when written off or pooled and vanished when scheduled.
console.log('\\n— decline in value files under its category, like every other D5 claim');
setModel({years:[{year:'2025-26'}],assets:[
  {asset_id:'A-SSD',item_supplier:'SSD — Umart',purchase_date:'2025-07-01',start_date:'2025-07-01',
   cost:280,treatment:'immediate',category:'Computers',work_pct:{'2025-26':100}},
  {asset_id:'A-GPU',item_supplier:'RX9060 — Umart',purchase_date:'2025-07-01',start_date:'2025-07-01',
   cost:1200,treatment:'schedule',effective_life:4,method:'prime_cost',category:'Computers',work_pct:{'2025-26':100}},
  {asset_id:'A-CHR',item_supplier:'Chair — Officeworks',purchase_date:'2025-07-01',start_date:'2025-07-01',
   cost:900,treatment:'schedule',effective_life:10,method:'prime_cost',category:'Furniture',work_pct:{'2025-26':100}}]});
activeYear='2025-26'; derive();
const D5L = buildLodgment('2025-26').deductions.D5;
const row = n => D5L.lines.find(l => l.name===n);
t('no lump depreciation row survives', !D5L.lines.some(l=>/^depreciation/.test(l.name)),
  D5L.lines.map(l=>l.name).join(','), 'categories only');
t('the write-off and the decline share one Computers row', near(row('Computers').amount, 280+300),
  row('Computers').amount.toFixed(2), '580.00');
t('and Furniture carries its own decline', near(row('Furniture').amount, 90),
  row('Furniture').amount.toFixed(2), '90.00');
t('every category total decomposes to named assets',
  row('Computers').parts.length===2 && /decline in value/.test(row('Computers').parts.map(p=>p.name).join('|')),
  row('Computers').parts.map(p=>p.name).join(' | '), 'two parts, one a decline');
t('and the D5 total is unchanged by where it is filed', near(D5L.total, 280+300+90),
  D5L.total.toFixed(2), '670.00');

console.log('\\n— CSV exports one file per call');
setModel({years:[{year:'2025-26'}],assets:[{asset_id:'A-C',description:'x',purchase_date:'2025-08-01',cost:400,treatment:'pool',work_pct:{'2025-26':100}}]});
activeYear='2025-26'; derive();
let dl=0; const realDownload=download; download=()=>{dl++;};
exportCSV('assets'); t('one sheet → one download', dl===1, dl, 1);
dl=0; exportCSV(); t('no argument → full set', dl===5, dl, 5);
download=realDownload;


console.log('\\n— dates are calendar dates, not UTC instants');
t('addYears does not drift', addYears('2030-06-30',5)==='2035-06-30', addYears('2030-06-30',5),'2035-06-30');
t('todayISO matches local date', todayISO()===iso(new Date()), todayISO(), iso(new Date()));
t('30 June survives a round trip', iso(fyEnd('2025-26'))==='2026-06-30', iso(fyEnd('2025-26')),'2026-06-30');
t('a monthly repeat clips 31 January to February month-end',
  addMonths('2026-01-31',1)==='2026-02-28', addMonths('2026-01-31',1), '2026-02-28');
t('and returns to the original day in March',
  addMonths('2026-01-31',2)==='2026-03-31', addMonths('2026-01-31',2), '2026-03-31');

console.log('\\n— an asset fully written off stops generating rows');
setModel({years:[{year:'2025-26'},{year:'2026-27'},{year:'2027-28'},{year:'2028-29'},{year:'2029-30'}],
  assets:[{asset_id:'A-Z',description:'iPhone',purchase_date:'2026-02-15',cost:2164,
    treatment:'schedule',effective_life:3,method:'prime_cost',work_pct:{'2025-26':70}}]});
activeYear='2025-26'; D=derive();
t('mid-year purchase spans 4 returns, not 3', D.dep.length===4, D.dep.length, 4);
t('no zero-claim row after write-off', D.dep.every(r=>r.deductible>0.005),'','all rows claim something');
t('total claimed = cost x work %',
  near(D.dep.reduce((s,r)=>s+r.deductible,0), 2164*0.7, 0.02),
  D.dep.reduce((s,r)=>s+r.deductible,0).toFixed(2), (2164*0.7).toFixed(2));
t('retention runs from the last real claim, not the last year held',
  D.keep['A-Z']==='2034-06-30', D.keep['A-Z'],'2034-06-30');

// This used to assert that a schedule produced one row per year you had created, so an asset
// bought with nothing else beside it depreciated for exactly one year and then stopped. That
// was the bug: derive() carries the adjustable value forward by walking the year list, so a
// year missing from it is never walked, the value never declines through it, and the next year
// that does exist takes a full year's decline — a deduction in a year already written off. A
// schedule now creates its own years, exactly as a pool already did.
console.log('\\n— a schedule creates the years its own effective life needs');
setModel({years:[{year:'2025-26'}],assets:[{asset_id:'A-Y',description:'iPhone',
  purchase_date:'2026-02-15',cost:2164,treatment:'schedule',effective_life:3,
  method:'prime_cost',work_pct:{'2025-26':70,'2026-27':70,'2027-28':70,'2028-29':70}}]});
D=derive();
t('a 3-year life spans four financial years from a February purchase',
  D.dep.length===4, D.dep.length, 4);
t('and writes off the whole cost across them',
  near(D.dep.reduce((s,r)=>s+r.decline,0), 2164, 0.02),
  D.dep.reduce((s,r)=>s+r.decline,0).toFixed(2), '2164.00');
t('the first year is apportioned by days held, not given a full year',
  D.dep[0].decline < 2164/3, D.dep[0].decline.toFixed(2), 'less than a full year');
t('nothing is claimed after the asset is written off',
  !D.dep.some(r => r.year > '2028-29'), D.dep.map(r=>r.year).join(','), 'stops at 2028-29');


`;
vm.runInContext(code + "\n;\n" + ENGINE_TESTS, boot());
const t = assert;  // the browser-session assertions below run at module scope

/* ============================================================
   Generated artifact — editable source and standalone page cannot drift.
   ============================================================ */
console.log('\n— generated standalone artifact');
t('the standalone page embeds ledger.js exactly',
  extractGeneratedSource(html) === normaliseSource(code),
  'embedded source', 'normalised ledger.js');
t('regenerating the page is a no-op',
  renderLedgerHtml(html, code) === normaliseNewlines(html),
  'rendered page', 'current page');
t('the standalone page does not load an external script',
  !/<script\s+[^>]*\bsrc=/i.test(html),
  'inline script', 'no external script');
let unsafeSourceError = '';
try { validateSource('console.log("unsafe");\n</script>'); } catch (error) { unsafeSourceError = error.message; }
t('the builder rejects source that can close the inline script',
  /cannot be safely inlined/.test(unsafeSourceError), unsafeSourceError, 'unsafe source error');
let missingMarkerError = '';
try { renderLedgerHtml('<script></script>', code); } catch (error) { missingMarkerError = error.message; }
t('the builder rejects a missing generated marker pair',
  /exactly one generated marker pair/.test(missingMarkerError), missingMarkerError, 'missing marker error');
let duplicateMarkerError = '';
try {
  renderLedgerHtml(`${START_MARKER}\n${START_MARKER}\n${END_MARKER}`, code);
} catch (error) { duplicateMarkerError = error.message; }
t('the builder rejects duplicate generated markers',
  /found 2 start, 1 end/.test(duplicateMarkerError), duplicateMarkerError, 'duplicate marker error');

/* ============================================================
   First-use acknowledgement — versioned, local and fail-open for the session.
   ============================================================ */
console.log('\n— first-use acknowledgement');
t('the gate is an accessible modal and the ledger starts inert',
  /id="ackGate" role="dialog" aria-modal="true"/.test(html) &&
    /id="ledgerApp" inert aria-hidden="true"/.test(html),
  'markup', 'modal + inert app');
t('the copy identifies advice limits and non-excludable rights',
  /not tax,\s+financial or legal advice/.test(html) &&
    /maximum extent permitted by law/.test(html) && /cannot lawfully be excluded/.test(html),
  'copy', 'advice limits + lawful carve-out');
t('the visible acknowledgement version matches the stored version',
  html.includes('Acknowledgement version ' + ACK_VERSION),
  ACK_VERSION, ACK_VERSION);
const ackStore = {};
const a1 = boot(ackStore, false, true, false);
vm.runInContext(code, a1);
t('a new browser is stopped at the acknowledgement',
  a1.DOM['#ackGate'].hidden === false && a1.DOM['#ledgerApp'].inert === true &&
    vm.runInContext('appStarted', a1) === false,
  [a1.DOM['#ackGate'].hidden,a1.DOM['#ledgerApp'].inert,vm.runInContext('appStarted',a1)].join('/'),
  'false/true/false');
t('continue is disabled until the checkbox is ticked', a1.DOM['#ackContinue'].disabled === true,
  a1.DOM['#ackContinue'].disabled, true);
a1.DOM['#ackCheck'].checked = true;
vm.runInContext('syncAcknowledgementButton()', a1);
t('ticking the checkbox enables continue', a1.DOM['#ackContinue'].disabled === false,
  a1.DOM['#ackContinue'].disabled, false);
t('acceptance starts the ledger', vm.runInContext('submitAcknowledgement(); appStarted', a1) === true,
  vm.runInContext('appStarted',a1), true);
t('acceptance is remembered as the current wording version', ackStore[ACK_STORAGE_KEY] === ACK_VERSION,
  ackStore[ACK_STORAGE_KEY], ACK_VERSION);
t('the accepted gate closes and unlocks the page',
  a1.DOM['#ackGate'].hidden === true && a1.DOM['#ledgerApp'].inert === false,
  [a1.DOM['#ackGate'].hidden,a1.DOM['#ledgerApp'].inert].join('/'), 'true/false');

const a2 = boot(ackStore, false, true, false);
vm.runInContext(code, a2);
t('the current version is not asked again',
  a2.DOM['#ackGate'].hidden === true && vm.runInContext('appStarted',a2) === true,
  [a2.DOM['#ackGate'].hidden,vm.runInContext('appStarted',a2)].join('/'), 'true/true');

const staleStore = { [ACK_STORAGE_KEY]:'older-copy' };
const a3 = boot(staleStore, false, true, false);
vm.runInContext(code, a3);
t('new wording asks a previously acknowledged user again',
  a3.DOM['#ackGate'].hidden === false && vm.runInContext('appStarted',a3) === false,
  [a3.DOM['#ackGate'].hidden,vm.runInContext('appStarted',a3)].join('/'), 'false/false');

vm.runInContext(`M.assets.push({asset_id:'kept'}); openAcknowledgement(true); submitAcknowledgement();`, a2);
t('reviewing the acknowledgement does not restart or clear the ledger',
  vm.runInContext(`appStarted && M.assets.length===1`, a2),
  vm.runInContext(`[appStarted,M.assets.length].join('/')`,a2), 'true/1');

const refusedAckStore = {};
const a4 = boot(refusedAckStore, true, true, false);
vm.runInContext(code, a4);
a4.DOM['#ackCheck'].checked = true;
t('storage refusal still allows this session',
  vm.runInContext('submitAcknowledgement(); appStarted && !acknowledgementStorageOK', a4),
  vm.runInContext(`[appStarted,acknowledgementStorageOK].join('/')`,a4), 'true/false');
t('storage refusal is disclosed in the page',
  /Acknowledgement not remembered/.test(a4.DOM['#recovery'].innerHTML),
  a4.DOM['#recovery'].innerHTML ? 'shown' : 'missing', 'shown');
const a5 = boot(refusedAckStore, false, true, false);
vm.runInContext(code, a5);
t('an unremembered acknowledgement returns next load',
  a5.DOM['#ackGate'].hidden === false && vm.runInContext('appStarted',a5) === false,
  [a5.DOM['#ackGate'].hidden,vm.runInContext('appStarted',a5)].join('/'), 'false/false');

/* ============================================================
   Crash recovery — needs a localStorage that survives reloads.
   ============================================================ */
const store = {};
const bootWith = refuse => { const c = boot(store, refuse); vm.runInContext(code, c); return c; };
console.log('\\n— session 1: enter data, then "crash" (no save)');
let s1=bootWith();
vm.runInContext(`
  M.assets.push({asset_id:'A-1',description:'laptop',purchase_date:'2025-08-01',
    cost:1890,treatment:'schedule',effective_life:2,method:'prime_cost',work_pct:{'2025-26':70}});
  touch();`, s1);
t('autosave written on every change', !!store['tax-ledger-autosave-v1'], Object.keys(store).join(),'key present');
const saved=JSON.parse(store['tax-ledger-autosave-v1']||'{}');
t('autosave carries the model', saved.model?.assets?.length===1, saved.model?.assets?.length,1);
t('autosave carries a timestamp', typeof saved.at==='number', typeof saved.at,'number');

console.log('\\n— session 2: fresh page load after the crash');
let s2=bootWith();
t('recovers the asset', vm.runInContext('M.assets.length',s2)===1, vm.runInContext('M.assets.length',s2),1);
t('recovered work marked unsaved', vm.runInContext('dirty',s2)===true, vm.runInContext('dirty',s2),true);
t('derives correctly after recovery',
  Math.abs(vm.runInContext('derive().dep[0].deductible',s2)-605.32)<0.5,
  vm.runInContext('derive().dep[0].deductible',s2).toFixed(2),'605.32 (334 days held)');

console.log('\\n— saving to file clears the autosave');
vm.runInContext('saveFile();', s2);
t('autosave cleared once the record exists', !store['tax-ledger-autosave-v1'], 'still present','cleared');
let s3=bootWith();
t('next load starts clean', vm.runInContext('M.assets.length',s3)===0, vm.runInContext('M.assets.length',s3),0);

console.log('\\n— recovery is announced, not silent');
let s4=bootWith();
vm.runInContext(`M.assets.push({asset_id:'A-2',description:'x',purchase_date:'2025-08-01',cost:500,treatment:'pool'}); touch();`,s4);
let s5=bootWith();
t('recovery is flagged, not silent', vm.runInContext('recoveredAt',s5)!==null,
  vm.runInContext('recoveredAt',s5),'a timestamp');
t('age renders in words', /ago$/.test(vm.runInContext('ageText(recoveredAt)',s5)),
  vm.runInContext('ageText(recoveredAt)',s5),'"N seconds ago"');
t('discarding clears both draft and flag',
  (vm.runInContext('discardRecovery(); [M.assets.length, recoveredAt].join(",")',s5)==='0,')
  && !store['tax-ledger-autosave-v1'],
  vm.runInContext('[M.assets.length,recoveredAt].join(",")',s5),'0,null + key gone');

// You import the wrong file, then the browser dies — or you just refresh to look again.
// An undo that only lived in memory would have been the one thing you needed.
console.log('\\n— the undo survives a reload');
const impStore = {};
const impBoot = () => { const c = boot(impStore); vm.runInContext(code, c); return c; };
let i1 = impBoot();
vm.runInContext(`M.years=[{year:'2025-26'}];
  M.expenses=[{id:'mine',date:'2025-09-01',description:'union fees',amount:600,work_pct:100,label:'D5'}];
  activeYear='2025-26';
  applyImport(planImport({schema:2, expenses:[
    {id:'bad',date:'2026-01-05',description:'someone elses phone',supplier:'Telco',
     amount:1200,work_pct:100,label:'D5'}]}), 'wrong-account.json');`, i1);
t('the import is in the autosave',
  /wrong-account\.json/.test(impStore['tax-ledger-autosave-v1']||''), 'stored','stored');

let i2 = impBoot();   // a fresh page load against the same browser
t('the undo record comes back', vm.runInContext('lastImport && lastImport.from',i2)==='wrong-account.json',
  vm.runInContext('lastImport && lastImport.from',i2), 'wrong-account.json');
t('and the rows came back with it', vm.runInContext('M.expenses.length',i2)===2,
  vm.runInContext('M.expenses.length',i2), 2);
t('undo still works after the reload', vm.runInContext('undoLastImport()',i2)===true, 'true','true');
t('leaving only what you typed',
  vm.runInContext(`M.expenses.length===1 && M.expenses[0].id==='mine'`,i2),
  vm.runInContext('M.expenses.map(e=>e.id).join(",")',i2), 'mine');

let i3 = impBoot();   // and the undo itself has to stick
t('the undone import does not come back', vm.runInContext('M.expenses.length',i3)===1,
  vm.runInContext('M.expenses.length',i3), 1);
t('and the banner does not either', vm.runInContext('lastImport',i3)===null,
  vm.runInContext('lastImport',i3), 'null');

console.log('\\n— storage unavailable (Safari private / file:// quota)');
delete store['tax-ledger-autosave-v1'];
let s6=bootWith(true); // setItem always throws
vm.runInContext(`M.assets.push({asset_id:'A-3',description:'y',purchase_date:'2025-08-01',cost:500,treatment:'pool'}); touch();`,s6);
t('storage failure is detected', vm.runInContext('autosaveOK',s6)===false,
  vm.runInContext('autosaveOK',s6),'false');
t('the app keeps working without a net',
  vm.runInContext('M.assets.length',s6)===1, vm.runInContext('M.assets.length',s6),1);


// The year picker is a write target, not just a filter: work_pct[activeYear] and every
// field on the Year tab land in whichever year is showing. The lock is what stops a
// stray click redirecting the next thing you type into a return you already lodged.
console.log('\\n— the year lock pins the write target');
// A store per scenario, except where a reload is the thing under test — the lock lives
// in localStorage, so sharing one would let each case inherit the last one's answer.
const lockBoot = (st = {}) => { const c = boot(st); vm.runInContext(code, c); return c; };

// Built off the real reporting year, so these stay true after 30 June rolls over rather
// than needing a hardcoded FY edited once a year. RY is what the lock targets; PRIOR is
// the year beside it that the lock has to refuse to drift into.
const probe = lockBoot();
const RY = vm.runInContext('reportingYear()', probe);
const PRIOR = vm.runInContext(`fyPrev(reportingYear())`, probe);
const NEXT = vm.runInContext(`fyNext(reportingYear())`, probe);
const sep = fy => fy.slice(0,4) + '-09-01';   // a date inside that FY
const TWO_YEARS = `M.years=[{year:'${PRIOR}',marginal:0.32},{year:'${RY}',marginal:0.32}];
  M.expenses=[{id:'x1',date:'${sep(PRIOR)}',description:'union fees',amount:600,work_pct:100,label:'D5'},
              {id:'x2',date:'${sep(RY)}',description:'union fees',amount:600,work_pct:100,label:'D5'}];
  M.assets=[{asset_id:'A-1',description:'phone',purchase_date:'${PRIOR.slice(0,4)}-08-01',cost:1200,
             treatment:'schedule',effective_life:3,method:'prime_cost',work_pct:{'${PRIOR}':70}}];
  activeYear='${PRIOR}'; render();`;

const reloadStore = {};
let k1 = lockBoot(reloadStore);
vm.runInContext(TWO_YEARS, k1);
t('unlocked, the year changes', vm.runInContext(`setActiveYear('${RY}')`,k1)===true &&
  vm.runInContext('activeYear',k1)===RY, vm.runInContext('activeYear',k1),RY);

// The point of the button: it does not pin what you happen to be looking at, it puts you
// on the return you are actually preparing.
vm.runInContext(`setActiveYear('${PRIOR}'); toggleYearLock();`, k1);
t('locking jumps to the reporting year', vm.runInContext('activeYear',k1)===RY,
  vm.runInContext('activeYear',k1),RY);
t('from wherever you were', PRIOR !== RY, PRIOR+' -> '+RY, 'a real move');
t('locked, the change is refused', vm.runInContext(`setActiveYear('${PRIOR}')`,k1)===false,
  vm.runInContext(`setActiveYear('${PRIOR}')`,k1),'false');
t('and the year does not move', vm.runInContext('activeYear',k1)===RY,
  vm.runInContext('activeYear',k1),RY);

// The write that the lock exists to protect.
vm.runInContext(`setField('assets','A-1','work_pct_year',40);`, k1);
t('the work-use % writes to the locked year',
  vm.runInContext(`M.assets[0].work_pct['${RY}']`,k1)===40,
  vm.runInContext(`JSON.stringify(M.assets[0].work_pct)`,k1),RY+' = 40');
t('and not to the year you nearly clicked',
  vm.runInContext(`M.assets[0].work_pct['${PRIOR}']`,k1)===70,
  vm.runInContext(`JSON.stringify(M.assets[0].work_pct)`,k1),PRIOR+' still 70');

// A lock that did not survive a reload would not be a lock.
let k2 = lockBoot(reloadStore);
vm.runInContext(TWO_YEARS.replace(`activeYear='${PRIOR}'; render();`,'render(); restoreUI();'), k2);
t('the lock survives a reload', vm.runInContext('yearLocked',k2)===true, vm.runInContext('yearLocked',k2),'true');
t('with the year it was set on', vm.runInContext('activeYear',k2)===RY,
  vm.runInContext('activeYear',k2),RY);

// Unlocking is one click, and it has to actually let go — without dragging you elsewhere.
vm.runInContext('toggleYearLock();', k2);
t('unlocking leaves you where you are', vm.runInContext('activeYear',k2)===RY,
  vm.runInContext('activeYear',k2),RY);
t('unlocking releases the year', vm.runInContext(`setActiveYear('${PRIOR}')`,k2)===true &&
  vm.runInContext('activeYear',k2)===PRIOR, vm.runInContext('activeYear',k2),PRIOR);

// Nothing recorded in the reporting year yet — there is no year to lock to, and the
// button must say so rather than silently pinning something else.
let k5 = lockBoot();
vm.runInContext(`M.years=[{year:'${PRIOR}'}];
  M.expenses=[{id:'y1',date:'${sep(PRIOR)}',amount:600,work_pct:100,label:'D5'}];
  activeYear='${PRIOR}'; render();`, k5);
t('no reporting year, no lock', vm.runInContext('toggleYearLock()',k5)===false,
  vm.runInContext('yearLocked',k5),'false');
t('and it does not move you', vm.runInContext('activeYear',k5)===PRIOR,
  vm.runInContext('activeYear',k5),PRIOR);

// Opening another file must not leave a lock pointing at a year that file may not have.
let k3 = lockBoot();
vm.runInContext(TWO_YEARS + 'toggleYearLock();', k3);
vm.runInContext(`M = emptyModel(); activeYear = null; yearLocked = false; render();`, k3);
t('opening a file drops the lock', vm.runInContext('yearLocked',k3)===false,
  vm.runInContext('yearLocked',k3),'false');

// Rolling forward names the year it creates, so it is announced, not accidental.
let k4 = lockBoot();
vm.runInContext(TWO_YEARS + `toggleYearLock(); rollForward();`, k4);
t('roll forward moves past the lock', vm.runInContext('activeYear',k4)===NEXT,
  vm.runInContext('activeYear',k4),NEXT);
t('and stays locked on the new year', vm.runInContext('yearLocked',k4)===true,
  vm.runInContext('yearLocked',k4),'true');

/* ============================================================
   The entry row belongs to the table it writes to.

   It used to be a `.formrow` flex box above the table, so the boxes you typed into
   never lined up with the columns they landed in — two independent width systems that
   could only agree by accident. Putting the row inside the <table> makes alignment
   structural. These assertions are what stops it drifting back out.
   ============================================================ */
console.log("\n— the entry row is a row of the table");

const ui = boot({}, false, true);
vm.runInContext(code, ui);

/** Columns a row occupies, counting colspan — a spanning cell still owes its width. */
function cols(rowHTML) {
  let n = 0;
  // The lookahead keeps `<thead>` from counting as a `<th>`.
  for (const cell of rowHTML.match(/<t[dh](?=[\s>])[^>]*>/g) || []) {
    const cs = /colspan="(\d+)"/i.exec(cell);
    n += cs ? Number(cs[1]) : 1;
  }
  return n;
}
const addRow = html => (/<tr class="add">[\s\S]*?<\/tr>/.exec(html) || [""])[0];
const headRow = html => (/<thead>[\s\S]*?<\/thead>/.exec(html) || [""])[0];

for (const [view, render, fields] of [
  ["#v-expenses", "renderExpenses", ["e-sup", "e-date", "e-repeat", "e-amt", "e-wp", "e-purpose"]],
  ["#v-assets",   "renderAssets",   ["a-item-supplier", "a-date", "a-cost", "a-wp", "a-cat"]],
  ["#v-income",   "renderIncome",   ["i-date", "i-type", "i-hold", "i-amt"]]
]) {
  vm.runInContext(render + "();", ui);
  const html = ui.DOM[view].innerHTML;
  const row = addRow(html), head = headRow(html);

  t(render + ": the entry row is inside the table",
    row !== "" && html.indexOf("<table") < html.indexOf(row),
    row === "" ? "no tr.add found" : "outside the table", "inside <table>");
  t(render + ": one entry cell per column", cols(row) === cols(head),
    cols(row) + " cells", cols(head) + " columns");
  t(render + ": no .formrow above the table", html.indexOf("formrow") === -1,
    html.indexOf("formrow") === -1 ? "none" : "still there", "none");
  for (const id of fields)
    t(render + ": " + id + " is in the entry row", row.indexOf('id="' + id + '"') !== -1,
      "missing", "present");
}

vm.runInContext("renderAssets();", ui);
const assetHead = headRow(ui.DOM["#v-assets"].innerHTML);
t('the asset register keeps only the everyday columns',
  ["Item / supplier","Date","Amount","Deductible %","How claimed","deduction","Actions"].every(x=>assetHead.includes(x)) &&
    !["Opening","Decline","Closing","Keep until","Category","Method"].some(x=>assetHead.includes(x)),
  assetHead.replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim(),
  'item / supplier, date, amount, deductible %, how claimed, deduction and actions');

vm.runInContext("renderExpenses();", ui);
const expenseHead = headRow(ui.DOM["#v-expenses"].innerHTML);
const sharedCols = vm.runInContext("registerColgroup()", ui);
t('assets and expenses use the same seven register slots',
  cols(assetHead) === 7 && cols(expenseHead) === 7 &&
    ui.DOM["#v-assets"].innerHTML.includes(sharedCols) &&
    ui.DOM["#v-expenses"].innerHTML.includes(sharedCols) && assetHead === expenseHead,
  cols(assetHead) + '/' + cols(expenseHead), '7/7 with identical headings and widths');

const assetAdd = addRow(ui.DOM["#v-assets"].innerHTML);
t('the asset entry exposes its own claim purpose in the shared selector style',
  assetAdd.includes('id="a-cat"') && assetAdd.includes('class="claim-purpose"') &&
    assetAdd.includes('Computers</option>'),
  assetAdd.includes('id="a-cat"') ? 'asset picker present' : 'missing', 'asset category picker');
t('asset categories are not prefixed with an instruction before cost is entered',
  !assetAdd.includes('Enter cost') && assetAdd.includes('>Computers</option>'),
  assetAdd.includes('Enter cost') ? 'instruction repeated in options' : 'plain categories', 'plain categories');
t('the asset entry never offers an expense category',
  !assetAdd.includes('>Information services</option>'),
  assetAdd.includes('>Information services</option>') ? 'expense category leaked' : 'separate', 'separate taxonomy');

console.log("\n— Assets and Expenses implementation consistency checker");
const consistentUI = boot({}, false, true);
vm.runInContext(code, consistentUI);
vm.runInContext("M = Object.assign(emptyModel(), {years:[{year:'2025-26'}],"
  + "assets:[{asset_id:'A-C',item_supplier:'dock — Dell',category:'Peripherals',"
  + "purchase_date:'2025-08-01',cost:500,treatment:'pool',work_pct:{'2025-26':100}}],"
  + "expenses:[{id:'E-C',date:'2025-08-01',supplier:'Optus',amount:50,work_pct:70,"
  + "category:'Information services',label:'D5'}]});"
  + "activeYear='2025-26'; derive(); renderAssets(); renderExpenses();", consistentUI);
const consistentAssets = consistentUI.DOM["#v-assets"].innerHTML;
const consistentExpenses = consistentUI.DOM["#v-expenses"].innerHTML;
const controlCount = source => (source.match(/data-register-control="how-claimed"/g) || []).length;
t('each tab has one shared How claimed control for entry and one recorded row',
  controlCount(consistentAssets) === 2 && controlCount(consistentExpenses) === 2,
  controlCount(consistentAssets) + '/' + controlCount(consistentExpenses), '2/2');
t('both tabs use the same claim-purpose selector contract',
  consistentAssets.includes('<select class="claim-purpose" data-register-control="how-claimed"') &&
    consistentExpenses.includes('<select class="claim-purpose" data-register-control="how-claimed"'),
  'shared selectors', 'shared selectors');
t('the Assets main register no longer stacks category and treatment displays',
  consistentAssets.includes('D6 · Peripherals — low-value pool') &&
    !consistentAssets.includes('class="pill pool"'),
  'single combined purpose', 'single combined purpose');
t('the shared display contract does not merge the two tax vocabularies',
  !consistentAssets.includes('Phone, internet and data') && !consistentExpenses.includes('D6 · Peripherals'),
  'separate vocabularies', 'separate vocabularies');
t('Assets has one identity input, matching the Expenses one-field pattern',
  consistentAssets.includes('id="a-item-supplier"') &&
    !consistentAssets.includes('id="a-desc"') && !consistentAssets.includes('id="a-sup"'),
  'one Item / supplier input', 'one identity input');
t('asset Details does not re-split the supplier into another editable field',
  !consistentAssets.includes('Supplier on receipt'),
  consistentAssets.includes('Supplier on receipt') ? 'duplicate supplier field' : 'joined only', 'joined only');
t('asset rows keep correction and delete controls directly in the table',
  consistentAssets.includes("sendToExpenses('A-C')") && consistentAssets.includes("removeRow('assets','A-C')"),
  'table controls present', 'table controls present');

// The supplier is what the whole view is built on — the group key, the lodgment
// breakdown line, half the import identity, and the only input left for guessing a label
// and a category. A charge without one is a charge nothing downstream can reason about,
// so it is refused at the door rather than accepted and worked around later.
const ex = boot({}, false, true);
vm.runInContext(code, ex);
vm.runInContext(`
  DOM_SET = (s, v) => { document.querySelector(s).value = v; };
  DOM_SET('#e-date', '2025-08-01'); DOM_SET('#e-wp', '100'); DOM_SET('#e-purpose', '');
  DOM_SET('#e-amt', '42'); DOM_SET('#e-sup', '');
  addExpense();
`, ex);
t('a charge with no supplier is refused', vm.runInContext("M.expenses.length", ex) === 0,
  vm.runInContext("M.expenses.length", ex), 0);

vm.runInContext(`DOM_SET('#e-amt', ''); DOM_SET('#e-sup', 'Netgear'); addExpense();`, ex);
t('and so is one with no amount', vm.runInContext("M.expenses.length", ex) === 0,
  vm.runInContext("M.expenses.length", ex), 0);

vm.runInContext(`DOM_SET('#e-amt', '42'); DOM_SET('#e-sup', 'Optus'); addExpense();`, ex);
t('with both, the row is added', vm.runInContext("M.expenses.length", ex) === 1,
  vm.runInContext("M.expenses.length", ex), 1);
t('the category is still guessed from the supplier alone',
  vm.runInContext("M.expenses[0].category", ex) === 'Information services',
  vm.runInContext("M.expenses[0].category", ex), 'Information services');
t('and no description is stored', !vm.runInContext("('description' in M.expenses[0])", ex),
  vm.runInContext("Object.keys(M.expenses[0]).join(',')", ex), 'no description');
t('the supplier clears for the next entry',
  vm.runInContext("document.querySelector('#e-sup').value", ex) === "",
  vm.runInContext("document.querySelector('#e-sup').value", ex), '""');

/* ============================================================
   Moving a row between Expenses and Assets.

   IMPORT-FORMAT.md tells converters to send anything over $300 they cannot classify to
   Assets, because a thing wrongly expensed over-claims while a service wrongly capitalised
   only under-claims. That rule is deliberately biased, so it is deliberately wrong
   sometimes, and it is only defensible because a correction exists.
   ============================================================ */
console.log("\n— a misclassified row can be corrected");

const mv = (st = {}) => { const c = boot(st); vm.runInContext(code, c); return c; };
const DOCK = `M.expenses.push({ id:"e-1", source:"gmail", source_ref:"msg-abc",
  issuer:"dell", date:"2025-08-01", description:"WD19S dock", supplier:"Dell",
  amount:310.32, work_pct:100, label:"D5", category:"Software and subscriptions",
  basis:"used for the work laptop" }); activeYear = "2025-26";`;

// ---- the duplicate this feature would otherwise manufacture ----
// A row that leaves `expenses` must still be recognised by the converter that produced it.
// Before the cross-collection source key, step 4 read "add 1, skip 0" and the ledger
// claimed the same $310.32 twice — $58.19 at D6 and $310.32 at D5.
const dup = mv();
vm.runInContext(`
  FILE = { schema:3, years:[], assets:[], income:[], expenses:[
    { id:"e-1", source:"gmail", source_ref:"msg-abc", date:"2025-08-01",
      description:"WD19S dock", supplier:"Dell", amount:310.32, work_pct:100, label:"D5" }]};
  var copy = () => JSON.parse(JSON.stringify(FILE));
  applyImport(planImport(copy()));
  first = M.expenses.length;
  var p2 = planImport(copy());
  reimport = p2.add.expenses.length + "/" + p2.skip.expenses.length;
  sendToAssets(M.expenses[0].id);
  moved = M.expenses.length + "/" + M.assets.length;
  var p4 = planImport(copy());
  after = p4.add.expenses.length + "/" + p4.skip.expenses.length;
  applyImport(p4);
  total = M.expenses.length + M.assets.length;
`, dup);
t('the file imports once', vm.runInContext('first', dup) === 1, vm.runInContext('first', dup), 1);
t('re-importing it skips', vm.runInContext('reimport', dup) === "0/1", vm.runInContext('reimport', dup), '0/1 (add/skip)');
t('the row moves to assets', vm.runInContext('moved', dup) === "0/1", vm.runInContext('moved', dup), '0/1 (expenses/assets)');
t('and is still recognised where it now lives',
  vm.runInContext('after', dup) === "0/1", vm.runInContext('after', dup), '0/1 — not re-added');
t('so the charge is held once, not twice',
  vm.runInContext('total', dup) === 1, vm.runInContext('total', dup), 1);

// ---- what the move preserves, and what it re-derives ----
const one = mv();
vm.runInContext(DOCK + ` sendToAssets("e-1"); A = M.assets[0];`, one);
const A = k => vm.runInContext("A." + k, one);
t('the asset keeps the purchase date', A("purchase_date") === "2025-08-01", A("purchase_date"), '2025-08-01');
t('the cost is the expense amount', A("cost") === 310.32, A("cost"), 310.32);
t('the supplier survives in the joined identity', A("item_supplier") === "Review item — Dell",
  A("item_supplier"), 'Review item — Dell');
t('the issuer survives', A("issuer") === "dell", A("issuer"), 'dell');
t('the converter identity survives',
  A("source") === "gmail" && A("source_ref") === "msg-abc",
  A("source") + "/" + A("source_ref"), 'gmail/msg-abc');
t('the basis survives', A("basis") === "used for the work laptop", A("basis"), 'used for the work laptop');
t('treatment is computed on arrival, not carried from the expense',
  A("treatment") === "schedule", A("treatment"), 'schedule — $301–999 with no pool open');
t('the expense is gone', vm.runInContext("M.expenses.length", one) === 0,
  vm.runInContext("M.expenses.length", one), 0);

// The two taxonomies are disjoint by design — a laptop is never an Information service.
// Carrying the category across would put a value in the picker the picker does not offer.
// Since an expense has no description, only the supplier is left to classify by, and a
// merchant name rarely says what was bought: the asset arrives uncategorised rather than
// miscategorised. Blank is a question the picker can answer; "Software and subscriptions"
// on an asset is an answer nothing can.
t('the expense category is not carried across',
  A("category") !== "Software and subscriptions", A("category"), 'not the expense category');
t('and a merchant name alone does not classify a thing',
  A("category") === "", JSON.stringify(A("category")), '"" — for you to pick');

// workPctFor() reads a missing work_pct as 100 — the one default that errs toward
// over-claiming, and a move is a way to reach it.
t('work_pct becomes an object keyed by financial year',
  typeof A("work_pct") === "object" && vm.runInContext('A.work_pct["2025-26"]', one) === 100,
  JSON.stringify(A("work_pct")), '{"2025-26":100}');

const zero = mv();
vm.runInContext(DOCK.replace("work_pct:100", "work_pct:0") + ` sendToAssets("e-1");
  wp = workPctFor(M.assets[0], "2025-26");`, zero);
t('a 0% row does not arrive claiming 100%',
  vm.runInContext('wp', zero) === 0, vm.runInContext('wp', zero), 0);

// ---- the number that actually changes ----
const claim = mv();
vm.runInContext(DOCK + `
  var before = buildLodgment("2025-26").deductions;
  d5before = before.D5 ? before.D5.total : 0;
  sendToAssets("e-1");
  derive();
  var after = buildLodgment("2025-26").deductions;
  d5after = after.D5 ? after.D5.total : 0;
  d6after = after.D6 ? after.D6.total : 0;
`, claim);
t('as an expense it claims its whole cost at D5',
  near(vm.runInContext('d5before', claim), 310.32), vm.runInContext('d5before', claim), 310.32);
// With no pool open the dock arrives on an individual schedule: a 3-year life suggested from
// the item, apportioned from 1 August, at the default diminishing value. The point of the move
// is unchanged — a thing stops claiming its whole cost in one year — only the route it takes to
// get there. In a first year the opening value IS the cost, so this is exactly double what the
// same move produced under prime cost — 94.6533 becomes 189.3066 — and that doubling is what the
// figure checks. It displays as $189.31: the doubled figure rounds up, where doubling the
// displayed $94.65 would not.
t('as a scheduled asset it depreciates instead',
  near(vm.runInContext('d5after', claim), 189.31), vm.runInContext('d5after', claim).toFixed(2), 189.31);
t('so the whole cost is no longer claimed this year',
  vm.runInContext('d5after', claim) < 310.32, vm.runInContext('d5after', claim).toFixed(2), 'well under 310.32');
t('and it is not in the pool, which was never opened',
  near(vm.runInContext('d6after', claim), 0), vm.runInContext('d6after', claim), 0);

// The confirmation is the whole safety net, so it has to state both numbers.
t('the confirmation names what is claimed today',
  dup.CONFIRMED.join(" ").indexOf("$310.32") !== -1, dup.CONFIRMED.join(" ").slice(0,80), 'mentions $310.32');
t('and what will be claimed instead',
  dup.CONFIRMED.join(" ").indexOf("$189.31") !== -1, dup.CONFIRMED.join(" ").slice(0,120), 'mentions $189.31');
// A figure without its method is half a fact: the same asset on prime cost claims $94.65, and
// the confirmation is the only place the choice is visible before the row lands.
t('and names the method that produced it',
  dup.CONFIRMED.join(" ").indexOf("diminishing value") !== -1,
  dup.CONFIRMED.join(" ").slice(0,120), 'mentions diminishing value');

// The pool route still exists and still has to be right — it is just no longer the default.
const intoPool = mv();
vm.runInContext(`M.assets.push({ asset_id:"A-POOL", item_supplier:"Hub — Dell",
    purchase_date:"2025-07-01", cost:400, treatment:"pool", work_pct:{"2025-26":100} });`
  + DOCK + ` sendToAssets("e-1"); derive();
  var after = buildLodgment("2025-26").deductions;
  movedTreatment = M.assets.find(a => a.asset_id !== "A-POOL").treatment;
  poolD6 = after.D6 ? after.D6.total : 0;`, intoPool);
t('a dock moved into an open pool is pooled, not scheduled',
  vm.runInContext('movedTreatment', intoPool)==='pool', vm.runInContext('movedTreatment', intoPool), 'pool');
t('and claims 18.75% of both assets at D6',
  near(vm.runInContext('poolD6', intoPool), (310.32+400)*0.1875),
  vm.runInContext('poolD6', intoPool).toFixed(2), ((310.32+400)*0.1875).toFixed(2));

// ---- back the other way ----
const trip = mv();
vm.runInContext(DOCK + ` sendToAssets("e-1"); sendToExpenses(M.assets[0].asset_id); E = M.expenses[0];`, trip);
const E = k => vm.runInContext("E." + k, trip);
t('a round trip returns the date', E("date") === "2025-08-01", E("date"), '2025-08-01');
t('a round trip returns the amount', E("amount") === 310.32, E("amount"), 310.32);
t('a round trip returns the work use', E("work_pct") === 100, E("work_pct"), 100);
t('a round trip keeps the converter identity',
  E("source_ref") === "msg-abc" && E("issuer") === "dell",
  E("source_ref") + "/" + E("issuer"), 'msg-abc/dell');
t('a round trip keeps the basis', E("basis") === "used for the work laptop", E("basis"), 'used for the work laptop');
t('and re-derives the category for expenses',
  vm.runInContext('knownCategories("expenses").indexOf(E.category) !== -1 || E.category === ""', trip),
  E("category"), 'an expense category');
t('the asset is gone', vm.runInContext("M.assets.length", trip) === 0, vm.runInContext("M.assets.length", trip), 0);

// An item-only asset has no safe Expenses supplier. Ask at the boundary, and leave the
// asset untouched when the person cancels instead of inventing or dropping that identity.
const noSupplier = mv();
vm.runInContext(`
  M.assets.push({asset_id:"A-2026-001",item_supplier:"Standing desk",purchase_date:"2025-08-01",
    cost:450,treatment:"pool",work_pct:{"2025-26":100}});
  activeYear="2025-26";
  sendToExpenses("A-2026-001");
`, noSupplier);
t('an item-only asset asks for the Expense supplier',
  noSupplier.PROMPTED.some(x => x.includes('Supplier for “Standing desk”')) &&
    vm.runInContext("M.assets.length", noSupplier) === 1,
  noSupplier.PROMPTED.join(' | '), 'supplier prompt');
t('cancelling the supplier prompt does not open the move confirmation',
  noSupplier.CONFIRMED.length === 0, noSupplier.CONFIRMED.length, 0);

const supplied = mv();
supplied.PROMPT_REPLY = "Officeworks";
vm.runInContext(`
  M.assets.push({asset_id:"A-2026-001",item_supplier:"Standing desk",purchase_date:"2025-08-01",
    cost:450,treatment:"pool",work_pct:{"2025-26":100}});
  activeYear="2025-26";
  sendToExpenses("A-2026-001");
`, supplied);
t('the supplied name becomes the Expense supplier',
  vm.runInContext("M.expenses[0].supplier", supplied) === "Officeworks",
  vm.runInContext("M.expenses[0].supplier", supplied), 'Officeworks');
t('answering the supplier prompt completes one confirmed move',
  vm.runInContext("M.assets.length+'/'+M.expenses.length", supplied) === '0/1' && supplied.CONFIRMED.length === 1,
  vm.runInContext("M.assets.length+'/'+M.expenses.length", supplied), '0/1');

// ---- refusals ----
// A disposal computes a balancing adjustment from fields an expense row cannot hold.
const disp = mv();
vm.runInContext(`
  M.assets.push({ asset_id:"A-2026-001", description:"old laptop", supplier:"Dell",
    purchase_date:"2025-08-01", cost:1800, treatment:"schedule", effective_life:2,
    work_pct:{"2025-26":100}, status:"disposed", disposal_date:"2026-03-01",
    disposal_proceeds:400 });
  activeYear = "2025-26";
  sendToExpenses("A-2026-001");
`, disp);
t('a disposed asset refuses to move',
  vm.runInContext("M.assets.length", disp) === 1 && vm.runInContext("M.expenses.length", disp) === 0,
  vm.runInContext("M.assets.length+'/'+M.expenses.length", disp), '1/0 — unchanged');
t('and says why', disp.ALERTS.join(" ").indexOf("balancing adjustment") !== -1,
  disp.ALERTS.join(" ").slice(0,60), 'mentions the balancing adjustment');

// Declining the dialog must change nothing at all.
const no = mv();
no.CONFIRM_REPLY = false;
vm.runInContext(DOCK + ` sendToAssets("e-1");`, no);
t('declining the confirmation moves nothing',
  vm.runInContext("M.expenses.length", no) === 1 && vm.runInContext("M.assets.length", no) === 0,
  vm.runInContext("M.expenses.length+'/'+M.assets.length", no), '1/0 — unchanged');

// ---- ids ----
const ids = mv();
vm.runInContext(`
  M.assets.push({ asset_id:"A-2026-001", description:"held", purchase_date:"2025-09-01",
    cost:500, treatment:"pool", work_pct:{"2025-26":100} });
  M.expenses.push({ id:"e-a", date:"2025-08-01", description:"dock", supplier:"Dell", amount:400, work_pct:100 });
  M.expenses.push({ id:"e-b", date:"2025-10-01", description:"stand", supplier:"Dell", amount:450, work_pct:100 });
  activeYear = "2025-26";
  sendToAssets("e-a"); sendToAssets("e-b");
  allIds = M.assets.map(a => a.asset_id);
`, ids);
t('moved rows get ids in their own financial year',
  vm.runInContext('allIds', ids).every(i => i.indexOf("A-2026-") === 0),
  vm.runInContext('allIds', ids).join(","), 'all A-2026-*');
t('and never collide with an id already held',
  new Set(vm.runInContext('allIds', ids)).size === 3,
  vm.runInContext('allIds', ids).join(","), '3 distinct ids');

/* ============================================================
   The entry rows.

   Entry files into the tab you are standing on — the thing-or-service choice belongs to
   rows a converter classified, and is corrected on the recorded row, not offered again
   where nothing is in doubt.
   ============================================================ */
console.log("\n— import corrections stay on recorded table rows");

const entry = (fields) => {
  const c = boot({}, false, true);
  vm.runInContext(code, c);
  vm.runInContext('activeYear = "2025-26";', c);
  for (const [sel, v] of Object.entries(fields)) c.DOM[sel] = Object.assign(stubEl(), { value: v });
  return c;
};

const EXP_FIELDS = { "#e-date":"2025-08-01", "#e-sup":"Dell", "#e-amt":"310.32",
  "#e-wp":"100", "#e-purpose":"software" };

// ---- every group is correctable, whatever its size ----
// JSON imports can create many duplicated or misclassified rows. Details must not be a
// prerequisite for correcting them, so the group header carries all three actions.
const grp = boot({}, false, true);
vm.runInContext(code, grp);
vm.runInContext(`
  M.expenses.push({id:"solo",date:"2025-08-01",description:"WD19S dock",supplier:"Dell",
    amount:310.32,work_pct:100,label:"D5"});
  M.expenses.push({id:"c1",date:"2025-08-01",description:"USB-C cable",supplier:"Amazon",
    amount:29,work_pct:100,label:"D5"});
  M.expenses.push({id:"c2",date:"2025-08-01",description:"USB-C cable",supplier:"Amazon",
    amount:29,work_pct:100,label:"D5"});
  activeYear="2025-26"; openGroups={}; derive(); renderExpenses();
`, grp);
const groupRow = key => {
  const rows = grp.DOM["#v-expenses"].innerHTML.match(/<tr class="grp(?: open)?">[\s\S]*?<\/tr>/g) || [];
  return rows.find(r => r.indexOf("<b>" + key + "</b>") !== -1) || "";
};
t('collapsed groups use the same Details action',
  groupRow("Dell").indexOf(">Details<") !== -1 && groupRow("Amazon").indexOf(">Details<") !== -1,
  [groupRow("Dell"), groupRow("Amazon")].map(r => r.includes(">Details<") ? "Details" : "missing").join(" / "),
  'Details / Details');
t('move and delete are directly available on collapsed group rows',
  groupRow("Dell").includes("sendGroupToAssets") && groupRow("Dell").includes("removeGroup") &&
    groupRow("Amazon").includes("sendGroupToAssets") && groupRow("Amazon").includes("removeGroup"),
  'collapsed actions', 'Details, send and delete');
t('groups begin collapsed', Object.keys(vm.runInContext("openGroups", grp)).length === 0,
  JSON.stringify(vm.runInContext("openGroups", grp)), '{} — nothing expanded');
t('the group rows still fill every column',
  (groupRow("Dell").match(/<td/g) || []).length === 7,
  (groupRow("Dell").match(/<td/g) || []).length, 7);

vm.runInContext(`toggleGroup("Amazon");`, grp);
const openedAmazon = grp.DOM["#v-expenses"].innerHTML;
t('opening Details does not move or duplicate group corrections',
  (openedAmazon.match(/sendGroupToAssets\('Amazon'\)/g) || []).length === 1 &&
    (openedAmazon.match(/removeGroup\('Amazon'\)/g) || []).length === 1,
  'one action set', 'one action set');

// Two cables are two assets, not one $58 asset — the $300 test applies per item.
vm.runInContext(`sendGroupToAssets("Amazon");`, grp);
t('a group moves as one row per item',
  vm.runInContext("M.assets.length", grp) === 2, vm.runInContext("M.assets.length", grp), 2);
t('each keeps its own cost',
  vm.runInContext("M.assets.map(a=>a.cost).join()", grp) === "29,29",
  vm.runInContext("M.assets.map(a=>a.cost).join()", grp), '29,29');
t('and is tested on its own cost, not the receipt total',
  vm.runInContext("M.assets.every(a=>a.treatment==='immediate')", grp),
  vm.runInContext("M.assets.map(a=>a.treatment).join()", grp), 'immediate,immediate');
t('their ids do not collide',
  new Set(vm.runInContext("M.assets.map(a=>a.asset_id)", grp)).size === 2,
  vm.runInContext("M.assets.map(a=>a.asset_id).join()", grp), '2 distinct ids');
t('the charges leave expenses', vm.runInContext("M.expenses.length", grp) === 1,
  vm.runInContext("M.expenses.length", grp), '1 — only the Dell dock is left');
t('the confirmation says how many rows it makes',
  /2 asset rows/.test(grp.CONFIRMED.join(" ")), grp.CONFIRMED.join(" ").slice(0,90), 'names 2 asset rows');

// ---- deleting directly from the group row ----
const del = boot({}, false, true);
vm.runInContext(code, del);
const DEL_ROWS = `
  M.expenses.push({id:"solo",date:"2025-08-01",description:"dock",supplier:"Dell",
    amount:310.32,work_pct:100,label:"D5"});
  ["2025-08-01","2025-09-01","2025-10-01"].forEach(function(d,i){
    M.expenses.push({id:"b"+i,date:d,description:"mobile",supplier:"Optus",
      amount:25,work_pct:70,label:"D5"}); });
  activeYear="2025-26"; openGroups={"Optus":true}; derive(); renderExpenses();`;
vm.runInContext(DEL_ROWS, del);
const delRow = key => (del.DOM["#v-expenses"].innerHTML.match(/<tr class="grp(?: open)?">[\s\S]*?<\/tr>/g) || [])
  .find(r => r.indexOf("<b>" + key + "</b>") !== -1) || "";
t('an open group keeps Details, send and delete on its header',
  delRow("Optus").includes(">Details<") && delRow("Optus").includes("sendGroupToAssets") &&
    delRow("Optus").includes("removeGroup"),
  'header actions', 'Details, send and delete');
t('group corrections are not repeated in a separate Details row',
  (del.DOM["#v-expenses"].innerHTML.match(/sendGroupToAssets\('Optus'\)/g) || []).length === 1 &&
    !del.DOM["#v-expenses"].innerHTML.includes(">Delete group<"),
  'one header action set', 'one header action set');

vm.runInContext(`removeGroup("Optus");`, del);
t('deleting a group removes every charge in it',
  vm.runInContext("M.expenses.length", del) === 1,
  vm.runInContext("M.expenses.length", del), '1 — only the Dell dock is left');
t('the confirmation says how many and how much',
  /all 3 .*charges/.test(del.CONFIRMED.join(" ")) && del.CONFIRMED.join(" ").indexOf("$75.00") !== -1,
  del.CONFIRMED.join(" ").split("\n")[0], 'names 3 charges and $75.00');

// A group of one is a single row, and asks the single-row question.
vm.runInContext(`removeGroup("Dell");`, del);
t('a one-charge group deletes just that charge',
  vm.runInContext("M.expenses.length", del) === 0, vm.runInContext("M.expenses.length", del), 0);

const keep = boot({}, false, true);
vm.runInContext(code, keep);
vm.runInContext(DEL_ROWS, keep);
keep.CONFIRM_REPLY = false;
vm.runInContext(`removeGroup("Optus"); removeGroup("Dell");`, keep);
t('declining deletes nothing', vm.runInContext("M.expenses.length", keep) === 4,
  vm.runInContext("M.expenses.length", keep), 4);

// A supplier with an apostrophe used to break every handler on its group row: esc() turned
// the quote into &#39;, the following replace found nothing, and the browser handed a bare
// quote back to the JS parser.
const apos = boot({}, false, true);
vm.runInContext(code, apos);
vm.runInContext(`
  M.expenses.push({id:"d1",date:"2025-08-01",description:"coffee",supplier:"Dan's Cafe",
    amount:12,work_pct:100,label:"D5"});
  activeYear="2025-26"; openGroups={}; derive(); renderExpenses();
`, apos);
const ah = apos.DOM["#v-expenses"].innerHTML;
// The browser decodes the attribute, so \&#39; becomes \' — an escaped quote inside the
// single-quoted argument, rather than one that closes it.
t('an apostrophe in a supplier is escaped for JavaScript',
  ah.indexOf("toggleGroup('Dan\\&#39;s Cafe')") !== -1,
  (/toggleGroup\([^)]*\)/.exec(ah) || ["missing"])[0], "toggleGroup('Dan\\&#39;s Cafe')");
t('and the group still moves', (() => {
    vm.runInContext(`sendGroupToAssets("Dan's Cafe");`, apos);
    return vm.runInContext("M.assets.length", apos) === 1;
  })(), vm.runInContext("M.assets.length", apos), 1);

/* ============================================================
   Action columns say the same thing on every row.

   The first version of the group button pluralised itself — "→ asset" on a one-charge
   group, "→ assets" on the next — so a column of identical actions looked ragged and read
   as a bug. Whatever a row contains, the action offered is the same action, and its label
   names where the row is going rather than how many rows go with it.
   ============================================================ */
console.log("\n— the action column is consistent down every table");

const cons = boot({}, false, true);
vm.runInContext(code, cons);
vm.runInContext(`
  M.expenses.push({id:"one",date:"2025-08-01",description:"dock",supplier:"Dell",amount:310.32,work_pct:100,label:"D5"});
  ["2025-08-01","2025-09-01"].forEach(function(d,i){
    M.expenses.push({id:"a"+i,date:d,description:"cable",supplier:"Amazon",amount:29,work_pct:100,label:"D5"}); });
  ["2025-08-01","2025-09-01","2025-10-01"].forEach(function(d,i){
    M.expenses.push({id:"b"+i,date:d,description:"mobile",supplier:"Optus",amount:25,work_pct:70,label:"D5"}); });
  M.assets.push({asset_id:"A-2026-001",description:"laptop",supplier:"Dell",purchase_date:"2025-08-01",
    cost:1800,treatment:"schedule",effective_life:2,work_pct:{"2025-26":100}});
  M.assets.push({asset_id:"A-2026-002",description:"chair",supplier:"Officeworks",purchase_date:"2025-09-01",
    cost:400,treatment:"pool",work_pct:{"2025-26":100}});
  M.income.push({id:"i1",date:"2025-08-01",type:"dividend",holding:"BANKA",franked:100});
  activeYear="2025-26"; openGroups={}; derive();
  renderExpenses(); renderAssets(); renderIncome();
`, cons);

t('entry rows keep Add as their only action',
  [cons.DOM["#v-expenses"].innerHTML, cons.DOM["#v-assets"].innerHTML].every(source => {
    const row = addRow(source);
    return row.includes(">Add<") && !row.includes("sendTo") && !row.includes("removeRow");
  }), 'Add only', 'Add only');

// Buttons in the LAST cell of each body row — the action column.
function actionLabels(viewHTML){
  const out = [];
  for (const row of viewHTML.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || []) {
    if (row.indexOf('class="add"') !== -1) continue;          // the entry row is not a record
    const cells = row.match(/<td[\s\S]*?(?=<td|<\/tr>)/g) || [];
    const last = cells[cells.length - 1] || "";
    for (const b of last.match(/>([^<>]+)<\/button>/g) || []) out.push(b.slice(1, -9).trim());
  }
  return out;
}
const distinct = a => [...new Set(a)].sort();

for (const [view, expected] of [
  ["#v-expenses", ["Details", "del", "→ Assets"]],
  ["#v-assets",   ["Details", "del", "→ Expenses"]],
  ["#v-income",   ["del"]]
]) {
  const got = distinct(actionLabels(cons.DOM[view].innerHTML));
  t(view + ": the action column offers one vocabulary",
    got.join("|") === expected.join("|"), got.join(", ") || "(none)", expected.join(", "));
}

// Import correction is visible without expanding the asset. Details must not duplicate it.
const closedAssetHTML = cons.DOM["#v-assets"].innerHTML;
t('asset correction actions are directly available on recorded rows',
  closedAssetHTML.includes("sendToExpenses('A-2026-001')") &&
    closedAssetHTML.includes("removeRow('assets','A-2026-001')"),
  'visible actions', 'send and delete');
vm.runInContext(`openAsset="A-2026-001"; renderAssets();`, cons);
const openAssetActions = distinct(actionLabels(cons.DOM["#v-assets"].innerHTML));
t('opening asset Details does not change the table action vocabulary',
  openAssetActions.join("|") === ["Details", "del", "→ Expenses"].join("|"),
  openAssetActions.join(", "), 'Details, del, → Expenses');

// Expense group headers follow the same direct-action contract. Expanded charge rows retain
// granular actions so one duplicate can be corrected without deleting its whole group.
vm.runInContext(`toggleGroup("Amazon");`, cons);
const expandedExpenses = cons.DOM["#v-expenses"].innerHTML;
const expenseHeads = (expandedExpenses.match(/<tr class="grp[^"]*">[\s\S]*?<\/tr>/g) || [])
  .filter(r => !r.includes('class="grp-item"'));
const expenseItems = expandedExpenses.match(/<tr class="grp-item">[\s\S]*?<\/tr>/g) || [];
t('every expense group row exposes Details, send and delete',
  expenseHeads.length === 3 && expenseHeads.every(r =>
    r.includes(">Details<") && r.includes(">→ Assets<") && r.includes(">del<")),
  expenseHeads.length + ' rows', '3 rows with all actions');
t('expanded charges expose move and mistaken-row deletion',
  expenseItems.length === 2 && expenseItems.every(r => r.includes(">→ Assets<") && r.includes(">del<")),
  expenseItems.length + ' detail rows', '2 rows with both corrections');
t('an expanded group has no duplicate correction-action row',
  (expandedExpenses.match(/sendGroupToAssets\('Amazon'\)/g) || []).length === 1 &&
    !expandedExpenses.includes('>Delete group<'),
  'one header action set', 'one header action set');

console.log("\n— what the entry row does with a work-use percentage");

// ---- a typed 0% is zero, not the default ----
// `num(v) || 100` read an explicit 0 as blank and claimed the full amount.
const z = entry(Object.assign({}, EXP_FIELDS, { "#e-wp":"0" }));
vm.runInContext(`addExpense();`, z);
t('a typed 0% work use claims nothing', vm.runInContext("M.expenses[0].work_pct", z) === 0,
  vm.runInContext("M.expenses[0].work_pct", z), 0);
const zb = entry(Object.assign({}, EXP_FIELDS, { "#e-wp":"" }));
vm.runInContext(`addExpense();`, zb);
t('a blank percentage is rejected instead of invented', vm.runInContext("M.expenses.length", zb) === 0,
  vm.runInContext("M.expenses.length", zb), 0);
t('the rejection explains the valid range', zb.ALERTS.some(x => x.includes("0 to 100")),
  zb.ALERTS.join(' | '), '0 to 100 guidance');
const zo = entry(Object.assign({}, EXP_FIELDS, { "#e-wp":"101" }));
vm.runInContext(`addExpense();`, zo);
t('an out-of-range percentage is rejected too', vm.runInContext("M.expenses.length", zo) === 0,
  vm.runInContext("M.expenses.length", zo), 0);
const za = entry({ "#a-item-supplier":"dock — Dell", "#a-date":"2025-08-01", "#a-cost":"400", "#a-wp":"0", "#a-cat":"" });
vm.runInContext(`addAsset();`, za);
t('the same holds on the asset entry row',
  vm.runInContext('workPctFor(M.assets[0],"2025-26")', za) === 0,
  vm.runInContext('workPctFor(M.assets[0],"2025-26")', za), 0);
const zab = entry({ "#a-item-supplier":"dock — Dell", "#a-date":"2025-08-01", "#a-cost":"400", "#a-wp":"" });
vm.runInContext(`addAsset();`, zab);
t('a blank asset percentage is rejected too', vm.runInContext("M.assets.length", zab) === 0,
  vm.runInContext("M.assets.length", zab), 0);
const categorizedAsset = entry({ "#a-item-supplier":"laptop — Dell", "#a-date":"2025-08-01",
  "#a-cost":"1800", "#a-wp":"80", "#a-cat":"Furniture" });
vm.runInContext(`previewAssetEntry();`, categorizedAsset);
t('the asset entry identifies a deliberately selected category',
  categorizedAsset.DOM["#a-purpose-hint"].textContent === 'Selected: D5 · Furniture — depreciate',
  categorizedAsset.DOM["#a-purpose-hint"].textContent, 'Selected: D5 · Furniture — depreciate');
vm.runInContext(`addAsset();`, categorizedAsset);
t('the selected asset category is stored on the asset',
  vm.runInContext("M.assets[0].category", categorizedAsset) === 'Furniture',
  vm.runInContext("M.assets[0].category", categorizedAsset), 'Furniture');

console.log("\n— suggestions inform, dates route, and the current view stays put");
const suggested = entry({ "#e-date":"2025-08-01", "#e-sup":"Optus", "#e-amt":"50",
  "#e-wp":"70", "#e-purpose":"" });
vm.runInContext(`addExpense();`, suggested);
t('a blank Tax purpose uses the supplier suggestion',
  vm.runInContext("M.expenses[0].category + '|' + M.expenses[0].label", suggested) === 'Information services|D5',
  vm.runInContext("M.expenses[0].category + '|' + M.expenses[0].label", suggested), 'Information services|D5');
const chosen = entry(Object.assign({}, EXP_FIELDS, { "#e-purpose":"donations" }));
vm.runInContext(`addExpense();`, chosen);
t('an explicit Tax purpose writes category and return section together',
  vm.runInContext("M.expenses[0].category + '|' + M.expenses[0].label", chosen) === 'Donations|D9',
  vm.runInContext("M.expenses[0].category + '|' + M.expenses[0].label", chosen), 'Donations|D9');

const monthly = entry({ "#e-date":"2025-07-20", "#e-repeat":"12", "#e-sup":"Optus",
  "#e-amt":"25", "#e-wp":"70", "#e-purpose":"phone" });
vm.runInContext(`previewExpenseEntry();`, monthly);
t('the entry preview includes every repeated charge in the viewed FY',
  monthly.DOM["#e-claim-preview"].textContent === '$210.00',
  monthly.DOM["#e-claim-preview"].textContent, '$210.00');
vm.runInContext(`addExpense();`, monthly);
t('monthly repeat creates one underlying row per charge',
  vm.runInContext("M.expenses.length", monthly) === 12, vm.runInContext("M.expenses.length", monthly), 12);
t('the repeated dates run from July through June',
  vm.runInContext("M.expenses[0].date + '|' + M.expenses[11].date", monthly) === '2025-07-20|2026-06-20',
  vm.runInContext("M.expenses[0].date + '|' + M.expenses[11].date", monthly), '2025-07-20|2026-06-20');
t('those rows produce the same FY deduction shown in the preview',
  near(vm.runInContext("derived.lodgment['2025-26'].deductions.D5.total", monthly), 210),
  vm.runInContext("derived.lodgment['2025-26'].deductions.D5.total", monthly), 210);
t('the confirmation names the number of monthly charges',
  vm.runInContext("entryNotice.text", monthly).includes('12 monthly charges'),
  vm.runInContext("entryNotice.text", monthly), '12 monthly charges');

const badRepeat = entry(Object.assign({}, EXP_FIELDS, { "#e-repeat":"1.5" }));
vm.runInContext(`addExpense();`, badRepeat);
t('a fractional repeat count is rejected', vm.runInContext("M.expenses.length", badRepeat) === 0,
  vm.runInContext("M.expenses.length", badRepeat), 0);

const acrossYears = entry({ "#e-date":"2026-05-31", "#e-repeat":"4", "#e-sup":"Optus",
  "#e-amt":"25", "#e-wp":"70", "#e-purpose":"phone" });
vm.runInContext(`M.years.push({year:"2025-26"}); addExpense();`, acrossYears);
t('repeats crossing 30 June are routed by each generated date',
  vm.runInContext("M.expenses.map(e=>e.date).join('|')", acrossYears) ===
    '2026-05-31|2026-06-30|2026-07-31|2026-08-31',
  vm.runInContext("M.expenses.map(e=>e.date).join('|')", acrossYears),
  '2026-05-31|2026-06-30|2026-07-31|2026-08-31');
t('the repeat confirmation names both financial years',
  vm.runInContext("entryNotice.text", acrossYears).includes('FY 2025–26 through FY 2026–27'),
  vm.runInContext("entryNotice.text", acrossYears), 'both FYs');

const routed = entry({ "#e-date":"2026-08-09", "#e-sup":"Cloudflare", "#e-amt":"30",
  "#e-wp":"100", "#e-purpose":"hosting" });
vm.runInContext(`M.years.push({year:"2025-26"}); addExpense();`, routed);
t('the transaction date owns the financial year',
  vm.runInContext("fyOf(M.expenses[0].date)", routed) === '2026-27',
  vm.runInContext("fyOf(M.expenses[0].date)", routed), '2026-27');
t('adding into another year does not move the current view',
  vm.runInContext("activeYear", routed) === '2025-26', vm.runInContext("activeYear", routed), '2025-26');
t('the confirmation names where the row went',
  vm.runInContext("entryNotice.text", routed).includes('FY 2026–27'),
  vm.runInContext("entryNotice.text", routed), 'mentions FY 2026–27');

const routedAsset = entry({ "#a-item-supplier":"laptop — Dell", "#a-date":"2026-08-09",
  "#a-cost":"1800", "#a-wp":"80" });
vm.runInContext(`M.years.push({year:"2025-26"}); addAsset();`, routedAsset);
t('an asset purchase date owns its first claim year',
  vm.runInContext("fyOf(assetStartDate(M.assets[0]))", routedAsset) === '2026-27',
  vm.runInContext("fyOf(assetStartDate(M.assets[0]))", routedAsset), '2026-27');
t('adding that asset also keeps the current view',
  vm.runInContext("activeYear", routedAsset) === '2025-26', vm.runInContext("activeYear", routedAsset), '2025-26');
t('the asset confirmation names its first claim year',
  vm.runInContext("entryNotice.text", routedAsset).includes('FY 2026–27'),
  vm.runInContext("entryNotice.text", routedAsset), 'mentions FY 2026–27');

/* ------------------------------------------------------------------
   The Assets register lists a year, not a shoebox
   ------------------------------------------------------------------ */
// A register that shows every asset in every year reports finished claims as though
// they were still open. Holding an asset and claiming it are different facts.
const held = boot();
vm.runInContext(code, held);
vm.runInContext(`M.assets = [
  { asset_id:"A1", item_supplier:"desk", purchase_date:"2025-08-01", cost:250,
    work_pct:80, treatment:"immediate" },
  { asset_id:"A2", item_supplier:"laptop", purchase_date:"2025-08-01", cost:900,
    work_pct:80, treatment:"pool" },
  { asset_id:"A3", item_supplier:"monitor", purchase_date:"2025-08-01", cost:800,
    work_pct:80, treatment:"pool", disposal_date:"2025-11-01", disposal_proceeds:400 },
  { asset_id:"A4", item_supplier:"chair", purchase_date:"2026-09-01", cost:700,
    work_pct:80, treatment:"pool" }
];
M.years = [{year:"2025-26", wfh_method:"fixed", wfh_hours:0, marginal:0.32},
           {year:"2026-27", wfh_method:"fixed", wfh_hours:0, marginal:0.32}];
derive();`, held);

const inYear = (id, fy) =>
  vm.runInContext(`assetInYear(M.assets.find(a=>a.asset_id==="${id}"), "${fy}")`, held);

t('an immediate deduction shows in the year it was taken',
  inYear("A1", "2025-26") === true, inYear("A1", "2025-26"), true);
t('and never again — the claim is finished, not pending',
  inYear("A1", "2026-27") === false, inYear("A1", "2026-27"), false);
t('a pooled asset keeps its place, because the pool keeps deducting',
  inYear("A2", "2026-27") === true, inYear("A2", "2026-27"), true);
t('an asset disposed of in an earlier year drops out',
  inYear("A3", "2026-27") === false, inYear("A3", "2026-27"), false);
t('but still appears in the year it was disposed of',
  inYear("A3", "2025-26") === true, inYear("A3", "2025-26"), true);
t('an asset bought in a later year is not backdated into this one',
  inYear("A4", "2025-26") === false, inYear("A4", "2025-26"), false);
t('and appears once its own year arrives',
  inYear("A4", "2026-27") === true, inYear("A4", "2026-27"), true);

/* ------------------------------------------------------------------
   Filing season: open on the return that is due, and pin it
   ------------------------------------------------------------------ */
// From 1 July to 31 October you are lodging the year that just ended, so the newest year in
// the file is the wrong guess exactly when the ledger is busiest. Dates are passed in rather
// than read from the clock, so none of this rots after 30 June.
console.log("\n— filing season");

const seaCtx = lockBoot();
const season = d => vm.runInContext(`filingSeason('${d}')`, seaCtx);
t('30 June is not filing season', season('2026-06-30')===false, season('2026-06-30'), false);
t('1 July opens it', season('2026-07-01')===true, season('2026-07-01'), true);
t('31 October is the last day', season('2026-10-31')===true, season('2026-10-31'), true);
t('1 November closes it', season('2026-11-01')===false, season('2026-11-01'), false);

// A date inside, and outside, the window whose reporting year is the given FY — derived from
// the FY itself so these follow reportingYear() over the rollover.
const inSeason  = fy => (Number(fy.slice(0,4)) + 1) + '-08-09';
const outSeason = fy => (Number(fy.slice(0,4)) + 1) + '-12-01';
const LAND = `M.years=[{year:'${RY}',marginal:0.32},{year:'${NEXT}',marginal:0.32}];
  M.expenses=[{id:'l1',date:'${sep(RY)}',supplier:'union',amount:600,work_pct:100,label:'D5'},
              {id:'l2',date:'${sep(NEXT)}',supplier:'union',amount:600,work_pct:100,label:'D5'}];`;
const OPEN = today => LAND + `activeYear=null; render(); restoreUI(); render();` +
  (today ? ` maybeAutoLock('${today}');` : "");

// The reported bug: one row dated after 1 July moved the landing year off the return due in
// October, and an import into that return then rendered as an empty register.
const lnd1 = lockBoot();
vm.runInContext(LAND + `activeYear=null; render();`, lnd1);
t('opens on the year being lodged, not the newest row entered',
  vm.runInContext('activeYear',lnd1)===RY, vm.runInContext('activeYear',lnd1), RY);

const lnd2 = lockBoot();
vm.runInContext(`M.years=[{year:'${PRIOR}'}];
  M.expenses=[{id:'prj1',date:'${sep(PRIOR)}',supplier:'union',amount:600,work_pct:100,label:'D5'}];
  activeYear=null; render();`, lnd2);
t('nothing recorded in that year yet, so it falls back to the latest entered',
  vm.runInContext('activeYear',lnd2)===PRIOR, vm.runInContext('activeYear',lnd2), PRIOR);

// A first open, before any file is loaded. There is no entered year to fall back to, so the
// picker is seeded — and it was seeded with the year you are standing in, which is the one
// year you cannot lodge.
const blank = lockBoot();
vm.runInContext(`M=emptyModel(); activeYear=null; render();`, blank);
t('an empty ledger opens on the return that is open, not the year you are in',
  vm.runInContext('activeYear',blank)===RY, vm.runInContext('activeYear',blank), RY);
t('and offers only that year until something is entered',
  vm.runInContext('JSON.stringify(derived.years)',blank)===JSON.stringify([RY]),
  vm.runInContext('JSON.stringify(derived.years)',blank), JSON.stringify([RY]));

// Landing on the right year is only half of it. The date box is what actually routes a row —
// fyOf(date) owns the financial year everywhere downstream — and it defaulted to today, so a
// receipt typed while lodging FY2025-26 filed itself into FY2026-27.
console.log('\n— the entry date opens inside the year on screen');
const dateBoot = lockBoot();
const eFor = (fy, today) => vm.runInContext(`entryDateFor(${JSON.stringify(fy)},${JSON.stringify(today)})`, dateBoot);
t('today is kept when it falls inside that year', eFor('2025-26','2025-09-01')==='2025-09-01',
  eFor('2025-26','2025-09-01'), '2025-09-01');
t('a year already closed clamps to its 30 June', eFor('2025-26','2026-08-09')==='2026-06-30',
  eFor('2025-26','2026-08-09'), '2026-06-30');
t('a year not yet begun clamps to its 1 July', eFor('2028-29','2026-08-09')==='2028-07-01',
  eFor('2028-29','2026-08-09'), '2028-07-01');
t('the boundaries themselves are inside', eFor('2025-26','2026-06-30')==='2026-06-30',
  eFor('2025-26','2026-06-30'), '2026-06-30');
t('no year on screen leaves today alone', eFor(null,'2026-08-09')==='2026-08-09',
  eFor(null,'2026-08-09'), '2026-08-09');

// The property that matters, against the real clock rather than an injected one: whatever the
// box opens at, it must belong to the year being viewed. RY has always closed by today, and
// NEXT is always the year today sits in, so both hold year-round without a hardcoded FY.
t('the default always routes to the year being viewed',
  vm.runInContext(`fyOf(entryDateFor('${RY}'))==='${RY}' && fyOf(entryDateFor('${NEXT}'))==='${NEXT}'`, dateBoot),
  vm.runInContext(`[fyOf(entryDateFor('${RY}')),fyOf(entryDateFor('${NEXT}'))].join(',')`, dateBoot),
  [RY,NEXT].join(','));
t('and on the year being lodged that is its 30 June, not today',
  vm.runInContext(`entryDateFor('${RY}')===iso(fyEnd('${RY}')) && entryDateFor('${RY}')!==todayISO()`, dateBoot),
  vm.runInContext(`entryDateFor('${RY}')`, dateBoot), (Number(RY.slice(0,4))+1)+'-06-30');

// What the three registers actually put on screen.
const dateDom = (() => { const c = boot({}, false, true); vm.runInContext(code, c); return c; })();
vm.runInContext(TWO_YEARS + `activeYear='${RY}'; render();`, dateDom);
[['#v-expenses','e-date'],['#v-assets','a-date'],['#v-income','i-date']].forEach(([view,id]) => {
  const html = dateDom.DOM[view].innerHTML;
  const got = (html.match(new RegExp(`id="${id}"[^>]*value="([^"]*)"`)) || [])[1];
  t(`the ${id} box opens in the year being lodged`, fyOf_(got)===RY, got, 'a date in '+RY);
});
function fyOf_(s){ return vm.runInContext(`fyOf(${JSON.stringify(s||'')})`, dateBoot); }

// The Lodgment tab is transcription, so a label that maps to three myTax boxes has to show
// three — and show them without being expanded first, since a collapsed row is a figure you
// do not know you still owe.
console.log('\n— D6 transcribes as the three boxes myTax requires');
const d6Dom = (() => { const c = boot({}, false, true); vm.runInContext(code, c); return c; })();
vm.runInContext(`M.years=[{year:'${RY}'}];
  M.assets=[{asset_id:'A-D',item_supplier:'Dell dock — Officeworks',purchase_date:'${sep(RY)}',
    cost:310.32,treatment:'pool',work_pct:{'${RY}':100}}];
  activeYear='${RY}'; render();`, d6Dom);
const lodge = d6Dom.DOM['#v-lodgment'].innerHTML;
t('the financial investment box is named and shown',
  /Low value pool deduction relating to financial investment/.test(lodge), '', 'named');
t('the rental property box is named and shown',
  /Low value pool deduction relating to rental property/.test(lodge), '', 'named');
t('the remaining box is named and shown',
  /Remaining low value pool deduction/.test(lodge), '', 'named');
t('the D6 row opens without being clicked', /class="lodge-row open"/.test(lodge),
  (lodge.match(/class="lodge-row[^"]*"/)||[])[0], 'class="lodge-row open"');
t('and it says the zeros must be typed, not left blank',
  /do not leave them blank/.test(lodge), '', 'the instruction');

// myTax takes D5 one described row at a time, so the label total is not the figure being
// transcribed — the category is. A copy button on the label only and not on the rows beneath
// it left the ten numbers actually being typed to be read off the screen by eye.
console.log('\n— every category copies its own figure, not just the label total');
const copyDom = (() => { const c = boot({}, false, true); vm.runInContext(code, c); return c; })();
vm.runInContext(`M.years=[{year:'${RY}'}];
  M.assets=[{asset_id:'A-C1',item_supplier:'SSD — Umart',purchase_date:'${sep(RY)}',start_date:'${sep(RY)}',
    cost:280,treatment:'immediate',category:'Computers',work_pct:{'${RY}':100}},
   {asset_id:'A-C2',item_supplier:'Chair — Officeworks',purchase_date:'${sep(RY)}',start_date:'${sep(RY)}',
    cost:150,treatment:'immediate',category:'Furniture',work_pct:{'${RY}':100}}];
  activeYear='${RY}'; render();`, copyDom);
const cats = copyDom.DOM['#v-lodgment'].innerHTML;
const catCopies = (cats.match(/lodge-cat-amt[\s\S]*?copyVal\((\d+\.\d\d)\)/g) || [])
  .map(s => s.match(/copyVal\((\d+\.\d\d)\)/)[1]);
t('each category row carries its own copy button', catCopies.length===2,
  catCopies.length, 2);
t('and copies the category figure, not the label total',
  catCopies.includes('280.00') && catCopies.includes('150.00'), catCopies.join(','), '280.00,150.00');
t('the label total still copies the total', /copyVal\(430\.00\)/.test(cats), '', 'copyVal(430.00)');
// The button sits inside the head that toggles the row open, so it has to stop the click
// there. The pool-field buttons deliberately do not: they are in the body, which nothing
// toggles, and guarding them would state a rule that is not the rule.
t('copying a category never also toggles the row it sits in',
  (cats.match(/lodge-cat-amt[\s\S]{0,120}?event\.stopPropagation\(\);copyVal\(/g)||[]).length===2,
  (cats.match(/lodge-cat-amt[\s\S]{0,120}?event\.stopPropagation\(\);copyVal\(/g)||[]).length, 2);

const lockStore = {};
const sea1 = lockBoot(lockStore);
vm.runInContext(OPEN(inSeason(RY)), sea1);
t('in filing season the ledger opens locked', vm.runInContext('yearLocked',sea1)===true,
  vm.runInContext('yearLocked',sea1), true);
t('pinned to the return being lodged', vm.runInContext('activeYear',sea1)===RY,
  vm.runInContext('activeYear',sea1), RY);

// A lock you cannot get out of is a cage. Unlocking has to outlive the reload that would
// otherwise reapply it.
vm.runInContext('toggleYearLock();', sea1);
const sea2 = lockBoot(lockStore);
vm.runInContext(OPEN(inSeason(RY)), sea2);
t('unlocking survives a reload', vm.runInContext('yearLocked',sea2)===false,
  vm.runInContext('yearLocked',sea2), false);

const sea3 = lockBoot(lockStore);
vm.runInContext(OPEN(inSeason(NEXT)), sea3);
t('but a new reporting year re-arms it', vm.runInContext('yearLocked',sea3)===true,
  vm.runInContext('yearLocked',sea3), true);
t('on the year that has become due', vm.runInContext('activeYear',sea3)===NEXT,
  vm.runInContext('activeYear',sea3), NEXT);

const sea4 = lockBoot();
vm.runInContext(`M.years=[{year:'${PRIOR}'}];
  M.expenses=[{id:'q1',date:'${sep(PRIOR)}',supplier:'union',amount:600,work_pct:100,label:'D5'}];
  activeYear=null; render(); maybeAutoLock('${inSeason(RY)}');`, sea4);
t('nothing in the reporting year, so nothing is pinned',
  vm.runInContext('yearLocked',sea4)===false, vm.runInContext('yearLocked',sea4), false);

const sea5 = lockBoot();
vm.runInContext(OPEN(outSeason(RY)), sea5);
t('outside the window the ledger opens unlocked', vm.runInContext('yearLocked',sea5)===false,
  vm.runInContext('yearLocked',sea5), false);
t('still on the return being lodged', vm.runInContext('activeYear',sea5)===RY,
  vm.runInContext('activeYear',sea5), RY);

// A saved year is only worth restoring if it holds something: the picker offers five projected
// pool years, and one of those clicked once must not outrank the return being lodged forever.
const projStore = {};
const prj1 = lockBoot(projStore);
vm.runInContext(LAND + `M.assets=[{asset_id:'A-9',item_supplier:'laptop',
  purchase_date:'${RY.slice(0,4)}-08-01',cost:900,work_pct:80,treatment:'pool'}];
  activeYear=null; render(); setActiveYear('${vm.runInContext(`fyNext('${NEXT}')`, seaCtx)}');`, prj1);
const prj2 = lockBoot(projStore);
vm.runInContext(LAND + `M.assets=[{asset_id:'A-9',item_supplier:'laptop',
  purchase_date:'${RY.slice(0,4)}-08-01',cost:900,work_pct:80,treatment:'pool'}];
  activeYear=null; render(); restoreUI();`, prj2);
t('a projected year holding nothing is not restored over the filing year',
  vm.runInContext('activeYear',prj2)===RY, vm.runInContext('activeYear',prj2), RY);

/* ---- an import says where it went, and does not move you ---- */
const impCtx = lockBoot();
vm.runInContext(LAND + `activeYear='${NEXT}'; render();
  PLAN = planImport({schema:5, expenses:[{id:'n1',date:'${sep(RY)}',supplier:'Telstra',
    amount:120,work_pct:0,label:'D5'}]});
  SUM = planSummary(PLAN);
  applyImport(PLAN,'gmail.json'); render();`, impCtx);
const wantFY = 'FY ' + vm.runInContext(`fyLabel('${RY}')`, impCtx);
t('the import summary names the year it writes to',
  vm.runInContext('SUM.text',impCtx).includes(wantFY), vm.runInContext('SUM.text',impCtx), wantFY);
t('the banner records that year too',
  (vm.runInContext('lastImport.summary.years',impCtx)||[]).includes(RY),
  vm.runInContext('JSON.stringify(lastImport.summary.years)',impCtx), RY);
t('the view does not move to follow the rows',
  vm.runInContext('activeYear',impCtx)===NEXT, vm.runInContext('activeYear',impCtx), NEXT);
t('and the rows are in the ledger even though they are off screen',
  vm.runInContext('M.expenses.length',impCtx)===3, vm.runInContext('M.expenses.length',impCtx), 3);

console.log("\n" + R.pass + " passed, " + R.fail + " failed\n");
process.exit(R.fail ? 1 : 0);
