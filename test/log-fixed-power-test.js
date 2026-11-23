#!/usr/bin/env node
'use strict';
// "Always log this power" (#837): an operator with an amplifier logs the
// amplifier's power, not the exciter power the radio reports. Off (blank) by
// default, per operator profile, new contacts only.
// The order: a power typed for this contact (log form, phone) > the fixed
// power > the radio's power > the power typed earlier this session >
// Default TX Power > empty.
// Run: node test/log-fixed-power-test.js
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const LTP = require('../lib/log-tx-power');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

test('fixedLogPower: blank, 0 or junk is off; a positive number is the watts', () => {
  assert.strictEqual(typeof LTP.fixedLogPower, 'function');
  for (const s of [null, undefined, {}, { logFixedPower: null }, { logFixedPower: '' }, { logFixedPower: 0 }, { logFixedPower: -5 }, { logFixedPower: 'abc' }]) {
    assert.strictEqual(LTP.fixedLogPower(s), 0, JSON.stringify(s));
  }
  assert.strictEqual(LTP.fixedLogPower({ logFixedPower: 500 }), 500);
  assert.strictEqual(LTP.fixedLogPower({ logFixedPower: '1000' }), 1000);
  // It is not the Default TX Power and does not read it.
  assert.strictEqual(LTP.fixedLogPower({ defaultPower: 50, defaultPowerSet: true }), 0);
});

// Every combination: fixed set or not, radio reading or not, sticky typed or
// not, default or not, and a per-contact power (form or phone) or not.
test('txPowerForContact: every combination follows the order', () => {
  const T = 7, F = 500, K = 95, E = 40, D = 25;
  let n = 0;
  for (const typed of [null, T]) for (const fixedW of [0, F]) for (const knownW of [0, K]) for (const enteredW of [0, E]) for (const defaultW of [0, D]) {
    const want = typed || fixedW || knownW || enteredW || defaultW || null;
    const got = LTP.txPowerForContact({ typed, fixedW, knownW, enteredW, defaultW });
    assert.strictEqual(got, want == null ? null : String(want), JSON.stringify({ typed, fixedW, knownW, enteredW, defaultW }));
    // The fill without a per-contact power is txPowerForLog.
    if (!typed) assert.strictEqual(LTP.txPowerForLog({ fixedW, knownW, enteredW, defaultW }), want);
    n++;
  }
  assert.strictEqual(n, 32);
});

test('the amplifier power wins over the radio reading (the FTDX101D report)', () => {
  assert.strictEqual(LTP.txPowerForLog({ fixedW: 1000, knownW: 95 }), 1000);
  assert.strictEqual(LTP.txPowerForContact({ fixedW: 1000, knownW: 95, defaultW: 100 }), '1000');
});

test('a power typed for this contact wins over the fixed power', () => {
  assert.strictEqual(LTP.txPowerForContact({ typed: '5', fixedW: 1000, knownW: 95 }), '5');
  // A phone sends a Number (ECHOCAT #85); it is stored as text, like before.
  assert.strictEqual(LTP.txPowerForContact({ typed: 12.5, fixedW: 1000 }), '12.5');
  // A supplied value is kept as the caller sent it (W9TEF 2026-09-19): never re-parsed.
  assert.strictEqual(LTP.txPowerForContact({ typed: '100W', fixedW: 1000 }), '100W');
});

test('empty = unchanged: no fixed power leaves the old order exactly', () => {
  const cases = [{}, { knownW: 5, enteredW: 50, defaultW: 100 }, { knownW: 0, enteredW: 20, defaultW: 100 }, { defaultW: 15 }, { knownW: '10' }];
  for (const c of cases) {
    for (const fixedW of [undefined, null, '', 0, 'junk']) {
      assert.strictEqual(LTP.txPowerForLog(Object.assign({ fixedW }, c)), LTP.txPowerForLog(c), JSON.stringify(c));
    }
    const k = c.knownW, e = c.enteredW, d = c.defaultW;
    const old = (Number(k) > 0 ? Number(k) : 0) || e || d || null;
    assert.strictEqual(LTP.txPowerForLog(c), old);
  }
  assert.strictEqual(LTP.txPowerForContact({}), null);
  assert.strictEqual(LTP.txPowerForContact({ typed: '' }), null);
  assert.strictEqual(LTP.txPowerForContact({ typed: 0 }), null);
});

// --- per profile ------------------------------------------------------------
const R = (f) => readSrc(path.join(__dirname, '..', f));
const main = R('main.js');
const app = R('renderer/app.js');
const html = R('renderer/index.html');
const popJs = R('renderer/log-popout.js');

test('per profile: logFixedPower is an operator key (not GLOBAL_KEYS), like defaultPower', () => {
  const start = main.indexOf('const GLOBAL_KEYS = new Set([');
  const g = main.slice(start, main.indexOf(']);', start));
  assert.ok(start > 0);
  assert.ok(!/'logFixedPower'/.test(g), 'logFixedPower must stay per operator');
  assert.ok(!/'defaultPower'/.test(g), 'Default TX Power is per operator too');
});

test('per profile: the save path reads the logging operator\'s settings (ops)', () => {
  const save = main.slice(main.indexOf('async function saveQsoRecord(qsoData, opts) {'));
  const body = save.slice(0, save.indexOf('\n}\n'));
  assert.ok(/LogTxPower\.fixedLogPower\(ops\)/.test(body), 'fixed power from ops');
  assert.ok(!/settings\.logFixedPower/.test(body), 'never the active settings inside saveQsoRecord');
});

// --- wiring -----------------------------------------------------------------
test('main: saveQsoRecord fills TX_PWR through txPowerForContact with the fixed power', () => {
  const save = main.slice(main.indexOf('async function saveQsoRecord(qsoData, opts) {'));
  const body = save.slice(0, save.indexOf('\n}\n'));
  assert.ok(/LogTxPower\.txPowerForContact\(\{\s*typed: qsoData\.txPower,\s*fixedW: LogTxPower\.fixedLogPower\(ops\),/.test(body));
  assert.ok(/knownW: tciRigTarget\(\) \? tciMeasuredWattsForLog\(\) : _currentTxPower,/.test(body), 'a TCI rig still logs measured watts, never a drive percent');
  assert.ok(/defaultW: LogTxPower\.operatorDefaultPower\(ops\)/.test(body));
});

test('main window: the log forms pre-fill with the fixed power first', () => {
  const fn = app.slice(app.indexOf('function logFormPower() {'), app.indexOf('window.api.onCatPower('));
  assert.ok(/fixedW: fixedLogPower/.test(fn), 'logFormPower passes the fixed power');
  assert.ok(/let fixedLogPower = 0;/.test(app));
  assert.ok((app.match(/fixedLogPower = LogTxPower\.fixedLogPower\(settings\);/g) || []).length >= 1, 'loaded with settings');
});

test('Settings > Logging: the box sits under Default TX Power and loads/saves logFixedPower', () => {
  const dp = html.indexOf('id="set-default-power"');
  const fx = html.indexOf('id="set-log-fixed-power"');
  assert.ok(dp > 0 && fx > dp && fx - dp < 1200, 'next to Default TX Power');
  assert.ok(!/id="set-log-fixed-power"[^>]*value=/.test(html), 'starts blank (off)');
  assert.ok(/Always log this power/.test(html));
  assert.ok(/const setLogFixedPower = document\.getElementById\('set-log-fixed-power'\);/.test(app));
  assert.ok(/const fx = LogTxPower\.fixedLogPower\(s\); setLogFixedPower\.value = fx \? String\(fx\) : '';/.test(app), 'populate');
  assert.ok(/logFixedPower: logFixedPowerVal \|\| null,/.test(app), 'save, blank = null');
  assert.ok(/const logFixedPowerVal = LogTxPower\.positiveWatts\(setLogFixedPower\.value\.trim\(\)\);/.test(app));
});

test('Log QSO pop-out: with no power handed in, the fixed power comes before the default', () => {
  assert.ok(/LogTxPower\.fixedLogPower\(settings\) \|\| window\.LogTxPower\.operatorDefaultPower\(settings\)/.test(popJs));
});

console.log(`\nLog fixed power: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
