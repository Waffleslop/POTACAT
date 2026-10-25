#!/usr/bin/env node
'use strict';
// Xiegu G90 speaks CI-V, so the rig picker sets it up through Hamlib (3088,
// 19200 baud), the way potacat.com/remote/xiegu-g90/ says. It was 'kenwood'
// under Serial CAT, which could never drive it. Run: node test/g90-hamlib-model-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { RIG_MODELS, getModelList } = require('../lib/rig-models');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

test('G90 is a Hamlib model: 3088 at 19200, no Kenwood CW text', () => {
  const g = RIG_MODELS.G90;
  assert.strictEqual(g.protocol, 'rigctld');
  assert.deepStrictEqual(g.hamlib, { rigId: 3088, baudRate: 19200 });
  assert.strictEqual(g.cw.text, false);
});

test('the model list carries the Hamlib setup for the picker', () => {
  const x = getModelList().find((b) => b.brand === 'Xiegu');
  assert.deepStrictEqual(x.hamlib, { G90: { rigId: 3088, baudRate: 19200 } });
  assert.ok(!getModelList().find((b) => b.brand === 'Icom').hamlib, 'only models that declare it');
});

test('the rig editor picks Other Rig (Hamlib) and fills model + baud', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
  assert.ok(/const hamlib = groupOf && groupOf\.hamlib && groupOf\.hamlib\[modelName\];/.test(app));
  assert.ok(/setRadioType\('hamlib'\);\s*hamlibFieldsLoaded = true;\s*await populateHamlibFields\(\{ rigId: hamlib\.rigId, baudRate: hamlib\.baudRate \}\);/.test(app));
});

console.log(`\nG90 Hamlib model: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
