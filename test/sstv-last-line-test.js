#!/usr/bin/env node
'use strict';
// GitHub #660: "images stop at 99% (line 255) and are never saved".
// When the last line of a picture completed, _stateDecoding returned only the
// image and dropped that line's rx-line, so the window never painted the last
// row and its counter stopped at "Line 255/256 (99%)". If the quality gate
// then discarded the picture, nothing else arrived and the window stayed on
// 99% with no word of why. Every line is now painted before the image (or the
// discard) is reported.
// Run: node test/sstv-last-line-test.js
const assert = require('assert');
const WORKER = process.env.SSTV_WORKER || '../lib/sstv-worker';
const { SstvDecoder, encodeImage } = require(WORKER);
const { MODES } = require('../lib/sstv-modes');
const SR = 48000;
const CHUNK = 4096;

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

function source(w, h) {
  const img = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    img[i] = 255 * x / (w - 1);
    img[i + 1] = 128;
    img[i + 2] = 255 * y / (h - 1);
    img[i + 3] = 255;
  }
  return img;
}

function flat(w, h, v) {
  const img = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < img.length; i += 4) { img[i] = img[i + 1] = img[i + 2] = v; img[i + 3] = 255; }
  return img;
}

// Decode one clean transmission; return the events in order.
function decode(modeKey, picture) {
  const m = MODES[modeKey];
  const pic = picture ? picture(m.width, m.height) : source(m.width, m.height);
  const enc = encodeImage(pic, m.width, m.height, modeKey);
  const sig = enc.samples || enc;
  const audio = new Float32Array(SR + sig.length + SR * 2);
  audio.set(sig, SR);
  const dec = new SstvDecoder();
  const events = [];
  for (let i = 0; i < audio.length; i += CHUNK) {
    for (const r of dec.processSamples(new Float32Array(audio.subarray(i, Math.min(i + CHUNK, audio.length))))) {
      if (r && (r.type !== 'rx-debug' || /discarded/i.test(r.detail || ''))) events.push(r);
    }
  }
  return { m, events };
}

function lastRowPainted(modeKey) {
  const { m, events } = decode(modeKey);
  const imgAt = events.findIndex((e) => e.type === 'rx-image');
  assert.ok(imgAt >= 0, modeKey + ': a clean picture is emitted');
  const lines = events.slice(0, imgAt).filter((e) => e.type === 'rx-line');
  const last = lines[lines.length - 1];
  const rows = last.rgba.length / (4 * m.width);
  assert.strictEqual(last.line + rows, m.height,
    `${modeKey}: the last rx-line before the image covers row ${m.height - 1} (got line ${last.line}, ${rows} row(s))`);
  // What the window shows for it: never stuck below 100%.
  const shown = Math.round(((last.line + rows - 1) / last.totalLines) * 100);
  assert.ok(last.line + rows === last.totalLines && shown >= 99, modeKey + ': the counter reaches the last line');
}

test('Robot 36: the last line is painted before the picture is reported', () => lastRowPainted('robot36'));
test('PD-90: the last row pair is painted before the picture is reported', () => lastRowPainted('pd90'));

// The second half of #660: a clean picture of a dark or grey scene held the
// 1200 Hz envelope above the per-line sync tracker's arm level on every line,
// so the quality gate saw sync on 0% of lines and discarded the picture it had
// just painted. Nothing reached main, so "Save every picture, even partial
// ones" could not keep it. The lock supervisor's line-period matches now
// vouch for it.
for (const [label, v] of [['black', 0], ['dark', 20], ['mid-grey', 128]]) {
  test(`Robot 36: a clean ${label} picture is kept, not discarded`, () => {
    const { events } = decode('robot36', (w, h) => flat(w, h, v));
    const discarded = events.find((e) => e.type === 'rx-debug');
    assert.ok(!discarded, 'discarded: ' + (discarded && discarded.detail));
    const img = events.find((e) => e.type === 'rx-image');
    assert.ok(img, 'an rx-image is emitted');
    assert.ok(!img.weak, `good tier, saved like any picture (sync=${img.stats.sync}% lock=${img.stats.lockSync}%)`);
    assert.ok(img.stats.lockSync >= 90, 'the lock supervisor matched nearly every line: ' + img.stats.lockSync);
  });
}

// The fix itself, in source: the end-of-image return carries the line too.
test('_stateDecoding returns the last line with the image', () => {
  const src = require('fs').readFileSync(require.resolve(WORKER), 'utf8');
  assert.ok(/if \(this\.lineNum >= this\.mode\.height\) return \[lineResult, this\._emitImage\(\)\];/.test(src));
});

console.log(`\nsstv-last-line: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
