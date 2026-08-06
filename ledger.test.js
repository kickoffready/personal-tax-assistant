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
  return { innerHTML:"", textContent:"", value:"", className:"", hidden:false,
    classList:{ toggle(){}, add(){}, remove(){} }, addEventListener(){},
    children:[], click(){}, appendChild(){}, removeChild(){}, closest(){ return null; } };
}

/** A fresh page load. `store` persists across boots to simulate a reload. */
function boot(store = {}, refuseStorage = false) {
  const ctx = {
    console, setTimeout, t: assert, near,
    document: { querySelector: stubEl, querySelectorAll: () => [], createElement: stubEl,
      body: { appendChild(){}, removeChild(){} }, addEventListener(){} },
    window: { addEventListener(){} },
    localStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { if (refuseStorage) throw new Error("QuotaExceededError"); store[k] = v; },
      removeItem: k => { delete store[k]; }
    },
    navigator: {}, alert: () => {}, confirm: () => true,
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
t('schema bumped to 2', leg.schema===2, leg.schema, 2);
t('expense 0.7 becomes 70', leg.expenses[0].work_pct===70, leg.expenses[0].work_pct, 70);
t('per-year 0.8 becomes 80', leg.assets[0].work_pct['2024-25']===80, leg.assets[0].work_pct['2024-25'], 80);
t('a scalar 0.25 becomes 25', leg.assets[1].work_pct===25, leg.assets[1].work_pct, 25);
t('migrating twice changes nothing', migrate(leg).expenses[0].work_pct===70, migrate(leg).expenses[0].work_pct, 70);
t('a schema 2 file is left alone', migrate({schema:2,expenses:[{work_pct:70}]}).expenses[0].work_pct===70,
  migrate({schema:2,expenses:[{work_pct:70}]}).expenses[0].work_pct, 70);

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
t('later years say where the claim went', poolClaimCell(M.assets[0]).includes('in pool'),'in pool','in pool');
activeYear='2025-26';
M.assets[0].work_pct={'2025-26':0}; P=derive();
t('a 0% asset adds nothing to the pool', P.pool['2025-26'].deduction===0, P.pool['2025-26'].deduction, 0);

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
activeYear='2025-26'; fileName=null;

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

console.log('\\n— storage unavailable (Safari private / file:// quota)');
delete store['tax-ledger-autosave-v1'];
let s6=bootWith(true); // setItem always throws
vm.runInContext(`M.assets.push({asset_id:'A-3',description:'y',purchase_date:'2025-08-01',cost:500,treatment:'pool'}); touch();`,s6);
t('storage failure is detected', vm.runInContext('autosaveOK',s6)===false,
  vm.runInContext('autosaveOK',s6),'false');
t('the app keeps working without a net',
  vm.runInContext('M.assets.length',s6)===1, vm.runInContext('M.assets.length',s6),1);


console.log("\n" + R.pass + " passed, " + R.fail + " failed\n");
process.exit(R.fail ? 1 : 0);
