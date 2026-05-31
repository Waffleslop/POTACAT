#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';
//
// SSTV PSNR regression test — locks the decoder's quality matrix
// against drift so future changes can't silently degrade it.
//
// Runs ~30s. Sibling to scripts/test-sstv.js (which is the broader
// experimental harness with verbose output); this file is the
// CI-friendly "did we regress" gate. Baselines are the post-Phase-2
// state on 2026-05-31; if a future fix legitimately raises a score,
// update the baseline (and ratchet the floor up — never widen
// tolerance to admit a regression).
//
// Floor = baseline - TOLERANCE_DB. Each cell logs "OK at X dB
// (≥ floor Y)" or "REGRESSION X < Y".
// =====================================================================

const { SstvDecoder, encodeImage } = require('../lib/sstv-worker');
const { MODES } = require('../lib/sstv-modes');

const SAMPLE_RATE = 48000;
const CHUNK = 4096;
const TOLERANCE_DB = 1.0;

// ---- Test image (8 vertical color bars + luminance gradient) ----
function makeTestImage(w, h) {
  const img = new Uint8ClampedArray(w * h * 4);
  const colors = [
    [255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0],
    [0, 255, 255], [255, 0, 255], [255, 255, 255], [64, 64, 64],
  ];
  for (let y = 0; y < h; y++) {
    const shade = 1 - 0.3 * (y / h);
    for (let x = 0; x < w; x++) {
      const bar = Math.min(7, Math.floor(x / (w / 8)));
      const [r, g, b] = colors[bar];
      const i = (y * w + x) * 4;
      img[i]     = Math.round(r * shade);
      img[i + 1] = Math.round(g * shade);
      img[i + 2] = Math.round(b * shade);
      img[i + 3] = 255;
    }
  }
  return img;
}

function imageMSE(a, b, w, h) {
  let sum = 0;
  const n = w * h * 3;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const dr = a[i] - b[i];
      const dg = a[i + 1] - b[i + 1];
      const db = a[i + 2] - b[i + 2];
      sum += dr * dr + dg * dg + db * db;
    }
  }
  return sum / n;
}
function psnr(mse) {
  if (mse === 0) return Infinity;
  return 10 * Math.log10(255 * 255 / mse);
}

// Linear-interp resample to simulate encoder-clock drift (in ppm).
function addClockDrift(samples, driftPpm) {
  if (driftPpm === 0) return samples;
  const factor = 1 + driftPpm * 1e-6;
  const outLen = Math.round(samples.length / factor);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const srcIdx = i * factor;
    const i0 = Math.floor(srcIdx);
    const i1 = Math.min(i0 + 1, samples.length - 1);
    const frac = srcIdx - i0;
    out[i] = samples[i0] * (1 - frac) + samples[i1] * frac;
  }
  return out;
}

function decodeOne(modeKey, opts) {
  opts = opts || {};
  const drift = opts.drift || 0;
  const mode = MODES[modeKey];
  const srcImg = makeTestImage(mode.width, mode.height);
  let samples = encodeImage(srcImg, mode.width, mode.height, modeKey);
  // Pad
  const padSamples = Math.round(SAMPLE_RATE * 0.3);
  const padded = new Float32Array(samples.length + padSamples * 2);
  padded.set(samples, padSamples);
  samples = padded;
  if (drift) samples = addClockDrift(samples, drift);
  const decoder = new SstvDecoder();
  let finalImage = null;
  for (let i = 0; i < samples.length; i += CHUNK) {
    const chunk = samples.subarray(i, Math.min(i + CHUNK, samples.length));
    const results = decoder.processSamples(new Float32Array(chunk));
    for (const r of results) {
      if (r.type === 'rx-image') finalImage = r;
    }
  }
  if (!finalImage) return { ok: false, psnr: null, mode: modeKey };
  return {
    ok: true,
    psnr: psnr(imageMSE(srcImg, finalImage.imageData, mode.width, mode.height)),
    mode: modeKey,
    twoPass: finalImage.stats && finalImage.stats.twoPass,
  };
}

// ---- Baseline PSNR floor (dB) ----
// "Baseline" is what the decoder produces today. Floor = baseline -
// TOLERANCE_DB. ANY future change that pushes a cell below its floor
// fails the test. To raise a baseline (legitimate improvement),
// edit this table.
//
// Layout: { mode, drift } → expected PSNR
const BASELINES = [
  // Clean (drift = 0)
  { mode: 'martin1',  drift: 0,    baseline: 44.4 },
  { mode: 'scottie1', drift: 0,    baseline: 40.8 },
  { mode: 'scottie2', drift: 0,    baseline: 31.4 },
  { mode: 'robot36',  drift: 0,    baseline: 25.0 },
  { mode: 'robot72',  drift: 0,    baseline: 28.9 },
  // Drift ±500 ppm
  { mode: 'martin1',  drift:  500, baseline: 26.6 },
  { mode: 'martin1',  drift: -500, baseline: 28.8 },
  { mode: 'scottie1', drift:  500, baseline: 28.7 },
  { mode: 'scottie1', drift: -500, baseline: 24.6 },
  { mode: 'scottie2', drift:  500, baseline: 22.1 },
  { mode: 'scottie2', drift: -500, baseline: 24.0 },
  { mode: 'robot36',  drift:  500, baseline: 18.9 },
  { mode: 'robot36',  drift: -500, baseline: 19.3 },
  { mode: 'robot72',  drift:  500, baseline: 20.4 },
  // Drift ±1000 ppm (Phase 1 two-pass closed Martin/Scottie)
  { mode: 'martin1',  drift: 1000, baseline: 25.4 },
  { mode: 'scottie1', drift: 1000, baseline: 25.1 },
  { mode: 'scottie2', drift: 1000, baseline: 26.9 },
  { mode: 'robot36',  drift: 1000, baseline: 20.9 },
  { mode: 'robot72',  drift: 1000, baseline: 21.6 },
  // Drift ±2000 ppm (severe; expected to be marginal)
  { mode: 'martin1',  drift:  2000, baseline: 31.4 },
  { mode: 'scottie1', drift:  2000, baseline: 27.1 },
  { mode: 'scottie1', drift: -2000, baseline: 29.8 },
  { mode: 'scottie2', drift:  2000, baseline: 25.5 },
  { mode: 'scottie2', drift: -2000, baseline: 25.4 },
  // PD modes (new in this commit — encoder existed, decoder added
  // 2026-05-31). PSNRs are low because PD's averaged-chroma
  // line-pair structure inherently loses some information; the
  // ceiling is content-dependent. Floors here lock in "the decoder
  // produces a recognizable image" — future improvements to
  // chroma upsampling or per-pixel sampling will raise these.
  // Baselines ratcheted up 2026-05-31 after MAD-based slant
  // regressor pass (4σ residual rejection in sstv-dsp.js) lifted
  // PD/Martin/Robot24 by 1–3 dB. Lock-in matrix: any future change
  // that drops these floors fails CI.
  { mode: 'pd90',  drift: 0, baseline: 13.4 },
  { mode: 'pd120', drift: 0, baseline: 11.8 },
  { mode: 'pd160', drift: 0, baseline: 13.8 },
  { mode: 'pd180', drift: 0, baseline: 14.2 },
  { mode: 'pd240', drift: 0, baseline: 14.9 },
  // Additional modes (added 2026-05-31). Martin M2/M3/M4, Scottie
  // DX, Robot 24 — reuse existing decoders, just new entries.
  { mode: 'martin2',   drift: 0, baseline: 30.1 },
  { mode: 'martin3',   drift: 0, baseline: 50.0 },  // small image, encode round-trips perfectly
  { mode: 'martin4',   drift: 0, baseline: 41.2 },
  { mode: 'scottieDx', drift: 0, baseline: 50.0 },  // slow scan, near-perfect
  { mode: 'robot24',   drift: 0, baseline: 24.3 },
];

function fmtDrift(d) {
  if (d === 0) return '   0ppm';
  return (d > 0 ? '+' : '') + d + 'ppm';
}

let pass = 0;
let fail = 0;
let regressions = [];

console.log('SSTV PSNR regression matrix (tolerance: ±' + TOLERANCE_DB + ' dB)\n');

for (const cell of BASELINES) {
  const r = decodeOne(cell.mode, { drift: cell.drift });
  const floor = cell.baseline - TOLERANCE_DB;
  const psnrStr = r.psnr == null ? '---' : r.psnr.toFixed(2);
  const baselineStr = cell.baseline.toFixed(1);
  const drift = fmtDrift(cell.drift);
  const ok = r.psnr != null && r.psnr >= floor;
  if (ok) {
    pass++;
    console.log(`  ✓ [${cell.mode.padEnd(8)}] drift=${drift}  ${psnrStr} dB  (baseline ${baselineStr}, floor ${floor.toFixed(1)})`);
  } else {
    fail++;
    regressions.push({ cell, actual: r.psnr });
    console.log(`  ✗ [${cell.mode.padEnd(8)}] drift=${drift}  ${psnrStr} dB  REGRESSION (baseline ${baselineStr}, floor ${floor.toFixed(1)})`);
  }
}

console.log('\n' + '='.repeat(60));
console.log(`Results: ${pass} passed, ${fail} regressions`);
if (fail > 0) {
  console.log('\nFAILURES:');
  for (const r of regressions) {
    const drop = r.cell.baseline - (r.actual == null ? 0 : r.actual);
    console.log(`  ${r.cell.mode} drift=${fmtDrift(r.cell.drift)}: dropped ${drop.toFixed(2)} dB (got ${r.actual == null ? 'NULL' : r.actual.toFixed(2)}, baseline ${r.cell.baseline.toFixed(1)})`);
  }
  process.exit(1);
}
console.log('No regressions — quality matrix matches baseline.');
process.exit(0);
