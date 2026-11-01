#!/usr/bin/env node
'use strict';
// The operator's own licence class refuses a transmission outside it
// (K3SBP 2026-11-01: a Technician's FT8 went out on 10 m above 28.300 MHz;
// the class in Settings > Station only filtered spots). Listening is never
// refused. Policy: lib/privileges.js txPrivilegeRefusal; main.js
// ownTxPrivilegeRefused() applies it at every key-down.
// Run: node test/own-licence-tx-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const P = require('../lib/privileges');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
const refuse = (freqHz, mode, licenseClass) => P.txPrivilegeRefusal({ freqHz, mode, licenseClass });

test('Technician FT8 on the 10 m dial is allowed', () => {
  assert.strictEqual(refuse(28074000, 'DATA', 'us_technician'), null);
  assert.strictEqual(refuse(28180000, 'FT4', 'us_technician'), null);
});

test('Technician data above 28.300 MHz is refused, with the reason', () => {
  const why = refuse(28450000, 'DATA', 'us_technician');
  assert.ok(why && /28\.450 MHz data is outside US Technician privileges/.test(why), why);
  assert.ok(/Settings > Station > License Class/.test(why));
});

test('Technician phone: 28.300-28.500 allowed, below 28.300 refused', () => {
  assert.strictEqual(refuse(28400000, 'USB', 'us_technician'), null);
  assert.ok(refuse(28250000, 'USB', 'us_technician'));
});

test('Technician on 20 m is refused; General on 20 m data is allowed', () => {
  assert.ok(refuse(14074000, 'DATA', 'us_technician'));
  assert.strictEqual(refuse(14074000, 'DATA', 'us_general'), null);
});

test('no class, no frequency or an unknown mode never refuses', () => {
  assert.strictEqual(refuse(14074000, 'DATA', 'none'), null);
  assert.strictEqual(refuse(14074000, 'DATA', undefined), null);
  assert.strictEqual(refuse(0, 'DATA', 'us_technician'), null);
  assert.strictEqual(refuse(28450000, 'XYZ', 'us_technician'), null);
  assert.strictEqual(refuse(14074000, 'DATA', 'us_advanced'), null, 'a class with no table must not refuse');
});

test('rig data-mode names are data: USB-D, USB-D2, DIGU, PKT-U, DATA-U', () => {
  for (const m of ['USB-D', 'USB-D2', 'LSB-D', 'DIGU', 'PKT-U', 'DATA-U', 'PKTUSB'])
    assert.strictEqual(P.emissionOf(m), 'DATA', m);
});

test('SSTV goes where phone goes', () => {
  assert.strictEqual(P.emissionOf('SSTV'), 'PHONE');
  assert.strictEqual(refuse(28400000, 'SSTV', 'us_technician'), null);
  assert.ok(refuse(28100000, 'SSTV', 'us_technician'));
});

test('CW is CW', () => {
  assert.strictEqual(P.emissionOf('CW'), 'CW');
  assert.strictEqual(refuse(28050000, 'CW', 'us_technician'), null);
  assert.ok(refuse(7030000, 'CW', 'us_general') === null);
});

test('an Icom USB-D key-down is no longer an unknown mode to the Guest Pass', () => {
  assert.strictEqual(P.isOutOfPrivilege(28074, 'USB-D', 'us_technician'), false);
});

// Wiring: every key-down passes the check.
const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
test('handleRemotePtt refuses a key-down outside the class', () => {
  assert.ok(/if \(state && ownTxPrivilegeRefused\(opts\.emission \|\| \(opts\.forceDataMode \? 'DATA' : _currentMode\), opts\.freqHz\)\) return;/.test(MAIN));
});
test('the JTCAT key-down is checked before anything is keyed or played, single and multi-slice', () => {
  const i = MAIN.indexOf("if (ownTxPrivilegeRefused('DATA')) {");
  const a = MAIN.indexOf("acquireRadio('jtcat'); // held for the duration of this transmission");
  assert.ok(i > 0 && a > i && a - i < 600, 'the check sits just before the radio is acquired');
  assert.ok(/if \(ownTxPrivilegeRefused\('DATA'\)\) \{\s*try \{ if \(ft8Engine && ft8Engine\._txActive\) ft8Engine\.txComplete\(\); \} catch \{\}\s*return;/.test(MAIN));
  assert.ok(/if \(ownTxPrivilegeRefused\('DATA', s\.freqKhz \? s\.freqKhz \* 1000 : undefined\)\)/.test(MAIN));
});
test('data and image key-downs name their emission', () => {
  assert.ok(/handleRemotePtt\(true, \{ audio: true, emission: 'DATA' \}\);/.test(MAIN), 'FT8 / tune');
  assert.ok(/forceDataMode: _sstvIcom, emission: 'SSTV'/.test(MAIN), 'SSTV');
  assert.ok(/forceDataMode: icom, emission: 'DATA'/.test(MAIN), 'Winlink');
  assert.ok(/handleRemotePtt\(on, on \? \{ audio: true, emission: 'DATA' \} : \{\}\)/.test(MAIN), 'Mercury');
});
test('CW text and the remote paddle are checked', () => {
  assert.ok(/if \(text && ownTxPrivilegeRefused\('CW'\)\) return;/.test(MAIN));
  assert.ok(/function passTxAllowed\(mode\) \{\s*if \(ownTxPrivilegeRefused\(mode \|\| _currentMode\)\) return false;/.test(MAIN));
});
test('a refusal reaches the main window, the JTCAT window, the VFO window and the phone', () => {
  const i = MAIN.indexOf('function ownTxPrivilegeRefused(');
  const body = MAIN.slice(i, MAIN.indexOf('\n}\n', i));
  for (const re of [/send\('app-notice'/, /jtcatPopoutWin\.webContents\.send\('jtcat-qso-state', \{ phase: 'error'/, /vfoPopoutWin\.webContents\.send\('tune-blocked'/, /type: 'tune-blocked', reason: why/])
    assert.ok(re.test(body), String(re));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
