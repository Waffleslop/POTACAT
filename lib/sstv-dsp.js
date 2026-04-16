'use strict';

// ---------------------------------------------------------------------------
// SSTV DSP primitives — shared by the worker decoder.
// ---------------------------------------------------------------------------

const TWO_PI = 2 * Math.PI;

// 2nd-order IIR bandpass (RBJ biquad, constant 0 dB peak gain).
// Use for sync-tone and VIS-tone selective detection on raw audio.
class BiquadBPF {
  constructor(freq, Q, sampleRate) {
    this.setFreq(freq, Q, sampleRate);
    this.x1 = 0; this.x2 = 0;
    this.y1 = 0; this.y2 = 0;
  }
  setFreq(freq, Q, sampleRate) {
    const w0 = TWO_PI * freq / sampleRate;
    const alpha = Math.sin(w0) / (2 * Q);
    const a0 = 1 + alpha;
    this.b0 = alpha / a0;
    this.b1 = 0;
    this.b2 = -alpha / a0;
    this.a1 = -2 * Math.cos(w0) / a0;
    this.a2 = (1 - alpha) / a0;
  }
  process(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x;
    this.y2 = this.y1; this.y1 = y;
    return y;
  }
  reset() {
    this.x1 = 0; this.x2 = 0;
    this.y1 = 0; this.y2 = 0;
  }
}

// 2nd-order IIR lowpass (RBJ biquad, Q=0.707 Butterworth).
// Used to smooth the raw instantaneous frequency from the FM demodulator.
class BiquadLPF {
  constructor(freq, sampleRate, Q = 0.707) {
    this.setFreq(freq, sampleRate, Q);
    this.x1 = 0; this.x2 = 0;
    this.y1 = 0; this.y2 = 0;
  }
  setFreq(freq, sampleRate, Q = 0.707) {
    const w0 = TWO_PI * freq / sampleRate;
    const cosw = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * Q);
    const a0 = 1 + alpha;
    this.b0 = ((1 - cosw) / 2) / a0;
    this.b1 = (1 - cosw) / a0;
    this.b2 = ((1 - cosw) / 2) / a0;
    this.a1 = (-2 * cosw) / a0;
    this.a2 = (1 - alpha) / a0;
  }
  process(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x;
    this.y2 = this.y1; this.y1 = y;
    return y;
  }
  reset() {
    this.x1 = 0; this.x2 = 0;
    this.y1 = 0; this.y2 = 0;
  }
}

// Envelope detector: narrow BPF → |y| → single-pole LPF.
// Returns a slowly-varying magnitude of the chosen tone.
class ToneEnvelope {
  constructor(freq, Q, sampleRate, tauMs = 3) {
    this.bpf = new BiquadBPF(freq, Q, sampleRate);
    this.env = 0;
    // 1st-order LPF coefficient for envelope smoothing
    this.alpha = 1 - Math.exp(-1 / (sampleRate * tauMs / 1000));
  }
  process(x) {
    const y = this.bpf.process(x);
    const mag = y < 0 ? -y : y;
    this.env += this.alpha * (mag - this.env);
    return this.env;
  }
  reset() {
    this.bpf.reset();
    this.env = 0;
  }
  get value() { return this.env; }
}

// Least-squares slant regression.
// Records (lineIdx, syncPeakSampleOffsetInLine) pairs and fits a line.
// Returns slope k0 = drift samples per line, enabling sample-rate correction.
class SlantRegressor {
  constructor() {
    this.reset();
  }
  reset() {
    this.lines = []; // {idx, pos}
  }
  add(lineIdx, peakPos) {
    this.lines.push({ idx: lineIdx, pos: peakPos });
  }
  // Unwrap peak positions so a peak that slides past the boundary doesn't break
  // the regression. Center around the median position.
  _unwrap(lineWidthSamples) {
    if (this.lines.length < 3) return this.lines.slice();
    const positions = this.lines.map(l => l.pos).slice().sort((a, b) => a - b);
    const median = positions[Math.floor(positions.length / 2)];
    const halfW = lineWidthSamples / 2;
    return this.lines.map(({ idx, pos }) => {
      let p = pos;
      // Shift by ±TW if the point is more than half a line away from median
      while (p - median > halfW) p -= lineWidthSamples;
      while (median - p > halfW) p += lineWidthSamples;
      return { idx, pos: p };
    });
  }
  // Compute slope (samples-per-line) using least-squares on unwrapped positions.
  // Optional tolerance window filters out outliers (|pos - median| > tol).
  compute(lineWidthSamples, tolerance = Infinity) {
    if (this.lines.length < 8) return null;
    const unwrapped = this._unwrap(lineWidthSamples);
    // Median of unwrapped positions
    const sorted = unwrapped.map(l => l.pos).slice().sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)];
    // Filter by tolerance
    const kept = unwrapped.filter(l => Math.abs(l.pos - med) <= tolerance);
    if (kept.length < 8) return null;
    // Least-squares slope: k = (m*sum(xy) - sum(x)*sum(y)) / (m*sum(x^2) - sum(x)^2)
    let T = 0, L = 0, TT = 0, TL = 0;
    const m = kept.length;
    for (const { idx, pos } of kept) {
      T += idx;
      L += pos;
      TT += idx * idx;
      TL += idx * pos;
    }
    const denom = m * TT - T * T;
    if (denom === 0) return null;
    const k0 = (m * TL - L * T) / denom;
    const intercept = (L - k0 * T) / m;
    return { k0, intercept, count: m, median: med };
  }
}

module.exports = {
  BiquadBPF,
  BiquadLPF,
  ToneEnvelope,
  SlantRegressor,
};
