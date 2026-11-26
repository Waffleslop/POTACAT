#!/usr/bin/env node
'use strict';
/**
 * Yaesu FT-950 model (#1059). An owner ran it as the FTDX3000 row: frequency,
 * ATU (AC002;) and power in plain watts (5-100 W) all matched the radio.
 *
 * Run: node test/ft950-model-test.js
 */
const assert = require('assert');
const { RIG_MODELS } = require('../lib/rig-models');
const { KenwoodCodec } = require('../lib/codecs/kenwood-codec');
const rigBands = require('../lib/rig-bands');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
function codecFor(id) {
  const out = [];
  const c = new KenwoodCodec(RIG_MODELS[id], (d) => out.push(String(d)));
  return { c, out };
}

test('FT-950 is in the model list', () => {
  assert.ok(RIG_MODELS['FT-950']);
  assert.strictEqual(RIG_MODELS['FT-950'].brand, 'Yaesu');
});

test('FT-950 maps to the same codec settings as the FTDX3000', () => {
  const a = RIG_MODELS['FT-950'], b = RIG_MODELS['FTDX3000'];
  assert.deepStrictEqual(a, b);
});

test('FT-950 power is plain watts, 5-100 W', () => {
  const m = RIG_MODELS['FT-950'];
  assert.strictEqual(m.minPower, 5);
  assert.strictEqual(m.maxPower, 100);
  assert.strictEqual(m.powerScale, undefined);
  const { c, out } = codecFor('FT-950');
  c.setTxPower(50);
  assert.deepStrictEqual(out, ['PC050;']);
});

test('FT-950 ATU tune is AC002;', () => {
  assert.strictEqual(RIG_MODELS['FT-950'].atuCmd, 'ac002');
});

test('FT-950 FA takes eight digits', () => {
  const { c, out } = codecFor('FT-950');
  c.setFrequency(14061941);
  assert.strictEqual(out.join(''), 'FA14061941;');
});

test('FT-950 bands are HF + 6 m, no VHF/UHF', () => {
  const b = rigBands.MODEL_BANDS['FT-950'];
  assert.ok(Array.isArray(b), 'FT-950 has a band entry');
  for (const x of ['160m', '20m', '10m', '6m']) assert.ok(b.includes(x), x);
  for (const x of ['2m', '70cm', '23cm']) assert.ok(!b.includes(x), x);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
