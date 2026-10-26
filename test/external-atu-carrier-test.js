#!/usr/bin/env node
'use strict';
// RF-sense external tuner carrier (N8JMS FTDX10, 2026-10-26): the tune put the
// radio in CW and sent a CAT transmit — key up, so no RF. It is AM now.
// Run: node test/external-atu-carrier-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
console.log('External ATU carrier');
const fnStart = main.indexOf('runExternalAtuTune = async function');
const fn = main.slice(fnStart, main.indexOf("ipcMain.on('external-atu-cancel'", fnStart));
test('the carrier mode is AM', () => {
  assert.ok(/const EXTERNAL_ATU_CARRIER_MODE = 'AM';/.test(main));
  assert.ok(/setModeOnly\(carrierMode, _currentFreqHz\)/.test(fn));
});
test('CW is never the tune carrier', () => {
  assert.ok(!/setModeOnly\('CW'/.test(fn) && !/setMode\('CW'\)/.test(fn), 'no CW mode set in the tune');
});
test('mode and power are still restored', () => {
  assert.ok(/setModeOnly\(restoreMode, _currentFreqHz\)/.test(fn) && /gatedSetTxPower\(restorePower\)/.test(fn));
});
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
