#!/usr/bin/env node
'use strict';
// jcoreyc (TS-480, Serial CAT, 2026-11-05): commands reached the radio, not
// one reply came back with RTS held low, and the link went red after 10 s.
// The RTS/CTS trial (connect and Test Connection) now covers Kenwood too.
// Run: node test/serial-hs-trial-test.js
const assert = require('assert');
const { trialApplies } = require('../lib/serial-hs-trial');
const { getModel } = require('../lib/rig-models');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
}

test('a Kenwood that never answers with RTS low gets the RTS/CTS trial (the TS-480)', () => {
  assert.strictEqual(trialApplies(getModel('TS-480')), true);
  assert.strictEqual(trialApplies(getModel(null, 'kenwood')), true, 'a generic Kenwood too');
});

test('Yaesu keeps it (#103)', () => {
  assert.strictEqual(trialApplies(getModel('FTDX10')), true);
  assert.strictEqual(trialApplies(getModel(null, 'yaesu')), true);
});

test('never the FT-817/818/857/897 legacy protocol, other brands, or no model', () => {
  for (const name of ['FT-818', 'FT-817', 'FT-857', 'FT-897']) {
    const m = getModel(name);
    if (m) assert.strictEqual(trialApplies(m), false, name);
  }
  assert.strictEqual(trialApplies({ brand: 'Elecraft', protocol: 'kenwood' }), false);
  assert.strictEqual(trialApplies(getModel(null, 'icom')), false);
  assert.strictEqual(trialApplies(null), false);
});

test('the TS-480 is NOT given RTS/CTS as a model default (Hamlib lists it with none)', () => {
  assert.notStrictEqual(getModel('TS-480').serialHandshake, 'hardware');
});

console.log(`\nSerial RTS/CTS trial: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
