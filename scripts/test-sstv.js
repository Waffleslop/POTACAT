'use strict';
// ---------------------------------------------------------------------------
// SSTV encode/decode test harness
// ---------------------------------------------------------------------------
// Generates a known test image for each supported mode, runs it through the
// encoder, optionally corrupts the audio (AWGN + clock drift), and verifies
// the decoder recovers VIS + lines + pixels.
//
// Usage:
//   node scripts/test-sstv.js            # full test matrix
//   node scripts/test-sstv.js martin1    # single mode
//   node scripts/test-sstv.js --quick    # reduced matrix
// ---------------------------------------------------------------------------

const { SstvDecoder, encodeImage } = require('../lib/sstv-worker');
const { MODES } = require('../lib/sstv-modes');

const SAMPLE_RATE = 48000;
const CHUNK = 4096;

// --- Test image -----------------------------------------------------------
// 8 vertical color bars with a vertical luminance gradient — easy to eye-
// verify, provides sharp horizontal edges to detect slant and smoothing loss.
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

// --- Signal corruption ----------------------------------------------------

// Additive white gaussian noise at target SNR (dB, signal-RMS vs noise-RMS).
function addNoise(samples, snrDb) {
  if (!isFinite(snrDb)) return samples;
  let sumSq = 0;
  for (let i = 0; i < samples.length; i++) sumSq += samples[i] * samples[i];
  const sigRms = Math.sqrt(sumSq / samples.length);
  const noiseRms = sigRms / Math.pow(10, snrDb / 20);
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    // Box-Muller transform for a standard-normal sample
    const u1 = Math.random() || 1e-10;
    const u2 = Math.random();
    const n = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    out[i] = samples[i] + n * noiseRms;
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

// --- Visual export --------------------------------------------------------

// Write a PPM (netpbm P6) so you can eyeball the decoded image. Most image
// viewers accept PPM; most chat clients can preview it.
const fs = require('fs');
const path = require('path');

function writePPM(filepath, rgba, w, h) {
  const header = Buffer.from(`P6\n${w} ${h}\n255\n`);
  const body = Buffer.alloc(w * h * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    body[j] = rgba[i];
    body[j + 1] = rgba[i + 1];
    body[j + 2] = rgba[i + 2];
  }
  fs.writeFileSync(filepath, Buffer.concat([header, body]));
}

// --- Metrics --------------------------------------------------------------

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

// --- Runner ---------------------------------------------------------------

function runTest(modeKey, opts = {}) {
  const { snr = Infinity, drift = 0, padMs = 300, savePath = null } = opts;
  const mode = MODES[modeKey];
  const srcImg = makeTestImage(mode.width, mode.height);

  let samples = encodeImage(srcImg, mode.width, mode.height, modeKey);

  // Pad with silence so the decoder sees the leader coming up cleanly
  const padSamples = Math.round(SAMPLE_RATE * padMs / 1000);
  const padded = new Float32Array(samples.length + padSamples * 2);
  padded.set(samples, padSamples);
  samples = padded;

  if (drift !== 0) samples = addClockDrift(samples, drift);
  samples = addNoise(samples, snr);

  const decoder = new SstvDecoder();
  let visMode = null;
  let linesDecoded = 0;
  let finalImage = null;

  for (let i = 0; i < samples.length; i += CHUNK) {
    const chunk = samples.subarray(i, Math.min(i + CHUNK, samples.length));
    const results = decoder.processSamples(new Float32Array(chunk));
    for (const r of results) {
      if (r.type === 'rx-vis') visMode = r.mode;
      else if (r.type === 'rx-line') linesDecoded = Math.max(linesDecoded, r.line + 1);
      else if (r.type === 'rx-image') finalImage = r;
    }
  }

  let mse = null, psnrDb = null;
  if (finalImage) {
    mse = imageMSE(srcImg, finalImage.imageData, mode.width, mode.height);
    psnrDb = psnr(mse);
    if (savePath) {
      writePPM(savePath + '_src.ppm', srcImg, mode.width, mode.height);
      writePPM(savePath + '_dec.ppm', finalImage.imageData, mode.width, mode.height);
    }
  }

  return {
    mode: modeKey,
    snr,
    drift,
    visDetected: visMode === modeKey,
    visMode,
    linesDecoded,
    totalLines: mode.height,
    mse,
    psnrDb,
    imageComplete: !!finalImage,
  };
}

function printResult(r) {
  const visTag = r.visDetected ? 'VIS-ok' : (r.visMode ? 'VIS-wrong(' + r.visMode + ')' : 'VIS-none');
  const lines = r.linesDecoded + '/' + r.totalLines;
  const snrStr = isFinite(r.snr) ? r.snr.toFixed(0) + 'dB' : 'clean';
  const psnrStr = r.psnrDb == null
    ? '---'
    : (isFinite(r.psnrDb) ? r.psnrDb.toFixed(1) + 'dB' : 'perfect');
  const driftStr = (r.drift > 0 ? '+' : '') + r.drift + 'ppm';
  console.log(
    '  [' + r.mode.padEnd(8) + '] ' +
    'snr=' + snrStr.padStart(7) + '  ' +
    'drift=' + driftStr.padStart(8) + '  ' +
    visTag.padEnd(18) + '  ' +
    'lines=' + lines.padEnd(9) + '  ' +
    'PSNR=' + psnrStr
  );
}

// Pass criteria: VIS correct + image complete + (if clean) PSNR >= target
function evalPass(r) {
  if (!r.visDetected) return false;
  if (!r.imageComplete) return false;
  if (!isFinite(r.snr)) {
    // Clean signal should produce near-perfect decode (PSNR > 25 dB)
    return r.psnrDb >= 25;
  }
  // Noisy: as long as the image finished we count it as a pass
  return true;
}

function main() {
  const argv = process.argv.slice(2);
  const quick = argv.includes('--quick');
  const selectedMode = argv.find(a => !a.startsWith('--'));
  const allModes = ['martin1', 'scottie1', 'scottie2', 'robot36', 'robot72'];
  const modes = selectedMode ? [selectedMode] : allModes;

  console.log('SSTV decoder regression tests');
  console.log('='.repeat(96));

  // Test matrix
  const cleanTests = modes.map(m => ({ mode: m, snr: Infinity, drift: 0 }));
  const noiseTests = quick
    ? modes.map(m => ({ mode: m, snr: 15, drift: 0 }))
    : modes.flatMap(m => [
        { mode: m, snr: 25, drift: 0 },
        { mode: m, snr: 15, drift: 0 },
        { mode: m, snr: 10, drift: 0 },
        { mode: m, snr: 5,  drift: 0 },
      ]);
  const driftTests = quick
    ? modes.map(m => ({ mode: m, snr: Infinity, drift: 1000 }))
    : modes.flatMap(m => [
        { mode: m, snr: Infinity, drift: 500 },
        { mode: m, snr: Infinity, drift: -500 },
        { mode: m, snr: Infinity, drift: 2000 },
        { mode: m, snr: Infinity, drift: -2000 },
      ]);

  const summary = { pass: 0, fail: 0 };
  const failures = [];

  const runGroup = (label, tests) => {
    console.log('\n-- ' + label + ' --');
    for (const t of tests) {
      const r = runTest(t.mode, { snr: t.snr, drift: t.drift });
      printResult(r);
      if (evalPass(r)) summary.pass++;
      else { summary.fail++; failures.push(r); }
    }
  };

  runGroup('Clean', cleanTests);
  runGroup('AWGN', noiseTests);
  runGroup('Clock drift', driftTests);

  console.log('\n' + '='.repeat(96));
  console.log('Pass: ' + summary.pass + '  Fail: ' + summary.fail);
  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) printResult(f);
  }
  process.exit(summary.fail > 0 ? 1 : 0);
}

main();
