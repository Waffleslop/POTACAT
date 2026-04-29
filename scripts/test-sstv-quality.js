'use strict';
// ---------------------------------------------------------------------------
// SSTV decoder quality benchmark
// ---------------------------------------------------------------------------
// Multiple test images target different decoder quality dimensions:
//   - bars       : vertical color bars w/ luminance gradient (horizontal edges)
//   - hstripes   : horizontal color stripes (vertical chroma variation)
//   - diag       : diagonal gradient (both axes)
//   - photo      : pseudo-photo (smooth gradients + detail bursts)
// Plus AWGN and clock-drift sweeps.
// ---------------------------------------------------------------------------

const { SstvDecoder, encodeImage } = require('../lib/sstv-worker');
const { MODES } = require('../lib/sstv-modes');

const SAMPLE_RATE = 48000;
const CHUNK = 4096;

// --- Test images ----------------------------------------------------------

function imgBars(w, h) {
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
      img[i] = Math.round(r * shade);
      img[i + 1] = Math.round(g * shade);
      img[i + 2] = Math.round(b * shade);
      img[i + 3] = 255;
    }
  }
  return img;
}

// Horizontal stripes — primary chroma changes every 4 lines.
// Tests vertical chroma resolution / temporal interp.
function imgHStripes(w, h) {
  const img = new Uint8ClampedArray(w * h * 4);
  const colors = [
    [255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0],
    [0, 255, 255], [255, 0, 255],
  ];
  for (let y = 0; y < h; y++) {
    const stripe = Math.floor(y / 4) % colors.length;
    const [r, g, b] = colors[stripe];
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      img[i] = r; img[i + 1] = g; img[i + 2] = b; img[i + 3] = 255;
    }
  }
  return img;
}

// Diagonal RGB gradient — exercises both horizontal and vertical chroma resolution
function imgDiag(w, h) {
  const img = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      img[i]     = Math.round(255 * x / (w - 1));
      img[i + 1] = Math.round(255 * y / (h - 1));
      img[i + 2] = Math.round(255 * (1 - (x + y) / (w + h - 2)));
      img[i + 3] = 255;
    }
  }
  return img;
}

// Pseudo-photo: smooth Voronoi-like blobs + sharp text-like blocks
function imgPhoto(w, h) {
  const img = new Uint8ClampedArray(w * h * 4);
  // Seeded pseudo-random for reproducible PSNR
  let s = 0x12345;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0xffffffff; };
  // 6 blob centers
  const centers = [];
  for (let i = 0; i < 6; i++) {
    centers.push({
      x: rnd() * w, y: rnd() * h,
      r: 80 + rnd() * 175, g: 80 + rnd() * 175, b: 80 + rnd() * 175,
    });
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Inverse-distance-weighted blend
      let wr = 0, wg = 0, wb = 0, ws = 0;
      for (const c of centers) {
        const dx = x - c.x, dy = y - c.y;
        const dist = Math.sqrt(dx * dx + dy * dy) + 1;
        const wt = 1 / (dist * dist);
        wr += c.r * wt; wg += c.g * wt; wb += c.b * wt; ws += wt;
      }
      let r = wr / ws, g = wg / ws, b = wb / ws;
      // Add detail blocks — quarters of the image have inverted colors
      if ((Math.floor(x / 16) + Math.floor(y / 16)) % 2 === 0 && y > h * 0.6) {
        r = 255 - r; g = 255 - g; b = 255 - b;
      }
      const i = (y * w + x) * 4;
      img[i] = Math.max(0, Math.min(255, Math.round(r)));
      img[i + 1] = Math.max(0, Math.min(255, Math.round(g)));
      img[i + 2] = Math.max(0, Math.min(255, Math.round(b)));
      img[i + 3] = 255;
    }
  }
  return img;
}

const TEST_IMAGES = {
  bars: imgBars,
  hstripes: imgHStripes,
  diag: imgDiag,
  photo: imgPhoto,
};

// --- Signal corruption ----------------------------------------------------

function addNoise(samples, snrDb) {
  if (!isFinite(snrDb)) return samples;
  let sumSq = 0;
  for (let i = 0; i < samples.length; i++) sumSq += samples[i] * samples[i];
  const sigRms = Math.sqrt(sumSq / samples.length);
  const noiseRms = sigRms / Math.pow(10, snrDb / 20);
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const u1 = Math.random() || 1e-10;
    const u2 = Math.random();
    const n = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    out[i] = samples[i] + n * noiseRms;
  }
  return out;
}

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

function runOne(modeKey, imgKey, opts = {}) {
  const { snr = Infinity, drift = 0, padMs = 300 } = opts;
  const mode = MODES[modeKey];
  const srcImg = TEST_IMAGES[imgKey](mode.width, mode.height);

  let samples = encodeImage(srcImg, mode.width, mode.height, modeKey);
  const padSamples = Math.round(SAMPLE_RATE * padMs / 1000);
  const padded = new Float32Array(samples.length + padSamples * 2);
  padded.set(samples, padSamples);
  samples = padded;
  if (drift !== 0) samples = addClockDrift(samples, drift);
  samples = addNoise(samples, snr);

  const decoder = new SstvDecoder();
  let visMode = null;
  let finalImage = null;
  for (let i = 0; i < samples.length; i += CHUNK) {
    const chunk = samples.subarray(i, Math.min(i + CHUNK, samples.length));
    const results = decoder.processSamples(new Float32Array(chunk));
    for (const r of results) {
      if (r.type === 'rx-vis') visMode = r.mode;
      else if (r.type === 'rx-image') finalImage = r;
    }
  }

  let psnrDb = null;
  if (finalImage) {
    psnrDb = psnr(imageMSE(srcImg, finalImage.imageData, mode.width, mode.height));
  }
  return {
    mode: modeKey, img: imgKey, snr, drift,
    visOk: visMode === modeKey,
    complete: !!finalImage,
    psnrDb,
  };
}

function fmt(r) {
  const psnrStr = r.psnrDb == null ? '---'
    : (isFinite(r.psnrDb) ? r.psnrDb.toFixed(1) + 'dB' : 'inf');
  const visTag = r.visOk ? 'ok' : 'NO';
  const okTag = r.complete ? 'ok' : 'NO';
  return `[${r.mode.padEnd(8)}/${r.img.padEnd(8)}] vis=${visTag} done=${okTag}  PSNR=${psnrStr}`;
}

function main() {
  const argv = process.argv.slice(2);
  const quick = argv.includes('--quick');
  const modeFilter = argv.find(a => !a.startsWith('--') && MODES[a]);
  const imgFilter = argv.find(a => !a.startsWith('--') && TEST_IMAGES[a]);

  const allModes = ['martin1', 'scottie1', 'scottie2', 'robot36', 'robot72'];
  const allImgs = Object.keys(TEST_IMAGES);
  const modes = modeFilter ? [modeFilter] : allModes;
  const imgs = imgFilter ? [imgFilter] : allImgs;

  console.log('SSTV decoder quality benchmark');
  console.log('='.repeat(80));

  const results = [];

  console.log('\n-- Clean signal --');
  for (const m of modes) for (const i of imgs) {
    const r = runOne(m, i, { snr: Infinity });
    console.log('  ' + fmt(r));
    results.push(r);
  }

  if (!quick) {
    console.log('\n-- AWGN sweeps (color bars) --');
    for (const m of modes) for (const snr of [25, 15, 10, 5]) {
      const r = runOne(m, 'bars', { snr });
      console.log('  ' + fmt(r) + ' @ snr=' + snr + 'dB');
      results.push(r);
    }
    console.log('\n-- Clock drift sweeps (color bars) --');
    for (const m of modes) for (const drift of [500, -500, 1000, -1000]) {
      const r = runOne(m, 'bars', { drift });
      console.log('  ' + fmt(r) + ' @ drift=' + drift + 'ppm');
      results.push(r);
    }
  }

  // Summary
  console.log('\n' + '='.repeat(80));
  let cleanSum = 0, cleanCount = 0;
  for (const r of results) {
    if (!isFinite(r.snr) && r.drift === 0 && r.psnrDb && isFinite(r.psnrDb)) {
      cleanSum += r.psnrDb; cleanCount++;
    }
  }
  console.log('Clean-signal mean PSNR: ' + (cleanSum / cleanCount).toFixed(2) + ' dB across ' + cleanCount + ' tests');
}

main();
