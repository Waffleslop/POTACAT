#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';
//
// SSTV reception under REALISTIC off-air conditions: an SSB receiver filter,
// noise measured inside that passband, a mistuned station, fading. It is a
// sibling to test/sstv-quality-test.js, which adds noise across the whole
// 48 kHz band (its "10 dB" is ~20 dB in a 2.4 kHz passband) and never
// mistunes. That blind spot hid a regression from 1.10.18 to 1.10.25:
//
//   - The input normaliser lifted band-limited noise past the leader gate,
//     and the idle leader lock averaged that noise into the station's tone:
//     pixels decoded 36-188 Hz off (dark, speckled or tinted images), e.g.
//     Scottie 1 in a 300-2700 Hz passband at 20 dB fell from 26 dB PSNR to 7.
//   - The 1.10.24 VIS bit-contrast gate rejected a station tuned 50-100 Hz
//     off in noise, and the late line-sync join that followed was dropped.
//
// Casey 2026-09-28: "I think our RX is broken. Nobody is getting good rx."
// Fixed by re-measuring the leader after the break and retuning before the
// VIS start bit (lib/sstv-worker.js _recalibrateFromLeader).
//
// Driven like production: a fresh SstvDecoder with no forced mode (VIS or
// sync auto-start), 48 kHz, 4096-sample chunks. Deterministic (seeded).
// Floor = baseline - TOLERANCE_DB. Raise a baseline when a change improves
// it; never lower one to admit a regression.
// Run: node test/sstv-realistic-rx-test.js
// =====================================================================

const { SstvDecoder, encodeImage } = require('../lib/sstv-worker');
const { MODES } = require('../lib/sstv-modes');

const SR = 48000;
const CHUNK = 4096;
const TOLERANCE_DB = 1.0;
const BP = [300, 2700, 40];

// ---------- deterministic noise ----------
function lcg(seed) {
  let s = (seed >>> 0) || 1;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
function gaussFill(out, seed) {
  const r = lcg(seed);
  for (let i = 0; i < out.length; i += 2) {
    const u1 = Math.max(1e-12, r()), u2 = r();
    const m = Math.sqrt(-2 * Math.log(u1));
    out[i] = m * Math.cos(2 * Math.PI * u2);
    if (i + 1 < out.length) out[i + 1] = m * Math.sin(2 * Math.PI * u2);
  }
  return out;
}

// ---------- FFT-based mistune + SSB filter ----------
function fft(re, im, inverse) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = 2 * Math.PI / len * (inverse ? 1 : -1);
    const wr = Math.cos(ang), wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k, b = a + half;
        const xr = re[b] * cr - im[b] * ci;
        const xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
  if (inverse) { for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; } }
}
function nextPow2(n) { let p = 1; while (p < n) p <<= 1; return p; }
function bpGain(f, lo, hi, tw) {
  const a = Math.abs(f);
  if (a <= lo - tw || a >= hi + tw) return 0;
  if (a >= lo && a <= hi) return 1;
  if (a < lo) return 0.5 - 0.5 * Math.cos(Math.PI * (a - (lo - tw)) / tw);
  return 0.5 + 0.5 * Math.cos(Math.PI * (a - hi) / tw);
}
// Frequency shift (analytic signal) and/or zero-phase band-pass.
function shiftAndFilter(x, shiftHz, bp) {
  const N = nextPow2(x.length);
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let i = 0; i < x.length; i++) re[i] = x[i];
  fft(re, im, false);
  if (shiftHz) {
    for (let k = 1; k < N / 2; k++) { re[k] *= 2; im[k] *= 2; }
    for (let k = N / 2 + 1; k < N; k++) { re[k] = 0; im[k] = 0; }
    fft(re, im, true);
    const w = 2 * Math.PI * shiftHz / SR;
    for (let i = 0; i < N; i++) {
      re[i] = re[i] * Math.cos(w * i) - im[i] * Math.sin(w * i);
      im[i] = 0;
    }
    if (!bp) { const out = new Float32Array(x.length); for (let i = 0; i < x.length; i++) out[i] = re[i]; return out; }
    fft(re, im, false);
  }
  if (bp) {
    for (let k = 0; k < N; k++) {
      const g = bpGain((k <= N / 2 ? k : k - N) * SR / N, bp[0], bp[1], bp[2]);
      re[k] *= g; im[k] *= g;
    }
  }
  fft(re, im, true);
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = re[i];
  return out;
}
function meanSq(x, a, b) { let s = 0; for (let i = a; i < b; i++) s += x[i] * x[i]; return s / (b - a); }

// ---------- images ----------
function makeBars(w, h) {
  const img = new Uint8ClampedArray(w * h * 4);
  const colors = [[255,0,0],[0,255,0],[0,0,255],[255,255,0],[0,255,255],[255,0,255],[255,255,255],[64,64,64]];
  for (let y = 0; y < h; y++) {
    const shade = 1 - 0.3 * (y / h);
    for (let x = 0; x < w; x++) {
      const [r, g, b] = colors[Math.min(7, Math.floor(x / (w / 8)))];
      const i = (y * w + x) * 4;
      img[i] = Math.round(r * shade); img[i + 1] = Math.round(g * shade); img[i + 2] = Math.round(b * shade); img[i + 3] = 255;
    }
  }
  return img;
}
// Photo-like: smooth mid-tones, lots of 1700-2000 Hz content near the leader.
function makePhoto(w, h) {
  const img = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const u = x / w, v = y / h;
    const i = (y * w + x) * 4;
    img[i] = 128 + 70 * Math.sin(6.3 * u + 1.1) * Math.cos(3.1 * v);
    img[i + 1] = 120 + 60 * Math.sin(4.7 * v + 0.3) + 30 * Math.cos(9 * u * v);
    img[i + 2] = 110 + 80 * Math.cos(5.3 * u - 2 * v);
    img[i + 3] = 255;
  }
  return img;
}
function psnr(a, b, w, h) {
  let s = 0;
  for (let i = 0; i < w * h; i++) {
    const j = i * 4;
    const dr = a[j] - b[j], dg = a[j + 1] - b[j + 1], db = a[j + 2] - b[j + 2];
    s += dr * dr + dg * dg + db * db;
  }
  const mse = s / (w * h * 3);
  return mse === 0 ? 99 : 10 * Math.log10(255 * 255 / mse);
}

// ---------- one received transmission ----------
// level = dBFS of the SSTV tone; snr = dB inside 300-2700 Hz vs the unfaded
// signal; shift = station mistuning in Hz; qsb = [Hz, depth dB]; lead = s of
// band noise before the VIS.
function receive(cell, seed) {
  const mode = MODES[cell.mode];
  const src = cell.img === 'photo' ? makePhoto(mode.width, mode.height) : makeBars(mode.width, mode.height);
  const enc = encodeImage(src, mode.width, mode.height, cell.mode);
  const lead = Math.round(SR * (cell.lead != null ? cell.lead : 0.3));
  const n = lead + enc.length + Math.round(SR * 5);
  let sig = new Float32Array(n);
  sig.set(enc, lead);
  if (cell.shift || cell.bp) sig = shiftAndFilter(sig, cell.shift || 0, cell.bp || null);
  if (cell.qsb) {
    const [fq, depth] = cell.qsb;
    for (let i = 0; i < n; i++) sig[i] *= Math.pow(10, -depth * (0.5 - 0.5 * Math.cos(2 * Math.PI * fq * i / SR)) / 20);
  }
  let out = sig;
  if (cell.snr != null) {
    const nb = shiftAndFilter(gaussFill(new Float32Array(n), seed), 0, BP);
    let ref = new Float32Array(n); ref.set(enc, lead);
    ref = shiftAndFilter(ref, cell.shift || 0, BP);
    const k = Math.sqrt(meanSq(ref, lead, lead + enc.length) / (meanSq(nb, lead, lead + enc.length) * Math.pow(10, cell.snr / 10)));
    out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = sig[i] + nb[i] * k;
  }
  const g = Math.pow(10, cell.level / 20);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, out[i] * g));
    x[i] = Math.round(v * 32767) / 32768; // 16-bit, as a sound card delivers it
  }
  const dec = new SstvDecoder();
  const events = [];
  for (let i = 0; i < x.length; i += CHUNK) {
    for (const r of dec.processSamples(x.slice(i, Math.min(i + CHUNK, x.length)))) if (r) events.push(r);
  }
  const vis = events.filter((e) => e.type === 'rx-vis');
  const lost = events.filter((e) => e.type === 'rx-lock-lost');
  const img = events.find((e) => e.type === 'rx-image' && e.mode === cell.mode);
  return {
    visLocked: vis.some((e) => e.mode === cell.mode && !e.auto),
    lost: lost.map((e) => `${e.mode}:${e.reason}`),
    psnr: img ? psnr(src, img.imageData, mode.width, mode.height) : null,
  };
}

// Baselines measured 2026-09-28 on the fixed decoder; `was` is what 1.10.25
// gave on the same audio (null = no image), so the size of each regression
// stays on record. The first three guard noise robustness in general: their
// generated noise happens not to trigger the leader bias, which the fixture
// case above pins instead.
const CELLS = [
  { id: 'Scottie 1, SSB filter, 20 dB',               mode: 'scottie1', level: -12, bp: BP, snr: 20,                   base: 26.4, was: 26.6 },
  { id: 'Robot 36, SSB filter, 20 dB, fading',        mode: 'robot36',  level: -12, bp: BP, snr: 20, qsb: [0.3, 10],   base: 16.4, was: 16.6 },
  { id: 'Robot 36 photo, SSB filter, 20 dB, fading',  mode: 'robot36',  level: -12, bp: BP, snr: 20, qsb: [0.3, 10], img: 'photo', base: 16.9, was: 17.0 },
  { id: 'Martin 1, -100 Hz, SSB filter, 12 dB',       mode: 'martin1',  level: -12, bp: BP, snr: 12, shift: -100,     base: 19.2, was: null, needVis: true },
  { id: 'Scottie 1, +50 Hz, SSB filter, 12 dB',       mode: 'scottie1', level: -12, bp: BP, snr: 12, shift: 50,       base: 19.0, was: 15.6 },
  { id: 'Scottie 1, +100 Hz, SSB filter, 12 dB',      mode: 'scottie1', level: -12, bp: BP, snr: 12, shift: 100,      base: 18.8, was: null, needVis: true },
  { id: 'Scottie 1, +25 Hz, clean',                   mode: 'scottie1', level: -12, shift: 25,                        base: 39.0, was: 23.0 },
  { id: 'Martin 1, -100 Hz, -20 dBFS, 8 dB, 8 s lead', mode: 'martin1', level: -20, bp: BP, snr: 8, shift: -100, lead: 8, base: 15.2, was: 9.2, noLoss: true },
  { id: 'Martin 1 at -40 dBFS (WB8IMY level)',        mode: 'martin1',  level: -40,                                   base: 43.4, was: 43.4 },
];

let passed = 0, failed = 0;
console.log('SSTV realistic reception (SSB filter, in-band noise, mistuning, fading)');

// The main regression depends on the band noise heard just before the leader,
// so random noise rarely reproduces it. This fixture is the first 1.6 s of a
// Scottie 1 transmission through a 300-2700 Hz filter at 20 dB, correctly
// tuned, in which 1.10.25 accepted the preceding noise as leader and locked
// its pixel frequency 188 Hz low for the whole picture (PSNR 6.9 dB).
{
  const fs = require('fs');
  const path = require('path');
  const buf = fs.readFileSync(path.join(__dirname, 'fixtures', 'sstv-leader-after-noise-48k.i16'));
  const i16 = new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2);
  const x = new Float32Array(i16.length);
  for (let i = 0; i < x.length; i++) x[i] = i16[i] / 32768;
  const dec = new SstvDecoder();
  let vis = null;
  for (let i = 0; i < x.length; i += CHUNK) {
    for (const r of dec.processSamples(x.slice(i, Math.min(i + CHUNK, x.length)))) if (r && r.type === 'rx-vis') vis = r.mode;
  }
  const off = dec.freqOffset;
  if (vis === 'scottie1' && Math.abs(off) <= 15) {
    passed++;
    console.log(`  ok  noise just before the leader does not bias the lock: pixel offset ${off.toFixed(1)} Hz (1.10.25: -188 Hz)`);
  } else {
    failed++;
    console.log(`  REGRESSION noise before the leader biased the lock: VIS ${vis}, pixel offset ${off.toFixed(1)} Hz (want scottie1 within 15 Hz)`);
  }
}
let seed = 7001;
for (const cell of CELLS) {
  const t0 = Date.now();
  const r = receive(cell, seed++);
  const floor = cell.base - TOLERANCE_DB;
  const problems = [];
  if (r.psnr == null) problems.push('no image');
  else if (r.psnr < floor) problems.push(`PSNR ${r.psnr.toFixed(1)} < floor ${floor.toFixed(1)}`);
  if (cell.needVis && !r.visLocked) problems.push('VIS not decoded (joined late from line sync)');
  if (cell.noLoss && r.lost.length) problems.push(`lock dropped (${r.lost.join(', ')})`);
  const ms = Date.now() - t0;
  const was = cell.was == null ? 'no image' : `${cell.was} dB`;
  if (problems.length) {
    failed++;
    console.log(`  REGRESSION ${cell.id}: ${problems.join('; ')} [baseline ${cell.base}, 1.10.25 gave ${was}] (${ms} ms)`);
  } else {
    passed++;
    console.log(`  ok  ${cell.id}: ${r.psnr.toFixed(1)} dB (floor ${floor.toFixed(1)}; 1.10.25 gave ${was}) (${ms} ms)`);
  }
}
console.log(`\nSSTV realistic reception: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
