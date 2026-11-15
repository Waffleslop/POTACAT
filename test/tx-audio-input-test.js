#!/usr/bin/env node
'use strict';
// Transmit audio input per rig (#594): the Kenwood key-down that picks the
// socket. Byte-exact through the real codecs, plus the main.js wiring.
// Run: node test/tx-audio-input-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const T = require('../lib/tx-audio-input');
const { RIG_MODELS } = require('../lib/rig-models');
const { KenwoodCodec } = require('../lib/codecs/kenwood-codec');
const { RigctldCodec } = require('../lib/codecs/rigctld-codec');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
}

function keyDown(Codec, model) {
  const writes = [];
  const codec = new Codec(model, (d) => writes.push(String(d)));
  codec.setTransmit(true);
  return writes.join('');
}
function serialKey(modelName, rig) {
  return keyDown(KenwoodCodec, T.applyToModel(RIG_MODELS[modelName], rig, modelName));
}
function rigctldKey(modelName, rig) {
  return keyDown(RigctldCodec, T.applyToModel(RIG_MODELS[modelName], rig, modelName));
}

const MODELS = ['TS-480', 'TS-590S/SG', 'TS-890S', 'TS-990S'];

test('every listed model exists in rig-models and keys with TX1; by default', () => {
  for (const m of MODELS) {
    assert.ok(RIG_MODELS[m], m + ' missing from rig-models');
    assert.strictEqual(RIG_MODELS[m].commands.setTransmitOn, 'TX1;', m);
  }
});

for (const m of MODELS) {
  test(`${m}: Front -> TX; on serial, T 1 on rigctld`, () => {
    const rig = { model: m, txAudioInput: 'front' };
    assert.strictEqual(serialKey(m, rig), 'TX;');
    assert.strictEqual(rigctldKey(m, rig), 'T 1\n');
  });
  test(`${m}: Rear -> TX1; on serial, T 3 on rigctld`, () => {
    const rig = { model: m, txAudioInput: 'rear' };
    assert.strictEqual(serialKey(m, rig), 'TX1;');
    assert.strictEqual(rigctldKey(m, rig), 'T 3\n');
  });
}

test('TS-590/890/990 with nothing saved: Rear, as before, never asks', () => {
  for (const m of ['TS-590S/SG', 'TS-890S', 'TS-990S']) {
    const rig = { model: m };
    assert.strictEqual(T.choiceFor(rig), 'rear', m);
    assert.strictEqual(serialKey(m, rig), 'TX1;', m);
    assert.strictEqual(T.needsAnswer(rig, { catType: 'serial' }), false, m);
  }
});

test('TS-480 with nothing saved: asks on serial, rigctld and an external rigctld', () => {
  const rig = { model: 'TS-480' };
  assert.strictEqual(T.choiceFor(rig), null);
  for (const catType of ['serial', 'rigctld', 'rigctldnet']) {
    assert.strictEqual(T.needsAnswer(rig, { catType }), true, catType);
  }
});

test('TS-480 answered: never asks again', () => {
  assert.strictEqual(T.needsAnswer({ model: 'TS-480', txAudioInput: 'front' }, { catType: 'serial' }), false);
  assert.strictEqual(T.needsAnswer({ model: 'TS-480', txAudioInput: 'rear' }, { catType: 'serial' }), false);
});

test('TS-480 does not ask when the key-down is not the CAT TX command', () => {
  const rig = { model: 'TS-480' };
  for (const ptt of ['vox', 'rts', 'dtr']) assert.strictEqual(T.needsAnswer(rig, { catType: 'serial', ptt }), false, ptt);
  for (const catType of ['flrig', 'none', 'dxlab-commander', undefined]) assert.strictEqual(T.needsAnswer(rig, { catType }), false, String(catType));
});

test('a Commands-tab PTT On override wins: no question', () => {
  assert.strictEqual(T.needsAnswer({ model: 'TS-480' }, { catType: 'serial', pttOverride: 'TX;' }), false);
});

test('other models are untouched', () => {
  const ts2000 = RIG_MODELS['TS-2000'];
  if (ts2000) assert.strictEqual(T.applyToModel(ts2000, { model: 'TS-2000', txAudioInput: 'rear' }), ts2000);
  assert.strictEqual(T.needsAnswer({ model: 'FT-710' }, { catType: 'serial' }), false);
  assert.strictEqual(T.choiceFor({ model: 'IC-7300', txAudioInput: 'front' }), null);
});

test('a junk saved value is ignored', () => {
  assert.strictEqual(T.choiceFor({ model: 'TS-480', txAudioInput: 'side' }), null);
  assert.strictEqual(T.choiceFor({ model: 'TS-590S/SG', txAudioInput: 'side' }), 'rear');
});

test('applyToModel does not mutate the shared model', () => {
  const before = RIG_MODELS['TS-480'].commands.setTransmitOn;
  T.applyToModel(RIG_MODELS['TS-480'], { model: 'TS-480', txAudioInput: 'front' });
  assert.strictEqual(RIG_MODELS['TS-480'].commands.setTransmitOn, before);
});

test('the refusal names where to answer', () => {
  const t = T.refusalText('TS-480');
  assert.ok(/shack PC/.test(t) && /Transmit audio input/.test(t) && /Settings > Radio/.test(t), t);
});

// main.js wiring: the model the codecs get carries the choice, and both key-down
// gates ask before keying.
const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
test('getActiveRigModel applies the rig\'s transmit audio input', () => {
  assert.ok(/function _activeRigModelBase\(\) \{\n[^\n]*\n  return TxAudioInput\.applyToModel\(_activeRigModelPicked\(\), r, r && r\.model\);/.test(MAIN));
});
test('handleRemotePtt and gatedSetTransmit both refuse an unanswered TS-480', () => {
  const hrp = MAIN.slice(MAIN.indexOf('function handleRemotePtt('));
  assert.ok(/if \(state && txAudioInputRefusal\(\)\)/.test(hrp.slice(0, 8000)), 'handleRemotePtt gate');
  const gst = MAIN.slice(MAIN.indexOf('function gatedSetTransmit('));
  const end = gst.indexOf('cat.setTransmit(state)');
  assert.ok(end > 0 && /txAudioInputRefusal\(\)/.test(gst.slice(0, end)), 'gatedSetTransmit gate before the key-down');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
