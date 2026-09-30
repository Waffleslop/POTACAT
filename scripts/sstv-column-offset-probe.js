#!/usr/bin/env node
'use strict';
// Where does each colour land horizontally? Encodes a picture whose columns
// are all different, decodes it through the real SstvDecoder (48 kHz, 4096
// chunks, auto-start like production) under a few channel conditions, and
// reports the per-channel column shift that best matches the source, plus
// the mean of the left 12 columns per channel (a "purple stripe" is green
// near zero there while red and blue are bright).
// Run: node scripts/sstv-column-offset-probe.js [mode...]
const { SstvDecoder, encodeImage } = require('../lib/sstv-worker');
const { MODES } = require('../lib/sstv-modes');
const SR = 48000;

function lcg(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
// A ramp per channel with different periods, bright on the right edge.
function makeTest(w, h) {
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
function nextPow2(n) { let p = 1; while (p < n) p <<= 1; return p; }
function fft(re, im, inv) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let b = n >> 1; for (; j & b; b >>= 1) j ^= b; j ^= b; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) {
    const a = 2 * Math.PI / len * (inv ? 1 : -1), wr = Math.cos(a), wi = Math.sin(a), h = len >> 1;
    for (let i = 0; i < n; i += len) { let cr = 1, ci = 0; for (let k = 0; k < h; k++) { const p = i + k, q = p + h; const xr = re[q] * cr - im[q] * ci, xi = re[q] * ci + im[q] * cr; re[q] = re[p] - xr; im[q] = im[p] - xi; re[p] += xr; im[p] += xi; const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t; } }
  }
  if (inv) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}
// Band-pass (zero phase) and an optional causal all-pass-ish delay spread
// modelled as a gentle group delay ramp across the passband, like a crystal
// SSB filter: `gdMs` = extra delay at the passband edges vs the centre.
function channel(x, bp, gdMs) {
  const N = nextPow2(x.length), re = new Float64Array(N), im = new Float64Array(N);
  for (let i = 0; i < x.length; i++) re[i] = x[i];
  fft(re, im, false);
  for (let k = 0; k < N; k++) {
    const f = (k <= N / 2 ? k : k - N) * SR / N, a = Math.abs(f);
    let g = 1;
    if (bp) { g = a < bp[0] - 40 || a > bp[1] + 40 ? 0 : a < bp[0] ? 0.5 - 0.5 * Math.cos(Math.PI * (a - bp[0] + 40) / 40) : a > bp[1] ? 0.5 + 0.5 * Math.cos(Math.PI * (a - bp[1]) / 40) : 1; }
    let ph = 0;
    if (gdMs) {
      // group delay tau(f) = gdMs * ((f - 1500)/1200)^2 seconds*1e-3 -> phase = -2pi * integral tau df
      const c = 1500, span = 1200, t0 = gdMs / 1000;
      const u = (a - c) / span;
      ph = -2 * Math.PI * t0 * span * (u * u * u / 3 + 1 / 3); // integral of t0*u^2 d(a)
      if (f < 0) ph = -ph;
    }
    const cr = Math.cos(ph) * g, ci = Math.sin(ph) * g;
    const r = re[k] * cr - im[k] * ci, m = re[k] * ci + im[k] * cr; re[k] = r; im[k] = m;
  }
  fft(re, im, true);
  const out = new Float32Array(x.length); for (let i = 0; i < x.length; i++) out[i] = re[i]; return out;
}
function run(modeName, cond) {
  const mode = MODES[modeName];
  const src = makeTest(mode.width, mode.height);
  const enc = encodeImage(src, mode.width, mode.height, modeName);
  const lead = SR * 0.3, n = lead + enc.length + SR * 4;
  let sig = new Float32Array(n); sig.set(enc, lead);
  if (cond.bp || cond.gd) sig = channel(sig, cond.bp, cond.gd);
  if (cond.snr != null) { const r = lcg(3); for (let i = 0; i < n; i++) { const u = Math.max(1e-12, r()), v = r(); sig[i] += 0.3 * Math.pow(10, -cond.snr / 20) * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); } }
  const dec = new SstvDecoder(); let img = null;
  for (let i = 0; i < n; i += 4096) for (const e of dec.processSamples(sig.slice(i, Math.min(n, i + 4096)))) if (e && e.type === 'rx-image' && e.mode === modeName) img = e.imageData;
  if (!img) return modeName + ' ' + cond.name + ': no image';
  const w = mode.width, h = mode.height, y0 = Math.floor(h * 0.3), y1 = Math.floor(h * 0.7);
  const best = [0, 1, 2].map((c) => {
    let bestS = 0, bestE = 1e18;
    for (let s = -20; s <= 20; s++) {
      let e = 0, cnt = 0;
      for (let y = y0; y < y1; y += 3) for (let x = 25; x < w - 25; x++) { const d = img[(y * w + x) * 4 + c] - src[(y * w + x - s) * 4 + c]; e += d * d; cnt++; }
      if (e / cnt < bestE) { bestE = e / cnt; bestS = s; }
    }
    return bestS;
  });
  const left = [0, 1, 2].map((c) => { let s = 0, k = 0; for (let y = y0; y < y1; y++) for (let x = 0; x < 12; x++) { s += img[(y * w + x) * 4 + c]; k++; } return Math.round(s / k); });
  return `${modeName.padEnd(9)} ${cond.name.padEnd(26)} shift R/G/B = ${best.join('/').padEnd(10)} left12 mean R/G/B = ${left.join('/')}`;
}
const modes = process.argv.slice(2).length ? process.argv.slice(2) : ['martin1', 'martin2', 'scottie1'];
const conds = [
  { name: 'clean' },
  { name: 'SSB 300-2700' , bp: [300, 2700] },
  { name: 'SSB + 1 ms edge delay', bp: [300, 2700], gd: 1 },
  { name: 'SSB + 2 ms edge delay, 20 dB', bp: [300, 2700], gd: 2, snr: 20 },
];
for (const m of modes) for (const c of conds) console.log(run(m, c));
