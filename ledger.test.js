#!/usr/bin/env node
/**
 * Tests for personal/ledger.html          run:  node personal/ledger.test.js
 *
 * No dependencies, no framework. The ledger is a single HTML file with no build
 * step, so these tests extract its <script> block and run it in a vm with just
 * enough DOM stubbed for the engine to work. Exits non-zero on any failure.
 *
 * These assertions are the reason to trust the arithmetic. Every rule they check
 * is sourced in personal/RULES.md — when a rate changes, update it there, update
 * the constant, and expect a test here to fail until you update it too.
 */

const fs = require("fs");
const vm = require("vm");
const path = require("path");

const code = fs.readFileSync(path.join(__dirname, "ledger.html"), "utf8")
  .match(/<script>([\s\S]*)<\/script>/)[1];

const R = { pass: 0, fail: 0 };
const near = (a, b, tol = 0.01) => Math.abs(a - b) <= tol;
function assert(name, cond, got, want) {
  if (cond) { R.pass++; console.log("  ok   " + name); }
  else { R.fail++; console.log("  FAIL " + name + "\n         got " + got + "  want " + want); }
}

function stubEl() {
  return { innerHTML:"", textContent:"", value:"", className:"", hidden:false, disabled:false,
    classList:{ toggle(){}, add(){}, remove(){} }, addEventListener(){}, setAttribute(){},
    children:[], click(){}, appendChild(){}, removeChild(){}, closest(){ return null; } };
}

/**
 * A fresh page load. `store` persists across boots to simulate a reload.
 * `memoDom` returns the same stub for a given selector every time, so a test can read
 * back what a render function wrote. Off by default — most tests want a blank element.
 */
function boot(store = {}, refuseStorage = false, memoDom = false) {
  const els = {};
  const pick = sel => memoDom ? (els[sel] = els[sel] || stubEl()) : stubEl();
  const ctx = {
    console, setTimeout, t: assert, near, DOM: els,
    document: { querySelector: pick, querySelectorAll: () => [], createElement: stubEl,
      body: { appendChild(){}, removeChild(){} }, addEventListener(){} },
    window: { addEventListener(){} },
    localStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { if (refuseStorage) throw new Error("QuotaExceededError"); store[k] = v; },
      removeItem: k => { delete store[k]; }
    },
    navigator: {}, alert: () => {}, confirm: () => true,
    // Set PROMPT_REPLY from inside a test to answer the next prompt(); reading it off
    // the context is what lets an engine test drive a dialog the page opens.
    PROMPT_REPLY: "", prompt: () => ctx.PROMPT_REPLY,
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
  .forEach(([c,w])=>t('$'+c+' → '+w, treatmentFor(c)===w, treatmentFor(c), w));

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
t('schema bumped to 3', leg.schema===3, leg.schema, 3);
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
M.expenses.find(e=>e.id==='b2').work_pct = 40;
t('a hand-edited charge shows the group as mixed',
  groupExpenses(M.expenses.filter(e=>fyOf(e.date)==='2025-26')).find(g=>g.key==='Optus').pcts.length===2,
  'mixed','mixed');

console.log('\\n— treatment is computed, and only deliberately overridden');
setModel({years:[{year:'2025-26'}], assets:[{asset_id:'A-T',description:'dock',
  purchase_date:'2025-08-01',cost:500,treatment:'pool',work_pct:{'2025-26':100}}]});
activeYear='2025-26'; derive();
t('the row shows a pill, not a dropdown',
  treatmentCell(M.assets[0]).includes('pill') && !treatmentCell(M.assets[0]).includes('<select'),'pill','pill');
setTreatment('A-T','schedule');
t('an override is recorded as deliberate', M.assets[0].treatment_locked===true, M.assets[0].treatment_locked, true);
t('the row says it was set by hand', treatmentCell(M.assets[0]).includes('set by hand'),'flagged','flagged');
resetTreatment('A-T');
t('reset returns to the computed value', M.assets[0].treatment==='pool', M.assets[0].treatment,'pool');
t('reset clears the lock', M.assets[0].treatment_locked===undefined, M.assets[0].treatment_locked,'undefined');
setTreatment('A-T','pool');
t('choosing the computed value is not an override', M.assets[0].treatment_locked===false,
  M.assets[0].treatment_locked, false);
t('cost change moves an un-overridden treatment',
  (setField('assets','A-T','cost',2400), M.assets[0].treatment==='schedule'), M.assets[0].treatment,'schedule');

console.log('\\n— a pooled asset claims at D6, and says so');
setModel({years:[{year:'2025-26'},{year:'2026-27'}], assets:[{asset_id:'A-D',description:'Dell',
  purchase_date:'2025-11-24',cost:310.32,treatment:'pool',work_pct:{'2025-26':100}}]});
activeYear='2025-26'; let P=derive();
t('year one is 18.75% of what went in', near(P.pool['2025-26'].deduction,58.19), P.pool['2025-26'].deduction.toFixed(2),'58.19');
t('it reaches the return at D6', near(P.lodgment['2025-26'].deductions.D6.total,58.19),
  P.lodgment['2025-26'].deductions.D6.total.toFixed(2),'58.19');
t('the asset row shows its share, not a dash', poolClaimCell(M.assets[0]).includes('58.19'),'58.19','58.19');
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
  expenses:[{id:'e3',date:'2025-09-01',description:'water bill',amount:200,work_pct:20,label:'D5'},
            {id:'e4',date:'2025-09-01',description:'internet',supplier:'telco',amount:900,work_pct:70,label:'D5'}],
  income:[{id:'i1',type:'foreign',date:'2025-09-01',holding:'X',gross_foreign:100,fx_rate:1.47},
          {id:'i2',type:'foreign',date:'2025-10-01',holding:'Y',gross_foreign:100,fx_rate:0.68}]});
D=derive(); const w=D.warnings.map(x=>x.title).join(' | ');
[[/expensed immediately/,'over-$300 expensed immediately'],
 [/outside the permitted/,'water flagged as non-qualifying'],
 [/covered by the 70c/,'fixed-rate double-dip flagged'],
 [/both sides of 1\\.0/,'mixed FX conventions flagged'],
 [/omits the Medicare levy/,'bare marginal rate flagged']]
 .forEach(([re,name])=>t(name, re.test(w), '', 'flag'));

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

console.log('\\n— nothing appears for a year you have not created');
setModel({years:[{year:'2025-26'}],assets:[{asset_id:'A-Y',description:'iPhone',
  purchase_date:'2026-02-15',cost:2164,treatment:'schedule',effective_life:3,
  method:'prime_cost',work_pct:{'2025-26':70}}]});
D=derive();
t('one year in the model = one row', D.dep.length===1, D.dep.length, 1);


`;
vm.runInContext(code + "\n;\n" + ENGINE_TESTS, boot());

/* ============================================================
   Crash recovery — needs a localStorage that survives reloads.
   ============================================================ */
const store = {};
const bootWith = refuse => { const c = boot(store, refuse); vm.runInContext(code, c); return c; };
const t = assert;  // the crash assertions below run at module scope
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
  ["#v-expenses", "renderExpenses", ["e-date", "e-desc", "e-sup", "e-amt", "e-wp", "e-cat", "e-basis"]],
  ["#v-assets",   "renderAssets",   ["a-desc", "a-sup", "a-date", "a-cost", "a-wp", "a-cat"]],
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

// The basis is the field that survives an audit; it has to be enterable at the moment
// you still remember the answer, not only afterwards on the row.
const ex = boot({}, false, true);
vm.runInContext(code, ex);
vm.runInContext(`
  DOM_SET = (s, v) => { document.querySelector(s).value = v; };
  DOM_SET('#e-amt', '42'); DOM_SET('#e-desc', 'router');
  DOM_SET('#e-sup', 'Netgear'); DOM_SET('#e-basis', 'shared with the home office');
  addExpense();
`, ex);
t('the entry row can set a basis',
  vm.runInContext("M.expenses[M.expenses.length-1].basis", ex) === 'shared with the home office',
  vm.runInContext("M.expenses[M.expenses.length-1].basis", ex), 'shared with the home office');
t('and clears it for the next entry',
  vm.runInContext("document.querySelector('#e-basis').value", ex) === "",
  vm.runInContext("document.querySelector('#e-basis').value", ex), '""');

console.log("\n" + R.pass + " passed, " + R.fail + " failed\n");
process.exit(R.fail ? 1 : 0);
