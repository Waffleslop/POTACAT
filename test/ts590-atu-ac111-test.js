#!/usr/bin/env node
'use strict';
/**
 * TS-590S/SG ATU tune. Kenwood's PC Control Command Reference for the
 * TS-590S/TS-590SG (B5A-0316-00, p. 3, AC): P1 = RX-AT THRU/IN, P2 = TX-AT
 * THRU/IN, P3 = stop/start tuning, and "To begin tuning, you must use command
 * AC111". POTACAT sent AC011;, and a TS-590SG with a remote tuner did not tune
 * (VA2PSL, issue #635). Other Kenwood rows keep AC011; until their own guide
 * says otherwise.
 *
 * Run: node test/ts590-atu-ac111-test.js
 */
const assert = require('assert');
const { RIG_MODELS } = require('../lib/rig-models');
const { KenwoodCodec } = require('../lib/codecs/kenwood-codec');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
function codecFor(model) {
  const out = [];
  const c = new KenwoodCodec(RIG_MODELS[model], (d) => out.push(String(d)));
  return { c, out };
}

test('TS-590S/SG model row declares the ac111 variant', () => {
  assert.strictEqual(RIG_MODELS['TS-590S/SG'].atuCmd, 'ac111');
});

test('TS-590S/SG start sequence is AC111; and startTune writes exactly AC111;', () => {
  const { c, out } = codecFor('TS-590S/SG');
  assert.deepStrictEqual(c.getAtuStartSequence(), [{ cmd: 'AC111;', delay: 0 }]);
  c.startTune();
  assert.deepStrictEqual(out, ['AC111;']);
});

test('TS-590S/SG stop is still AC000;', () => {
  const { c } = codecFor('TS-590S/SG');
  assert.strictEqual(c.getAtuStopCmd(), 'AC000;');
});

test('every other row on the standard variant still sends AC011; (no shared-codec change)', () => {
  const others = Object.keys(RIG_MODELS).filter(k => RIG_MODELS[k].protocol === 'kenwood' && RIG_MODELS[k].atuCmd === 'standard');
  assert.ok(others.length > 0, 'some rows remain on standard');
  for (const k of others) {
    const { c, out } = codecFor(k);
    c.startTune();
    assert.deepStrictEqual(out, ['AC011;'], k);
  }
});

console.log(`\nTS-590S/SG ATU AC111: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
