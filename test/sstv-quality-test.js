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

// Add Gaussian white noise to a sample buffer at a target SNR (dB
// relative to signal RMS). The encoder produces sine waves with peak
// 1.0 / RMS ≈ 0.707. We measure the actual signal RMS and scale noise
// to hit the requested SNR. Box-Muller for the Gaussian samples;
// seeded LCG so noise tests are deterministic.
function addNoise(samples, snrDb, seed) {
  if (snrDb == null || snrDb >= 200) return samples;
  // Signal RMS
  let sumSq = 0;
  for (let i = 0; i < samples.length; i++) sumSq += samples[i] * samples[i];
  const sigRms = Math.sqrt(sumSq / samples.length);
  // Target noise RMS
  const targetNoiseRms = sigRms * Math.pow(10, -snrDb / 20);
  // Seeded LCG (Numerical Recipes constants) for reproducible noise
  let s = (seed || 1) >>> 0;
  function rand() {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  }
  // Box-Muller pairs
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i += 2) {
    const u1 = Math.max(1e-12, rand());
    const u2 = rand();
    const mag = Math.sqrt(-2 * Math.log(u1)) * targetNoiseRms;
    const z0 = mag * Math.cos(2 * Math.PI * u2);
    const z1 = mag * Math.sin(2 * Math.PI * u2);
    out[i] = samples[i] + z0;
    if (i + 1 < samples.length) out[i + 1] = samples[i + 1] + z1;
  }
  return out;
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
  const snrDb = opts.snrDb;
  const mode = MODES[modeKey];
  const srcImg = makeTestImage(mode.width, mode.height);
  let samples = encodeImage(srcImg, mode.width, mode.height, modeKey);
  // Pad
  const padSamples = Math.round(SAMPLE_RATE * 0.3);
  const padded = new Float32Array(samples.length + padSamples * 2);
  padded.set(samples, padSamples);
  samples = padded;
  if (drift) samples = addClockDrift(samples, drift);
  if (snrDb != null) samples = addNoise(samples, snrDb, opts.noiseSeed || 1);
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

  // Noise robustness cells (added 2026-05-31). Deterministic
  // Gaussian noise injected after encode at the specified SNR (seed=1).
  // Locks in current noise-floor behavior — any future change that
  // breaks weak-signal decoding gets caught.
  //
  // SNR is dB of signal RMS over noise RMS. Real-world weak-SSTV
  // sits in the 10–20 dB SNR range; below 5 dB even MMSSTV
  // struggles, so we stop the matrix there.
  //
  // ANOMALY: robot36 @ 30dB seed=1 produces 15.4 dB PSNR — WORSE than
  // 20dB SNR (24.3 dB) on the same seed. With seed=42 it's 25.2 dB.
  // This is a noise-pattern sensitivity in robot36's sync detection
  // (probe-noise.js confirms). Baseline captures current reality; a
  // future sync-detection fix should raise this floor.
  { mode: 'martin1',  drift: 0, snrDb: 30, baseline: 41.9 },
  { mode: 'martin1',  drift: 0, snrDb: 20, baseline: 35.3 },
  { mode: 'scottie1', drift: 0, snrDb: 30, baseline: 40.7 },
  { mode: 'scottie1', drift: 0, snrDb: 20, baseline: 34.6 },
  { mode: 'scottie2', drift: 0, snrDb: 30, baseline: 31.3 },
  { mode: 'scottie2', drift: 0, snrDb: 20, baseline: 29.1 },
  { mode: 'scottie2', drift: 0, snrDb: 10, baseline: 22.6 },
  // robot36 @ 30dB SNR seed=1 — lifted 2026-05-31 from 15.4 → 24.9 dB
  // by gating late-trigger slant updates on a "drift detected" flag
  // (only run lines 128+ if line-12 correction was >300 ppm). The
  // seed=1 noise was tricking the late regressor into applying fake
  // slope; YCbCr modes have noisy enough per-line sync that late
  // triggers were over-correcting on it.
  { mode: 'robot36',  drift: 0, snrDb: 30, baseline: 24.9 },
  { mode: 'robot36',  drift: 0, snrDb: 20, baseline: 24.3 },
  { mode: 'robot36',  drift: 0, snrDb: 10, baseline: 19.6 },
  { mode: 'robot72',  drift: 0, snrDb: 30, baseline: 28.4 },
  { mode: 'robot72',  drift: 0, snrDb: 20, baseline: 26.5 },
  { mode: 'pd180',    drift: 0, snrDb: 30, baseline: 14.2 },
  { mode: 'pd180',    drift: 0, snrDb: 20, baseline: 14.1 },
  { mode: 'pd180',    drift: 0, snrDb: 10, baseline: 13.0 },
];

function fmtDrift(d) {
  if (d === 0) return '   0ppm';
  return (d > 0 ? '+' : '') + d + 'ppm';
}

let pass = 0;
let fail = 0;
let regressions = [];

console.log('SSTV PSNR regression matrix (tolerance: ±' + TOLERANCE_DB + ' dB)\n');

function fmtCond(cell) {
  const d = fmtDrift(cell.drift);
  if (cell.snrDb != null) return `${d} snr=${(cell.snrDb + 'dB').padStart(4)}`;
  return d;
}

for (const cell of BASELINES) {
  const r = decodeOne(cell.mode, { drift: cell.drift, snrDb: cell.snrDb });
  const floor = cell.baseline - TOLERANCE_DB;
  const psnrStr = r.psnr == null ? '---' : r.psnr.toFixed(2);
  const baselineStr = cell.baseline.toFixed(1);
  const ok = r.psnr != null && r.psnr >= floor;
  if (ok) {
    pass++;
    console.log(`  ✓ [${cell.mode.padEnd(8)}] ${fmtCond(cell)}  ${psnrStr} dB  (baseline ${baselineStr}, floor ${floor.toFixed(1)})`);
  } else {
    fail++;
    regressions.push({ cell, actual: r.psnr });
    console.log(`  ✗ [${cell.mode.padEnd(8)}] ${fmtCond(cell)}  ${psnrStr} dB  REGRESSION (baseline ${baselineStr}, floor ${floor.toFixed(1)})`);
  }
}

// =====================================================================
// Non-SSTV audio false-emit guard
// =====================================================================
//
// Background: commit bd7c629 (2026-05-28) fixed a ~3-week regression
// where the SmartSDR Direct VITA-49 audio path delivered band noise
// that false-locked the leader detector. The decoder would lock a
// bogus mode and grind through a 1–3 min decode while real SSTV
// headers passed by. Root cause was downstream of just the leader
// detector (multi-gate chain); the specific fix added std-and-mean
// frequency-purity tests to the leader gate.
//
// This guard feeds two synthesized non-SSTV inputs and asserts the
// decoder NEVER emits an rx-image event. It catches the broader
// class of "decoder false-emits from non-SSTV audio" — that's the
// user-visible symptom, regardless of which gate (leader, VIS, or
// decode-quality) is the line of defense in any future version.
//
// It does NOT specifically reproduce the exact SmartSDR Direct
// noise spectrum that caused the original bug — that would require
// a fixture WAV recording of real radio band noise. Hard to ship in
// a unit test. The downstream filters (VIS bit pattern, sync≥50%
// gate) catch the synthesized inputs below even if the leader gate
// is widened — so this guard tests the SYSTEM property, not the
// specific gate. Don't relax it to make it pass without thinking.
console.log('\nNon-SSTV audio false-emit guard:');
{
  // Load the real SmartSDR Direct VITA-49 capture that caused the
  // original ~3-week SSTV-no-decode regression. Stored as raw int16 LE
  // PCM @ 24 kHz mono, 10 s.
  //
  // Verified 2026-05-31 via scripts/probe-capture.js: this fixture
  // exercises the bd7c629 leader-purity gate. At 2.0 s and 7.9 s into
  // the capture, the gate fires with "mean=1759Hz std=532Hz" — exactly
  // matching the bd7c629 commit's recorded values ("band noise:
  // mean≈1747 Hz, std≈537 Hz"). The fixture is the genuine article.
  //
  // Note that the test is a SYSTEM-level guard, not a single-gate
  // guard: today's decoder has additional downstream defenses (MAD
  // slant regressor, width-validated sync, drift-detector gating)
  // beyond the May 28 leader-purity fix. To fail this test, a
  // regression would have to defeat ALL the gates that combine to
  // reject this specific real-world noise pattern. That's actually
  // the right shape: defense in depth. Don't tune the fixture or
  // weaken the assertion to make a regression pass.
  function loadRadioCapture() {
    const fs = require('fs');
    const path = require('path');
    const file = path.join(__dirname, 'fixtures', 'sstv-smartsdr-direct-noise-24k.pcm');
    const pcm = fs.readFileSync(file);
    const inLen = pcm.length / 2;
    // Upsample 24 kHz → 48 kHz via linear interp (factor 2) — same
    // upsampler the main app uses for SmartSDR Direct audio.
    const out = new Float32Array(inLen * 2);
    for (let i = 0; i < inLen; i++) {
      const s0 = pcm.readInt16LE(i * 2) / 32768;
      const s1 = i + 1 < inLen ? pcm.readInt16LE((i + 1) * 2) / 32768 : s0;
      out[i * 2]     = s0;
      out[i * 2 + 1] = (s0 + s1) * 0.5;
    }
    return out;
  }
  const checks = [
    {
      name: 'real SmartSDR Direct band-noise capture (10 s, the bd7c629 regression)',
      generate: loadRadioCapture,
    },
    {
      name: 'pure white Gaussian noise (rms 0.5, 30 s, seed=1)',
      generate: () => {
        const N = SAMPLE_RATE * 30;
        const noise = new Float32Array(N);
        let s = 1 >>> 0;
        for (let i = 0; i < N; i += 2) {
          s = (s * 1664525 + 1013904223) >>> 0;
          const u1 = Math.max(1e-12, s / 4294967296);
          s = (s * 1664525 + 1013904223) >>> 0;
          const u2 = s / 4294967296;
          const mag = Math.sqrt(-2 * Math.log(u1)) * 0.5;
          noise[i] = mag * Math.cos(2 * Math.PI * u2);
          if (i + 1 < N) noise[i + 1] = mag * Math.sin(2 * Math.PI * u2);
        }
        return noise;
      },
    },
    {
      name: 'jittered 1900 Hz pseudo-leader (±500 Hz, 30 s)',
      generate: () => {
        const N = SAMPLE_RATE * 30;
        const out = new Float32Array(N);
        let s = 1 >>> 0;
        let phase = 0;
        for (let i = 0; i < N; i++) {
          s = (s * 1664525 + 1013904223) >>> 0;
          const jitter = ((s / 2147483648) - 1) * 500;
          phase += 2 * Math.PI * (1900 + jitter) / SAMPLE_RATE;
          out[i] = 0.5 * Math.sin(phase);
        }
        return out;
      },
    },
  ];
  for (const check of checks) {
    const samples = check.generate();
    const dec = new SstvDecoder();
    const images = [];
    for (let i = 0; i < samples.length; i += CHUNK) {
      const out = dec.processSamples(new Float32Array(samples.subarray(i, Math.min(i + CHUNK, samples.length))));
      for (const r of out) if (r.type === 'rx-image') images.push(r);
    }
    if (images.length === 0) {
      pass++;
      console.log(`  ✓ ${check.name} → 0 rx-image events`);
    } else {
      fail++;
      regressions.push({
        cell: { mode: 'noise-false-emit', drift: 0, baseline: 0 },
        actual: images.length,
      });
      console.log(`  ✗ FALSE-EMIT REGRESSION: ${check.name} → ${images.length} bogus rx-image event(s)`);
    }
  }
}

console.log('\n' + '='.repeat(60));
console.log(`Results: ${pass} passed, ${fail} regressions`);
if (fail > 0) {
  console.log('\nFAILURES:');
  for (const r of regressions) {
    const drop = r.cell.baseline - (r.actual == null ? 0 : r.actual);
    console.log(`  ${r.cell.mode} ${fmtCond(r.cell)}: dropped ${drop.toFixed(2)} dB (got ${r.actual == null ? 'NULL' : r.actual.toFixed(2)}, baseline ${r.cell.baseline.toFixed(1)})`);
  }
  process.exit(1);
}
console.log('No regressions — quality matrix matches baseline.');
process.exit(0);
