#!/usr/bin/env node
'use strict';
// The purple stripe down the left of a received picture (Casey + another
// station, 2026-09-29, in every release back to at least 1.10.15). A line
// whose sync lands just before the buffer cut starts in the PREVIOUS buffer
// (_computeLineStart returns a negative start), and extractChannel used to
// read nothing for those samples, so the first colour channel's leftmost
// columns were painted BLACK_FREQ: green near zero while red and blue stay
// bright = purple. The decoder now reads those samples from the previous
// line's buffer.
// Scottie found a second bug here: busy content held the 1200 Hz envelope
// just above the fresh-pulse guard's arm level, the guard armed after the
// real sync and latched a ripple, the line start moved a whole colour scan
// late and red came out black (see _finishLine's missed-pulse check).
// Run: node test/sstv-first-column-test.js
const assert = require('assert');
const WORKER = process.env.SSTV_WORKER || '../lib/sstv-worker';
const { SstvDecoder, encodeImage } = require(WORKER);
const { MODES } = require('../lib/sstv-modes');
const SR = 48000;

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

function source(w, h) {
  const img = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    img[i] = 60 + 190 * (x / (w - 1));
    img[i + 1] = 128 + 100 * Math.sin(x / 7);
    img[i + 2] = 128 + 100 * Math.cos(x / 11);
    img[i + 3] = 255;
  }
  return img;
}

function leftMeans(modeName) {
  const mode = MODES[modeName];
  const src = source(mode.width, mode.height);
  const enc = encodeImage(src, mode.width, mode.height, modeName);
  const lead = SR * 0.3, n = lead + enc.length + SR * 4;
  const sig = new Float32Array(n); sig.set(enc, lead);
  const dec = new SstvDecoder(); let img = null;
  for (let i = 0; i < n; i += 4096) {
    for (const e of dec.processSamples(sig.slice(i, Math.min(n, i + 4096)))) {
      if (e && e.type === 'rx-image' && e.mode === modeName) img = e.imageData;
    }
  }
  assert.ok(img, 'no ' + modeName + ' image decoded');
  const w = mode.width, h = mode.height, y0 = Math.floor(h * 0.3), y1 = Math.floor(h * 0.7);
  const mean = (buf, c) => { let s = 0, k = 0; for (let y = y0; y < y1; y++) for (let x = 0; x < 4; x++) { s += buf[(y * w + x) * 4 + c]; k++; } return s / k; };
  return [0, 1, 2].map(c => ({ got: mean(img, c), want: mean(src, c) }));
}

console.log('SSTV first columns');
for (const m of ['martin1', 'martin2', 'scottie1']) {
  test(m + ': the left four columns carry every colour (no purple stripe)', () => {
    leftMeans(m).forEach((r, c) => {
      assert.ok(Math.abs(r.got - r.want) < 20, `${'RGB'[c]} left mean ${r.got.toFixed(0)} vs source ${r.want.toFixed(0)}`);
    });
  });
}

console.log(`\nSSTV first columns: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
