#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
// The TX power a contact is logged at: the radio's (read or as POTACAT set
// it), else the operator's own entry or default, else empty. Never a guessed
// 100 W (#523: TS-590SG and TS-2000 owners, whose power is not read, had every
// QSO logged at 100 W).
// Run: node test/log-tx-power-test.js
const assert = require('assert');
const path = require('path');
const { txPowerForLog, operatorDefaultPower, positiveWatts } = require('../lib/log-tx-power');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

test('nothing known and no default: empty, not 100 W (#523)', () => {
  assert.strictEqual(txPowerForLog({}), null);
  assert.strictEqual(txPowerForLog({ knownW: 0, enteredW: 0, defaultW: 0 }), null);
  assert.strictEqual(txPowerForLog(null), null);
  assert.strictEqual(txPowerForLog({ knownW: NaN, enteredW: '', defaultW: undefined }), null);
});

test('the radio\'s power (read or set by POTACAT) comes first', () => {
  assert.strictEqual(txPowerForLog({ knownW: 5, enteredW: 50, defaultW: 100 }), 5);
  assert.strictEqual(txPowerForLog({ knownW: '10', defaultW: 100 }), 10);
  assert.strictEqual(txPowerForLog({ knownW: 2.5 }), 2.5);
});

test('then the operator\'s typed entry, then their own default', () => {
  assert.strictEqual(txPowerForLog({ knownW: 0, enteredW: 20, defaultW: 100 }), 20);
  assert.strictEqual(txPowerForLog({ knownW: 0, enteredW: 0, defaultW: 15 }), 15);
});

test('the old untouched Settings 100 is not the operator\'s default', () => {
  assert.strictEqual(operatorDefaultPower({ defaultPower: 100 }), 0);
  assert.strictEqual(operatorDefaultPower({ defaultPower: '100' }), 0);
  assert.strictEqual(operatorDefaultPower({}), 0);
  assert.strictEqual(operatorDefaultPower(null), 0);
  assert.strictEqual(operatorDefaultPower({ defaultPower: null, defaultPowerSet: false }), 0);
});

test('a default the operator typed is kept, 100 included once marked', () => {
  assert.strictEqual(operatorDefaultPower({ defaultPower: 5 }), 5);
  assert.strictEqual(operatorDefaultPower({ defaultPower: 100, defaultPowerSet: true }), 100);
  assert.strictEqual(operatorDefaultPower({ defaultPower: '25', defaultPowerSet: true }), 25);
});

test('positiveWatts refuses junk', () => {
  for (const v of [0, -5, '', null, undefined, 'abc', NaN, Infinity]) assert.strictEqual(positiveWatts(v), 0, String(v));
  assert.strictEqual(positiveWatts(' 7 '), 7);
});

// --- source guards: the surfaces that fill power read through the helper ---
const R = (f) => readSrc(path.join(__dirname, '..', f));
const main = R('main.js');
const app = R('renderer/app.js');
const html = R('renderer/index.html');
const popJs = R('renderer/log-popout.js');
const popHtml = R('renderer/log-popout.html');

test('main: saveQsoRecord fills an empty power through the helper, never the raw setting', () => {
  const save = main.slice(main.indexOf('async function saveQsoRecord(qsoData, opts) {'));
  const body = save.slice(0, save.indexOf('\n}\n'));
  assert.ok(/LogTxPower\.txPowerForLog\(\{ knownW: _currentTxPower, defaultW: LogTxPower\.operatorDefaultPower\(ops\) \}\)/.test(body));
  assert.ok(!/ops\.defaultPower\)/.test(body), 'no raw ops.defaultPower fallback');
});

test('main window: no log form falls back to 100 W', () => {
  assert.ok(!/defaultPower \|\| 100/.test(app), 'no defaultPower || 100');
  assert.ok(!/parseInt\(settings\.defaultPower, 10\) \|\| 100/.test(app));
  assert.ok(!/parseInt\(setDefaultPower\.value, 10\) \|\| 100/.test(app));
  assert.ok(/logPower\.value = logFormPower\(\) \|\| '';/.test(app), 'the overlay pre-fills through logFormPower');
  assert.ok((app.match(/power: logFormPower\(\),/g) || []).length === 2, 'both pop-out opens use logFormPower');
  assert.ok(/defaultPowerSet: defaultPowerVal > 0/.test(app), 'Settings marks a typed default');
  assert.ok(html.includes('<script src="../lib/log-tx-power.js"></script>'));
  assert.ok(!/id="set-default-power"[^>]*value="100"/.test(html), 'the Settings box does not start at 100');
});

test('Log QSO pop-out: the default comes from operatorDefaultPower', () => {
  assert.ok(popHtml.includes('<script src="../lib/log-tx-power.js"></script>'));
  assert.ok(/LogTxPower\.operatorDefaultPower\(settings\)/.test(popJs));
  assert.ok(!/powerInput\.value = String\(settings\.defaultPower\)/.test(popJs));
});

console.log(`\nLog TX power: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
