#!/usr/bin/env node
'use strict';
/**
 * Robot 36 decoded from an INDEPENDENTLY synthesised, spec-timed signal (150 ms
 * lines: sync 9, porch 3, Y 88, separator 4.5, 1900 Hz porch 1.5, chroma 44 —
 * as MMSSTV and slowrx send it), not from encodeImage(): the quality matrix
 * decodes our own encoder, so a timing mistake the two share round-trips
 * cleanly. That is how POTACAT ran a 147 ms line for months and every real
 * Robot 36 decoded green (artemisstiles 2026-10-24).
 */
const assert = require('assert');
const { SstvDecoder, encodeImage } = require('../lib/sstv-worker');
const SR = 48000, W = 320, H = 240;
let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
const COLORS = [[255,0,0],[0,255,0],[0,0,255],[255,255,0],[0,255,255],[255,0,255],[255,255,255],[64,64,64]];
function makeImg() {
  const img = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const [r, g, b] = COLORS[Math.min(7, Math.floor(x / 40))];
    const i = (y * W + x) * 4; img[i] = r; img[i + 1] = g; img[i + 2] = b; img[i + 3] = 255;
  }
  return img;
}
function synth(segments) {
  let total = 0; for (const s of segments) total += s.ms;
  const n = Math.round(SR * total / 1000);
  const out = new Float32Array(n);
  let si = 0, segStart = 0, phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i * 1000 / SR;
    while (si < segments.length - 1 && t >= segStart + segments[si].ms) { segStart += segments[si].ms; si++; }
    const s = segments[si];
    const f = typeof s.f === 'function' ? s.f(t - segStart) : s.f;
    phase += 2 * Math.PI * f / SR;
    out[i] = Math.sin(phase);
  }
  return out;
}
const ycc = (r, g, b) => [0.299*r + 0.587*g + 0.114*b, 128 - 0.169*r - 0.331*g + 0.5*b, 128 + 0.5*r - 0.419*g - 0.081*b];
const fOf = (v) => 1500 + Math.max(0, Math.min(255, v)) / 255 * 800;
function specRobot36(img) {
  const segs = [{ f: 1900, ms: 300 }, { f: 1200, ms: 10 }, { f: 1900, ms: 300 }, { f: 1200, ms: 30 }];
  let par = 0;
  for (let b = 0; b < 7; b++) { const bit = (8 >> b) & 1; par ^= bit; segs.push({ f: bit ? 1100 : 1300, ms: 30 }); }
  segs.push({ f: par ? 1100 : 1300, ms: 30 }, { f: 1200, ms: 30 });
  for (let y = 0; y < H; y++) {
    const row = (x) => { const i = (y * W + x) * 4; return ycc(img[i], img[i + 1], img[i + 2]); };
    const even = y % 2 === 0;
    segs.push({ f: 1200, ms: 9 }, { f: 1500, ms: 3 });
    segs.push({ f: (t) => fOf(row(Math.min(W - 1, Math.floor(t / 88 * W)))[0]), ms: 88 });
    segs.push({ f: even ? 1500 : 2300, ms: 4.5 }, { f: 1900, ms: 1.5 });
    segs.push({ f: (t) => { const c = row(Math.min(W - 1, Math.floor(t / 44 * 160) * 2)); return fOf(even ? c[2] : c[1]); }, ms: 44 });
  }
  segs.push({ f: 0, ms: 300 });
  return synth(segs);
}
function decode(samples) {
  const pad = new Float32Array(samples.length + SR);
  pad.set(samples, SR / 2);
  const d = new SstvDecoder();
  let img = null;
  for (let i = 0; i < pad.length; i += 4096) {
    for (const r of d.processSamples(pad.subarray(i, Math.min(i + 4096, pad.length)))) if (r.type === 'rx-image') img = r;
  }
  return img;
}
function barMeans(out) {
  return COLORS.map((_, b) => {
    const s = [0, 0, 0]; let n = 0;
    for (let y = 40; y < 200; y++) for (let x = b * 40 + 12; x < b * 40 + 28; x++) {
      const i = (y * W + x) * 4; s[0] += out[i]; s[1] += out[i + 1]; s[2] += out[i + 2]; n++;
    }
    return s.map((v) => v / n);
  });
}
const src = makeImg();
const spec = specRobot36(src);
check('our encoder sends the spec line: 150 ms', () => {
  const ours = encodeImage(src, W, H, 'robot36');
  // Same image data length as the independent spec signal, within a few samples
  // (VIS framing aside): image part = 240 x 150 ms.
  const imageMs = (ours.length / SR) * 1000;
  const specMs = (spec.length / SR) * 1000 - 300; // spec adds 300 ms of silence
  assert.ok(Math.abs(imageMs - specMs) < 5, `ours ${imageMs.toFixed(1)} ms vs spec ${specMs.toFixed(1)} ms`);
});
check('a spec-timed Robot 36 decodes in colour (every bar its own colour, no green cast)', () => {
  const img = decode(spec);
  assert.ok(img, 'an image (the lock was kept)');
  const means = barMeans(img.imageData);
  means.forEach((m, b) => {
    const want = COLORS[b];
    const err = Math.max(...m.map((v, k) => Math.abs(v - want[k])));
    assert.ok(err < 45, `bar ${b} want ${want} got ${m.map(Math.round)}`);
  });
});
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
