#!/usr/bin/env node
'use strict';
/**
 * Scottie, PD and Robot 72 against INDEPENDENTLY synthesised, spec-timed
 * signals (the timings MMSSTV and slowrx send), the way
 * test/sstv-robot36-spec-test.js checks Robot 36.
 *
 * Each scan used to be built pixel by pixel, every pixel rounded to whole
 * samples at 48 kHz, so a whole scan came out 1.2 to 2% long or short
 * (Scottie 1: 21 samples for a 20.736-sample pixel, 140.0 ms for 138.24).
 * Encoder and decoder shared the mistake, so the quality matrix, which decodes
 * our own encoder, never saw it. Robot 72 also had the Robot 36 porch bug:
 * the 1.5 ms 1900 Hz porch belongs after each separator, before the chroma,
 * not 4.5 ms at the end of the line.
 *
 * For each mode: our transmit is the spec length, and a spec-timed picture
 * decodes with every colour bar its own colour.
 */
const assert = require('assert');
const { SstvDecoder, encodeImage } = require('../lib/sstv-worker');
const { MODES } = require('../lib/sstv-modes');
const SR = 48000;
let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

const COLORS = [[255,0,0],[0,255,0],[0,0,255],[255,255,0],[0,255,255],[255,0,255],[255,255,255],[64,64,64]];
function makeImg(W, H) {
  const img = new Uint8ClampedArray(W * H * 4);
  const bw = W / 8;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const [r, g, b] = COLORS[Math.min(7, Math.floor(x / bw))];
    const i = (y * W + x) * 4; img[i] = r; img[i + 1] = g; img[i + 2] = b; img[i + 3] = 255;
  }
  return img;
}

// Continuous-phase FM synthesis from {f, ms} segments; f may be a function of
// the time (ms) into the segment, so a scan is timed by the clock, not by
// whole-sample pixels.
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

function header(vis) {
  const segs = [{ f: 1900, ms: 300 }, { f: 1200, ms: 10 }, { f: 1900, ms: 300 }, { f: 1200, ms: 30 }];
  let par = 0;
  for (let b = 0; b < 7; b++) { const bit = (vis >> b) & 1; par ^= bit; segs.push({ f: bit ? 1100 : 1300, ms: 30 }); }
  segs.push({ f: par ? 1100 : 1300, ms: 30 }, { f: 1200, ms: 30 });
  return segs;
}
// A scan of `scanMs` whose value at time t is pixel floor(t / scanMs * n).
const scan = (scanMs, n, val) => ({ f: (t) => fOf(val(Math.min(n - 1, Math.floor(t / scanMs * n)))), ms: scanMs });

// Spec line layouts (ms). Returns { segs, imageMs }.
const SPEC = {
  scottie(mode, img, scanMs) {
    const W = mode.width, H = mode.height;
    const segs = header(mode.visCode);
    segs.push({ f: 1200, ms: 9 }); // the one starting sync MMSSTV sends before line 0
    const px = (y, x) => { const i = (y * W + x) * 4; return [img[i], img[i + 1], img[i + 2]]; };
    for (let y = 0; y < H; y++) {
      segs.push({ f: 1500, ms: 1.5 }, scan(scanMs, W, (x) => px(y, x)[1]));
      segs.push({ f: 1500, ms: 1.5 }, scan(scanMs, W, (x) => px(y, x)[2]));
      segs.push({ f: 1200, ms: 9 }, { f: 1500, ms: 1.5 }, scan(scanMs, W, (x) => px(y, x)[0]));
    }
    return { segs, lineMs: 6 + 3 * scanMs + 9 - 3 + 1.5 };
  },
  pd(mode, img, scanMs) {
    const W = mode.width, H = mode.height;
    const segs = header(mode.visCode);
    const c = (y, x) => { const i = (y * W + x) * 4; return ycc(img[i], img[i + 1], img[i + 2]); };
    for (let y = 0; y < H; y += 2) {
      const y1 = Math.min(y + 1, H - 1);
      segs.push({ f: 1200, ms: 20 }, { f: 1500, ms: 2.08 });
      segs.push(scan(scanMs, W, (x) => c(y, x)[0]));
      segs.push(scan(scanMs, W, (x) => (c(y, x)[2] + c(y1, x)[2]) / 2));
      segs.push(scan(scanMs, W, (x) => (c(y, x)[1] + c(y1, x)[1]) / 2));
      segs.push(scan(scanMs, W, (x) => c(y1, x)[0]));
    }
    return { segs };
  },
  robot72(mode, img) {
    const W = mode.width, H = mode.height;
    const segs = header(mode.visCode);
    const c = (y, x) => { const i = (y * W + x) * 4; return ycc(img[i], img[i + 1], img[i + 2]); };
    for (let y = 0; y < H; y++) {
      segs.push({ f: 1200, ms: 9 }, { f: 1500, ms: 3 }, scan(138, W, (x) => c(y, x)[0]));
      segs.push({ f: 1500, ms: 4.5 }, { f: 1900, ms: 1.5 }, scan(69, W, (x) => c(y, x)[2]));
      segs.push({ f: 2300, ms: 4.5 }, { f: 1900, ms: 1.5 }, scan(69, W, (x) => c(y, x)[1]));
    }
    return { segs };
  },
};

// Spec image length (ms), header excluded.
const SPEC_LINE_MS = {
  scottie1: 9 + 256 * (1.5 + 138.24 + 1.5 + 138.24 + 9 + 1.5 + 138.24),
  scottie2: 9 + 256 * (1.5 + 88.064 + 1.5 + 88.064 + 9 + 1.5 + 88.064),
  pd90: 128 * (20 + 2.08 + 4 * 170.24),
  pd120: 248 * (20 + 2.08 + 4 * 121.6),
  pd180: 248 * (20 + 2.08 + 4 * 183.04),
  robot72: 240 * 300,
};
const HEADER_MS = 300 + 10 + 300 + 30 + 8 * 30 + 30;

const CASES = [
  { key: 'scottie1', spec: (m, img) => SPEC.scottie(m, img, 138.24), startSync: 9 },
  { key: 'scottie2', spec: (m, img) => SPEC.scottie(m, img, 88.064), startSync: 9 },
  { key: 'pd90', spec: (m, img) => SPEC.pd(m, img, 170.24) },
  { key: 'pd120', spec: (m, img) => SPEC.pd(m, img, 121.6) },
  { key: 'pd180', spec: (m, img) => SPEC.pd(m, img, 183.04) },
  { key: 'robot72', spec: (m, img) => SPEC.robot72(m, img) },
];

function decode(samples) {
  const pad = new Float32Array(samples.length + SR);
  pad.set(samples, SR / 2);
  const d = new SstvDecoder();
  let img = null;
  for (let i = 0; i < pad.length; i += 4096) {
    for (const r of d.processSamples(new Float32Array(pad.subarray(i, Math.min(i + 4096, pad.length))))) if (r.type === 'rx-image') img = r;
  }
  return img;
}
function barMeans(out, W, H) {
  const bw = W / 8;
  return COLORS.map((_, b) => {
    const s = [0, 0, 0]; let n = 0;
    for (let y = Math.floor(H * 0.15); y < Math.floor(H * 0.85); y++) {
      for (let x = Math.floor(b * bw + bw * 0.3); x < Math.floor(b * bw + bw * 0.7); x++) {
        const i = (y * W + x) * 4; s[0] += out[i]; s[1] += out[i + 1]; s[2] += out[i + 2]; n++;
      }
    }
    return s.map((v) => v / n);
  });
}

for (const c of CASES) {
  const mode = MODES[c.key];
  const W = mode.width, H = mode.height;
  const src = makeImg(W, H);
  check(`${mode.name}: our transmit is the spec length (${(SPEC_LINE_MS[c.key] / 1000).toFixed(2)} s of picture)`, () => {
    const ours = encodeImage(src, W, H, c.key);
    // Our encoder sends no starting sync for Scottie; compare the picture lines.
    const imageMs = ours.length / SR * 1000 - HEADER_MS;
    const want = SPEC_LINE_MS[c.key] - (c.startSync || 0);
    assert.ok(Math.abs(imageMs - want) < 0.001 * want + 2, `ours ${imageMs.toFixed(1)} ms vs spec ${want.toFixed(1)} ms (${((imageMs / want - 1) * 100).toFixed(2)}%)`);
  });
  check(`${mode.name}: a spec-timed picture decodes with every colour bar its own colour`, () => {
    const img = decode(synth(c.spec(mode, src).segs.concat([{ f: 0, ms: 300 }])));
    assert.ok(img, 'no image (the lock was lost)');
    const means = barMeans(img.imageData, W, H);
    const bad = [];
    means.forEach((m, b) => {
      const want = COLORS[b];
      const err = Math.max(...m.map((v, k) => Math.abs(v - want[k])));
      if (err >= 45) bad.push(`bar ${b} want ${want} got ${m.map(Math.round)}`);
    });
    assert.ok(!bad.length, bad.join('; '));
  });
}

console.log(`\nSSTV spec timing: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
