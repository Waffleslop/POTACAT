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

function encodeImage(imageData, srcWidth, srcHeight, modeKey) {
  const mode = MODES[modeKey];
  if (!mode) throw new Error('Unknown SSTV mode: ' + modeKey);

  // Scale image to mode resolution
  const pixels = scaleImageToMode(imageData, srcWidth, srcHeight, mode.width, mode.height);

  const out = [];
  encodePhase = 0;

  // VIS header
  encodeVIS(out, mode.visCode);

  // Encode each line
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

class SstvDecoder {
  constructor() {
    this._initFilters();
    this._initState();
  }

  _initFilters() {
    const sr = SAMPLE_RATE;
    // Narrow tone-envelope detectors on raw audio.
    // Q=25 at 1200 Hz -> BW ~48 Hz -> rise time ~20 ms (enough for 5+ ms sync).
    this.env1200 = new ToneEnvelope(1200, 25, sr, 3);
    this.env1900 = new ToneEnvelope(1900, 25, sr, 3);
    this.env1100 = new ToneEnvelope(1100, 30, sr, 3);
    this.env1300 = new ToneEnvelope(1300, 30, sr, 3);
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
    this.leaderFreqCount = 0;
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

    return { freq, rawFreq, e12, e19, e11, e13 };
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
    for (let i = 0; i < samples.length; i++) {
      const dsp = this._runDsp(samples[i]);
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

  // STATE_IDLE: wait for sustained 1900 Hz leader energy.
  _stateIdle({ freq, rawFreq, e19, e12 }) {
    if (this._isLeaderTone(e19, e12)) {
      this.leaderSamples++;
      // Use raw (pre-offset) frequency for calibration
      this.leaderFreqAccum += rawFreq;
      this.leaderFreqCount++;
      if (this.leaderSamples >= this.leaderMinSamples) {
        const measuredLeader = this.leaderFreqAccum / this.leaderFreqCount;
        this.freqOffset = measuredLeader - 1900;
        this.leaderFreqAccum = 0;
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
        this.leaderFreqCount = 0;
      }
    }
    return null;
  }

  // STATE_LEADER: after initial leader, expect 1200 Hz break -> second leader -> 1200 Hz start bit.
  _stateLeader({ e12, e19 }) {
    const isLeader = this._isLeaderTone(e19, e12);
    const isBreak  = this._isSyncTone(e12, e19);

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
    if (!this._envSawLow) {
      if (e12 < ENV_THRESHOLD_MIN) this._envSawLow = true;
    } else if (e12 > this._lineSyncPeak) {
      this._lineSyncPeak = e12;
      this._lineSyncPeakIdx = this.lineFreqs.length - 1;
    }

    const lineSamples = this.getLineSamples();

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
    const lineResult = this.decodeLine(this.lineFreqs);
    this.lineFreqs = [];
    this.lineSyncEnv = [];
    this.sampleCounter = 0;
    this._lineSyncPeak = 0;
    this._lineSyncPeakIdx = -1;
    this._envSawLow = false;
    this.lineNum++;
    // Periodically refine slant correction (iterative with tightening windows)
    this._updateSlant();
    return lineResult;
  }

  _updateSlant() {
    // Refine the rate correction in up to 5 iterative passes. After each
    // successful correction, reset the regressor so subsequent passes fit
    // only the residual drift (not the already-corrected historical data).
    const triggers = [24, 40, 56, 80, 128];
    if (this.slantIter >= triggers.length) return;
    if (this.lineNum < triggers[this.slantIter]) return;

    const lineWidth = this._nominalLineSamples();
    const tolerances = [0.15, 0.10, 0.06, 0.04, 0.025].map(f => f * lineWidth);
    const tol = tolerances[this.slantIter];
    const fit = this.slantRegressor.compute(lineWidth, tol);
    if (fit) {
      const residual = fit.k0 / lineWidth;
      // Sanity-reject wildly off corrections — real clocks don't drift >2%
      if (Math.abs(residual) < 0.02) {
        // Compose with existing correction so the factor accumulates instead
        // of decaying back toward 1.0 each iteration.
        this.slantFactor *= (1 + residual);
        this.slantRegressor.reset();
      }
    }
    this.slantIter++;
  }

  // Current effective line length accounting for slant correction.
  getLineSamples() {
    return Math.round(this._nominalLineSamples() * this.slantFactor);
  }

  _nominalLineSamples() {
    const mode = this.mode;
    if (!mode) return 0;
    const r = (ms) => Math.round(SAMPLE_RATE * ms / 1000);
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

  // Emit decoded image (full or partial)
  _emitImage() {
    const result = {
      type: 'rx-image',
      imageData: this.imageData,
      width: this.mode.width,
      height: this.mode.height,
      mode: this.modeKey,
    };
    this.reset();
    return result;
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
    const peakIdx = this._lineSyncPeakIdx;
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
        // this matches what the encoder actually emitted.
        const sepLen = this._ms(mode.separatorMs);
        const chanLen = this._ms(mode.pixelMs) * mode.width;
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

  decodeLine(freqs) {
    const mode = this.mode;
    const y = this.lineNum;
    // Anchor pixel extraction on the detected sync peak rather than on buffer
    // start. Due to VIS envelope-detection latency and cumulative per-line
    // timing slip, buffer[0] is rarely exactly at a line boundary — the true
    // sync pulse lives somewhere inside the buffer (often near the end).
    const syncPeakIdx = this._lineSyncPeakIdx;
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

  decodeMartinLine(freqs, y, _syncPeakIdx) {
    const mode = this.mode;
    const w = mode.width;
    const lineLen = freqs.length;
    let lineStart = this._computeLineStart(mode, lineLen);
    if (lineStart == null) lineStart = 0;
    // Channel positions from line start (in samples). `chanLen` uses
    // pixel-rounded duration (matches the encoder) instead of scanMs to avoid
    // a per-channel drift of ~11 samples that accumulates across G/B/R.
    const postSync = lineStart + this._ms(mode.syncMs + mode.porchMs);
    const chanLen = this._ms(mode.pixelMs) * w;
    const sepLen  = this._ms(mode.separatorMs);
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
    // Scottie line: sep + G + sep + B + sync + porch + R
    const sepLen  = this._ms(mode.separatorMs);
    const chanLen = this._ms(mode.pixelMs) * w;
    const syncLen = this._ms(mode.syncMs);
    const porchLen = this._ms(mode.porchMs);
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
    // Pixel-rounded channel lengths — match encoder exactly
    const yChanLen = this._ms(mode.yPixelMs) * w;
    const chromChanLen = this._ms(mode.chromPixelMs) * mode.chromWidth;
    const chromSepLen = this._ms(mode.chromSepMs);

    let offset = lineStart + this._ms(mode.syncMs + mode.porchMs);
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
    parentPort.postMessage({ type: 'error', message: err.message || String(err) });
  }
});

parentPort.postMessage({ type: 'ready' });
