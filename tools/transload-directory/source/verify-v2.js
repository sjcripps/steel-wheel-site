#!/usr/bin/env node
// Verification harness for the STAGED transload directory v2 artifact.
// Run from tools/transload-directory/:  node source/verify-v2.js
const fs = require('fs');
let fails = 0;
const ok = (cond, msg, extra='') => { console.log((cond?'PASS':'FAIL') + ' | ' + msg + (extra?' | '+extra:'')); if(!cond) fails++; };

const d = JSON.parse(fs.readFileSync('data/transload-v2.json','utf8'));
const fac = d.facilities;
const tiers = {};
fac.forEach(f => tiers[f.tier] = (tiers[f.tier]||0)+1);
ok(d.version === 2, 'json version 2');
ok(fac.length === (tiers.verified||0)+(tiers.listed||0)+(tiers.review||0), 'tier counts sum to total', JSON.stringify(tiers)+' total='+fac.length);
ok(tiers.verified === 709 && tiers.review === 88 && tiers.listed === 1672, 'expected tier counts 709/88/1672');

const keys = new Set(); let dup = 0;
fac.forEach(f => { const k = [f.name.toUpperCase(), f.city.toUpperCase(), f.state, (f.note||'').toUpperCase()].join('|'); if (keys.has(k)) dup++; keys.add(k); });
ok(dup === 0, 'no duplicate name+city+state(+note) pairs', 'dupes='+dup);

const VALID = new Set(`AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC AB BC MB NB NL NS NT NU ON PE QC SK YT AGU BCN BCS CAM CHH CHP COA COL DUR GRO GUA HID JAL MEX MIC MOR NAY NLE OAX PUE QUE ROO SIN SLP SON TAB TAM TLA VER YUC ZAC CMX MX BJ DF EM GJ HG JA MH PQ QA SL SO TM VL`.split(/\s+/));
const badStates = [...new Set(fac.filter(f=>!VALID.has(f.state)).map(f=>f.state))];
ok(badStates.length === 0, 'all state codes valid', badStates.join(','));

const tx = fac.filter(f => f.name.toLowerCase().includes('transloadx'));
ok(tx.length === 1 && tx[0].city === 'Framingham' && tx[0].state === 'MA' && tx[0].tier === 'listed', 'TransloadX (Framingham MA) present as listed');

const closures = fs.readFileSync('source/closures-v2.csv','utf8').trim().split('\n').slice(1);
ok(closures.length === 15, '15 rows in closures archive', 'got '+closures.length);
const closedKeys = closures.map(l => { const c = l.split(','); return (c[0]+'|'+c[2]+'|'+c[3]).toUpperCase(); });
const facSimple = new Set(fac.map(f => (f.name+'|'+f.city+'|'+f.state).toUpperCase()));
const leaked = closedKeys.filter(k => facSimple.has(k));
ok(leaked.length === 0, 'no permanently-closed facility leaked into v2', leaked.join(';'));

ok(!fac.some(f => f.name.toLowerCase().includes('casco')), 'Casco Bay rows excluded from v2 JSON');
const pending = fs.readFileSync('source/pending-rows-v2.csv','utf8');
ok(pending.includes('Casco Bay Rail Holdings') && pending.includes('pending-verification') && pending.includes('PORTLAND') && pending.includes('AUBURN'), 'Casco Bay placeholders staged (Portland + Auburn ME, pending-verification)');

const storVals = [...new Set(fac.map(f=>f.storage))];
ok(storVals.every(v => ['yes','no','unknown'].includes(v)), 'railcar storage values valid', storVals.join(','));
ok(fac.some(f=>f.storage==='yes'), 'at least one railcar_storage=yes row');
ok(fac.filter(f=>f.tier==='listed').every(f=>f.caps_known===false), 'all listed rows carry caps_known=false');

const html = fs.readFileSync('index-v2.html','utf8');
ok(html.includes('/data/transload-v2.json'), 'page fetches v2 JSON');
ok(html.includes('id="tierVerified"') && html.includes('id="tierListed"'), 'tier filter controls present');
ok(html.includes('isVerified(f) && !showVerified'), 'tier filter logic wired into applyFilters');
ok(html.includes('id="storageFilter"') && html.includes("(f.storage || 'unknown') !== storage"), 'storage filter wired');
ok(html.includes('tier-pill tier-verified') && html.includes('tier-pill tier-listed') && html.includes('tier-legend'), 'tier badges + legend present');
ok(html.includes('/contact?subject=Transload%20directory%20listing'), 'get-listed CTA present');
ok(html.includes('2,400+'), 'facility count copy updated to 2,400+');
ok(!html.includes('800+'), 'no stale 800+ copy left');
ok(!/intermodal/i.test(html), 'no "intermodal" (brand rule)');
ok(!/guarantee|binding quote/i.test(html), 'no guarantee/binding-quote language');
ok(html.includes('Not yet verified'), 'unknown capabilities labeled, render as dash');

const sim = (q, tierV, tierL, storage) => fac.filter(f => {
  const isV = f.tier === 'verified';
  if (isV && !tierV) return false;
  if (!isV && !tierL) return false;
  if (storage && (f.storage||'unknown') !== storage) return false;
  if (q) { const hay = (f.name+' '+f.city+' '+(f.note||'')).toLowerCase(); if (!hay.includes(q)) return false; }
  return true;
});
ok(sim('transloadx', true, true, '').length === 1, 'search simulation: "transloadx" finds exactly 1');
ok(sim('', true, false, '').length === (tiers.verified||0), 'tier simulation: verified-only matches verified count');
ok(sim('', false, true, '').length === (tiers.listed||0)+(tiers.review||0), 'tier simulation: listed-only = listed+review');
ok(sim('', true, true, 'yes').length === 1, 'storage simulation: yes = 1');
ok(sim('duie', true, true, '').length === 2, 'search simulation: "duie" finds both A Duie Pyle rows', 'got '+sim('duie',true,true,'').length);

const api = fs.readdirSync('/home/ubuntu/projects/steel-wheel-site/api').filter(f => !f.startsWith('_') && f.endsWith('.ts'));
ok(api.length === 12, 'serverless function count still 12', 'got '+api.length);

const v1json = JSON.parse(fs.readFileSync('data/transload.json','utf8'));
ok(v1json.version === 1 && v1json.facilities.length > 0, 'v1 transload.json intact', 'v1 facilities='+v1json.facilities.length);
ok(fs.readFileSync('index.html','utf8').includes('/data/transload.json'), 'v1 index.html still points at v1 data');

console.log(fails === 0 ? '\nALL CHECKS PASSED' : `\n${fails} CHECK(S) FAILED`);
process.exit(fails ? 1 : 0);
