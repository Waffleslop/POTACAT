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

const SAMPLE_RATE = 48000;
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

// Hilbert transform FIR filter (odd-length, windowed sinc)
function buildHilbertCoeffs(numTaps) {
  const coeffs = new Float32Array(numTaps);
  const mid = (numTaps - 1) / 2;
  for (let i = 0; i < numTaps; i++) {
    const n = i - mid;
    if (n === 0) {
      coeffs[i] = 0;
    } else if (n % 2 !== 0) {
      coeffs[i] = 2 / (Math.PI * n);
    } else {
      coeffs[i] = 0;
    }
    // Hamming window
    coeffs[i] *= 0.54 - 0.46 * Math.cos(TWO_PI * i / (numTaps - 1));
  }
  return coeffs;
}

const HILBERT_TAPS = 65;
const hilbertCoeffs = buildHilbertCoeffs(HILBERT_TAPS);
const HILBERT_DELAY = Math.floor(HILBERT_TAPS / 2);

// Decoder state machine
const STATE_IDLE     = 0;  // waiting for leader tone
const STATE_LEADER   = 1;  // tracking 1900 Hz leader
const STATE_VIS_START = 2; // waiting for 1200 Hz start bit after break+leader
const STATE_VIS_BITS = 3;  // reading VIS data bits
const STATE_DECODING = 4;  // decoding image lines

class SstvDecoder {
  constructor() {
    // Hilbert transform ring buffer
    this.hilbertBuf = new Float32Array(HILBERT_TAPS);
    this.hilbertIdx = 0;
    // State
    this.state = STATE_IDLE;
    this.prevPhase = 0;
    // Frequency smoothing — sliding window average
    // 96 samples at 48kHz = 2ms — with outlier rejection, this handles HF noise well
    this.freqSmoothBuf = new Float64Array(96);
    this.freqSmoothIdx = 0;
    this.freqSmoothSum = 0;
    this.freqSmoothCount = 0;
    // Leader/VIS detection
    this.leaderCount = 0;
    this.leaderMinSamples = Math.round(SAMPLE_RATE * 0.1);   // 100ms minimum leader
    this.breakSeen = false;
    this.secondLeaderCount = 0;
    this.visBits = [];
    this.visBitSamples = 0;
    this.visBitAccum = 0;
    this.visBitCount = 0;
    this.visExpectedSamples = Math.round(SAMPLE_RATE * VIS_BIT_MS / 1000); // 30ms per bit
    this.visStartSamples = 0;
    // Decode state
    this.modeKey = null;
    this.mode = null;
    this.lineNum = 0;
    this.imageData = null;
    this.sampleCounter = 0;
    this.lineFreqs = [];
    this.prevCr = null;
    this.prevCb = null;
    // Diagnostics
    this._diagCount = 0;
  }

  reset() {
    this.state = STATE_IDLE;
    this.leaderCount = 0;
    this.breakSeen = false;
    this.secondLeaderCount = 0;
    this.visBits = [];
    this.visBitSamples = 0;
    this.visBitAccum = 0;
    this.visBitCount = 0;
    this.visStartSamples = 0;
    this.modeKey = null;
    this.mode = null;
    this.lineNum = 0;
    this.imageData = null;
    this.sampleCounter = 0;
    this.lineFreqs = [];
    this.prevCr = null;
    this.prevCb = null;
    this.hilbertBuf.fill(0);
    this.hilbertIdx = 0;
    this.prevPhase = 0;
    this.freqSmoothBuf.fill(0);
    this.freqSmoothIdx = 0;
    this.freqSmoothSum = 0;
    this.freqSmoothCount = 0;
  }

  // Returns instantaneous frequency for one sample
  measureFreq(sample) {
    // Feed into Hilbert transform ring buffer (acts as implicit bandpass via FIR shape)
    this.hilbertBuf[this.hilbertIdx] = sample;
    this.hilbertIdx = (this.hilbertIdx + 1) % HILBERT_TAPS;

    // Compute imaginary part (Hilbert transform output)
    let imag = 0;
    let idx = this.hilbertIdx; // oldest sample
    for (let t = 0; t < HILBERT_TAPS; t++) {
      imag += this.hilbertBuf[idx] * hilbertCoeffs[t];
      idx = (idx + 1) % HILBERT_TAPS;
    }

    // Real part is the delayed input (center of the filter)
    const realIdx = (this.hilbertIdx + HILBERT_DELAY) % HILBERT_TAPS;
    const real = this.hilbertBuf[realIdx];

    // Instantaneous phase
    const phase = Math.atan2(imag, real);

    // Phase difference (unwrapped)
    let dPhase = phase - this.prevPhase;
    if (dPhase > Math.PI) dPhase -= TWO_PI;
    else if (dPhase < -Math.PI) dPhase += TWO_PI;
    this.prevPhase = phase;

    // Instantaneous frequency (negate: our Hilbert convention yields negative dPhase for positive freq)
    let rawFreq = -dPhase * SAMPLE_RATE / TWO_PI;

    // Reject outliers — frequencies outside valid SSTV range are noise
    // Valid SSTV: 1100 Hz (sync) to 2300 Hz (white), with some margin
    if (rawFreq < 800 || rawFreq > 2600) {
      rawFreq = this._lastValidFreq || 1500; // hold previous valid frequency
    } else {
      this._lastValidFreq = rawFreq;
    }

    // Running-sum sliding window average for smoothing
    const bufLen = this.freqSmoothBuf.length;
    this.freqSmoothSum -= this.freqSmoothBuf[this.freqSmoothIdx];
    this.freqSmoothBuf[this.freqSmoothIdx] = rawFreq;
    this.freqSmoothSum += rawFreq;
    this.freqSmoothIdx = (this.freqSmoothIdx + 1) % bufLen;
    if (this.freqSmoothCount < bufLen) this.freqSmoothCount++;
    return this.freqSmoothSum / this.freqSmoothCount;
  }

  // Process a buffer of audio samples
  processSamples(samples) {
    const results = [];
    const prevLine = this.lineNum;
    const prevState = this.state;
    let freqSum = 0;
    for (let i = 0; i < samples.length; i++) {
      const freq = this.measureFreq(samples[i]);
      freqSum += freq;
      const result = this.processFreq(freq);
      if (result) results.push(result);
    }
    // Check if we're near end of image with no progress
    if (this.lineNum === prevLine) {
      const partial = this.checkPartialImage();
      if (partial) results.push(partial);
    } else {
      this._partialStall = 0;
    }

    // Periodic diagnostics (~10 times/sec at 4096-sample buffers)
    this._diagCounter = (this._diagCounter || 0) + 1;
    if (this._diagCounter % 10 === 0) {
      const STATE_NAMES = ['IDLE', 'LEADER', 'VIS_START', 'VIS_BITS', 'DECODING'];
      const avgFreq = samples.length > 0 ? Math.round(freqSum / samples.length) : 0;
      let detail = '';
      if (this.state === STATE_IDLE) detail = 'leader=' + this.leaderCount + '/' + this.leaderMinSamples;
      else if (this.state === STATE_LEADER) detail = 'break=' + this.breakSeen + ' leader2=' + this.secondLeaderCount;
      else if (this.state === STATE_VIS_BITS) detail = 'bit=' + this.visBitCount + '/9 bits=[' + this.visBits.join('') + '] bitFreq=' + (this.visBitAccumCount > 0 ? Math.round(this.visBitAccum / this.visBitAccumCount) : '?');
      else if (this.state === STATE_DECODING) detail = 'line=' + this.lineNum + '/' + (this.mode ? this.mode.height : '?');
      results.push({
        type: 'rx-debug',
        state: STATE_NAMES[this.state] || '?',
        avgFreq,
        detail,
      });
    }
    return results;
  }

  processFreq(freq) {
    switch (this.state) {
      case STATE_IDLE:      return this._stateIdle(freq);
      case STATE_LEADER:    return this._stateLeader(freq);
      case STATE_VIS_START: return this._stateVisStart(freq);
      case STATE_VIS_BITS:  return this._stateVisBits(freq);
      case STATE_DECODING:  return this._stateDecoding(freq);
    }
    return null;
  }

  // STATE_IDLE: wait for sustained ~1900 Hz
  _stateIdle(freq) {
    if (freq > 1750 && freq < 2050) {
      this.leaderCount++;
      if (this.leaderCount >= this.leaderMinSamples) {
        this.state = STATE_LEADER;
        this.breakSeen = false;
        this.secondLeaderCount = 0;
        this._transitionGrace = 0;
        return { type: 'rx-debug', state: 'LEADER', avgFreq: Math.round(freq), detail: 'Leader tone detected (' + (this.leaderCount / SAMPLE_RATE * 1000).toFixed(0) + 'ms)' };
      }
    } else {
      this.leaderCount = Math.max(0, this.leaderCount - 2); // gentle decay — HF noise shouldn't wipe out progress
    }
    return null;
  }

  // STATE_LEADER: we have leader, wait for 1200 Hz break → second leader → 1200 Hz start bit
  // During frequency transitions, the smoothed measurement passes through intermediate values.
  // Use a grace window to tolerate brief excursions during transitions.
  _stateLeader(freq) {
    const isLeader = freq > 1750 && freq < 2050;
    const isBreak  = freq > 1050 && freq < 1350;

    if (!this.breakSeen) {
      if (isLeader) {
        this.leaderCount++;
        this._transitionGrace = 0;
      } else if (isBreak) {
        this.breakSeen = true;
        this.secondLeaderCount = 0;
        this._transitionGrace = 0;
        return { type: 'rx-debug', state: 'LEADER', avgFreq: Math.round(freq), detail: '1200 Hz break detected' };
      } else {
        this._transitionGrace = (this._transitionGrace || 0) + 1;
        if (this._transitionGrace > Math.round(SAMPLE_RATE * 0.015)) {
          this.state = STATE_IDLE;
          this.leaderCount = 0;
          return { type: 'rx-debug', state: 'IDLE', avgFreq: Math.round(freq), detail: 'Leader lost (freq=' + Math.round(freq) + ')' };
        }
      }
    } else {
      if (isLeader) {
        this.secondLeaderCount++;
        this._transitionGrace = 0;
      } else if (this.secondLeaderCount > Math.round(SAMPLE_RATE * 0.03) && isBreak) {
        this.state = STATE_VIS_START;
        this.visStartSamples = 0;
        return { type: 'rx-debug', state: 'VIS_START', avgFreq: Math.round(freq), detail: 'Start bit — reading VIS code...' };
      } else if (isBreak && this.secondLeaderCount === 0) {
        // Still in break area before second leader
      } else {
        this._transitionGrace = (this._transitionGrace || 0) + 1;
        if (this._transitionGrace > Math.round(SAMPLE_RATE * 0.015)) {
          this.state = STATE_IDLE;
          this.leaderCount = 0;
          return { type: 'rx-debug', state: 'IDLE', avgFreq: Math.round(freq), detail: 'Leader2 lost (freq=' + Math.round(freq) + ')' };
        }
      }
    }
    return null;
  }

  // STATE_VIS_START: consume the 1200 Hz start bit (30ms + smoothing lag), then start reading data bits
  _stateVisStart(freq) {
    this.visStartSamples++;
    // Extra samples to let the smoothing window settle after the leader→start transition
    const settleExtra = Math.round(this.freqSmoothBuf.length * 0.6);
    if (this.visStartSamples >= this.visExpectedSamples + settleExtra) {
      this.state = STATE_VIS_BITS;
      this.visBits = [];
      this.visBitSamples = 0;
      this.visBitAccum = 0;
      this.visBitAccumCount = 0;
      this.visBitCount = 0;
    }
    return null;
  }

  // STATE_VIS_BITS: read 7 data bits + 1 parity bit (30ms each, 1100=1, 1300=0), then 30ms stop bit
  // Only accumulate from the center 60% of each bit window to avoid transition smearing
  _stateVisBits(freq) {
    this.visBitSamples++;
    // Skip the first and last 20% of each bit window (transition artifacts from smoothing)
    const margin = Math.round(this.visExpectedSamples * 0.2);
    if (this.visBitSamples > margin && this.visBitSamples < this.visExpectedSamples - margin) {
      this.visBitAccum += freq;
      this.visBitAccumCount++;
    }

    if (this.visBitSamples >= this.visExpectedSamples) {
      const avgFreq = this.visBitAccumCount > 0 ? this.visBitAccum / this.visBitAccumCount : freq;
      this.visBitSamples = 0;
      this.visBitAccum = 0;
      this.visBitAccumCount = 0;

      if (this.visBitCount < 8) {
        // Data bits (7) + parity bit (1) — 1100 Hz = 1, 1300 Hz = 0
        const bit = avgFreq < 1200 ? 1 : 0;
        this.visBits.push(bit);
      }
      this.visBitCount++;

      if (this.visBitCount >= 9) {
        // 8 bits read (7 data + 1 parity) + stop bit consumed
        // Extract VIS code from first 7 bits (LSB first)
        let visCode = 0;
        for (let i = 0; i < 7; i++) {
          visCode |= (this.visBits[i] << i);
        }

        const modeKey = VIS_TO_MODE[visCode];
        if (!modeKey) {
          parentPort.postMessage({ type: 'rx-debug', state: 'IDLE', avgFreq: 0, detail: 'Unknown VIS code ' + visCode + ' bits=[' + this.visBits.join('') + '] — reset' });
        }
        if (modeKey) {
          this.modeKey = modeKey;
          this.mode = MODES[modeKey];
          this.state = STATE_DECODING;
          this.lineNum = 0;
          this.sampleCounter = 0;
          this.lineFreqs = [];
          this.imageData = new Uint8ClampedArray(this.mode.width * this.mode.height * 4);
          // Fill with black
          for (let p = 3; p < this.imageData.length; p += 4) this.imageData[p] = 255;
          this.prevCr = null;
          this.prevCb = null;
          return { type: 'rx-vis', mode: modeKey, modeName: this.mode.name };
        } else {
          // Unknown VIS code, return to idle
          this.state = STATE_IDLE;
          this.leaderCount = 0;
        }
      }
    }
    return null;
  }

  _stateDecoding(freq) {
    this.lineFreqs.push(freq);
    this.sampleCounter++;

    const lineSamples = this.getLineSamples();

    // Near the expected line boundary (within ±5%), look for sync pulse to self-correct
    if (this.sampleCounter >= lineSamples * 0.95 && !this._syncLockFound) {
      // Look for 1200 Hz sync pulse marking the START of the next line
      if (freq < 1350 && !this._syncDipStart) {
        this._syncDipStart = this.sampleCounter;
      } else if (freq >= 1350 && this._syncDipStart) {
        const dipLen = this.sampleCounter - this._syncDipStart;
        if (dipLen >= Math.round(SAMPLE_RATE * 0.002)) { // at least 2ms of sync
          // Found sync! Use this as the actual line boundary
          // The sync pulse belongs to the NEXT line, so end current line here
          this._syncLockFound = true;
          // Trim lineFreqs to end before the sync pulse
          const trimTo = this._syncDipStart;
          this.lineFreqs.length = trimTo;
          this.sampleCounter = trimTo;
        }
        this._syncDipStart = null;
      }
    }

    if (this.sampleCounter >= lineSamples || this._syncLockFound) {
      // Decode this line from accumulated frequency data
      const lineResult = this.decodeLine(this.lineFreqs);
      // If we found sync, carry over the sync samples to the next line
      const overflow = this._syncLockFound ? [] : [];
      this.lineFreqs = overflow;
      this.sampleCounter = overflow.length;
      this._syncLockFound = false;
      this._syncDipStart = null;
      this.lineNum++;

      if (this.lineNum >= this.mode.height) {
        return this._emitImage();
      }

      return lineResult;
    }
    return null;
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

  // Call after a batch of audio — if decoding has stalled near completion, emit partial image
  checkPartialImage() {
    if (this.state === STATE_DECODING && this.mode && this.lineNum >= this.mode.height * 0.9) {
      // >90% decoded and we're between audio chunks — likely end of transmission
      this._partialStall = (this._partialStall || 0) + 1;
      // After 3 consecutive check calls with no line progress, emit what we have
      if (this._partialStall >= 3) {
        // Decode the partial last line if we have enough data (>50% of a line)
        if (this.lineFreqs.length > this.getLineSamples() * 0.5) {
          this.decodeLine(this.lineFreqs);
          this.lineNum++;
        }
        return this._emitImage();
      }
    } else {
      this._partialStall = 0;
    }
    return null;
  }

  // Calculate line duration in samples, matching encoder's per-segment rounding
  getLineSamples() {
    const mode = this.mode;
    const r = (ms) => Math.round(SAMPLE_RATE * ms / 1000);
    if (mode.colorSpace === 'ycbcr') {
      const yPixelSamples = r(mode.yPixelMs) * mode.width;
      const chromPixelSamples = r(mode.chromPixelMs) * (mode.halfChrom ? mode.chromWidth : mode.width);
      if (mode.halfChrom) {
        // Robot 36: sync + porch + Y + chromSep + chrom + chromPorch
        return r(mode.syncMs) + r(mode.porchMs) + yPixelSamples + r(mode.chromSepMs) + chromPixelSamples + r(mode.chromPorchMs);
      } else {
        // Robot 72: sync + porch + Y + sep + Cr + sep + Cb + porch
        return r(mode.syncMs) + r(mode.porchMs) + yPixelSamples + r(mode.chromSepMs) + chromPixelSamples + r(mode.chromSepMs) + chromPixelSamples + r(mode.chromPorchMs);
      }
    } else {
      const pixelSamples = r(mode.pixelMs) * mode.width;
      if (mode.scottieLineOrder) {
        // Scottie: sep + G + sep + B + sync + porch + R
        return r(mode.separatorMs) + pixelSamples + r(mode.separatorMs) + pixelSamples + r(mode.syncMs) + r(mode.porchMs) + pixelSamples;
      } else {
        // Martin: sync + porch + (scan + sep) * 3
        return r(mode.syncMs) + r(mode.porchMs) + (pixelSamples + r(mode.separatorMs)) * 3;
      }
    }
  }

  // Find the actual sync pulse (1200 Hz dip) within the line's frequency data.
  // Returns the sample offset where sync starts, or 0 if not found.
  findSyncOffset(freqs) {
    // Look for a sustained dip below 1350 Hz (sync = 1200 Hz)
    // Search within the first 20% of the line data (sync should be near the start)
    const searchLen = Math.min(Math.round(freqs.length * 0.2), freqs.length);
    const syncThreshold = 1350;
    const minRun = Math.round(SAMPLE_RATE * 0.002); // at least 2ms of sync tone
    let bestStart = -1;
    let bestLen = 0;
    let runStart = -1;
    let runLen = 0;

    for (let i = 0; i < searchLen; i++) {
      if (freqs[i] < syncThreshold) {
        if (runStart < 0) runStart = i;
        runLen++;
      } else {
        if (runLen > bestLen) { bestStart = runStart; bestLen = runLen; }
        runStart = -1;
        runLen = 0;
      }
    }
    if (runLen > bestLen) { bestStart = runStart; bestLen = runLen; }

    // Return the offset if we found a convincing sync pulse
    if (bestLen >= minRun && bestStart >= 0) {
      return bestStart;
    }
    return 0; // fallback: assume line starts at beginning
  }

  decodeLine(freqs) {
    const mode = this.mode;
    const w = mode.width;
    const y = this.lineNum;

    if (mode.colorSpace === 'ycbcr') {
      return this.decodeYCbCrLine(freqs, y);
    } else if (mode.scottieLineOrder) {
      return this.decodeScottieLine(freqs, y);
    } else {
      return this.decodeMartinLine(freqs, y);
    }
  }

  // Sample pixel value from frequency array at a time offset
  samplePixel(freqs, offsetMs, pixelMs, pixelIdx) {
    const startSample = Math.round(SAMPLE_RATE * offsetMs / 1000);
    const numSamples = Math.round(SAMPLE_RATE * pixelMs / 1000);
    const center = startSample + Math.floor(numSamples * (pixelIdx + 0.5) / 1);
    // Average a few samples around the center for noise reduction
    const halfWin = Math.max(1, Math.floor(numSamples / 3));
    let sum = 0, count = 0;
    for (let s = center - halfWin; s <= center + halfWin; s++) {
      if (s >= 0 && s < freqs.length) {
        sum += freqs[s];
        count++;
      }
    }
    const avgFreq = count > 0 ? sum / count : BLACK_FREQ;
    return Math.max(0, Math.min(255, Math.round((avgFreq - BLACK_FREQ) / FREQ_RANGE * 255)));
  }

  // Extract channel values from a scan region of the frequency array
  extractChannel(freqs, offsetMs, scanMs, numPixels) {
    const startSample = Math.round(SAMPLE_RATE * offsetMs / 1000);
    const totalSamples = Math.round(SAMPLE_RATE * scanMs / 1000);
    const values = new Uint8Array(numPixels);
    for (let x = 0; x < numPixels; x++) {
      const pixStart = startSample + Math.round(x * totalSamples / numPixels);
      const pixEnd = startSample + Math.round((x + 1) * totalSamples / numPixels);
      let sum = 0, count = 0;
      for (let s = pixStart; s < pixEnd && s < freqs.length; s++) {
        sum += freqs[s];
        count++;
      }
      const avgFreq = count > 0 ? sum / count : BLACK_FREQ;
      values[x] = Math.max(0, Math.min(255, Math.round((avgFreq - BLACK_FREQ) / FREQ_RANGE * 255)));
    }
    return values;
  }

  decodeMartinLine(freqs, y) {
    const mode = this.mode;
    const w = mode.width;
    // Find actual sync pulse position and use it as anchor
    const syncSample = this.findSyncOffset(freqs);
    const syncOffsetMs = syncSample / SAMPLE_RATE * 1000;
    // Martin line: sync(4.862) + porch(0.572) + G(146.432) + sep(0.572) + B(146.432) + sep(0.572) + R(146.432) + sep(0.572)
    let offset = syncOffsetMs + mode.syncMs + mode.porchMs;
    const gVals = this.extractChannel(freqs, offset, mode.scanMs, w);
    offset += mode.scanMs + mode.separatorMs;
    const bVals = this.extractChannel(freqs, offset, mode.scanMs, w);
    offset += mode.scanMs + mode.separatorMs;
    const rVals = this.extractChannel(freqs, offset, mode.scanMs, w);

    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      this.imageData[idx]     = rVals[x];
      this.imageData[idx + 1] = gVals[x];
      this.imageData[idx + 2] = bVals[x];
      this.imageData[idx + 3] = 255;
    }

    // Emit line-by-line progress
    const rgba = this.imageData.slice(y * w * 4, (y + 1) * w * 4);
    return { type: 'rx-line', line: y, totalLines: mode.height, rgba };
  }

  decodeScottieLine(freqs, y) {
    const mode = this.mode;
    const w = mode.width;
    // Scottie sync is mid-line (between B and R), so find it and work backwards/forwards
    // Line structure: sep(1.5) + G(138.24) + sep(1.5) + B(138.24) + sync(9.0) + porch(1.5) + R(138.24)
    // Find sync pulse — for Scottie it's in the middle of the line, not the start
    // Search the middle 40% of the line for the sync
    const midSearch = Math.round(freqs.length * 0.3);
    const midEnd = Math.round(freqs.length * 0.7);
    let syncStart = -1, syncLen = 0, bestStart = -1, bestLen = 0;
    for (let i = midSearch; i < midEnd; i++) {
      if (freqs[i] < 1350) {
        if (syncStart < 0) syncStart = i;
        syncLen++;
      } else {
        if (syncLen > bestLen) { bestStart = syncStart; bestLen = syncLen; }
        syncStart = -1; syncLen = 0;
      }
    }
    if (syncLen > bestLen) { bestStart = syncStart; bestLen = syncLen; }

    // If we found the sync, use it as anchor; otherwise fall back to timing
    let offset;
    if (bestLen >= Math.round(SAMPLE_RATE * 0.004) && bestStart >= 0) {
      // Sync found at bestStart — work backwards to find sep + B start + sep + G start
      const syncMs = bestStart / SAMPLE_RATE * 1000;
      // Before sync: sep(1.5) + B(138.24) + sep(1.5) + G(138.24)
      const gStartMs = syncMs - mode.scanMs - mode.separatorMs - mode.scanMs - mode.separatorMs;
      offset = Math.max(0, gStartMs + mode.separatorMs);
    } else {
      offset = mode.separatorMs;
    }
    const gVals = this.extractChannel(freqs, offset, mode.scanMs, w);
    offset += mode.scanMs + mode.separatorMs;
    const bVals = this.extractChannel(freqs, offset, mode.scanMs, w);
    offset += mode.scanMs + mode.syncMs + mode.porchMs;
    const rVals = this.extractChannel(freqs, offset, mode.scanMs, w);

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

  decodeYCbCrLine(freqs, y) {
    const mode = this.mode;
    const w = mode.width;

    // Find sync and use as anchor
    const syncSample = this.findSyncOffset(freqs);
    const syncOffsetMs = syncSample / SAMPLE_RATE * 1000;
    // Extract Y channel
    let offset = syncOffsetMs + mode.syncMs + mode.porchMs;
    const yVals = this.extractChannel(freqs, offset, mode.yScanMs, w);
    offset += mode.yScanMs + mode.chromSepMs;

    if (mode.halfChrom) {
      // Robot 36: alternating Cr/Cb per line
      const chromVals = this.extractChannel(freqs, offset, mode.chromScanMs, mode.chromWidth);

      // Upscale chrominance from 160 to 320 pixels
      const chromFull = new Uint8Array(w);
      for (let x = 0; x < w; x++) {
        chromFull[x] = chromVals[Math.min(Math.floor(x * mode.chromWidth / w), mode.chromWidth - 1)];
      }

      const isEven = (y % 2) === 0;
      if (isEven) {
        this.prevCr = chromFull;
      } else {
        this.prevCb = chromFull;
      }

      // We need both Cr and Cb to produce RGB; use prev values if available
      const crLine = this.prevCr || new Uint8Array(w).fill(128);
      const cbLine = this.prevCb || new Uint8Array(w).fill(128);

      // Convert YCbCr to RGB and write pixels
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

      // Also fix the previous line if we now have both Cr and Cb
      if (!isEven && y > 0 && this.prevCr) {
        for (let x = 0; x < w; x++) {
          const prevY = this.extractChannel(freqs, 0, 0, 0); // can't re-extract, use stored
          // Previous line was already written with available data, re-update with both chroma
          const prevIdx = ((y - 1) * w + x) * 4;
          // We already wrote the previous line with the Cr data; now we have Cb too
          // Re-derive Y from the stored image data (approximate)
          const prevR = this.imageData[prevIdx];
          const prevG = this.imageData[prevIdx + 1];
          const prevB = this.imageData[prevIdx + 2];
          const prevYVal = 0.299 * prevR + 0.587 * prevG + 0.114 * prevB;
          const cb2 = cbLine[x] - 128;
          const cr2 = crLine[x] - 128;
          this.imageData[prevIdx]     = Math.max(0, Math.min(255, Math.round(prevYVal + 1.402 * cr2)));
          this.imageData[prevIdx + 1] = Math.max(0, Math.min(255, Math.round(prevYVal - 0.344 * cb2 - 0.714 * cr2)));
          this.imageData[prevIdx + 2] = Math.max(0, Math.min(255, Math.round(prevYVal + 1.772 * cb2)));
        }
      }
    } else {
      // Robot 72: full Cr + Cb every line
      const crVals = this.extractChannel(freqs, offset, mode.chromScanMs, w);
      offset += mode.chromScanMs + mode.chromSepMs;
      const cbVals = this.extractChannel(freqs, offset, mode.chromScanMs, w);

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
}

// ===== WORKER MESSAGE HANDLER ==============================================

const decoder = new SstvDecoder();

const { parentPort } = require('worker_threads');

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
              // Transfer imageData buffer
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

      default:
        break;
    }
  } catch (err) {
    parentPort.postMessage({ type: 'error', message: err.message || String(err) });
  }
});

parentPort.postMessage({ type: 'ready' });
