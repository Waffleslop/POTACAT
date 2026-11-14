#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
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
  assert.strictEqual(refuse(14074000, 'XYZ', 'us_advanced'), null);
});

// 2026-11-03: the tables ended at 6 m, so FT8 on 2 m was refused for every
// class ("tune within your privileges" on 144.174).
test('2 m, 1.25 m, 70 cm, 33 cm, 23 cm: every US class may transmit', () => {
  for (const cls of ['us_technician', 'us_general', 'us_advanced', 'us_extra']) {
    assert.strictEqual(refuse(144174000, 'DATA', cls), null, '2 m FT8 ' + cls);
    assert.strictEqual(refuse(146520000, 'FM', cls), null, '2 m FM ' + cls);
    assert.strictEqual(refuse(223500000, 'FM', cls), null, '1.25 m ' + cls);
    assert.strictEqual(refuse(432065000, 'DATA', cls), null, '70 cm ' + cls);
    assert.strictEqual(refuse(903100000, 'USB', cls), null, '33 cm ' + cls);
    assert.strictEqual(refuse(1296100000, 'CW', cls), null, '23 cm ' + cls);
  }
  assert.strictEqual(refuse(144174000, 'DATA', 'ca_basic'), null);
  assert.strictEqual(refuse(432065000, 'DATA', 'ca_honours'), null);
});
test('the bottom 100 kHz of 6 m and 2 m is CW only', () => {
  assert.ok(refuse(144050000, 'DATA', 'us_extra'));
  assert.ok(refuse(50050000, 'USB', 'us_general'));
  assert.strictEqual(refuse(144050000, 'CW', 'us_technician'), null);
  assert.strictEqual(refuse(50313000, 'DATA', 'us_technician'), null);
});
test('60 m: General and up on the channels and 5351.5-5366.5, never Technician', () => {
  assert.strictEqual(refuse(5357000, 'DATA', 'us_general'), null);
  assert.strictEqual(refuse(5332000, 'USB', 'us_extra'), null);
  assert.ok(refuse(5357000, 'DATA', 'us_technician'));
  assert.ok(refuse(5340000, 'DATA', 'us_extra'), 'between channels');
});
test('Technician: CW only on 80, 40 and 15 m; US Advanced has its own table', () => {
  assert.strictEqual(refuse(7030000, 'CW', 'us_technician'), null);
  assert.ok(refuse(7074000, 'DATA', 'us_technician'));
  assert.strictEqual(refuse(14074000, 'DATA', 'us_advanced'), null);
  assert.ok(refuse(14160000, 'USB', 'us_advanced'));
  assert.strictEqual(refuse(14200000, 'USB', 'us_advanced'), null);
});
// #250 step 1: the renderer copies are gone. lib/privileges.js is the one
// source, loaded as window.Privileges (test/privileges-one-source-test.js
// proves the result is unchanged, cell by cell).
test('renderer/app.js (the spot filter) uses the shared tables', () => {
  const src = readSrc(path.join(__dirname, '..', 'renderer', 'app.js'));
  assert.ok(!/const PRIVILEGE_RANGES = /.test(src), 'no copy of the table');
  assert.ok(/Privileges\.isOutOfPrivilege\(/.test(src), 'calls the shared module');
  const html = readSrc(path.join(__dirname, '..', 'renderer', 'index.html'));
  assert.ok(html.includes('<script src="../lib/privileges.js"></script>'), 'index.html loads it');
});
test('renderer/bandspread-popout.js uses the shared tables', () => {
  const src = readSrc(path.join(__dirname, '..', 'renderer', 'bandspread-popout.js'));
  assert.ok(!/const PRIVILEGE_MAP = /.test(src), 'no copy of the table');
  assert.ok(/Privileges\.PRIVILEGE_MAP\[cls\]/.test(src), 'reads the shared module');
  const html = readSrc(path.join(__dirname, '..', 'renderer', 'bandspread-popout.html'));
  assert.ok(html.includes('<script src="../lib/privileges.js"></script>'), 'the pop-out page loads it');
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
const MAIN = readSrc(path.join(__dirname, '..', 'main.js'));
test('handleRemotePtt refuses a key-down outside the class', () => {
  assert.ok(/const pttEmission = opts\.emission \|\| \(opts\.forceDataMode \? 'DATA' : null\);/.test(MAIN));
  assert.ok(/if \(state && ownTxPrivilegeRefused\(pttEmission \|\| _currentMode, opts\.freqHz\)\) return false;/.test(MAIN));
});
test('the JTCAT key-down is checked before anything is keyed or played, single and multi-slice', () => {
  const i = MAIN.indexOf("if (ownTxPrivilegeRefused('DATA')) {");
  const a = MAIN.indexOf("acquireRadio('jtcat'); // held for the duration of this transmission");
  assert.ok(i > 0 && a > i && a - i < 600, 'the check sits just before the radio is acquired');
  // #190: a refused tx-start unwinds through jtcatRefuseTx (txComplete on a
  // JS8 engine announced "fully transmitted" for a message that never keyed).
  assert.ok(/if \(ownTxPrivilegeRefused\('DATA'\)\) \{\s*jtcatRefuseTx\('[^']+'\);\s*return;/.test(MAIN));
  assert.ok(/if \(ownTxPrivilegeRefused\('DATA', s\.freqKhz \? s\.freqKhz \* 1000 : undefined\)\)/.test(MAIN));
});
test('data and image key-downs name their emission', () => {
  assert.ok(/handleRemotePtt\(true, \{ audio: true, emission: 'DATA', txKind: jtcatTxKind\(\)(, lanOwner: [^}]+)? \}\);/.test(MAIN), 'FT8');
  assert.ok(/forceDataMode: _sstvIcom, emission: 'SSTV'/.test(MAIN), 'SSTV');
  assert.ok(/\.\.\.pttMode, emission: 'DATA', txKind: 'winlink'/.test(MAIN), 'Winlink');
  assert.ok(/handleRemotePtt\(on, on \? \{ audio: true, emission: 'DATA', txKind: 'winlink' \} : \{\}\)/.test(MAIN), 'Mercury');
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
