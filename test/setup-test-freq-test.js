#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
// w0tlp (Station Setup, 2026-11-02): the test transmit was refused as out of
// band with the radio in LSB. Now: test at the dial when the licence allows
// it, else move to the band's FT8 dial and come back, else say why.
// Run: node test/setup-test-freq-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { planTestFrequency, rfOf } = require('../lib/setup-test-freq');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
}

test('a tone in LSB inside the phone privileges is tested right there', () => {
  assert.deepStrictEqual(planTestFrequency({ freqHz: 7200000, mode: 'LSB', licenseClass: 'us_general' }), { action: 'here', emission: 'LSB' });
  assert.deepStrictEqual(planTestFrequency({ freqHz: 3900000, mode: 'LSB', licenseClass: 'us_general' }), { action: 'here', emission: 'LSB' });
});

test('outside the phone privileges at the dial: move to a clear data frequency, never into the FT8 passband', () => {
  const p = planTestFrequency({ freqHz: 14160000, mode: 'USB', licenseClass: 'us_general', extraDialsKhz: [14078] });
  assert.strictEqual(p.action, 'move');
  assert.strictEqual(p.emission, 'DATA');
  assert.ok(/outside US General privileges/.test(p.why));
  assert.strictEqual(p.rfHz, 14087500, 'just above FT2 at 14.084 + 3.5 kHz');
  assert.strictEqual(p.dialHz, p.rfHz - 1000, 'USB: the tone is above the dial');
  const lsb = planTestFrequency({ freqHz: 3700000, mode: 'LSB', licenseClass: 'us_general', extraDialsKhz: [3578] });
  assert.strictEqual(lsb.dialHz, lsb.rfHz + 1000, 'LSB: the tone is below the dial');
});

test('the tone is at least 3.5 kHz from every FT8, FT4, FT2, JS8 and WSPR dial, and outside their passbands', () => {
  const { digitalDialsHz, CLEAR_HZ } = require('../lib/setup-test-freq');
  for (const [band, freqHz, js8] of [['20m', 14160000, 14078], ['40m', 7200000, 7078], ['80m', 3700000, 3578], ['10m', 28400000, 28078]]) {
    const p = planTestFrequency({ freqHz, mode: 'USB', licenseClass: 'us_general', extraDialsKhz: [js8] });
    if (p.action !== 'move') continue;
    for (const d of digitalDialsHz(band, [js8])) {
      assert.ok(Math.abs(p.rfHz - d) >= CLEAR_HZ, `${band}: ${p.rfHz} vs dial ${d}`);
      assert.ok(!(p.rfHz >= d && p.rfHz <= d + 3000), `${band}: inside the passband of ${d}`);
    }
  }
});

test('no frequency on the band the licence allows: refused, with the reason, nothing keyed', () => {
  const p = planTestFrequency({ freqHz: 14200000, mode: 'USB', licenseClass: 'us_technician' });
  assert.strictEqual(p.action, 'refuse');
  assert.ok(/There is no data frequency on 20m where your licence allows a test either/.test(p.why), p.why);
});

test('the frequency checked is where the tone lands: LSB puts it below the dial', () => {
  assert.strictEqual(rfOf(7074000, 'LSB'), 7073000);
  assert.strictEqual(rfOf(7074000, 'USB'), 7075000);
  assert.strictEqual(rfOf(7074000, 'DIGU'), 7075000);
});

test('no licence class set: never refused, tested at the dial', () => {
  assert.strictEqual(planTestFrequency({ freqHz: 14160000, mode: 'USB', licenseClass: 'none' }).action, 'here');
  assert.strictEqual(planTestFrequency({ freqHz: 14160000, mode: 'USB' }).action, 'here');
});

test('main: the test plans first, moves and confirms arrival, keys with the plan\'s emission, and comes back', () => {
  const main = readSrc(path.join(__dirname, '..', 'main.js'));
  const f = main.slice(main.indexOf('async function _runStationSetupTxTest('), main.indexOf('function getIcomNetworkDataModSpec('));
  const plan = f.indexOf('SetupTestFreq.planTestFrequency(');
  assert.ok(plan > 0 && plan < f.indexOf("applyRigControl({ action: 'set-tx-power', value: testW }, 'setup')"), 'decided before the power is touched');
  assert.ok(/if \(plan\.action === 'refuse'\) \{[\s\S]*?return done\(\{ result: 'error', message: plan\.why \}\);/.test(f));
  assert.ok(/const arrived = await waitForCondition\(/.test(f) && /did not report arriving there, so nothing was keyed/.test(f));
  assert.ok(/startJtcatTune\(\{ toneHz: STATION_SETUP_TEST_TONE_HZ, emission: plan\.emission, noDataSwap: voice \}\);/.test(f));
  assert.ok(/if \(movedFromHz\) \{\s*tuneRadio\(movedFromHz \/ 1000/.test(f), 'back to the operator\'s frequency');
  assert.ok(/The voice test needs a phone frequency your licence allows/.test(f), 'the voice test never moves to a data frequency');
});

console.log(`\nSetup test frequency: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
