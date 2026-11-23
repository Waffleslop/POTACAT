#!/usr/bin/env node
'use strict';
/**
 * FT-2000 ATU tune (#990). Yaesu's FT-2000 CAT Operation Reference (p. 5, AC)
 * defines AC P1 P2 P3 with P1 and P2 fixed at 0 and P3 = 0 off / 1 on /
 * 2 tuning start. The row was on the Kenwood 'standard' variant, which sends
 * AC011; (a non-zero fixed field, and "tuner on", not "tune"). It now uses
 * the 'ac002' variant, as the FTDX3000 does. The PC power scale is untouched.
 *
 * Run: node test/ft2000-atu-cmd-test.js
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

test('FT-2000 row declares the ac002 variant', () => {
  assert.strictEqual(RIG_MODELS['FT-2000'].atuCmd, 'ac002');
});

test('FT-2000 tune writes exactly AC002;', () => {
  const { c, out } = codecFor('FT-2000');
  c.startTune();
  assert.deepStrictEqual(out, ['AC002;']);
});

test('a row still on the standard variant (FT-450D-class Kenwood) sends AC011;', () => {
  const k = Object.keys(RIG_MODELS).find(n => RIG_MODELS[n].protocol === 'kenwood' && RIG_MODELS[n].atuCmd === 'standard');
  assert.ok(k, 'some row remains on standard');
  const { c, out } = codecFor(k);
  c.startTune();
  assert.deepStrictEqual(out, ['AC011;'], k);
});

test('FT-2000 power settings are unchanged (not part of #990)', () => {
  assert.strictEqual(RIG_MODELS['FT-2000'].maxPower, 200);
  assert.strictEqual(RIG_MODELS['FT-2000'].powerScale, undefined);
});

console.log(`\nFT-2000 ATU: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
