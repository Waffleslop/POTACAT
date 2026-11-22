#!/usr/bin/env node
'use strict';
// GitHub #526: in the VFO window a custom CAT slider jumped back to its
// minimum while being dragged. Every vfo-radio-state push carries the custom
// CAT list, and the window rebuilt every custom control on each push; the new
// slider started at the saved value or, with none saved, at its minimum.
// Run: node test/vfo-custom-cat-slider-test.js
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const S = require('../lib/custom-cat-slider');

const html = readSrc(path.join(__dirname, '..', 'renderer', 'vfo-popout.html'));

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message || e)); }
}

const slider = (extra) => Object.assign({ name: 'RF Gain', command: 'RG{v3};', type: 'slider', min: 0, max: 255 }, extra || {});
const list = (extra) => [slider(extra), { name: 'NB', command: 'NB1;', type: 'toggle', commandOff: 'NB0;' }, { name: '', command: '' }];

console.log('VFO window: custom CAT sliders stay where they are dragged (#526) — the rules');
test('a push with the same slots does not rebuild, dragging or not', () => {
  const sig = S.definitionSignature(list());
  assert.strictEqual(S.plan(sig, list(), false), 'keep');
  assert.strictEqual(S.plan(sig, list(), true), 'keep');
});
test('a saved value that changed is not a reason to rebuild', () => {
  const sig = S.definitionSignature(list({ value: 10 }));
  assert.strictEqual(S.plan(sig, list({ value: 200 }), false), 'keep');
  assert.strictEqual(S.plan(sig, list(), false), 'keep');
});
test('a real change to a slot rebuilds, but waits for the drag to end', () => {
  const sig = S.definitionSignature(list());
  assert.strictEqual(S.plan(sig, list({ max: 100 }), false), 'rebuild');
  assert.strictEqual(S.plan(sig, list({ command: 'RG{v};' }), false), 'rebuild');
  assert.strictEqual(S.plan(sig, list({ max: 100 }), true), 'defer');
  assert.strictEqual(S.plan(null, list(), false), 'rebuild', 'first push builds');
});
test('a rebuilt slider starts at the value last moved to, never at its minimum', () => {
  assert.strictEqual(S.startValue(slider(), 137), 137);
  assert.strictEqual(S.startValue(slider({ value: 20 }), 137), 137, 'last moved beats the saved value');
  assert.strictEqual(S.startValue(slider({ value: 20 }), undefined), 20, 'else the saved value');
  assert.strictEqual(S.startValue(slider({ min: 5 }), undefined), 5, 'else the minimum');
  assert.strictEqual(S.startValue(slider({ max: 100 }), 137), 100, 'clamped to a range that shrank');
});
test('a saved value moved elsewhere (main window slider) is reported once, by slot key', () => {
  const seen = S.savedValues(list({ value: 10 }));
  assert.deepStrictEqual(S.savedValueChanges(list({ value: 10 }), seen), {});
  assert.deepStrictEqual(S.savedValueChanges(list({ value: 90 }), seen), { [S.slotKey(slider())]: 90 });
  assert.deepStrictEqual(S.savedValueChanges(list({ value: 90 }), {}), {}, 'first sight is not a move');
});
test('the slot key is the one customSliderTimers used: name|command', () => {
  assert.strictEqual(S.slotKey(slider()), 'RF Gain|RG{v3};');
});

console.log('VFO window: the wiring');
const pushHandler = (html.match(/if \(s\.customCatButtons\)[^\n]*\n(?:[^\n]*\n){0,3}/) || [''])[0];
test('a vfo-radio-state push goes through applyCustomCatPush, not straight to a rebuild', () => {
  assert.ok(pushHandler, 'the push handler reads s.customCatButtons');
  assert.ok(/applyCustomCatPush\(s\.customCatButtons\)/.test(pushHandler), pushHandler);
  assert.ok(!/buildCustomCatBtns\(\)/.test(pushHandler), 'no rebuild on every push');
});
test('the window loads the rules and follows the plan', () => {
  assert.ok(/<script src="\.\.\/lib\/custom-cat-slider\.js"><\/script>/.test(html));
  const fn = (html.match(/function applyCustomCatPush\(list\) \{[\s\S]*?\n\}/) || [''])[0];
  assert.ok(/CustomCatSlider\.plan\(customCatSig, list, busy\)/.test(fn), 'plan with the built signature and the drag state');
  assert.ok(/=== 'defer'/.test(fn) && /customCatPending = true/.test(fn), 'a deferred rebuild is kept for the release');
});
test('a slider starts at startValue and records every move under its key', () => {
  const build = (html.match(/function buildCustomCatBtns\(\) \{[\s\S]*?\n\}/) || [''])[0];
  assert.ok(/customCatSig = CustomCatSlider\.definitionSignature\(customCatButtons\)/.test(build));
  assert.ok(/range\.value = CustomCatSlider\.startValue\(b, customSliderLast\[key\]\)/.test(build));
  assert.ok(!/range\.value = Number\.isFinite\(b\.value\) \? b\.value : lo/.test(build), 'the old jump-to-minimum start is gone');
  assert.ok(/customSliderLast\[key\] = \+range\.value/.test(build), 'input remembers the value');
  assert.ok(/addEventListener\('pointerdown', \(\) => \{ customSliderHeld = true; \}\)/.test(build), 'a press marks the drag');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
