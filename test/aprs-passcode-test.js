#!/usr/bin/env node
'use strict';
// APRS phase 4: the APRS-IS passcode (lib/aprs-passcode.js).
//
// Published callsign/passcode pairs, each found in at least two independent
// public sources (checked 2026-11-18):
//
//   N0CALL -> 13023
//     1. microdog/aprs2traccar README (github.com/microdog/aprs2traccar),
//        Dire Wolf example: "IGLOGIN N0CALL-10 13023" and "13023 being the
//        passcode for N0CALL".
//     2. KK4VCZ, "Scripting APRS Bulletins from Xastir"
//        (kk4vcz.com/posts/xastir-bulletin/): "N0CALL 13023 -to_rf".
//     3. fagci/dsp pull request 981 (github.com/fagci/dsp/pull/981), its
//        tests: "passcode N0CALL = 13023".
//
// Further published pairs, each from one source only, kept as extra checks
// (they are not the pairs the rule above rests on):
//   NOCALL -> 12960  Xastir's callpass(1) manual page, EXAMPLES: "callpass
//                    nocall outputs 'Passcode for nocall is 12960'"
//                    (manpages.debian.org, xastir package).
//   X2YZ   -> 29322  The callpass crate's documentation (docs.rs/callpass):
//                    "x2yz" ... "29322".
//
// The algorithm itself was written from a description in words (gkbrk.com
// journal, 2023-05-08), not from any program's source.
// Run: node test/aprs-passcode-test.js

const assert = require('assert');
const { aprsPasscode, passcodeBase } = require('../lib/aprs-passcode');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

test('N0CALL is 13023 (three independent sources)', () => {
  assert.strictEqual(aprsPasscode('N0CALL'), 13023);
});

test('single-source pairs agree: NOCALL 12960, X2YZ 29322', () => {
  assert.strictEqual(aprsPasscode('NOCALL'), 12960);
  assert.strictEqual(aprsPasscode('X2YZ'), 29322);
});

test('the SSID is not part of it, and case does not matter', () => {
  assert.strictEqual(aprsPasscode('n0call'), 13023);
  assert.strictEqual(aprsPasscode('N0CALL-10'), 13023);
  assert.strictEqual(aprsPasscode(' n0call-9 '), 13023);
  assert.strictEqual(passcodeBase('k3abc-10'), 'K3ABC');
});

test('it is 15 bits: 0 to 32767', () => {
  for (const c of ['A', 'AB', 'ABC', 'W1AW', 'VE3XYZ', 'ZZ9ZZZ', '9M2ABC', 'K1A']) {
    const p = aprsPasscode(c);
    assert.ok(Number.isInteger(p) && p >= 0 && p <= 32767, c + ' -> ' + p);
  }
});

test('no callsign gives -1 (the read-only login), never a number for nothing', () => {
  assert.strictEqual(aprsPasscode(''), -1);
  assert.strictEqual(aprsPasscode(null), -1);
  assert.strictEqual(aprsPasscode('-10'), -1);
});

test('lib/aprs-is.js uses this one implementation', () => {
  assert.strictEqual(require('../lib/aprs-is').aprsPasscode, aprsPasscode);
});

console.log(`\nAPRS passcode: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
