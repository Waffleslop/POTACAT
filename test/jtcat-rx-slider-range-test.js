#!/usr/bin/env node
'use strict';
// #1052: the JTCAT RX slider track ran 0 to 300 while every writer holds the
// level at 0 to 100% (gain = pct/100, main clamps to 0..1), so 100% showed a
// third of the way along and the thumb snapped back. Every FT8 RX slider that
// feeds the synced level must be max="100", and stored values above 100 from
// old settings must clamp.
// Run: node test/jtcat-rx-slider-range-test.js
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const ROOT = process.env.RXSLIDER_ROOT || path.join(__dirname, '..');
const R = (f) => readSrc(path.join(ROOT, f));
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
console.log('JTCAT RX slider range');

function sliderTag(file, id) {
  const m = R(file).match(new RegExp('<input[^>]*id="' + id + '"[^>]*>'));
  assert.ok(m, id + ' not found in ' + file);
  return m[0];
}
for (const [file, id] of [
  ['renderer/jtcat-popout.html', 'jp-rx-gain'],
  ['renderer/index.html', 'jtcat-rx-gain'],
  ['renderer/remote.html', 'ft8-rx-gain'],
  ['renderer/js8call-popout.html', 'jc-rx-gain'],
]) {
  test(id + ' track is 0 to 100', () => {
    const t = sliderTag(file, id);
    assert.ok(/min="0"/.test(t), 'min 0');
    assert.ok(/max="100"/.test(t), 'max must be 100 (the level is held at 0-100%): ' + t);
  });
}

test('main clamps every stored RX level it reads or sends to 0..1', () => {
  const m = R('main.js');
  assert.ok(/function clampJtcatRxGain\(/.test(m));
  assert.ok(/clampJtcatRxGain\(storedRaw\)/.test(m), 'per-band memory restore');
  assert.ok(/value: typeof settings\.jtcatRxGain === 'number' \? clampJtcatRxGain\(settings\.jtcatRxGain\)/.test(m), 'ECHOCAT hydrate');
  assert.ok(/'jtcat-set-rx-gain', clampJtcatRxGain\(settings\.jtcatRxGain\)/.test(m), 'JS8 pop-out seed');
});

test('main window clamps the seeded and relayed level to 100%', () => {
  const a = R('renderer/app.js');
  assert.ok(/var rxPct = Math\.max\(0, Math\.min\(100, Math\.round\(s\.jtcatRxGain \* 100\)\)\);/.test(a));
  assert.ok(/var lvlPct = Math\.max\(0, Math\.min\(100, Math\.round\(level \* 100\)\)\);/.test(a));
});

test('ECHOCAT Web clamps the shack echo and the remembered value to 100%', () => {
  const r = R('renderer/remote.js');
  assert.ok(/var rgPct = Math\.max\(0, Math\.min\(100, Math\.round\(Number\(msg\.value\) \* 100\)\)\);/.test(r));
  assert.ok(/savedFt8Rx = Math\.max\(0, Math\.min\(100, savedFt8Rx\)\)/.test(r));
});

test('the wire value stays a 0..1 fraction (pct / 100)', () => {
  const r = R('renderer/remote.js');
  assert.ok(/type: 'jtcat-rx-gain', value: pct \/ 100/.test(r));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
