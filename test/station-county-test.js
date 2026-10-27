#!/usr/bin/env node
'use strict';
/**
 * The operator's own state and county on each contact (MY_STATE / MY_CNTY),
 * for LoTW and other loggers (AE5JE 2026-10-27). Not one pair of fields
 * stamped on everything: an activation takes the county chosen for that
 * park, anything else the home county, and only from the home grid.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const SC = require('../lib/station-county');
const { buildAdifFields } = require('../lib/adif-writer');
const { splitForLotw } = require('../lib/lotw-split');

const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
const COUNTIES = require('../assets/geo/us-counties.json').states;

console.log('The county list (TQSL, as LoTW spells it)');
check('every state, with LoTW\'s spellings', () => {
  assert.strictEqual(Object.keys(COUNTIES).length, 50);
  assert.strictEqual(SC.knownCounty(COUNTIES, 'va', 'fairfax'), 'Fairfax');
  assert.ok(COUNTIES.LA.length > 60, 'Louisiana parishes');
  assert.strictEqual(SC.knownCounty(COUNTIES, 'VA', 'Nowhere'), '');
  const lic = fs.readFileSync(path.join(ROOT, 'assets/geo/LICENSE'), 'utf8');
  assert.ok(/American Radio Relay League/.test(lic) && /us-counties\.json/.test(lic), 'TQSL notice travels with the data');
});

console.log('The rule');
const home = { state: 'VA', county: 'Fairfax', grid: 'FM18lv' };
const parks = { 'US-1234': { state: 'VA', county: 'Loudoun' }, 'US-9999': { state: 'MD', county: 'Frederick' } };
const ctx = { home, parkCounty: (r) => parks[r] || null };
check('a home contact takes the home state and county', () => {
  assert.deepStrictEqual(SC.stationLocationFor({}, ctx), { myState: 'VA', myCounty: 'VA,Fairfax' });
  assert.deepStrictEqual(SC.stationLocationFor({ myGridsquare: 'FM18ab' }, ctx), { myState: 'VA', myCounty: 'VA,Fairfax' }, 'same 4-char grid');
});
check('a contact from another grid gets neither, never the wrong county', () => {
  assert.deepStrictEqual(SC.stationLocationFor({ myGridsquare: 'EM73' }, ctx), {});
});
check('an activation takes the county chosen for THAT park, never the home one', () => {
  assert.deepStrictEqual(SC.stationLocationFor({ mySigInfo: 'US-1234' }, ctx), { myState: 'VA', myCounty: 'VA,Loudoun' });
  assert.deepStrictEqual(SC.stationLocationFor({ mySigInfo: 'US-5555' }, ctx), {}, 'no choice yet: nothing, not home');
  assert.deepStrictEqual(SC.stationLocationFor({ mySigInfo: 'US-5555,US-1234' }, ctx), { myState: 'VA', myCounty: 'VA,Loudoun' }, 'an n-fer finds the choice on any of its parks');
});
check('what a logging path supplied is kept; a county is only true with its own state', () => {
  assert.deepStrictEqual(SC.stationLocationFor({ myState: 'VA', myCounty: 'VA,Arlington' }, ctx), {});
  assert.deepStrictEqual(SC.stationLocationFor({ mySigInfo: 'US-9999', myState: 'PA' }, ctx), {}, 'park choice is MD, record says PA: no county');
  assert.deepStrictEqual(SC.stationLocationFor({}, { home: { state: '', county: 'Fairfax' } }), {}, 'no home state: nothing');
});
check('values in ADIF shape', () => {
  assert.strictEqual(SC.countyValue('va', 'Fairfax'), 'VA,Fairfax');
  assert.strictEqual(SC.countyValue('VA', ''), '');
  assert.deepStrictEqual(SC.parseCountyValue('VA, Fairfax'), { state: 'VA', county: 'Fairfax' });
  assert.strictEqual(SC.isUsParkRef('US-1234'), true);
  assert.strictEqual(SC.isUsParkRef('K-0001'), true);
  assert.strictEqual(SC.isUsParkRef('VE-0001'), false);
});

console.log('Records and LoTW');
check('the record carries MY_CNTY', () => {
  const f = buildAdifFields({ callsign: 'W1AW', frequency: '14074', mode: 'FT8', myState: 'VA', myCounty: 'VA,Fairfax' });
  assert.strictEqual(f.MY_CNTY, 'VA,Fairfax');
  assert.strictEqual(f.MY_STATE, 'VA');
});
check('the home LoTW batch leaves state and county to the TQSL Station Location', () => {
  const { home: h } = splitForLotw([{ CALL: 'W1AW', MY_STATE: 'VA', MY_CNTY: 'VA,Fairfax', STATION_CALLSIGN: 'K3SBP' }], { myCallsign: 'K3SBP' });
  assert.strictEqual(h.length, 1);
  assert.ok(!('MY_STATE' in h[0]) && !('MY_CNTY' in h[0]), 'TQSL would refuse a batch whose records disagree with the location');
});
check('an activation batch is signed with its county, one batch per county', () => {
  const recs = [
    { CALL: 'W1AW', MY_POTA_REF: 'US-1234', MY_GRIDSQUARE: 'FM18', MY_STATE: 'VA', STATION_CALLSIGN: 'K3SBP', QSO_DATE: '20261027' },
    { CALL: 'W1AX', MY_POTA_REF: 'US-1234', MY_GRIDSQUARE: 'FM18', MY_STATE: 'VA', MY_CNTY: 'VA,Fairfax', STATION_CALLSIGN: 'K3SBP', QSO_DATE: '20261028' },
  ];
  const { activations } = splitForLotw(recs, { myCallsign: 'K3SBP', fill: () => ({ MY_CNTY: 'VA,Loudoun' }) });
  assert.strictEqual(activations.length, 2, 'Loudoun (filled) and Fairfax (supplied) are two batches');
  const l = activations.find((b) => b.county === 'VA,Loudoun');
  assert.ok(l && l.records[0].MY_CNTY === 'VA,Loudoun' && /Loudoun/.test(l.label));
  assert.ok(activations.find((b) => b.county === 'VA,Fairfax'), 'a supplied county is never overwritten');
});

console.log('Wiring');
const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'renderer/app.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'renderer/index.html'), 'utf8');
check('every log path and the LoTW upload fill through stationLocationFillFor', () => {
  assert.ok(/Object\.assign\(qsoData, stationLocationFillFor\(qsoData, ops\)\);/.test(main), 'saveQsoRecord, with the operator\'s own settings (Log as)');
  assert.ok(/return \{ MY_GRIDSQUARE: f\.myGridsquare, MY_STATE: f\.myState, MY_CNTY: f\.myCounty \};/.test(main), 'LoTW fill');
  assert.ok(/home: \{ state: s\.homeState, county: s\.homeCounty, grid: s\.grid \}/.test(main));
});
check('a park county is only one LoTW knows, remembered per park', () => {
  const fn = main.slice(main.indexOf('function setParkCounty('), main.indexOf('function setParkCounty(') + 1200);
  assert.ok(/StationCounty\.knownCounty\(usCounties\(\)/.test(fn) && /settings\.parkCounties\[r\] = \{ state: st, county: c \}/.test(fn));
  for (const ch of ["'county-list'", "'park-county-get'", "'park-county-set'", "'home-county-from-qrz'"]) assert.ok(main.includes('ipcMain.handle(' + ch), ch);
});
check('Settings > Station has the home fields; the activation bar asks the park county', () => {
  assert.ok(/id="set-home-state"/.test(html) && /id="set-home-county"/.test(html) && /id="home-county-qrz"/.test(html));
  assert.ok(/id="activator-county"/.test(html) && /id="activator-county-state"/.test(html));
  assert.ok(/homeState: \(document\.getElementById\('set-home-state'\)/.test(app) && /homeCounty: \(document\.getElementById\('set-home-county'\)/.test(app), 'saved');
  const badge = app.slice(app.indexOf('function updateParkExtraBadge('), app.indexOf('function updateParkExtraBadge(') + 700);
  assert.ok(/refreshActivatorCounty\(\);/.test(badge), 'follows every change to the activation\'s parks');
});

check('a device chooses the park county too, and sees the choice and the list', () => {
  const rs = fs.readFileSync(path.join(ROOT, 'lib/remote-server.js'), 'utf8');
  assert.ok(/'park-county'\]/.test(rs), 'capability');
  assert.ok(/county: msg\.county && typeof msg\.county === 'object'/.test(rs));
  assert.ok(/const r = setParkCounty\(refs\[0\], county\.state, county\.county, 'ECHOCAT device'\);/.test(main));
  assert.ok(/\.\.\.activatorCountyState\(parkRefs\[0\] && parkRefs\[0\]\.ref\),/.test(main), 'activator-state carries county + countyChoices');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
