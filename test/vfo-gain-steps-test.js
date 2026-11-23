'use strict';
// #997: the VFO window's Preamp and Att buttons sent a boolean, so they reached
// only the first step (FTX-1 AMP2, Att 12/18 dB on the Yaesus). They now step
// through the radio's own ladder, the way the main Rig panel's "Pre"/"Att" do.
// Bytes come only from the existing ladders: Yaesu FTX-1 CAT manual 2508-C,
// PA command, PDF p.22 (P1 0 = HF/50: IPO/AMP1/AMP2; P1 1/2 = VHF/UHF: off/on).
//
// Run: node test/vfo-gain-steps-test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const G = require('../lib/rig-gain-steps');
const { KenwoodCodec } = require('../lib/codecs/kenwood-codec');
const { RIG_MODELS } = require('../lib/rig-models');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (err) { failed++; console.log('  FAIL ' + name + '\n       ' + (err.stack || err.message)); }
}
const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

// One press of the VFO window's button, end to end: the window picks the value
// from the ladder it was sent, main's handler resolves it, the codec writes it.
function presses(modelId, kind, hz, n) {
  const model = RIG_MODELS[modelId];
  const writes = [];
  const codec = new KenwoodCodec(model, (d) => writes.push(String(d)));
  codec._lastFreqHz = hz;
  const steps = kind === 'preamp' ? model.preampSteps : model.attSteps;
  const targets = kind === 'preamp' ? model.preampTargets : undefined;
  let cur = 0;
  const sent = [];
  for (let i = 0; i < n; i++) {
    const ladder = G.ladderForFreq(steps, targets, hz);
    const value = G.clickValue(cur, ladder);
    sent.push(value);
    const step = G.resolveStep(value, steps);
    if (kind === 'preamp') codec.setPreamp(step); else codec.setAttenuator(step);
    cur = step;
  }
  return { writes, sent };
}

console.log('\n=== VFO window Preamp/Att step through the ladder (#997) ===');

for (const id of ['FTX-1 Field', 'FTX-1 Optima']) {
  test(`${id} on 20 m: Preamp presses go IPO, AMP1, AMP2, IPO (PA00; PA01; PA02; PA00;)`, () => {
    // start at IPO; four presses = AMP1, AMP2, IPO, AMP1
    const r = presses(id, 'preamp', 14074000, 4);
    assert.deepStrictEqual(r.sent, [1, 2, 0, 1]);
    assert.deepStrictEqual(r.writes, ['PA01;', 'PA02;', 'PA00;', 'PA01;']);
  });

  test(`${id} on 2 m: Preamp is off/on only (PA11; PA10;), never AMP2`, () => {
    const r = presses(id, 'preamp', 146520000, 4);
    assert.deepStrictEqual(r.sent, [1, 0, 1, 0]);
    assert.deepStrictEqual(r.writes, ['PA11;', 'PA10;', 'PA11;', 'PA10;']);
  });

  test(`${id} on 70 cm: Preamp is off/on only (PA21; PA20;)`, () => {
    const r = presses(id, 'preamp', 446000000, 2);
    assert.deepStrictEqual(r.writes, ['PA21;', 'PA20;']);
  });
}

test('Yaesu Att steps through the whole ladder: off, 6, 12, 18 dB, off', () => {
  const r = presses('FT-710', 'att', 14074000, 5);
  assert.deepStrictEqual(r.sent, [1, 2, 3, 0, 1]);
  assert.deepStrictEqual(r.writes, ['RA01;', 'RA02;', 'RA03;', 'RA00;', 'RA01;']);
});

test('a radio with no ladder is unchanged: the window sends true / false', () => {
  assert.strictEqual(G.clickValue(0, []), true);
  assert.strictEqual(G.clickValue(1, []), false);
  assert.strictEqual(G.clickValue(false, undefined), true);
  assert.strictEqual(G.clickValue(true, undefined), false);
  assert.strictEqual(G.clickValue(0, [{ v: 0 }]), true, 'a one-entry ladder is not a ladder');
});

test('a ladder rig gets a number, never a boolean', () => {
  assert.strictEqual(typeof G.clickValue(0, G.YAESU_PREAMP_IPO_AMP1_AMP2), 'number');
});

test('ladderForFreq: HF/50 keeps the whole ladder, VHF/UHF cut it to off/on, no targets keeps it', () => {
  const pre = G.YAESU_PREAMP_IPO_AMP1_AMP2;
  assert.strictEqual(G.ladderForFreq(pre, ['hf50', 'vhf', 'uhf'], 50313000).length, 3);
  assert.strictEqual(G.ladderForFreq(pre, ['hf50', 'vhf', 'uhf'], 144200000).length, 2);
  assert.strictEqual(G.ladderForFreq(pre, ['hf50', 'vhf', 'uhf'], 432100000).length, 2);
  assert.strictEqual(G.ladderForFreq(pre, undefined, 144200000).length, 3);
  assert.deepStrictEqual(G.ladderForFreq(undefined, ['hf50'], 144200000), []);
});

test('the button label shows the step, as the main panel does', () => {
  const att = G.YAESU_ATT_6_12_18;
  assert.strictEqual(G.buttonLabel('Att', 2, att), 'Att 12');
  assert.strictEqual(G.buttonLabel('Preamp', 2, G.YAESU_PREAMP_IPO_AMP1_AMP2), 'Preamp 2');
  assert.strictEqual(G.buttonLabel('Preamp', 0, G.YAESU_PREAMP_IPO_AMP1_AMP2), 'Preamp');
});

console.log('\n=== wiring ===');

test('main sends the step and the ladder to the VFO window', () => {
  const main = read('main.js');
  const i = main.indexOf("webContents.send('vfo-radio-state'");
  const h = main.slice(i, i + 6000);
  assert.ok(/preampStep: _currentPreampStep/.test(h) && /attStep: _currentAttStep/.test(h));
  assert.ok(h.includes("preampSteps: vfoGainLadder('preampSteps', true)"), 'preamp ladder, cut to the band');
  assert.ok(h.includes("attSteps: vfoGainLadder('attSteps', false)"));
  const j = main.indexOf('function vfoGainLadder');
  assert.ok(j > 0 && main.slice(j, j + 500).includes('_rigGainSteps.ladderForFreq('));
});

test('the VFO window loads the ladder module and sends clickValue(step, ladder)', () => {
  const vfo = read('renderer', 'vfo-popout.html');
  assert.ok(/<script src="\.\.\/lib\/rig-gain-steps\.js"><\/script>/.test(vfo));
  assert.ok(/RigGainSteps\.clickValue\(/.test(vfo));
  assert.ok(/RigGainSteps\.buttonLabel\(/.test(vfo));
  assert.ok(vfo.includes("for (const g of ['preamp', 'att'])"));
  assert.ok(vfo.includes("s[g + 'Steps']") && vfo.includes("s[g + 'Step']"));
});

test('this test is in the run list', () => {
  assert.ok(read('scripts', 'run-tests.js').includes("'test/vfo-gain-steps-test.js'"));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
