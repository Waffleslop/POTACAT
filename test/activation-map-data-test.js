#!/usr/bin/env node
'use strict';
// The phone's activation recap asks the desktop to place contacts; the reply
// now carries what the LOG says (state, grid, band), never a call-area guess
// as a state (NA4DQ 2026-10-24). Run: node test/activation-map-data-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { logDetailsFor } = require('../lib/activation-map-data');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

const recs = [
  { CALL: 'K1ABC', QSO_DATE: '20260101', TIME_ON: '1200', STATE: 'CT', GRIDSQUARE: 'FN31', BAND: '40M', FREQ: '7.200', MY_SIG_INFO: 'US-0001' },
  { CALL: 'K1ABC', QSO_DATE: '20261024', TIME_ON: '1800', STATE: 'MA', GRIDSQUARE: 'FN42', BAND: '20M', FREQ: '14.285', MY_SIG_INFO: 'US-7589' },
  { CALL: 'K1ABC', QSO_DATE: '20261025', TIME_ON: '0100', STATE: 'NH', GRIDSQUARE: 'FN43', BAND: '20M', MY_SIG_INFO: 'US-0002' },
  { CALL: 'W9XYZ', QSO_DATE: '20261024', TIME_ON: '181500', BAND: '40M', FREQ: '7.180' },
  { CALL: 'N0NE', QSO_DATE: '20261024', TIME_ON: '1820', STATE: 'MN' },
];

test('a record logged at this park wins over a newer one elsewhere', () => {
  const m = logDetailsFor(recs, ['k1abc'], 'US-7589');
  assert.deepStrictEqual(m.get('K1ABC'), { state: 'MA', gridsquare: 'FN42', band: '20m', freq: '14.285' });
});

test('without a park match, the newest record', () => {
  const m = logDetailsFor(recs, ['K1ABC'], 'US-9999');
  assert.strictEqual(m.get('K1ABC').state, 'NH');
});

test('only fields the record holds; calls not asked for are left out', () => {
  const m = logDetailsFor(recs, ['W9XYZ', 'NOTLOGGED'], 'US-7589');
  assert.deepStrictEqual(m.get('W9XYZ'), { band: '40m', freq: '7.180' });
  assert.ok(!m.has('NOTLOGGED') && !m.has('N0NE'));
});

test('multi-park refs: a comma list in MY_SIG_INFO matches its park', () => {
  const m = logDetailsFor([{ CALL: 'K2X', QSO_DATE: '20261024', STATE: 'NY', MY_SIG_INFO: 'US-0001,US-7589' }], ['K2X'], 'us-7589');
  assert.strictEqual(m.get('K2X').state, 'NY');
});

test('wiring: the reply places by a logged grid first and never takes a state from the call area', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8').replace(/\r\n/g, '\n');
  const at = main.indexOf("remoteServer.on('get-activation-map-data'");
  const h = main.slice(at, main.indexOf("remoteServer.on('get-all-qsos'", at));
  assert.ok(/ActivationMapData\.logDetailsFor\(parseAllRawQsos\(logPath\)/.test(h));
  assert.ok(h.indexOf('gridToLatLon(grid)') < h.indexOf('resolveCallsign('), 'grid before cty.dat');
  assert.ok(/\.\.\.\(logged\.state \? \{ state: logged\.state \} : \{\}\)/.test(h), 'state only from the log');
  assert.ok(!/state: (entity|loc|area)/.test(h), 'no state from the call area');
});

console.log(`\nActivation map data: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
