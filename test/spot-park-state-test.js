#!/usr/bin/env node
'use strict';
/**
 * A park spanning several states: the activator's own spot says which one
 * (POTA spot locationCode, "US-UT"), so POTACAT stops asking (N0KAH
 * 2026-10-28: "it asks you to fill in the state ... and of course I never
 * remember to ask").
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Q = require('../lib/qso-expand');

const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
const TRAIL = ['CA', 'NV', 'UT', 'WY', 'NE', 'KS', 'MO', 'CO'];   // US-4578, 8 states
const spot = (o) => ({ source: 'pota', reference: 'US-4578', callsign: 'N7XXX', locationCode: 'US-UT', spotTime: '2026-10-28T01:15:00Z', ...o });

console.log('The rule');
check('the activator\'s spot names the state: no question', () => {
  assert.strictEqual(Q.spotStateFor([spot()], 'US-4578', 'N7XXX', TRAIL), 'UT');
  assert.strictEqual(Q.spotStateFor([spot()], 'us-4578', 'N7XXX/P', TRAIL), 'UT', 'a portable suffix is the same activator');
});
check('the newest spot wins when they move on the trail', () => {
  const s = [spot({ locationCode: 'US-NV', spotTime: '2026-10-28T00:10:00Z' }), spot()];
  assert.strictEqual(Q.spotStateFor(s, 'US-4578', 'N7XXX', TRAIL), 'UT');
});
check('still ask: another activator, no locationCode, a state not in the park, a one-state park', () => {
  assert.strictEqual(Q.spotStateFor([spot({ callsign: 'K1ABC' })], 'US-4578', 'N7XXX', TRAIL), '');
  assert.strictEqual(Q.spotStateFor([spot({ locationCode: '' })], 'US-4578', 'N7XXX', TRAIL), '');
  assert.strictEqual(Q.spotStateFor([spot({ locationCode: 'US-TX' })], 'US-4578', 'N7XXX', TRAIL), '');
  assert.strictEqual(Q.spotStateFor([spot()], 'US-4578', 'N7XXX', ['UT']), '', 'one state needs no question');
  assert.strictEqual(Q.spotStateFor([spot({ source: 'cluster' })], 'US-4578', 'N7XXX', TRAIL), '');
});
check('the picked state lands in the record\'s STATE', () => {
  const recs = Q.expandContact({ callsign: 'N7XXX', sig: 'POTA', sigInfo: 'US-4578', parkState: 'US-4578:UT', mode: 'CW', qsoAt: Date.parse('2026-10-28T01:20:00Z') }, {
    myRefs: [], callInfo: () => null, parkInfo: () => ({ states: TRAIL, grid: '' }),
  });
  assert.strictEqual(recs[0].state, 'UT');
});

console.log('Wiring');
const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'renderer/app.js'), 'utf8');
check('POTA spots keep locationCode', () => {
  assert.ok(/locationCode: \/\^\[A-Z\]\{2\}-\[A-Z0-9\]\{1,3\}\$\/i\.test\(String\(s\.locationCode/.test(main));
});
check('every log path: logContact fills a missing park state from the spot, per park', () => {
  const lc = main.slice(main.indexOf('async function logContact('), main.indexOf('const records = QsoExpand.expandContact(e, {'));
  assert.ok(/if \(!e\.parkState && e\.sigInfo\)/.test(lc) && /spotParkState\(ref, firstCall\)/.test(lc) && /e\.parkState = picks\.join\(','\)/.test(lc));
});
check('both desktop log forms ask only when no spot says', () => {
  const n = (app.match(/const fromSpot = states\.length > 1 && window\.api\.spotParkState \? await window\.api\.spotParkState\(potaRef, callsigns\[0\]\) : '';/g) || []).length;
  assert.strictEqual(n, 2);
  assert.strictEqual((app.match(/else if \(states\.length > 1\) parkState = await promptParkState\(/g) || []).length, 2);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
