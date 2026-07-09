'use strict';

// ---------------------------------------------------------------------------
// SSTV Worker — runs in a Worker thread, handles encode + decode
// ---------------------------------------------------------------------------
// Message protocol:
//   IN:  { type: 'encode', imageData, width, height, mode }
//   IN:  { type: 'rx-audio', samples }
//   IN:  { type: 'stop' }
//   OUT: { type: 'encode-result', samples }
//   OUT: { type: 'rx-vis', mode }
//   OUT: { type: 'rx-line', line, totalLines, rgba }
//   OUT: { type: 'rx-image', imageData, width, height, mode }
//   OUT: { type: 'error', message }
// ---------------------------------------------------------------------------

const {
  MODES, VIS_TO_MODE,
  SYNC_FREQ, BLACK_FREQ, WHITE_FREQ, FREQ_RANGE,
  VIS_LEADER_MS, VIS_BREAK_MS, VIS_BIT_MS, VIS_STOP_MS,
  VIS_LEADER_FREQ, VIS_BIT1_FREQ, VIS_BIT0_FREQ,
} = require('./sstv-modes');

const { BiquadBPF, BiquadLPF, ToneEnvelope, SlantRegressor } = require('./sstv-dsp');

let SAMPLE_RATE = 48000;
const TWO_PI = 2 * Math.PI;

// ===== ENCODER =============================================================

let encodePhase = 0;

function appendTone(out, freq, durationMs) {
  const numSamples = Math.round(SAMPLE_RATE * durationMs / 1000);
  const phaseInc = TWO_PI * freq / SAMPLE_RATE;
  for (let i = 0; i < numSamples; i++) {
    out.push(Math.sin(encodePhase));
    encodePhase += phaseInc;
  }
  // Prevent float overflow
  if (encodePhase > TWO_PI * 1000) encodePhase -= TWO_PI * Math.floor(encodePhase / TWO_PI);
}

function appendPixelTone(out, value, pixelMs) {
  // value: 0-255, maps to BLACK_FREQ (1500) - WHITE_FREQ (2300)
  const freq = BLACK_FREQ + (value / 255) * FREQ_RANGE;
  appendTone(out, freq, pixelMs);
}

function encodeVIS(out, visCode) {
  // Leader: 300ms of 1900 Hz
  appendTone(out, VIS_LEADER_FREQ, VIS_LEADER_MS);
  // Break: 10ms of 1200 Hz
  appendTone(out, SYNC_FREQ, VIS_BREAK_MS);
  // Leader again: 300ms of 1900 Hz
  appendTone(out, VIS_LEADER_FREQ, VIS_LEADER_MS);

  // Start bit: 30ms of 1200 Hz
  appendTone(out, SYNC_FREQ, VIS_BIT_MS);

  // 7 data bits, LSB first
  let parity = 0;
  for (let bit = 0; bit < 7; bit++) {
    const b = (visCode >> bit) & 1;
    parity ^= b;
    appendTone(out, b ? VIS_BIT1_FREQ : VIS_BIT0_FREQ, VIS_BIT_MS);
  }
  // Even parity bit
  appendTone(out, parity ? VIS_BIT1_FREQ : VIS_BIT0_FREQ, VIS_BIT_MS);

  // Stop bit: 30ms of 1200 Hz
  appendTone(out, SYNC_FREQ, VIS_STOP_MS);
}

// Mean absolute horizontal pixel-to-pixel difference, summed over
// R/G/B channels. Used as a "sharpness" metric to gate YCbCr two-
// pass replay: a resample that smears edges reduces this score; a
// crisp decode preserves it. Skip the alpha channel.
function _horizSharpness(rgba, w, h) {
  if (!rgba || w < 2 || h < 1) return 0;
  let sum = 0;
  let n = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w - 1; x++) {
      const i = (y * w + x) * 4;
      sum += Math.abs(rgba[i] - rgba[i + 4]);
      sum += Math.abs(rgba[i + 1] - rgba[i + 5]);
      sum += Math.abs(rgba[i + 2] - rgba[i + 6]);
      n += 3;
    }
  }
  return n === 0 ? 0 : sum / n;
}

// RGB to YCbCr (ITU-R BT.601)
function rgbToYCbCr(r, g, b) {
  const y  = 0.299 * r + 0.587 * g + 0.114 * b;
  const cb = 128 - 0.169 * r - 0.331 * g + 0.500 * b;
  const cr = 128 + 0.500 * r - 0.419 * g - 0.081 * b;
  return [
    Math.max(0, Math.min(255, Math.round(y))),
    Math.max(0, Math.min(255, Math.round(cb))),
    Math.max(0, Math.min(255, Math.round(cr))),
  ];
}

function scaleImageToMode(imageData, srcW, srcH, dstW, dstH) {
  // Simple bilinear-ish nearest-neighbor scale to mode resolution
  const dst = new Uint8ClampedArray(dstW * dstH * 4);
  const xRatio = srcW / dstW;
  const yRatio = srcH / dstH;
  for (let y = 0; y < dstH; y++) {
    const sy = Math.min(Math.floor(y * yRatio), srcH - 1);
    for (let x = 0; x < dstW; x++) {
      const sx = Math.min(Math.floor(x * xRatio), srcW - 1);
      const si = (sy * srcW + sx) * 4;
      const di = (y * dstW + x) * 4;
      dst[di]     = imageData[si];
      dst[di + 1] = imageData[si + 1];
      dst[di + 2] = imageData[si + 2];
      dst[di + 3] = 255;
    }
  }
  return dst;
}

function encodeMartinLine(out, pixels, mode, y) {
  const w = mode.width;
  // Sync pulse
  appendTone(out, SYNC_FREQ, mode.syncMs);
  // Porch
  appendTone(out, BLACK_FREQ, mode.porchMs);
  // Three color channels in GBR order
  for (const ch of mode.channelOrder) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      appendPixelTone(out, pixels[idx + ch], mode.pixelMs);
    }
    // Separator after each channel
    appendTone(out, BLACK_FREQ, mode.separatorMs);
  }
}

function encodeScottieLine(out, pixels, mode, y) {
  const w = mode.width;
  // Scottie: sep -> G -> sep -> B -> sync -> porch -> R
  // Starting separator
  appendTone(out, BLACK_FREQ, mode.separatorMs);
  // Green channel
  for (let x = 0; x < w; x++) {
    const idx = (y * w + x) * 4;
    appendPixelTone(out, pixels[idx + 1], mode.pixelMs); // G
  }
  // Separator
  appendTone(out, BLACK_FREQ, mode.separatorMs);
  // Blue channel
  for (let x = 0; x < w; x++) {
    const idx = (y * w + x) * 4;
    appendPixelTone(out, pixels[idx + 2], mode.pixelMs); // B
  }
  // Sync pulse (between B and R in Scottie)
  appendTone(out, SYNC_FREQ, mode.syncMs);
  // Porch
  appendTone(out, BLACK_FREQ, mode.porchMs);
  // Red channel
  for (let x = 0; x < w; x++) {
    const idx = (y * w + x) * 4;
    appendPixelTone(out, pixels[idx], mode.pixelMs); // R
  }
}

function encodeRobot36Line(out, pixels, mode, y) {
  const w = mode.width;
  // Sync
  appendTone(out, SYNC_FREQ, mode.syncMs);
  // Porch
  appendTone(out, BLACK_FREQ, mode.porchMs);

  // Y luminance scan (full width)
  for (let x = 0; x < w; x++) {
    const idx = (y * w + x) * 4;
    const [yy] = rgbToYCbCr(pixels[idx], pixels[idx + 1], pixels[idx + 2]);
    appendPixelTone(out, yy, mode.yPixelMs);
  }

  // Chrominance separator
  // Even lines: 1500 Hz sep -> Cr (R-Y)
  // Odd lines:  2300 Hz sep -> Cb (B-Y)
  const isEven = (y % 2) === 0;
  appendTone(out, isEven ? BLACK_FREQ : WHITE_FREQ, mode.chromSepMs);

  // Chrominance scan (half horizontal resolution)
  const chromW = mode.chromWidth;
  for (let x = 0; x < chromW; x++) {
    // Sample at double the pixel step for half-res
    const sx = Math.min(Math.floor(x * w / chromW), w - 1);
    const idx = (y * w + sx) * 4;
    const [, cb, cr] = rgbToYCbCr(pixels[idx], pixels[idx + 1], pixels[idx + 2]);
    const chromVal = isEven ? cr : cb;
    appendPixelTone(out, chromVal, mode.chromPixelMs);
  }

  // Trailing porch
  appendTone(out, BLACK_FREQ, mode.chromPorchMs);
}

function encodeRobot72Line(out, pixels, mode, y) {
  const w = mode.width;
  // Sync
  appendTone(out, SYNC_FREQ, mode.syncMs);
  // Porch
  appendTone(out, BLACK_FREQ, mode.porchMs);

  // Y luminance scan (full width)
  for (let x = 0; x < w; x++) {
    const idx = (y * w + x) * 4;
    const [yy] = rgbToYCbCr(pixels[idx], pixels[idx + 1], pixels[idx + 2]);
    appendPixelTone(out, yy, mode.yPixelMs);
  }

  // Cr separator
  appendTone(out, BLACK_FREQ, mode.chromSepMs);

  // Cr scan (full width)
  for (let x = 0; x < w; x++) {
    const idx = (y * w + x) * 4;
    const [, , cr] = rgbToYCbCr(pixels[idx], pixels[idx + 1], pixels[idx + 2]);
    appendPixelTone(out, cr, mode.chromPixelMs);
  }

  // Cb separator
  appendTone(out, BLACK_FREQ, mode.chromSepMs);

  // Cb scan (full width)
  for (let x = 0; x < w; x++) {
    const idx = (y * w + x) * 4;
    const [, cb] = rgbToYCbCr(pixels[idx], pixels[idx + 1], pixels[idx + 2]);
    appendPixelTone(out, cb, mode.chromPixelMs);
  }

  // Trailing porch
  appendTone(out, BLACK_FREQ, mode.chromPorchMs);
}

// PD modes encode pairs of lines together. Each pair sends:
//   sync(1200, 20ms) → porch(1500, 2.08ms) → Y(line N) → R-Y(avg N,N+1)
//                   → B-Y(avg N,N+1) → Y(line N+1)
// Chrominance is averaged across the two-line pair, giving the receiver
// vertical chroma interpolation. If height is odd, the final pair
// duplicates the last line for the chroma average.
function encodePdLinePair(out, pixels, mode, yTop) {
  const w = mode.width;
  const yBot = Math.min(yTop + 1, mode.height - 1);

  // Long sync + porch
  appendTone(out, SYNC_FREQ, mode.syncMs);
  appendTone(out, BLACK_FREQ, mode.porchMs);

  // Y for top line
  for (let x = 0; x < w; x++) {
    const idx = (yTop * w + x) * 4;
    const [yy] = rgbToYCbCr(pixels[idx], pixels[idx + 1], pixels[idx + 2]);
    appendPixelTone(out, yy, mode.pixelMs);
  }

  // Averaged R-Y (Cr) across the line pair
  for (let x = 0; x < w; x++) {
    const idxT = (yTop * w + x) * 4;
    const idxB = (yBot * w + x) * 4;
    const [, , crT] = rgbToYCbCr(pixels[idxT], pixels[idxT + 1], pixels[idxT + 2]);
    const [, , crB] = rgbToYCbCr(pixels[idxB], pixels[idxB + 1], pixels[idxB + 2]);
    appendPixelTone(out, (crT + crB) * 0.5, mode.pixelMs);
  }

  // Averaged B-Y (Cb) across the line pair
  for (let x = 0; x < w; x++) {
    const idxT = (yTop * w + x) * 4;
    const idxB = (yBot * w + x) * 4;
    const [, cbT] = rgbToYCbCr(pixels[idxT], pixels[idxT + 1], pixels[idxT + 2]);
    const [, cbB] = rgbToYCbCr(pixels[idxB], pixels[idxB + 1], pixels[idxB + 2]);
    appendPixelTone(out, (cbT + cbB) * 0.5, mode.pixelMs);
  }

  // Y for bottom line
  for (let x = 0; x < w; x++) {
    const idx = (yBot * w + x) * 4;
    const [yy] = rgbToYCbCr(pixels[idx], pixels[idx + 1], pixels[idx + 2]);
    appendPixelTone(out, yy, mode.pixelMs);
  }
}

function encodeImage(imageData, srcWidth, srcHeight, modeKey) {
  // Accept any case ('PD90', 'pd90', 'Pd90' all work). Mobile sends
  // uppercase mode names; the desktop UI uses lowercase keys.
  const mode = MODES[modeKey] || MODES[String(modeKey || '').toLowerCase()];
  if (!mode) throw new Error('Unknown SSTV mode: ' + modeKey);

  // Scale image to mode resolution
  const pixels = scaleImageToMode(imageData, srcWidth, srcHeight, mode.width, mode.height);

  const out = [];
  encodePhase = 0;

  // VIS header
  encodeVIS(out, mode.visCode);

  // Encode each line (or line-pair, for PD modes)
  if (mode.colorSpace === 'pd') {
    for (let y = 0; y < mode.height; y += 2) {
      encodePdLinePair(out, pixels, mode, y);
    }
  } else {
    for (let y = 0; y < mode.height; y++) {
      if (mode.colorSpace === 'ycbcr') {
        if (mode.halfChrom) {
          encodeRobot36Line(out, pixels, mode, y);
        } else {
          encodeRobot72Line(out, pixels, mode, y);
        }
      } else if (mode.scottieLineOrder) {
        encodeScottieLine(out, pixels, mode, y);
      } else {
        encodeMartinLine(out, pixels, mode, y);
      }
    }
  }

  return new Float32Array(out);
}

// ===== DECODER =============================================================
// Inspired by MMSSTV's DSP pipeline:
//   * Dual tone-envelope gate (1200/1900 Hz) for sync detection — immune to
//     bright-white pixels and noise spikes that fool a simple freq threshold.
//   * VIS bit decision via 1100/1300 Hz tone envelopes with 1900 Hz reference
//     gate — far more robust than inst-freq averaging.
//   * Least-squares slant regression across per-line sync peaks (k0 slope)
//     derives a sample-rate correction for the remote encoder's clock drift.
//   * Median pixel sampling for impulse-noise rejection.
//   * Butterworth LPF on the demodulated frequency replaces a 2ms boxcar
//     that was smearing sharp pixel edges.
// ---------------------------------------------------------------------------

// Band-limited Hilbert + matching band-pass FIR pair.
// Both filters are linear-phase (symmetric coefficients), so they share a
// constant group delay = (numTaps - 1) / 2 with no smearing of pixel edges
// beyond that fixed lag. Restricting the analytic signal to the SSTV tone
// band [1100, 2400] Hz rejects out-of-band noise BEFORE the atan2 phase
// estimator — a critical step for low-SNR decoding, since broadband noise
// otherwise dominates the variance of the freq estimate.
function buildBplHilbertCoeffs(numTaps, fL, fH, fs) {
  const coeffs = new Float32Array(numTaps);
  const mid = (numTaps - 1) / 2;
  const wL = TWO_PI * fL / fs;
  const wH = TWO_PI * fH / fs;
  for (let i = 0; i < numTaps; i++) {
    const n = i - mid;
    if (n === 0) {
      coeffs[i] = 0;
    } else {
      // Inverse DTFT of -j*sgn(f) restricted to [fL, fH] passband:
      //   h[n] = (cos(wL*n) - cos(wH*n)) / (π*n)
      coeffs[i] = (Math.cos(wL * n) - Math.cos(wH * n)) / (Math.PI * n);
    }
    coeffs[i] *= 0.54 - 0.46 * Math.cos(TWO_PI * i / (numTaps - 1));
  }
  return coeffs;
}

function buildBplPassCoeffs(numTaps, fL, fH, fs) {
  const coeffs = new Float32Array(numTaps);
  const mid = (numTaps - 1) / 2;
  const wL = TWO_PI * fL / fs;
  const wH = TWO_PI * fH / fs;
  for (let i = 0; i < numTaps; i++) {
    const n = i - mid;
    if (n === 0) {
      // DC term — passband width / fs
      coeffs[i] = (wH - wL) / Math.PI;
    } else {
      coeffs[i] = (Math.sin(wH * n) - Math.sin(wL * n)) / (Math.PI * n);
    }
    coeffs[i] *= 0.54 - 0.46 * Math.cos(TWO_PI * i / (numTaps - 1));
  }
  return coeffs;
}

const HILBERT_TAPS = 65;
// SSTV tone band: sync 1200, VIS bits 1100/1300, leader 1900, pixel band
// 1500–2300. Padded substantially (700–3000) to keep filter group-delay
// step response sharp at pixel transitions — narrower passbands reduce
// noise more but also stretch the transient response, smearing edges by
// ~1 pixel per 200 Hz of bandwidth removed.
const BPL_FL = 500;
const BPL_FH = 3500;
const hilbertCoeffs = buildBplHilbertCoeffs(HILBERT_TAPS, BPL_FL, BPL_FH, 48000);
const realBpCoeffs  = buildBplPassCoeffs(HILBERT_TAPS, BPL_FL, BPL_FH, 48000);
const HILBERT_DELAY = Math.floor(HILBERT_TAPS / 2);

// Decoder state machine
const STATE_IDLE     = 0;  // waiting for leader tone
const STATE_LEADER   = 1;  // tracking 1900 Hz leader
const STATE_VIS_START = 2; // waiting for 1200 Hz start bit after break+leader
const STATE_VIS_BITS = 3;  // reading VIS data bits
const STATE_DECODING = 4;  // decoding image lines
const STATE_NAMES = ['IDLE', 'LEADER', 'VIS_START', 'VIS_BITS', 'DECODING'];

// Envelope threshold — raw audio is usually ±0.1..0.5; envelope peaks near 0.3
// of input amplitude. Minimum usable envelope for a tone is ~0.04.
const ENV_THRESHOLD_MIN = 0.02;

// Leader-lock noise gate (K3SBP 2026-05-28). The envelope-only leader test
// (`e19 > e12*1.4`) false-locks on loud SmartSDR-Direct band noise: noise
// energy in the 1900 Hz detector sustains long enough to trip an 80 ms
// "leader", then the decoder grinds through a bogus mode for 1–3 minutes,
// never idle to catch a real header. A REAL leader is a pure, stable
// 1900 Hz tone; measured over the lock window its frequency mean sits at
// ~1900 Hz with low std. Band noise's measured frequency wanders (mean
// off-center, std huge). Measured on K3SBP's 8600: real leaders (even
// 8 dB SNR) → mean≈1900, std≤391 Hz; band noise → mean≈1747, std≈537 Hz.
// Gate the IDLE→LEADER transition on both.
const LEADER_MEAN_TOL_HZ = 250;  // |meanFreq - 1900| must be within this
const LEADER_STD_MAX_HZ  = 450;  // freq std across the lock window must be under this

// Idle-state AFC (automatic frequency capture) tuning constants.
// Capture range ±AFC_MAX_OFFSET_HZ around the nominal 1900 Hz leader;
// a candidate must be a magnitude-qualified, low-variance tone sustained
// for AFC_SUSTAIN_MS before the detectors retune. MMSSTV notably has NO
// AFC — this is a deliberate step past parity (its users tune manually
// against spectrum markers; ours shouldn't have to).
const AFC_MAX_OFFSET_HZ = 300;   // beyond this, treat as not-SSTV
const AFC_MIN_DELTA_HZ = 40;     // don't fight the normal path inside capture BW
const AFC_MAG_MIN = 0.02;        // analytic magnitude floor (same scale as ENV_THRESHOLD_MIN)
const AFC_STD_MAX_HZ = 60;       // EMA std ceiling — a leader is a stable tone
const AFC_SUSTAIN_MS = 60;       // must hold before retuning

// Nominal per-line sample count for a mode object (static twin of the
// instance method — also drives the sync-interval auto-start mode match).
function nominalLineSamplesFor(mode) {
  if (!mode) return 0;
  const r = (ms) => Math.round(SAMPLE_RATE * ms / 1000);
  if (mode.colorSpace === 'pd') {
    // PD: sync + porch + 4 scans of width w (Y-top, Cr, Cb, Y-bot)
    const pixelSamples = r(mode.pixelMs) * mode.width;
    return r(mode.syncMs) + r(mode.porchMs) + 4 * pixelSamples;
  }
  if (mode.colorSpace === 'ycbcr') {
    const yPixelSamples = r(mode.yPixelMs) * mode.width;
    const chromPixelSamples = r(mode.chromPixelMs) * (mode.halfChrom ? mode.chromWidth : mode.width);
    if (mode.halfChrom) {
      return r(mode.syncMs) + r(mode.porchMs) + yPixelSamples + r(mode.chromSepMs) + chromPixelSamples + r(mode.chromPorchMs);
    }
    return r(mode.syncMs) + r(mode.porchMs) + yPixelSamples + r(mode.chromSepMs) + chromPixelSamples + r(mode.chromSepMs) + chromPixelSamples + r(mode.chromPorchMs);
  }
  const pixelSamples = r(mode.pixelMs) * mode.width;
  if (mode.scottieLineOrder) {
    return r(mode.separatorMs) + pixelSamples + r(mode.separatorMs) + pixelSamples + r(mode.syncMs) + r(mode.porchMs) + pixelSamples;
  }
  return r(mode.syncMs) + r(mode.porchMs) + (pixelSamples + r(mode.separatorMs)) * 3;
}

// Sync-interval auto-start (MMSSTV's no-VIS fallback, 2026-07-07): when the
// VIS header was missed (joined late, QSB over the header), identify the
// mode from the spacing of 1200 Hz sync pulses and start mid-image.
// Ambiguous periods (M1/M3 and M2/M4 are timing-identical) resolve by
// on-air commonality.
const SYNC_START_PRIORITY = [
  'martin1', 'scottie1', 'robot36', 'martin2', 'scottie2', 'robot72',
  'pd90', 'pd120', 'robot24', 'pd160', 'pd180', 'pd240', 'scottieDx',
  'martin3', 'martin4',
];
const SYNC_START_TOL = 0.015;      // ±1.5% period match
const SYNC_START_MIN_INTERVALS = 5; // consistent intervals required
let _syncStartTable = null;
function syncStartTable() {
  if (_syncStartTable) return _syncStartTable;
  _syncStartTable = SYNC_START_PRIORITY
    .filter((key) => MODES[key])
    .map((key) => {
      const mode = MODES[key];
      const r = (ms) => Math.round(SAMPLE_RATE * ms / 1000);
      const pixelSamples = mode.pixelMs ? r(mode.pixelMs) * mode.width : 0;
      // Where the sync pulse sits inside the line: at the start for
      // Martin/Robot/PD, after the G+B scans for Scottie line order.
      const syncInLineOffset = mode.scottieLineOrder
        ? r(mode.separatorMs) + pixelSamples + r(mode.separatorMs) + pixelSamples
        : 0;
      return { key, lineSamples: nominalLineSamplesFor(mode), syncInLineOffset };
    });
  return _syncStartTable;
}

class SstvDecoder {
  constructor() {
    this.toneOffset = 0; // AFC coarse detector offset (Hz) — survives reset()
    this._initFilters();
    this._initState();
  }

  // Retune the four tone detectors to nominal+offset. The state machine is
  // untouched — leader lock, VIS bits, and sync detection all read the
  // retuned envelopes, and the leader-mean calibration (which sets
  // freqOffset for pixel mapping) validates against the retuned center.
  _setToneOffset(offset) {
    this.toneOffset = offset;
    const sr = SAMPLE_RATE;
    this.env1200.bpf.setFreq(1200 + offset, 25, sr);
    this.env1900.bpf.setFreq(1900 + offset, 25, sr);
    this.env1100.bpf.setFreq(1100 + offset, 30, sr);
    this.env1300.bpf.setFreq(1300 + offset, 30, sr);
    // Restart leader accumulation — samples gathered with the old centers
    // mix two calibrations.
    this.leaderSamples = 0;
    this.leaderFreqAccum = 0;
    this.leaderFreqSqAccum = 0;
    this.leaderFreqCount = 0;
  }

  _initFilters() {
    const sr = SAMPLE_RATE;
    // Narrow tone-envelope detectors on raw audio.
    // Q=25 at 1200 Hz -> BW ~48 Hz -> rise time ~20 ms (enough for 5+ ms sync).
    // AFC (2026-07-07): all four centers shift together by toneOffset when the
    // idle-state tracker finds a stable off-tune carrier — the narrow Q made
    // the front door deaf beyond ~±75 Hz of tuning error while MMSSTV users
    // routinely work stations 100–300 Hz off. toneOffset persists across
    // reset() so image #2 from the same station locks instantly.
    const off = this.toneOffset || 0;
    this.env1200 = new ToneEnvelope(1200 + off, 25, sr, 3);
    this.env1900 = new ToneEnvelope(1900 + off, 25, sr, 3);
    this.env1100 = new ToneEnvelope(1100 + off, 30, sr, 3);
    this.env1300 = new ToneEnvelope(1300 + off, 30, sr, 3);
    // Butterworth LPF on demodulated frequency — cutoff tuned to pass the
    // fastest pixel modulation sharply (~3.6 kHz for Robot-36 Y, 2.3 kHz for
    // Martin/Scottie) while attenuating 2x-carrier ripple around 3800 Hz and
    // HF noise. Raising from 2400 to 3000 sharpens bar-edge transitions at
    // the cost of a little extra noise passthrough.
    this.freqLpf = new BiquadLPF(3000, sr);
    // Hilbert ring buffer
    this.hilbertBuf = new Float32Array(HILBERT_TAPS);
    this.hilbertIdx = 0;
    this.prevPhase = 0;
    this._lastValidFreq = 1900;
  }

  _initState() {
    this.state = STATE_IDLE;
    // Leader / VIS
    this.leaderSamples = 0;
    this.leaderMinSamples = Math.round(SAMPLE_RATE * 0.08); // 80 ms sustained leader
    this.breakSeen = false;
    this.secondLeaderSamples = 0;
    this._transitionGrace = 0;
    this.visBitSamples = 0;
    this.visBitE11 = 0;
    this.visBitE13 = 0;
    this.visBitE19 = 0;
    this.visBitCount = 0;
    this.visBits = [];
    this.visExpectedSamples = Math.round(SAMPLE_RATE * VIS_BIT_MS / 1000);
    this.visStartSamples = 0;
    // Frequency offset calibration — auto-detected from leader tone
    this.freqOffset = 0;
    this.leaderFreqAccum = 0;
    this.leaderFreqSqAccum = 0;
    this.leaderFreqCount = 0;
    // Idle-state AFC tracker (EMA of magnitude-qualified rawFreq)
    this._afcAlpha = 1 - Math.exp(-1 / (SAMPLE_RATE * 0.010)); // 10 ms EMA
    this._afcMean = 1900;
    this._afcVar = 0;
    this._afcQualified = 0; // consecutive qualified samples
    // Sync-interval auto-start tracker (no-VIS fallback)
    this._idleSampleCounter = 0;
    this._idleSyncOnsets = [];
    this._idleSyncActive = false;
    this._idleSyncBase = 0; // slow EMA baseline of e12 (content leakage floor)
    this._idleSyncBaseAlpha = 1 - Math.exp(-1 / (SAMPLE_RATE * 0.2)); // τ=200 ms
    // Per-mode decoding
    this.modeKey = null;
    this.mode = null;
    this.lineNum = 0;
    this.imageData = null;
    this.sampleCounter = 0;
    // Per-line buffers: frequency for pixel extraction, sync envelope for peak
    this.lineFreqs = [];
    this.lineSyncEnv = [];
    // Slant regression + correction
    this.slantRegressor = new SlantRegressor();
    this.slantFactor = 1.0; // multiplies nominal line-sample count
    this.slantIter = 0;
    this._slantDriftDetected = false; // set when first trigger corrects >300 ppm
    this.lineLenNominal = 0; // cached nominal line length (unmodified by slant)
    this.prevCr = null;
    this.prevCb = null;
    // Diagnostics
    this._diagCount = 0;
    this._partialStall = 0;
    this._syncLockFound = false;
    this._syncDipStart = null;
    this._lineSyncPeak = 0;
    this._lineSyncPeakIdx = -1;
    this._envSawLow = false;
    // Decode-quality gate — per-line sync presence + sync-column scatter.
    this._linesWithSync = 0;
    this._syncPeakCols = [];
    // Two-pass receive: per-line (freqs, syncPeakIdx) snapshots so we
    // can re-decode with the final slantFactor at end-of-image. See
    // _finishLine + _emitImage.
    this._lineHistory = [];
  }

  reset() {
    this._initFilters();
    this._initState();
  }

  // Run DSP pipeline for one raw audio sample; returns derived values.
  _runDsp(sample) {
    // --- Hilbert-based instantaneous frequency ---
    this.hilbertBuf[this.hilbertIdx] = sample;
    this.hilbertIdx = (this.hilbertIdx + 1) % HILBERT_TAPS;
    // Convolve the same delay line with two linear-phase FIRs:
    //   imag = band-limited Hilbert  → 90° phase shift, in-band only
    //   real = matching band-pass    → 0° phase shift, in-band only
    // Both filters share the same group delay (HILBERT_DELAY samples), so
    // real and imag here are aligned in time.
    let imag = 0, real = 0;
    let idx = this.hilbertIdx;
    for (let t = 0; t < HILBERT_TAPS; t++) {
      const s = this.hilbertBuf[idx];
      imag += s * hilbertCoeffs[t];
      real += s * realBpCoeffs[t];
      idx = (idx + 1) % HILBERT_TAPS;
    }
    const phase = Math.atan2(imag, real);
    let dPhase = phase - this.prevPhase;
    if (dPhase > Math.PI) dPhase -= TWO_PI;
    else if (dPhase < -Math.PI) dPhase += TWO_PI;
    this.prevPhase = phase;
    let rawFreq = -dPhase * SAMPLE_RATE / TWO_PI;
    // Reject wildly out-of-band readings (noise dominates at start of capture).
    // We deliberately keep this loose — narrowing to the SSTV tone band [1100,
    // 2400] regressed 25 dB SNR sharply because legitimate noisy excursions
    // got replaced with stale freqs. Pixel-level in-band gating in
    // `extractChannel` already filters smearing residue.
    if (rawFreq < 600 || rawFreq > 2800) {
      rawFreq = this._lastValidFreq;
    } else {
      this._lastValidFreq = rawFreq;
    }
    // Butterworth LPF for pixel-value smoothing. Offset calibrated from leader.
    const freq = this.freqLpf.process(rawFreq) - this.freqOffset;

    // --- Parallel tone envelopes on raw audio ---
    const e12 = this.env1200.process(sample);
    const e19 = this.env1900.process(sample);
    const e11 = this.env1100.process(sample);
    const e13 = this.env1300.process(sample);

    // Analytic magnitude — in-band (500–3500 Hz) signal amplitude, used by
    // the idle-state AFC to qualify rawFreq readings as "a real tone".
    const mag = Math.sqrt(real * real + imag * imag);

    return { freq, rawFreq, e12, e19, e11, e13, mag };
  }

  // Sync present: dominant 1200 Hz energy above 1900 Hz reference.
  _isSyncTone(e12, e19) {
    return e12 > ENV_THRESHOLD_MIN && e12 > e19 * 1.4;
  }
  _isLeaderTone(e19, e12) {
    return e19 > ENV_THRESHOLD_MIN && e19 > e12 * 1.4;
  }

  processSamples(samples) {
    const results = [];
    const prevLine = this.lineNum;
    let freqSum = 0;
    // Two-pass: capture raw audio from the moment we leave IDLE (leader
    // detected) so the replay decoder sees the full signal from leader
    // onwards. Without leader+VIS in the buffer, a fresh replay decoder
    // would start cold-state and miss line 0's sync detection.
    // Replay-mode skips capture so we don't infinitely recurse.
    for (let i = 0; i < samples.length; i++) {
      const sample = samples[i];
      if (this.state !== STATE_IDLE && !this._replayMode) {
        if (!this._rawBuffer) {
          // Lazy-init buffer when we first leave IDLE — sized for ~150s of audio
          this._rawBuffer = new Float32Array(SAMPLE_RATE * 150);
          this._rawBufferLen = 0;
        }
        if (!this._rawCaptureArmed) {
          // Fresh capture per transmission (2026-07-07): restart at 0 on each
          // IDLE-exit so two-pass replay AND manual redecode see exactly THIS
          // transmission. Previously the length was never reset, so decode
          // #2 onward appended after decode #1 (+4 s growth per overflow,
          // all session) and a replay would re-find the FIRST image.
          this._rawCaptureArmed = true;
          this._rawBufferLen = 0;
        }
        this._captureRaw(sample);
      } else if (this.state === STATE_IDLE && this._rawCaptureArmed) {
        // Back in IDLE: disarm, but KEEP the buffer + length — it holds the
        // just-finished transmission for the manual "Redecode" feature.
        this._rawCaptureArmed = false;
      }
      const dsp = this._runDsp(sample);
      freqSum += dsp.freq;
      const result = this._step(dsp);
      if (result) results.push(result);
    }

    // Track samples since last line progress — used for partial-image timeout
    if (this.lineNum !== prevLine) {
      this._samplesSinceProgress = 0;
    } else {
      this._samplesSinceProgress = (this._samplesSinceProgress || 0) + samples.length;
      const partial = this.checkPartialImage();
      if (partial) results.push(partial);
    }

    // Periodic diagnostics
    this._diagCount++;
    if (this._diagCount % 10 === 0) {
      const avgFreq = samples.length > 0 ? Math.round(freqSum / samples.length) : 0;
      let detail = '';
      if (this.state === STATE_IDLE) {
        detail = 'leader=' + this.leaderSamples + '/' + this.leaderMinSamples
          + ' e19=' + this.env1900.value.toFixed(3);
      } else if (this.state === STATE_LEADER) {
        detail = 'break=' + this.breakSeen + ' leader2=' + this.secondLeaderSamples;
      } else if (this.state === STATE_VIS_BITS) {
        detail = 'bit=' + this.visBitCount + '/9 bits=[' + this.visBits.join('') + ']';
      } else if (this.state === STATE_DECODING) {
        detail = 'line=' + this.lineNum + '/' + (this.mode ? this.mode.height : '?')
          + ' slant=' + ((this.slantFactor - 1) * 1e6).toFixed(0) + 'ppm';
      }
      results.push({
        type: 'rx-debug',
        state: STATE_NAMES[this.state] || '?',
        avgFreq,
        detail,
      });
    }
    return results;
  }

  _step(dsp) {
    switch (this.state) {
      case STATE_IDLE:      return this._stateIdle(dsp);
      case STATE_LEADER:    return this._stateLeader(dsp);
      case STATE_VIS_START: return this._stateVisStart(dsp);
      case STATE_VIS_BITS:  return this._stateVisBits(dsp);
      case STATE_DECODING:  return this._stateDecoding(dsp);
    }
    return null;
  }

  // Idle-state AFC: track magnitude-qualified instantaneous frequency; when
  // a stable tone sits ≥AFC_MIN_DELTA_HZ away from the current detector
  // centers (in either direction — including back toward 0 when an
  // on-frequency station follows an off-tune one), retune the detectors.
  // A false retune can't cause a false decode (leader gate + VIS parity
  // still stand); the risk it manages is DEAFNESS, so it re-aims freely.
  _afcTrack(rawFreq, mag) {
    if (mag < AFC_MAG_MIN || rawFreq < 1900 - AFC_MAX_OFFSET_HZ - 100 || rawFreq > 1900 + AFC_MAX_OFFSET_HZ + 100) {
      this._afcQualified = 0;
      return;
    }
    const a = this._afcAlpha;
    const d = rawFreq - this._afcMean;
    this._afcMean += a * d;
    this._afcVar += a * (d * d - this._afcVar);
    this._afcQualified++;
    if (this._afcQualified < Math.round(SAMPLE_RATE * AFC_SUSTAIN_MS / 1000)) return;
    if (Math.sqrt(this._afcVar) > AFC_STD_MAX_HZ) return;
    const offset = Math.max(-AFC_MAX_OFFSET_HZ, Math.min(AFC_MAX_OFFSET_HZ, this._afcMean - 1900));
    if (Math.abs(offset - this.toneOffset) < AFC_MIN_DELTA_HZ) return;
    this._setToneOffset(offset);
    this._afcQualified = 0;
  }

  // Sync-interval auto-start: in IDLE, watch for 1200 Hz sync pulses at a
  // stable repetition interval matching a known mode's line period —
  // MMSSTV's no-VIS fallback for joining a transmission already in
  // progress. Needs SYNC_START_MIN_INTERVALS consistent intervals, so
  // noise (random onsets) and speech never qualify; the false-emit
  // fixtures in test/sstv-quality-test.js guard that property.
  _trySyncIntervalStart() {
    const onsets = this._idleSyncOnsets;
    if (onsets.length < SYNC_START_MIN_INTERVALS + 1) return null;
    const intervals = [];
    for (let i = 1; i < onsets.length; i++) {
      const d = onsets[i] - onsets[i - 1];
      // Plausible line periods: ~57 ms (Robot 24) to ~900 ms (Scottie DX)
      if (d >= SAMPLE_RATE * 0.05 && d <= SAMPLE_RATE * 0.95) intervals.push(d);
    }
    if (intervals.length < SYNC_START_MIN_INTERVALS) return null;
    const sorted = intervals.slice().sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const consistent = intervals.filter((d) => Math.abs(d - median) / median < 0.02);
    if (consistent.length < SYNC_START_MIN_INTERVALS) return null;
    const match = syncStartTable().find((m) =>
      Math.abs(median - m.lineSamples) / m.lineSamples <= SYNC_START_TOL);
    if (!match) return null;

    this._enterDecodingMode(match.key);
    this._syncIntervalStarted = true;
    // No leader was heard, so the leader-derived pixel calibration never
    // ran — seed it from the AFC coarse offset (0 when on-frequency); the
    // per-line continuous AFC refines from the sync plateaus.
    this.freqOffset = this.toneOffset;
    // Alignment: the onset that completed the pattern IS a sync pulse.
    // Sync sits syncInLineOffset into the line (0 except Scottie), so we
    // are that many samples past the line start right now. Backfill the
    // already-elapsed portion with black so line 0 renders partially
    // instead of shifting every subsequent line.
    if (match.syncInLineOffset > 0) {
      this.sampleCounter = match.syncInLineOffset;
      this.lineFreqs = new Array(match.syncInLineOffset).fill(BLACK_FREQ);
      this.lineSyncEnv = new Array(match.syncInLineOffset).fill(0);
    }
    return {
      type: 'rx-debug',
      state: 'DECODING',
      avgFreq: 1200,
      detail: `Sync-interval auto-start: ${match.key} (period ${Math.round(median / SAMPLE_RATE * 1000)} ms, no VIS heard)`,
    };
  }

  // Sync-onset tracking for the no-VIS auto-start. Runs in BOTH pre-decode
  // states (IDLE and LEADER): mid-image content can sustain enough 1900 Hz
  // energy to false-lock the leader detector, and while the machine hunts
  // for a break/VIS that never comes it would otherwise be blind to the
  // very sync pattern that identifies the transmission.
  _trackIdleSync(e12, e19) {
    this._idleSampleCounter++;
    // Onset = e12 rising well above its own slow baseline (τ=200 ms EMA of
    // content leakage into the sync band). The plain _isSyncTone boolean
    // (e12 > e19·1.4) can't fire mid-image: short Martin/Scottie syncs only
    // partially charge the 20 ms-rise envelope while the 1900 Hz detector
    // still carries content residue. A relative rising edge fires on every
    // line sync regardless; interval consistency does the noise rejection.
    this._idleSyncBase += this._idleSyncBaseAlpha * (e12 - this._idleSyncBase);
    const onsetThr = Math.max(ENV_THRESHOLD_MIN, this._idleSyncBase * 2);
    if (!this._idleSyncActive && e12 > onsetThr) {
      this._idleSyncActive = true;
      this._idleSyncOnsets.push(this._idleSampleCounter);
      if (this._idleSyncOnsets.length > 12) this._idleSyncOnsets.shift();
      return this._trySyncIntervalStart();
    }
    if (this._idleSyncActive
        && e12 < Math.max(ENV_THRESHOLD_MIN * 0.75, this._idleSyncBase * 1.3)) {
      this._idleSyncActive = false;
    }
    return null;
  }

  // STATE_IDLE: wait for sustained 1900 Hz leader energy.
  _stateIdle({ freq, rawFreq, e19, e12, mag }) {
    this._afcTrack(rawFreq, mag);
    const started = this._trackIdleSync(e12, e19);
    if (started) return started;
    if (this._isLeaderTone(e19, e12)) {
      this.leaderSamples++;
      // Use raw (pre-offset) frequency for calibration
      this.leaderFreqAccum += rawFreq;
      this.leaderFreqSqAccum += rawFreq * rawFreq;
      this.leaderFreqCount++;
      if (this.leaderSamples >= this.leaderMinSamples) {
        const measuredLeader = this.leaderFreqAccum / this.leaderFreqCount;
        const variance = Math.max(0, this.leaderFreqSqAccum / this.leaderFreqCount - measuredLeader * measuredLeader);
        const leaderStd = Math.sqrt(variance);
        // Noise gate: a real leader is a stable tone at the (AFC-retuned)
        // detector center. Reject band noise that merely sustained envelope
        // energy — its measured frequency is off-center and/or wildly
        // variant. Validate against 1900+toneOffset so an AFC capture at,
        // say, +200 Hz isn't rejected by the absolute-1900 test; freqOffset
        // below stays ABSOLUTE (measured − 1900) so pixel mapping is exact.
        if (Math.abs(measuredLeader - (1900 + this.toneOffset)) > LEADER_MEAN_TOL_HZ || leaderStd > LEADER_STD_MAX_HZ) {
          this.leaderSamples = 0;
          this.leaderFreqAccum = 0;
          this.leaderFreqSqAccum = 0;
          this.leaderFreqCount = 0;
          return {
            type: 'rx-debug',
            state: 'IDLE',
            avgFreq: Math.round(measuredLeader),
            detail: `Leader rejected as noise (mean=${Math.round(measuredLeader)}Hz std=${Math.round(leaderStd)}Hz)`,
          };
        }
        this.freqOffset = measuredLeader - 1900;
        this.leaderFreqAccum = 0;
        this.leaderFreqSqAccum = 0;
        this.leaderFreqCount = 0;
        this.state = STATE_LEADER;
        this.breakSeen = false;
        this.secondLeaderSamples = 0;
        this._transitionGrace = 0;
        return {
          type: 'rx-debug',
          state: 'LEADER',
          avgFreq: Math.round(measuredLeader),
          detail: 'Leader detected, offset=' + Math.round(this.freqOffset) + ' Hz',
        };
      }
    } else {
      this.leaderSamples = Math.max(0, this.leaderSamples - 2);
      if (this.leaderSamples === 0) {
        this.leaderFreqAccum = 0;
        this.leaderFreqSqAccum = 0;
        this.leaderFreqCount = 0;
      }
    }
    return null;
  }

  // STATE_LEADER: after initial leader, expect 1200 Hz break -> second leader -> 1200 Hz start bit.
  _stateLeader({ e12, e19 }) {
    const isLeader = this._isLeaderTone(e19, e12);
    const isBreak  = this._isSyncTone(e12, e19);
    // Keep the no-VIS sync tracker alive: a false leader-lock on image
    // content must not blind the auto-start (see _trackIdleSync). A real
    // VIS break adds one onset here — harmless, it never forms 5
    // line-period-consistent intervals.
    const syncStarted = this._trackIdleSync(e12, e19);
    if (syncStarted) return syncStarted;

    if (!this.breakSeen) {
      if (isLeader) {
        this._transitionGrace = 0;
      } else if (isBreak) {
        this.breakSeen = true;
        this.secondLeaderSamples = 0;
        this._transitionGrace = 0;
        return { type: 'rx-debug', state: 'LEADER', avgFreq: 1200, detail: '1200 Hz break detected' };
      } else {
        this._transitionGrace++;
        // Generous grace — envelope detectors have ~20 ms rise time
        if (this._transitionGrace > Math.round(SAMPLE_RATE * 0.04)) {
          this.state = STATE_IDLE;
          this.leaderSamples = 0;
          return { type: 'rx-debug', state: 'IDLE', avgFreq: 0, detail: 'Leader lost before break' };
        }
      }
    } else {
      if (isLeader) {
        this.secondLeaderSamples++;
        this._transitionGrace = 0;
      } else if (this.secondLeaderSamples > Math.round(SAMPLE_RATE * 0.03) && isBreak) {
        // 30ms+ of second leader, now start bit (1200 Hz) — VIS begins
        this.state = STATE_VIS_START;
        this.visStartSamples = 0;
        return { type: 'rx-debug', state: 'VIS_START', avgFreq: 1200, detail: 'VIS start bit detected' };
      } else if (isBreak) {
        this._transitionGrace = 0;
      } else {
        this._transitionGrace++;
        if (this._transitionGrace > Math.round(SAMPLE_RATE * 0.04)) {
          this.state = STATE_IDLE;
          this.leaderSamples = 0;
          return { type: 'rx-debug', state: 'IDLE', avgFreq: 0, detail: 'Second leader lost' };
        }
      }
    }
    return null;
  }

  // STATE_VIS_START: consume the 1200 Hz start bit (30 ms).
  _stateVisStart() {
    this.visStartSamples++;
    // Allow small settle window past the nominal 30 ms for envelope fall time
    const settleExtra = Math.round(SAMPLE_RATE * 0.004);
    if (this.visStartSamples >= this.visExpectedSamples + settleExtra) {
      this.state = STATE_VIS_BITS;
      this.visBits = [];
      this.visBitSamples = 0;
      this.visBitE11 = 0;
      this.visBitE13 = 0;
      this.visBitE19 = 0;
      this.visBitCount = 0;
    }
    return null;
  }

  // STATE_VIS_BITS: 7 data bits + 1 parity + stop bit. 1100 Hz = 1, 1300 Hz = 0.
  // Accumulate narrowband tone envelopes in the center 60% of each bit window
  // to avoid transition ringing.
  _stateVisBits({ e11, e13, e19 }) {
    this.visBitSamples++;
    const margin = Math.round(this.visExpectedSamples * 0.2);
    if (this.visBitSamples > margin && this.visBitSamples < this.visExpectedSamples - margin) {
      this.visBitE11 += e11;
      this.visBitE13 += e13;
      this.visBitE19 += e19;
    }

    if (this.visBitSamples >= this.visExpectedSamples) {
      const E11 = this.visBitE11;
      const E13 = this.visBitE13;
      const E19 = this.visBitE19;
      this.visBitSamples = 0;
      this.visBitE11 = 0;
      this.visBitE13 = 0;
      this.visBitE19 = 0;

      if (this.visBitCount < 8) {
        // Qualification: at least one of the bit tones must dominate the 1900 Hz
        // reference. If both are weak, the bit is unreliable — mark as uncertain.
        const bitToneSum = E11 + E13;
        const reliable = bitToneSum > E19 * 1.5;
        const bit = E11 > E13 ? 1 : 0;
        this.visBits.push(bit);
        if (!reliable) {
          // For now just log; extended VIS could error-correct later
          // (parity bit check below will catch most issues)
        }
      }
      this.visBitCount++;

      if (this.visBitCount >= 9) {
        // 7 data + parity + stop consumed
        let visCode = 0;
        for (let i = 0; i < 7; i++) visCode |= (this.visBits[i] << i);
        // Parity check — MMSSTV-style: if parity fails, try flipping each bit
        // to find a valid code (single-bit correction).
        const parityBit = this.visBits[7];
        const computedParity = this.visBits.slice(0, 7).reduce((a, b) => a ^ b, 0);
        let finalCode = visCode;
        if (parityBit !== computedParity) {
          // Try single-bit flips
          let corrected = null;
          for (let flip = 0; flip < 7; flip++) {
            const trial = visCode ^ (1 << flip);
            if (VIS_TO_MODE[trial]) { corrected = trial; break; }
          }
          if (corrected != null) finalCode = corrected;
        }

        const modeKey = VIS_TO_MODE[finalCode];
        if (modeKey) {
          this._enterDecodingMode(modeKey);
          return { type: 'rx-vis', mode: modeKey, modeName: this.mode.name };
        } else {
          const detail = 'Unknown VIS ' + visCode + ' bits=[' + this.visBits.join('') + ']';
          this.state = STATE_IDLE;
          this.leaderSamples = 0;
          return { type: 'rx-debug', state: 'IDLE', avgFreq: 0, detail };
        }
      }
    }
    return null;
  }

  // Append one raw audio sample to the two-pass buffer, growing if needed.
  // Pre-sized in _enterDecodingMode for the typical mode; growth here is
  // a fallback for over-long captures (drifted + padded).
  _captureRaw(sample) {
    if (this._rawBufferLen >= this._rawBuffer.length) {
      const next = new Float32Array(this._rawBuffer.length + (48000 * 4)); // +4s
      next.set(this._rawBuffer);
      this._rawBuffer = next;
    }
    this._rawBuffer[this._rawBufferLen++] = sample;
  }

  // Manual re-decode of the retained raw-audio buffer — MMSSTV's "replay
  // from RX buffer" (2026-07-07). The buffer holds the last transmission
  // from leader/first-sync onward; slantPpm optionally resamples to undo a
  // user-observed slant before the replay. Human-initiated, so the quality
  // gate never fully rejects: worst case the result comes back weak-tier.
  redecodeBuffer({ slantPpm = 0 } = {}) {
    if (!this._rawBuffer || !this._rawBufferLen) return null;
    const src = slantPpm
      ? this._resampleRaw(this._rawBuffer, this._rawBufferLen, 1 / (1 + slantPpm * 1e-6))
      : this._rawBuffer.subarray(0, this._rawBufferLen);
    const replay = new SstvDecoder();
    replay._replayMode = true;
    replay._manualEmit = true;
    replay.toneOffset = this.toneOffset; // keep the AFC capture
    replay._initFilters();
    let image = null;
    const CHUNK = 4096;
    for (let i = 0; i < src.length; i += CHUNK) {
      const chunk = new Float32Array(src.subarray(i, Math.min(i + CHUNK, src.length)));
      for (const r of replay.processSamples(chunk)) {
        if (r.type === 'rx-image') image = r;
      }
    }
    if (!image && replay.mode && replay.lineNum > 4) {
      const forced = replay._emitImage();
      if (forced && forced.type === 'rx-image') image = forced;
    }
    if (image) {
      image.redecode = true;
      image.stats = image.stats || {};
      image.stats.redecode = true;
      if (slantPpm) image.stats.redecodePpm = slantPpm;
    }
    return image;
  }

  // Linear-interp resample of the raw audio buffer to undo encoder
  // clock drift. ratio > 1 inserts samples; < 1 drops them.
  //
  // Resampler experiments (2026-05-31, all gave same matrix-pass-count
  // of 12/15, none closed the remaining Robot drift cases):
  //   - Linear (here): 12s matrix runtime. Baseline.
  //   - Sinc Lanczos-3 (16-tap): +1.5 dB Martin/Robot36 but -0.5 dB
  //     Scottie1 (ringing on G→B channel transitions). 6× slower.
  //   - Catmull-Rom cubic (4-tap): also -0.5 dB Scottie1. 5× slower.
  //
  // Conclusion: Scottie's per-pixel median-of-trimmed-middle pixel
  // sampling is brittle to smoother (higher-order) interpolators —
  // they introduce sub-sample-level smearing the median can't reject.
  // Linear's "noisy at boundaries" interpolation actually helps
  // Scottie's median sampling reject the boundary samples cleanly.
  // Keep linear; the Robot drift cases need attack via a different
  // path (chroma re-sampling or skip-replay-for-YCbCr).
  _resampleRaw(buf, len, ratio) {
    const outLen = Math.round(len * ratio);
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const src = i / ratio;
      const i0 = Math.floor(src);
      const i1 = Math.min(i0 + 1, len - 1);
      const frac = src - i0;
      out[i] = buf[i0] * (1 - frac) + buf[i1] * frac;
    }
    return out;
  }

  _enterDecodingMode(modeKey) {
    this.modeKey = modeKey;
    this.mode = MODES[modeKey];
    this.state = STATE_DECODING;
    this.lineNum = 0;
    this.sampleCounter = 0;
    this.lineFreqs = [];
    this.lineSyncEnv = [];
    this.imageData = new Uint8ClampedArray(this.mode.width * this.mode.height * 4);
    for (let p = 3; p < this.imageData.length; p += 4) this.imageData[p] = 255;
    // Two-pass raw-audio buffer is initialized lazily in processSamples
    // the moment we leave IDLE — see comment there.
    this._twoPassDone = false;
    this.prevCr = null;
    this.prevCb = null;
    // Per-line chroma & luma history for Robot 36 bilateral interp.
    // chromaByLine[y] = { isCr, vals: Uint8Array(w) }; yByLine[y] = Uint8Array(w).
    // Bilateral re-render of line y-1 fires when y arrives, averaging the
    // missing chroma component from y-2 and y. Memory is bounded (height *
    // width * ~3 bytes ≈ 230KB for Robot 36).
    if (this.mode.colorSpace === 'ycbcr' && this.mode.halfChrom) {
      this.chromaByLine = new Array(this.mode.height);
      this.yByLine = new Array(this.mode.height);
    } else {
      this.chromaByLine = null;
      this.yByLine = null;
    }
    this.slantRegressor.reset();
    this.slantFactor = 1.0;
    this.slantIter = 0;
    this._slantDriftDetected = false;
    this.lineLenNominal = this._nominalLineSamples();
    this._lineSyncPeak = 0;
    this._lineSyncPeakIdx = -1;
    // Reset tone envelopes so VIS stop-bit energy doesn't bias line 0's
    // sync-peak tracking and confuse the per-line anchor.
    this.env1200.reset();
    this.env1900.reset();
    this.env1100.reset();
    this.env1300.reset();
    // Running estimate of line-start position in buffer — used as fallback
    // when sync can't be detected in the current line (e.g. final line).
    this._lastLineStart = null;
    this._lineStartHist = null;
  }

  // --- Decoding loop ---

  _stateDecoding({ freq, e12 }) {
    this.lineFreqs.push(freq);
    this.lineSyncEnv.push(e12);
    this.sampleCounter++;
    // Peak tracking with "fresh pulse" guard: once a buffer begins, ignore
    // envelope peaks until it has dipped to near-zero. This rejects decaying
    // residue from the previous line's sync (which could otherwise latch the
    // peak at buffer start when a sync pulse spans a buffer boundary).
    //
    // AFC-retuned decodes get a TIME-BASED arm fallback (2026-07-07): with
    // the detectors shifted toward the image band, mid-line content leaks a
    // floor into the sync envelope that can sit a hair above the absolute
    // arm constant — e.g. +200 Hz off-tune gave a 0.0209 floor vs the 0.02
    // threshold, so the guard never re-armed and every line lost its sync
    // (sync=0%, decode discarded). 25% into the line the previous pulse's
    // decay (τ≈20 ms) is long gone in every mode, so arming there preserves
    // the fresh-pulse intent without a level heuristic. STRICTLY gated on
    // an active AFC retune: on-frequency decodes keep the byte-identical
    // absolute path — two level-based variants of this fallback shifted
    // which lines contributed slant-regressor points on clean signals and
    // cost the martin1 clean ratchet ~1 dB. Don't widen the gate.
    const lineSamples = this.getLineSamples();
    if (!this._envSawLow) {
      if (e12 < ENV_THRESHOLD_MIN) this._envSawLow = true;
      else if (Math.abs(this.toneOffset) >= AFC_MIN_DELTA_HZ
               && this.lineFreqs.length > lineSamples * 0.25) {
        this._envSawLow = true;
      }
    } else if (e12 > this._lineSyncPeak) {
      this._lineSyncPeak = e12;
      this._lineSyncPeakIdx = this.lineFreqs.length - 1;
    }

    if (this.sampleCounter >= lineSamples) {
      const lineResult = this._finishLine();
      if (this.lineNum >= this.mode.height) return this._emitImage();
      return lineResult;
    }
    return null;
  }

  _finishLine() {
    const mode = this.mode;
    // Record sync peak for slant regression
    if (this._lineSyncPeakIdx >= 0) {
      this.slantRegressor.add(this.lineNum, this._lineSyncPeakIdx);
    }
    // Decode-quality gate — a real SSTV line has a strong 1200 Hz sync pulse.
    if (this._lineSyncPeakIdx >= 0 && this._lineSyncPeak > ENV_THRESHOLD_MIN * 2) {
      this._linesWithSync++;
      this._syncPeakCols.push(this._lineSyncPeakIdx);
    }
    // Continuous AFC: take median of smoothed freq over the sync plateau and
    // slowly nudge freqOffset so sync reads as 1200 Hz. This tracks radio drift.
    if (this._lineSyncPeakIdx >= 0 && this._lineSyncPeak > ENV_THRESHOLD_MIN * 2) {
      const plateauThreshold = this._lineSyncPeak * 0.7;
      const syncFreqs = [];
      for (let i = 0; i < this.lineSyncEnv.length; i++) {
        if (this.lineSyncEnv[i] > plateauThreshold) syncFreqs.push(this.lineFreqs[i]);
      }
      if (syncFreqs.length >= 10) {
        syncFreqs.sort((a, b) => a - b);
        const med = syncFreqs[Math.floor(syncFreqs.length / 2)];
        const err = med - 1200;
        if (Math.abs(err) < 80) this.freqOffset += 0.05 * err;
      }
    }
    // Two-pass receive: snapshot the raw line data BEFORE decoding so we
    // can re-decode at end-of-image with the final slantFactor. Lines
    // captured before the first slant refinement (line 12) get painted
    // with slantFactor=1.0, which leaves measurable PSNR loss in the
    // top of the image at ≥1000 ppm drift. Final-pass re-decode using
    // the converged slantFactor recovers those lines. Memory cost:
    // ~21000 floats per line × 256 lines ≈ 22 MB worst-case for a
    // Martin M1 RX. Acceptable for the duration of a single image.
    // K3SBP 2026-05-31.
    if (!this._lineHistory) this._lineHistory = [];
    this._lineHistory.push({
      freqs: this.lineFreqs.slice(),
      syncPeakIdx: this._lineSyncPeakIdx,
      lineNum: this.lineNum,
    });
    const lineResult = this.decodeLine(this.lineFreqs);
    this.lineFreqs = [];
    this.lineSyncEnv = [];
    this.sampleCounter = 0;
    // Remember this line's sync peak + envelope floor — the fresh-pulse
    // guard's adaptive arm threshold derives from both (see _stateDecoding).
    if (this._lineSyncPeak > 0) this._prevLineSyncPeak = this._lineSyncPeak;
    if (this._lineEnvMin !== undefined && this._lineEnvMin !== Infinity) {
      this._prevLineEnvMin = this._lineEnvMin;
    }
    // A full line with the guard never arming = the absolute threshold sits
    // below the content floor (off-tune/AFC-retuned signals) — enable the
    // adaptive rescue for the rest of this decode.
    if (!this._envSawLow && this.lineNum > 0) this._armRescue = true;
    this._lineEnvMin = Infinity;
    this._lineSyncPeak = 0;
    this._lineSyncPeakIdx = -1;
    this._envSawLow = false;
    // PD modes encode TWO image rows per audio "line pair", so advance
    // lineNum by 2 to keep the existing termination check (lineNum >=
    // mode.height) and imageData row indexing correct.
    this.lineNum += (this.mode && this.mode.colorSpace === 'pd') ? 2 : 1;
    // Periodically refine slant correction (iterative with tightening windows)
    this._updateSlant();
    return lineResult;
  }

  _updateSlant() {
    // Refine the rate correction in up to 5 iterative passes. After each
    // successful correction, reset the regressor so subsequent passes fit
    // only the residual drift (not the already-corrected historical data).
    //
    // First trigger moved from line 24 to 12 (2026-05-31 K3SBP). Earlier
    // refinement helps high-drift captures: at 1000+ ppm we were doing
    // ~24 lines of badly-skewed decode before the first correction, and
    // the later passes never fully caught up because the slant regressor
    // got contaminated by mis-detected sync columns from those early
    // skewed lines. Trigger at line 12 gets us a coarse correction
    // before the slant has dragged sync columns out of the unwrap window.
    // Trigger schedule rationale: first refinement at line 12 catches
    // big initial drift before mis-detected sync columns contaminate the
    // regressor (key for ≥1000ppm captures). Mid-image triggers refine
    // progressively. Post-128 triggers catch residual drift that would
    // otherwise let the second half of the image skew — vital for
    // 256-line modes (Martin/Scottie). K3SBP 2026-05-31.
    //
    // IMPORTANT: line 12 is load-bearing for Martin clean. Moving the
    // first trigger to line 16 was tried — improved drift cases by
    // 4-14 dB but regressed Martin clean from 44 → 22 dB. The
    // mechanism isn't fully understood but is reproducible. Don't
    // delay the first trigger past 12.
    const triggers = [12, 24, 40, 64, 96, 128, 160, 192, 224];
    if (this.slantIter >= triggers.length) return;
    if (this.lineNum < triggers[this.slantIter]) return;
    // YCbCr modes (Robot 36 / Robot 72) freeze late-trigger slant
    // updates ONLY when the signal hasn't shown significant drift.
    //
    // Reason: lines 97+ in YCbCr modes have noisy per-line sync (half-
    // chrom alternates Cr/Cb), so the late-trigger regressor fits on
    // a small set and over-corrects on slope noise. Worst-observed:
    // robot36 @ 30dB SNR seed=1 (probe 2026-05-31) where line 128
    // applied +81 ppm of fake "slope" — ruined bottom half (15.4 dB
    // vs 25 dB if late triggers are skipped).
    //
    // BUT for actually-drifted captures (±500 ppm or worse), late
    // triggers ARE needed because residual drift accumulates through
    // the second half. So: use the FIRST trigger's correction magnitude
    // as a "drift detector" — if line 12 corrected >300 ppm, this is
    // a drifted signal and we keep all triggers. Otherwise (clean or
    // noise-only), freeze after line 96.
    //
    // 300 ppm threshold: empirically separates clean/noise (~50–100
    // ppm corrections from sync jitter) from real encoder drift
    // (500+ ppm). Channel modes (Martin/Scottie) keep the full
    // schedule regardless — their late fits have many sync points
    // and don't over-correct.
    if (
      this.mode && this.mode.colorSpace === 'ycbcr' &&
      triggers[this.slantIter] > 96 &&
      !this._slantDriftDetected
    ) return;

    const lineWidth = this._nominalLineSamples();
    // Tolerance shrinks as we refine — outliers from later passes are
    // less likely with a near-correct slantFactor in place. Post-128
    // triggers stay at the tightest tolerance.
    const tolerances = [0.15, 0.10, 0.06, 0.04, 0.03, 0.025, 0.025, 0.025, 0.025].map(f => f * lineWidth);
    const tol = tolerances[this.slantIter];
    const fit = this.slantRegressor.compute(lineWidth, tol);
    if (fit) {
      const residual = fit.k0 / lineWidth;
      // Sanity-reject wildly off corrections. Cap shrinks with trigger
      // index: early triggers admit a wide range (≥1000 ppm encoder
      // drift is real), later triggers reject anything more than a
      // physically-plausible RESIDUAL after the bulk slant is known.
      //
      // Without this, noise-pattern flukes (e.g. robot36 @ 30dB seed=1
      // probe 2026-05-31) generate large late-image swings that distort
      // the second half of the picture. Real clocks don't change rate
      // mid-image; if the late regressor disagrees with the early one
      // by more than a few hundred ppm, the late one is the one that's
      // wrong.
      //
      // Trigger schedule: [12, 24, 40, 64, 96, 128, 160, 192, 224]
      //   0–1  (lines 12, 24)  → 2.0%  (catch big initial drift)
      //   2    (line 40)       → 0.5%
      //   3    (line 64)       → 0.2%
      //   4+   (line 96+)      → 0.1% (1000 ppm — physically improbable
      //                                residual once converged)
      const residualCaps = [0.02, 0.02, 0.005, 0.002, 0.001, 0.001, 0.001, 0.001, 0.001];
      const cap = residualCaps[this.slantIter] ?? 0.001;
      if (Math.abs(residual) < cap) {
        // Compose with existing correction so the factor accumulates instead
        // of decaying back toward 1.0 each iteration.
        this.slantFactor *= (1 + residual);
        this.slantRegressor.reset();
        // Drift detector: if the FIRST trigger (line 12) corrected
        // more than 300 ppm, treat this as a drifted signal and
        // continue late-trigger updates even on YCbCr modes (see
        // YCbCr freeze gate above).
        if (this.slantIter === 0 && Math.abs(residual) > 0.0003) {
          this._slantDriftDetected = true;
        }
      }
    }
    this.slantIter++;
  }

  // Current effective line length accounting for slant correction.
  getLineSamples() {
    return Math.round(this._nominalLineSamples() * this.slantFactor);
  }

  _nominalLineSamples() {
    return nominalLineSamplesFor(this.mode);
  }

  // Emit decoded image (full or partial), or discard it if the decode is noise.
  _emitImage() {
    // Compute the same metrics the gate uses, then log them either way.
    // N4RDX 2026-05-23 reported Scottie 2 producing visibly bad ("red")
    // decodes — without seeing the metric on a passing-but-bad image we
    // couldn't tell whether the gate was too lenient, the bias was off,
    // or his signal was just weak. Now every decode-end surfaces the
    // numbers; bug reports come with data.
    const total = this.mode ? this.mode.height : 1;
    const syncPct = Math.round((this._linesWithSync / Math.max(1, total)) * 100);
    const spread = this._computeSyncSpread();
    const stats = { mode: this.modeKey, sync: syncPct, spread: +spread.toFixed(3) };

    // Decode-quality gate, TWO-TIER (2026-07-07, MMSSTV-parity roadmap #1) —
    // a real SSTV image has a strong 1200 Hz sync pulse at a consistent
    // column on essentially every line; a noise "decode" has neither.
    //   good   → emit + auto-save (unchanged behavior).
    //   weak   → EMIT with weak:true so the operator sees the noisy image
    //            (MMSSTV always paints something); main skips auto-save.
    //            Reaching here at all required a VIS lock with valid parity
    //            plus ≥half an image of lines — noise dies at the leader
    //            gate long before this point, and the false-emit guard in
    //            test/sstv-quality-test.js enforces that weak emissions
    //            never fire on the real band-noise fixtures.
    //   reject → drop silently (scattered sync = no real transmission).
    let tier = this._decodeQualityTier();
    // Manual redecode always shows SOMETHING — the human asked for it.
    if (tier === 'reject' && this._manualEmit) tier = 'weak';
    if (tier === 'reject') {
      this.reset();
      return {
        type: 'rx-debug',
        state: 'IDLE',
        avgFreq: 0,
        detail: `Decode discarded — mode=${stats.mode} sync=${stats.sync}% spread=${stats.spread} (gate: sync≥50%, spread<0.15)`,
        stats,
      };
    }
    if (tier === 'weak') {
      // Skip two-pass replay: the drift estimate is unreliable at low sync
      // ratios, and replay's own quality gate compares sync percentages
      // that are already in the noise here.
      stats.weak = true;
      const weakResult = {
        type: 'rx-image',
        imageData: this.imageData,
        width: this.mode.width,
        height: this.mode.height,
        mode: this.modeKey,
        weak: true,
        stats,
      };
      this.reset();
      return weakResult;
    }
    // Phase 1 two-pass receive: if the streaming pass detected
    // significant clock drift, resample the captured raw audio buffer
    // by 1/slantFactor (undoing the drift on the wire) and re-decode
    // through a fresh decoder instance. The fresh decoder sees a
    // non-drifted signal, so slantFactor stays at 1.0 throughout and
    // every line uses correct timing — no per-line slant-correction
    // composition mismatch.
    //
    // Memory: the captured buffer is ~24MB for a Martin M1 at +1000ppm.
    // The fresh decoder allocates its own filters + imageData. Combined
    // peak is bounded and only held during the final-pass decode.
    //
    // Gated on |slantFactor - 1| > 100 ppm — below that the gain is
    // negligible and not worth the extra decode cost.
    // YCbCr modes (Robot 36 / Robot 72) gain less from two-pass than
    // GBR channel modes do — the linear-interp resample on chroma
    // bands costs more than the timing correction recovers (verified
    // bench 2026-05-31: robot72 streaming 21.6 dB → replay 21.0 dB at
    // +1000ppm). Keep streaming for them by default; revisit when a
    // chroma-aware resampler or sinc-shorter-window variant lands.
    // YCbCr replay results are non-uniform across drift directions:
    // robot36 -500 / robot72 +500 gain +4 dB with replay, but
    // robot36 +500 regresses by 1.8 dB. The current sync-ratio
    // quality gate is mode-agnostic and misses these chroma-resample
    // artifacts. Until a chroma-aware quality metric (or a chroma-
    // safe resampler) lands, keep streaming for YCbCr modes — they
    // benefit less than channel-mode (Martin/Scottie) two-pass.
    //   Bench 2026-05-31 (MAD regressor + replay-on for YCbCr):
    //     robot36 -500: 19.3 → 23.8 dB (+4.5) — gain
    //     robot72 +500: 20.4 → 24.6 dB (+4.2) — gain
    //     robot36 +500: 18.9 → 17.1 dB (-1.8) — loss, fails floor
    //   Net: skip replay for YCbCr until quality gate is smarter.
    // YCbCr replay still gated off. Three quality-gate attempts
    // tried 2026-05-31:
    //   1. Sync ratio only: passes too easily for chroma-resample
    //      artifacts. robot36 +500 lost 1.8 dB.
    //   2. Sharpness gate (mean horiz |Δpixel|, ratio ≥ 0.95):
    //      partial — fixed robot36 +500 but admitted robot36 +1000
    //      replay (-4.9 dB; sharper image but wrong colors).
    //   3. Sharpness gate strict (≥ 1.0): same issue — robot36
    //      +1000 replay was sharper than streaming but PSNR-bad.
    // The underlying problem: any cheap quality gate that uses
    // STREAMING vs REPLAY image features can be fooled when the
    // resampler produces a sharp-but-wrong-colored output. A
    // proper SSIM-style metric or a chroma-similarity score
    // would solve this; both are significant DSP work. Keeping
    // skip-for-YCbCr until that work lands.
    const skipReplayForMode = this.mode && this.mode.colorSpace === 'ycbcr';
    if (
      !this._replayMode &&
      !skipReplayForMode &&
      this._rawBuffer && this._rawBufferLen > 0 &&
      Math.abs(this.slantFactor - 1) > 1e-4
    ) {
      try {
        const finalSlant = this.slantFactor;
        // Resample the captured leader+VIS+image buffer by 1/slantFactor
        // to undo the encoder drift. Output is non-drifted by construction.
        const resampled = this._resampleRaw(this._rawBuffer, this._rawBufferLen, 1 / finalSlant);
        // Fresh decoder, replay-mode (no recursive raw buffering).
        // Replay runs full state machine (IDLE → LEADER → VIS → DECODING)
        // on the non-drifted audio, so its tone envelopes warm up
        // through the leader and line 0 sync detection works correctly.
        const replay = new SstvDecoder();
        replay._replayMode = true;
        // Feed the resampled buffer in chunks
        const CHUNK = 4096;
        let replayImage = null;
        for (let i = 0; i < resampled.length; i += CHUNK) {
          const chunk = resampled.subarray(i, Math.min(i + CHUNK, resampled.length));
          const out = replay.processSamples(chunk);
          for (const r of out) {
            if (r.type === 'rx-image') replayImage = r;
          }
        }
        // If replay didn't naturally emit an image (e.g. ran out of
        // padding), force a partial emission.
        if (!replayImage && replay.lineNum >= this.mode.height * 0.75) {
          replayImage = replay._emitImage();
          if (replayImage && replayImage.type !== 'rx-image') replayImage = null;
        }
        if (replayImage && replayImage.imageData && replayImage.mode === this.modeKey) {
          // Quality gate: only override streaming if replay shows
          // at-least-as-good alignment. Replay's sync ratio should be
          // ≥ streaming's (the resample removes drift, so per-line sync
          // should land MORE consistently). When it doesn't, replay
          // is likely worse than streaming and we keep streaming.
          // Observed in testing 2026-05-31: robot72 streaming gave
          // 21.6 dB, replay gave 21.0 dB because linear-interp
          // aliasing on the chroma scans cost more than the timing
          // correction gained. Gate prevents the regression.
          const rSync = replayImage.stats && replayImage.stats.sync != null
            ? replayImage.stats.sync : 0;
          if (rSync >= syncPct) {
            stats.twoPass = true;
            stats.replaySync = rSync;
            stats.replaySlant = ((finalSlant - 1) * 1e6).toFixed(0) + 'ppm';
            this.imageData = replayImage.imageData;
          } else {
            stats.twoPass = false;
            stats.twoPassReason = `replay sync ${rSync}% < streaming ${syncPct}% — kept streaming result`;
          }
        } else {
          stats.twoPass = false;
          stats.twoPassReason = `replay produced ${replay.lineNum}/${this.mode.height} lines, mode=${replay.modeKey} — kept streaming result`;
        }
      } catch (err) {
        stats.twoPass = false;
        stats.twoPassReason = 'replay threw: ' + (err && err.message ? err.message : err);
      }
    }

    const result = {
      type: 'rx-image',
      imageData: this.imageData,
      width: this.mode.width,
      height: this.mode.height,
      mode: this.modeKey,
      stats, // sync% + spread + two-pass info
    };
    this.reset();
    return result;
  }

  // Sync-column std-dev as a fraction of line width. Returns Infinity when
  // we don't have enough samples (under 8 lines with sync).
  _computeSyncSpread() {
    const cols = this._syncPeakCols;
    if (!cols || cols.length < 8) return Infinity;
    const lineWidth = this.getLineSamples() || 1;
    let mean = 0;
    for (const c of cols) mean += c;
    mean /= cols.length;
    let varSum = 0;
    for (const c of cols) { const d = c - mean; varSum += d * d; }
    return Math.sqrt(varSum / cols.length) / lineWidth;
  }

  // True when the just-finished decode shows real SSTV structure: a 1200 Hz
  // sync pulse present on at least half the lines, landing at a consistent
  // column. Noise produces sparse, randomly-scattered sync peaks. Real sync
  // sits at a near-constant column (gradual slant only); noise scatters
  // uniformly, std ~= 0.29 of the width. 0.15 cleanly separates them.
  // Decode-quality gate: noise-rejection threshold for line-sync rate and
  // sync-column spread. Per-mode threshold via mode.syncGateMin (default
  // 0.5). Robot 36's half-chroma layout legitimately produces a lower
  // per-line sync count even on clean signals — the Y scan registers
  // strong sync but the alternating Cr/Cb scans do not, so the apparent
  // ratio caps near 50%. K3SBP 2026-05-31: clean robot36 decodes were
  // being rejected at sync=47% (just under the 0.5 hard threshold) and
  // never emitting rx-image despite producing 239/240 lines with PSNR
  // well above the 25 dB pass bar.
  _decodeLooksReal() {
    return this._decodeQualityTier() === 'good';
  }

  // Three-way version of the gate: 'good' (auto-save quality), 'weak'
  // (real transmission a human may still want to see — shown with a badge,
  // not auto-saved), 'reject' (noise). The weak floor scales with the
  // per-mode gate (Robot's legit sync ratio caps near 50%, so its weak
  // floor is proportionally lower), and the spread ceiling loosens from
  // 0.15 to 0.25 — still far below the ~0.29 uniform-scatter signature of
  // noise (see comment above _decodeLooksReal's original gate).
  _decodeQualityTier() {
    const total = this.mode ? this.mode.height : 0;
    if (total <= 0) return 'reject';
    const gateMin = this.mode && typeof this.mode.syncGateMin === 'number'
      ? this.mode.syncGateMin
      : 0.5;
    const syncRatio = this._linesWithSync / total;
    const spread = this._computeSyncSpread();
    if (syncRatio >= gateMin && spread < 0.15) return 'good';
    if (syncRatio >= gateMin * 0.5 && spread < 0.25) return 'weak';
    return 'reject';
  }

  // Emit partial image only after a genuine stall — 3 line-widths of audio with
  // no line progress, signaling the transmission has ended. The "near end"
  // gate prevents false partials during the normal between-line gap.
  checkPartialImage() {
    if (this.state !== STATE_DECODING || !this.mode) return null;
    if (this.lineNum < this.mode.height * 0.5) return null;
    const lineLen = this._nominalLineSamples();
    if ((this._samplesSinceProgress || 0) < lineLen * 3) return null;
    // We've gone >=3 line-widths without completing a line — transmission ended.
    if (this.lineFreqs.length > lineLen * 0.5) {
      this.decodeLine(this.lineFreqs);
      this.lineNum++;
    }
    return this._emitImage();
  }

  // --- Per-line pixel extraction ---

  // Locate the strongest 1200 Hz sync pulse in the current line buffer and
  // return the sample index of the pulse's physical start.
  //
  // The envelope crosses half-amplitude AFTER the pulse begins — the BPF
  // Q=25 rings up with τ ≈ 6.6 ms. Time from pulse start to half-peak is
  // τ · ln(2 / (1 + exp(-T/τ))), which depends on the mode's sync duration.
  // We subtract that offset to return the pulse's physical start index.
  _findSyncStart() {
    const env = this.lineSyncEnv;
    if (!env || env.length === 0) return null;
    if (this._lineSyncPeak < ENV_THRESHOLD_MIN * 2) return null;

    // Sync-pulse width validation. The simple-max peak detector tracks
    // a single envelope sample's height; a brief noise impulse near
    // 1200 Hz can spike the envelope and beat the genuine sync plateau.
    // A real sync pulse maintains elevated envelope for ~syncMs; an
    // impulse falls back to noise floor within a few samples.
    //
    // Check: do at least 50% of the samples in a ±syncMs/2 window
    // around _lineSyncPeakIdx exceed peak*0.5? If yes, the peak is
    // broad (real sync). If no, the peak is narrow (impulse) — fall
    // back to a boxcar matched-filter peak which sums energy over a
    // syncMs-wide window and naturally rejects single-sample spikes.
    //
    // Discovered 2026-05-31 chasing robot36 @ 30dB seed=1 anomaly:
    // narrow noise impulses were beating the broad sync plateau on
    // ~5% of lines, pushing the slant regressor into bad fits late
    // in the image.
    const syncWidthSamples = Math.round(SAMPLE_RATE * this.mode.syncMs / 1000);
    let chosenPeakIdx = this._lineSyncPeakIdx;
    if (syncWidthSamples >= 8 && env.length > syncWidthSamples * 2) {
      // Width check around simple-max
      const halfPeakThresh = this._lineSyncPeak * 0.5;
      const halfW = syncWidthSamples >> 1;
      const lo = Math.max(0, this._lineSyncPeakIdx - halfW);
      const hi = Math.min(env.length, this._lineSyncPeakIdx + halfW);
      let elevated = 0;
      for (let i = lo; i < hi; i++) if (env[i] >= halfPeakThresh) elevated++;
      const width = (hi - lo) || 1;
      const broadEnough = elevated >= width * 0.5;
      if (!broadEnough) {
        // Simple-max peak is impulse-like. Find boxcar peak instead.
        let running = 0;
        for (let i = 0; i < syncWidthSamples; i++) running += env[i];
        let bestSum = running;
        let bestStart = 0;
        for (let i = syncWidthSamples; i < env.length; i++) {
          running += env[i] - env[i - syncWidthSamples];
          if (running > bestSum) { bestSum = running; bestStart = i - syncWidthSamples + 1; }
        }
        // Existing edge-detect walks back from this position; use the
        // window's end so it walks through the sync plateau.
        chosenPeakIdx = Math.min(env.length - 1, bestStart + syncWidthSamples - 1);
      }
    }

    const peakIdx = chosenPeakIdx;
    const half = this._lineSyncPeak * 0.5;
    let riseIdx = 0;
    for (let i = peakIdx - 1; i >= 0; i--) {
      if (env[i] < half) { riseIdx = i + 1; break; }
    }
    // Fitted empirically against measured transition offsets in Martin M1
    // (T=4.862 ms needs 126 samples) and Robot (T=9 ms needs 202 samples).
    const TAU_MS = 14.0;
    const FIXED_LAG_MS = 0.41;
    const T = this.mode.syncMs;
    const riseOffsetMs = FIXED_LAG_MS + TAU_MS * Math.log(2 / (1 + Math.exp(-T / TAU_MS)));
    const riseOffsetSamples = Math.round(SAMPLE_RATE * riseOffsetMs / 1000);
    return Math.max(0, riseIdx - riseOffsetSamples);
  }

  // Compute the line-start sample position in the buffer, given the detected
  // sync position and the mode's sync placement within a line. Falls back to
  // the last known line-start when this buffer has no usable sync (e.g. the
  // final line of a transmission, which isn't followed by another sync).
  _computeLineStart(mode, lineLen) {
    const syncStart = this._findSyncStart();
    let measured = null;
    if (syncStart != null) {
      if (mode.scottieLineOrder) {
        // Pre-sync content: sep + G + sep + B. Use pixel-rounded durations so
        // this matches what the encoder actually emitted. Slant-corrected
        // so we infer the sync position correctly on drifted signals.
        const sepLen = this._msS(mode.separatorMs);
        const chanLen = this._msS(mode.pixelMs) * mode.width;
        measured = syncStart - (2 * sepLen + 2 * chanLen);
      } else if (syncStart >= lineLen * 0.5) {
        measured = syncStart - lineLen;
      } else {
        measured = syncStart;
      }
      if (mode.syncBiasSamples) measured += mode.syncBiasSamples;
    }
    // Smooth per-line jitter using a running median of the last few
    // measurements. Per-line sync peak detection has natural jitter from
    // pixel-content leaking through the 1200 Hz BPF; the median rejects
    // occasional outliers while keeping the window short enough that the
    // fit tracks real clock drift without lagging badly.
    if (measured != null) {
      if (!this._lineStartHist) this._lineStartHist = [];
      this._lineStartHist.push(measured);
      if (this._lineStartHist.length > 5) this._lineStartHist.shift();
      const sorted = this._lineStartHist.slice().sort((a, b) => a - b);
      const med = sorted[Math.floor(sorted.length / 2)];
      this._lastLineStart = med;
      return med;
    }
    return this._lastLineStart;
  }

  // Convert ms -> sample count using the shared sample-rate rounding helper.
  _ms(ms) { return Math.round(SAMPLE_RATE * ms / 1000); }

  // Slant-corrected ms -> sample count. Use for per-channel and per-pixel
  // offsets WITHIN a line so the actual symbol length of a drifted
  // encoder tracks pixel sampling positions. CAVEAT: rounding per
  // _msS call absorbs sub-sample slant correction (e.g. Martin pixelMs
  // = 0.4576ms = 21.97 samples; ×0.999 = 21.95 → still rounds to 22).
  // An "accumulate float then round" variant was tried but broke the
  // existing pipeline calibration that's compensating for per-pixel
  // rounding elsewhere — see commit history 2026-05-31. K3SBP.
  _msS(ms) { return Math.round(SAMPLE_RATE * ms / 1000 * this.slantFactor); }

  decodeLine(freqs) {
    const mode = this.mode;
    const y = this.lineNum;
    // Anchor pixel extraction on the detected sync peak rather than on buffer
    // start. Due to VIS envelope-detection latency and cumulative per-line
    // timing slip, buffer[0] is rarely exactly at a line boundary — the true
    // sync pulse lives somewhere inside the buffer (often near the end).
    const syncPeakIdx = this._lineSyncPeakIdx;
    if (mode.colorSpace === 'pd')    return this.decodePdLine(freqs, y, syncPeakIdx);
    if (mode.colorSpace === 'ycbcr') return this.decodeYCbCrLine(freqs, y, syncPeakIdx);
    if (mode.scottieLineOrder)       return this.decodeScottieLine(freqs, y, syncPeakIdx);
    return this.decodeMartinLine(freqs, y, syncPeakIdx);
  }

  // Per-pixel frequency extraction. Each pixel window covers ~13 raw samples
  // for Robot/Scottie at 48 kHz; the freq trace ringing at channel/sync
  // boundaries spills 2–3 samples into adjacent pixels. We:
  //   1. Reject samples outside the pixel-tone band [1450, 2350] Hz —
  //      sync/porch leak shows up here as 1200/1500 Hz tails.
  //   2. Trim middle 50% (instead of 60%) to drop more boundary samples.
  //   3. Take the median of the trimmed set rather than its mean — median
  //      is unbiased by the few residual boundary samples still inside the
  //      window, while the trimmed mean drags toward whichever side of the
  //      transition contributes more samples.
  // Returns Uint8Array[numPixels].
  extractChannel(freqs, startSample, totalSamples, numPixels) {
    const values = new Uint8Array(numPixels);
    const tmp = [];
    for (let x = 0; x < numPixels; x++) {
      const pixStart = startSample + Math.round(x * totalSamples / numPixels);
      const pixEnd = startSample + Math.round((x + 1) * totalSamples / numPixels);
      tmp.length = 0;
      for (let s = pixStart; s < pixEnd; s++) {
        if (s >= 0 && s < freqs.length) {
          const f = freqs[s];
          // Out-of-band samples are smearing residue from sync (1200 Hz)
          // or — for chrom indicator regions — from sep tones at 1500/2300
          // that didn't fully decay. Drop them so they don't bias the
          // pixel estimate. Allow a small margin (50 Hz) since BLACK_FREQ
          // and WHITE_FREQ are exactly at the band edges.
          if (f >= BLACK_FREQ - 50 && f <= WHITE_FREQ + 50) tmp.push(f);
        }
      }
      let avgFreq;
      if (tmp.length >= 3) {
        tmp.sort((a, b) => a - b);
        // Median of middle 50% trimmed window
        const lo = Math.floor(tmp.length * 0.25);
        const hi = Math.ceil(tmp.length * 0.75);
        const mid = (lo + hi) >> 1;
        avgFreq = tmp[Math.max(lo, Math.min(hi - 1, mid))];
      } else if (tmp.length > 0) {
        avgFreq = tmp[Math.floor(tmp.length / 2)];
      } else {
        avgFreq = BLACK_FREQ;
      }
      values[x] = Math.max(0, Math.min(255, Math.round((avgFreq - BLACK_FREQ) / FREQ_RANGE * 255)));
    }
    return values;
  }

  // PD modes encode TWO image rows per audio "line pair":
  //   sync + porch + Y(top, w pixels) + Cr(avg of top+bot, w) +
  //   Cb(avg of top+bot, w) + Y(bot, w pixels)
  // Vertical chrominance is reconstructed by applying the SAME averaged
  // Cr/Cb to both rows. (Bilateral upscaling between line pairs could
  // improve smoothness but is a polish item — current approach matches
  // the encoder exactly so PSNR ceiling is at the encode round-trip
  // limit.) K3SBP 2026-05-31.
  decodePdLine(freqs, yTop, _syncPeakIdx) {
    const mode = this.mode;
    const w = mode.width;
    const yBot = Math.min(yTop + 1, mode.height - 1);
    const lineLen = freqs.length;
    let lineStart = this._computeLineStart(mode, lineLen);
    if (lineStart == null) lineStart = 0;
    // chanLen MUST mirror the encoder's per-pixel rounding (appendTone
    // does `round(pixelMs * fs / 1000)` per pixel, NOT in aggregate).
    // A "more accurate" `round(pixelMs * w * fs / 1000)` formulation
    // was tried 2026-05-31 — it lost 3–6 dB across PD modes because
    // every PD channel boundary then sat tens of samples off the
    // encoder's actual emission. Keep the per-pixel-rounded form.
    const chanLen = this._msS(mode.pixelMs) * w;
    let offset = lineStart + this._msS(mode.syncMs + mode.porchMs);

    const yTopVals = this.extractChannel(freqs, offset, chanLen, w);
    offset += chanLen;
    const crVals = this.extractChannel(freqs, offset, chanLen, w);
    offset += chanLen;
    const cbVals = this.extractChannel(freqs, offset, chanLen, w);
    offset += chanLen;
    const yBotVals = this.extractChannel(freqs, offset, chanLen, w);

    // Convert each YCbCr pair → RGB. The shared Cr/Cb is applied to both
    // Y values (vertical chrominance interp = nearest-neighbor between
    // line pairs; MMSSTV uses linear interp across the y axis for a
    // slightly smoother result — future polish).
    function ycbcrToRgb(yv, cb, cr, into, idx) {
      // Encoder writes Y, Cb=128-0.169R-0.331G+0.500B, Cr=128+0.500R-0.419G-0.081B.
      // Inverse:
      const yC = yv;
      const cbC = cb - 128;
      const crC = cr - 128;
      const r = yC + 1.402 * crC;
      const g = yC - 0.344 * cbC - 0.714 * crC;
      const b = yC + 1.772 * cbC;
      into[idx]     = Math.max(0, Math.min(255, Math.round(r)));
      into[idx + 1] = Math.max(0, Math.min(255, Math.round(g)));
      into[idx + 2] = Math.max(0, Math.min(255, Math.round(b)));
      into[idx + 3] = 255;
    }

    for (let x = 0; x < w; x++) {
      ycbcrToRgb(yTopVals[x], cbVals[x], crVals[x], this.imageData, (yTop * w + x) * 4);
      if (yBot !== yTop) {
        ycbcrToRgb(yBotVals[x], cbVals[x], crVals[x], this.imageData, (yBot * w + x) * 4);
      }
    }
    const rgba = this.imageData.slice(yTop * w * 4, (yBot + 1) * w * 4);
    return { type: 'rx-line', line: yTop, totalLines: mode.height, rgba };
  }

  decodeMartinLine(freqs, y, _syncPeakIdx) {
    const mode = this.mode;
    const w = mode.width;
    const lineLen = freqs.length;
    let lineStart = this._computeLineStart(mode, lineLen);
    if (lineStart == null) lineStart = 0;
    // Channel positions from line start (in samples). All offsets are
    // slant-corrected — at +1000 ppm drift the actual symbol length is
    // 0.999 × nominal, so nominal offsets land progressively off as we
    // step through G/B/R. Using _msS scales all offsets by slantFactor.
    const postSync = lineStart + this._msS(mode.syncMs + mode.porchMs);
    const chanLen = this._msS(mode.pixelMs) * w;
    const sepLen  = this._msS(mode.separatorMs);
    const gStart = postSync;
    const bStart = gStart + chanLen + sepLen;
    const rStart = bStart + chanLen + sepLen;

    const gVals = this.extractChannel(freqs, gStart, chanLen, w);
    const bVals = this.extractChannel(freqs, bStart, chanLen, w);
    const rVals = this.extractChannel(freqs, rStart, chanLen, w);

    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      this.imageData[idx]     = rVals[x];
      this.imageData[idx + 1] = gVals[x];
      this.imageData[idx + 2] = bVals[x];
      this.imageData[idx + 3] = 255;
    }
    const rgba = this.imageData.slice(y * w * 4, (y + 1) * w * 4);
    return { type: 'rx-line', line: y, totalLines: mode.height, rgba };
  }

  decodeScottieLine(freqs, y, _syncPeakIdx) {
    const mode = this.mode;
    const w = mode.width;
    const lineLen = freqs.length;
    let lineStart = this._computeLineStart(mode, lineLen);
    if (lineStart == null) lineStart = 0;
    // Scottie line: sep + G + sep + B + sync + porch + R. All offsets
    // slant-corrected — see _msS doc.
    const sepLen  = this._msS(mode.separatorMs);
    const chanLen = this._msS(mode.pixelMs) * w;
    const syncLen = this._msS(mode.syncMs);
    const porchLen = this._msS(mode.porchMs);
    const gStart = lineStart + sepLen;
    const bStart = gStart + chanLen + sepLen;
    const rStart = bStart + chanLen + syncLen + porchLen;

    const gVals = this.extractChannel(freqs, gStart, chanLen, w);
    const bVals = this.extractChannel(freqs, bStart, chanLen, w);
    const rVals = this.extractChannel(freqs, rStart, chanLen, w);

    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      this.imageData[idx]     = rVals[x];
      this.imageData[idx + 1] = gVals[x];
      this.imageData[idx + 2] = bVals[x];
      this.imageData[idx + 3] = 255;
    }
    const rgba = this.imageData.slice(y * w * 4, (y + 1) * w * 4);
    return { type: 'rx-line', line: y, totalLines: mode.height, rgba };
  }

  decodeYCbCrLine(freqs, y, _syncPeakIdx) {
    const mode = this.mode;
    const w = mode.width;
    const lineLen = freqs.length;
    let lineStart = this._computeLineStart(mode, lineLen);
    if (lineStart == null) lineStart = 0;
    // Pixel-rounded channel lengths — match encoder exactly. All offsets
    // slant-corrected (see _msS) so drifted captures sample at the
    // actual pixel positions rather than nominal.
    const yChanLen = this._msS(mode.yPixelMs) * w;
    const chromChanLen = this._msS(mode.chromPixelMs) * mode.chromWidth;
    const chromSepLen = this._msS(mode.chromSepMs);

    let offset = lineStart + this._msS(mode.syncMs + mode.porchMs);
    const yVals = this.extractChannel(freqs, offset, yChanLen, w);
    const sepStart = offset + yChanLen;
    offset += yChanLen + chromSepLen;

    if (mode.halfChrom) {
      // Robot 36: each line carries either Cr (even) or Cb (odd). The
      // canonical signal is the separator tone immediately after the Y
      // scan: BLACK_FREQ (1500 Hz) = Cr line, WHITE_FREQ (2300 Hz) = Cb
      // line. The encoder writes that tone based on line parity, but
      // we MUST read it back from the audio rather than re-deriving
      // from y % 2 — if a line drops mid-image (weak signal, dropped
      // sync), parity flips and every line after gets Cr/Cb swapped,
      // producing the "colored lines, no recognizable image" symptom
      // that K3SBP reported on two received Robot 36 transmissions
      // 2026-04-28. Reading the separator tone is self-correcting.
      //
      // Decide Cr vs Cb from the separator tone. BLACK_FREQ (1500 Hz) → Cr,
      // WHITE_FREQ (2300 Hz) → Cb. Two refinements over the simple average:
      //   1. Take the median of the middle 60% window — robust to noise
      //      spikes at low SNR that would bias the mean across the 1900 Hz
      //      decision boundary.
      //   2. Prefer the parity-implied value when the median is in the
      //      "uncertain zone" (1700–2100 Hz). Adjacent-line tone detection
      //      has correctly-decoded neighbors as evidence: at the start of
      //      a strong noise burst, fall back to parity rather than coin-
      //      flip on noise.
      let isCrLine;
      const sepLen = chromSepLen | 0;
      const expectedIsCr = (y % 2) === 0;
      if (sepLen > 0) {
        const skip = Math.max(0, Math.floor(sepLen * 0.2));
        const start = sepStart + skip;
        const end = sepStart + sepLen - skip;
        const sepSamples = [];
        for (let i = start; i < end && i < freqs.length; i++) {
          if (freqs[i] > 0) sepSamples.push(freqs[i]);
        }
        if (sepSamples.length > 0) {
          sepSamples.sort((a, b) => a - b);
          const med = sepSamples[Math.floor(sepSamples.length / 2)];
          if (med < 1700) isCrLine = true;
          else if (med > 2100) isCrLine = false;
          else isCrLine = expectedIsCr;
        } else {
          isCrLine = expectedIsCr;
        }
      } else {
        isCrLine = expectedIsCr;
      }
      const chromVals = this.extractChannel(freqs, offset, chromChanLen, mode.chromWidth);
      // Bilinear horizontal upscale from chromWidth to width
      const chromFull = new Uint8Array(w);
      const scale = (mode.chromWidth - 1) / (w - 1);
      for (let x = 0; x < w; x++) {
        const srcX = x * scale;
        const i0 = Math.floor(srcX);
        const i1 = Math.min(i0 + 1, mode.chromWidth - 1);
        const frac = srcX - i0;
        chromFull[x] = Math.round(chromVals[i0] * (1 - frac) + chromVals[i1] * frac);
      }

      // Persist this line's data so future bilateral passes can re-render
      // earlier lines with averaged neighbor chroma.
      this.chromaByLine[y] = { isCr: isCrLine, vals: chromFull };
      this.yByLine[y] = yVals.slice();
      if (isCrLine) this.prevCr = chromFull;
      else          this.prevCb = chromFull;

      // Initial render with the best single-sided estimate of the missing
      // chroma — the most-recently-seen opposite-type line. Even-line 0 has
      // no prior Cb, fall back to neutral gray (128).
      const crLine = isCrLine ? chromFull : (this.prevCr || new Uint8Array(w).fill(128));
      const cbLine = isCrLine ? (this.prevCb || new Uint8Array(w).fill(128)) : chromFull;
      this._renderRobotLine(y, yVals, crLine, cbLine);

      // Bilateral re-render: line y-1's missing chroma (opposite parity from
      // y-1's own type) now has neighbors at lines y-2 (same type as y-1's
      // missing) and y (current). Average them for sharper vertical edges
      // when both neighbors lie inside the same image region — but at hard
      // chroma transitions (e.g. the boundary between distinct colored
      // zones) bilateral averaging would smudge two unrelated colors, so we
      // pick the neighbor whose Y is closer to y-1's Y per-pixel.
      if (y > 0) {
        const prev = this.chromaByLine[y - 1];
        if (prev) {
          const wantCr = !prev.isCr;
          const backIdx = this._findChromaNeighborIdx(y - 1, wantCr, -1);
          const fwdIdx  = this._findChromaNeighborIdx(y - 1, wantCr, +1);
          const back = backIdx >= 0 ? this.chromaByLine[backIdx].vals : null;
          const fwd  = fwdIdx  >= 0 ? this.chromaByLine[fwdIdx].vals  : null;
          let missing;
          if (back && fwd) {
            const yLine = this.yByLine[y - 1];
            const yBack = this.yByLine[backIdx];
            const yFwd  = this.yByLine[fwdIdx];
            missing = new Uint8Array(w);
            for (let x = 0; x < w; x++) {
              const dB = Math.abs(yLine[x] - yBack[x]);
              const dF = Math.abs(yLine[x] - yFwd[x]);
              if (dB < 12 && dF < 12) {
                // Both sides similar in luma — true bilateral average.
                missing[x] = (back[x] + fwd[x] + 1) >> 1;
              } else if (dB <= dF) {
                missing[x] = back[x];
              } else {
                missing[x] = fwd[x];
              }
            }
          } else {
            missing = back || fwd;
          }
          if (missing) {
            const cr = prev.isCr ? prev.vals : missing;
            const cb = prev.isCr ? missing : prev.vals;
            this._renderRobotLine(y - 1, this.yByLine[y - 1], cr, cb);
          }
        }
      }
    } else {
      const crVals = this.extractChannel(freqs, offset, chromChanLen, w);
      offset += chromChanLen + chromSepLen;
      const cbVals = this.extractChannel(freqs, offset, chromChanLen, w);

      for (let x = 0; x < w; x++) {
        const yVal = yVals[x];
        const cb = cbVals[x] - 128;
        const cr = crVals[x] - 128;
        const idx = (y * w + x) * 4;
        this.imageData[idx]     = Math.max(0, Math.min(255, Math.round(yVal + 1.402 * cr)));
        this.imageData[idx + 1] = Math.max(0, Math.min(255, Math.round(yVal - 0.344 * cb - 0.714 * cr)));
        this.imageData[idx + 2] = Math.max(0, Math.min(255, Math.round(yVal + 1.772 * cb)));
        this.imageData[idx + 3] = 255;
      }
    }

    const rgba = this.imageData.slice(y * w * 4, (y + 1) * w * 4);
    return { type: 'rx-line', line: y, totalLines: mode.height, rgba };
  }

  // YCbCr -> RGB write into imageData for a given line. Used both for the
  // initial single-sided render and the bilateral re-render once neighbor
  // chroma arrives.
  _renderRobotLine(y, yVals, crLine, cbLine) {
    const w = this.mode.width;
    for (let x = 0; x < w; x++) {
      const yVal = yVals[x];
      const cb = cbLine[x] - 128;
      const cr = crLine[x] - 128;
      const idx = (y * w + x) * 4;
      this.imageData[idx]     = Math.max(0, Math.min(255, Math.round(yVal + 1.402 * cr)));
      this.imageData[idx + 1] = Math.max(0, Math.min(255, Math.round(yVal - 0.344 * cb - 0.714 * cr)));
      this.imageData[idx + 2] = Math.max(0, Math.min(255, Math.round(yVal + 1.772 * cb)));
      this.imageData[idx + 3] = 255;
    }
  }

  // Find line index of the nearest stored chroma line of the requested
  // type (Cr or Cb) searching in the given direction (+1 or -1). Searches at
  // most 3 lines — beyond that the temporal correlation is too weak to be
  // useful. Returns -1 if not found.
  _findChromaNeighborIdx(y, wantCr, dir) {
    if (!this.chromaByLine) return -1;
    for (let k = 1; k <= 3; k++) {
      const ny = y + dir * k;
      if (ny < 0 || ny >= this.mode.height) return -1;
      const c = this.chromaByLine[ny];
      if (c && c.isCr === wantCr) return ny;
    }
    return -1;
  }
}

// ===== WORKER MESSAGE HANDLER ==============================================

const { parentPort } = require('worker_threads');

// For testing/direct invocation
module.exports = { SstvDecoder, encodeImage };

// When loaded outside a worker thread, parentPort is null — skip message setup
if (!parentPort) return;

const decoder = new SstvDecoder();

parentPort.on('message', (msg) => {
  try {
    switch (msg.type) {
      case 'encode': {
        const imageData = msg.imageData instanceof Uint8ClampedArray
          ? msg.imageData
          : new Uint8ClampedArray(msg.imageData);
        const samples = encodeImage(imageData, msg.width, msg.height, msg.mode);
        parentPort.postMessage(
          { type: 'encode-result', samples },
          [samples.buffer]  // Transfer ownership for zero-copy
        );
        break;
      }

      case 'rx-audio': {
        const samples = msg.samples instanceof Float32Array
          ? msg.samples
          : new Float32Array(msg.samples);
        const results = decoder.processSamples(samples);
        for (const result of results) {
          if (result) {
            if (result.type === 'rx-image') {
              parentPort.postMessage(result, [result.imageData.buffer]);
            } else {
              parentPort.postMessage(result);
            }
          }
        }
        break;
      }

      case 'stop':
        decoder.reset();
        break;

      case 'redecode': {
        // Manual replay of the retained raw-audio buffer (MMSSTV "get it
        // back"). Emits an rx-image (never hard-rejected — human asked) or
        // an rx-debug explaining why there was nothing to replay.
        const out = decoder.redecodeBuffer({ slantPpm: msg.slantPpm || 0 });
        if (out) parentPort.postMessage(out, [out.imageData.buffer]);
        else {
          parentPort.postMessage({
            type: 'rx-debug', state: STATE_NAMES[decoder.state] || '?', avgFreq: 0,
            detail: 'Redecode: no buffered transmission to replay',
          });
        }
        break;
      }

      case 'set-sample-rate':
        if (msg.sampleRate && msg.sampleRate !== SAMPLE_RATE) {
          console.log('[SSTV Worker] Sample rate: ' + msg.sampleRate + ' Hz (was ' + SAMPLE_RATE + ')');
          SAMPLE_RATE = msg.sampleRate;
          decoder.reset();
          decoder.leaderMinSamples = Math.round(SAMPLE_RATE * 0.08);
          decoder.visExpectedSamples = Math.round(SAMPLE_RATE * VIS_BIT_MS / 1000);
        }
        break;

      default:
        break;
    }
  } catch (err) {
    // Include the stack so we can find the line throwing "Invalid array
    // length" without bisecting the file — K3SBP 2026-05-25 ("Engine error:
    // Invalid array length" firing per audio frame with no decode landing).
    parentPort.postMessage({
      type: 'error',
      message: err.message || String(err),
      stack: err && err.stack ? err.stack : null,
    });
  }
});

parentPort.postMessage({ type: 'ready' });
