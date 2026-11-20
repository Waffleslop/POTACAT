#!/usr/bin/env node
'use strict';
// The radio's GPS wiring (source text): both beacons ask lib/aprs-position.js,
// the GPS state reaches the APRS window and Settings, and the Settings grid
// changes only when the operator presses the offer.
// Run: node test/flex-gps-wiring-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const main = read('main.js');
const app = read('renderer/app.js');
const html = read('renderer/index.html');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

test('the beacon position comes from the one provider, with the GPS state', () => {
  assert.match(main, /function aprsBeaconPosition\(\) \{[\s\S]{0,200}AprsPosition\.beaconPositionFrom\(\{ source: st\.source, gps: flexGps,/);
});

test('both beacons pass the provider refusal as their sentence (no fallback to another position)', () => {
  const uses = main.match(/lat: pos\.ok \? pos\.lat : null, lon: pos\.ok \? pos\.lon : null, positionSentence: pos\.ok \? '' : pos\.sentence/g) || [];
  assert.strictEqual(uses.length, 2, 'buildBeacon (APRS-IS) and buildRfBeacon (radio)');
  assert.ok(!/pos \? pos\.lat/.test(main), 'no caller treats the provider result as a bare point');
});

test('smartsdr gps events keep the latest state; a dropped radio clears it', () => {
  assert.match(main, /smartSdr\.on\('gps', \(s\) => flexGpsSet\(s\)\)/);
  assert.match(main, /smartSdr\.on\('disconnected', \(\) => flexGpsSet\(null\)\)/);
});

test('the GPS state goes to the APRS window and Settings only (not the ECHOCAT tap)', () => {
  assert.match(main, /aprsWin\.webContents\.send\('aprs-gps', p\)/);
  assert.match(main, /win\.webContents\.send\('flex-gps', p\)/);
  assert.ok(!/aprsWinSend\('aprs-gps'/.test(main));
  assert.match(main, /ipcMain\.handle\('flex-gps-get'/);
});

test('Settings: the GPS grid is an offer the operator presses, never set by itself', () => {
  assert.match(html, /id="set-grid-from-gps" class="hidden"/);
  const sets = app.match(/setGrid\.value = g\.grid/g) || [];
  assert.strictEqual(sets.length, 1, 'one place fills the grid from the GPS');
  const at = app.indexOf('setGrid.value = g.grid');
  const before = app.slice(Math.max(0, at - 300), at);
  assert.match(before, /gpsBtn\.addEventListener\('click'/, 'and it is the button press');
  assert.ok(!/settings\.grid\s*=[^=][^\n]*(gps|Gps)/.test(main), 'main never writes the grid from the GPS');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
