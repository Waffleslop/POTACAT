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

// Envelope detector: narrow BPF -> |y| -> single-pole LPF.
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
  // Plain weighted OLS slope fit over a set of {idx, pos}. Returns
  // { k0, intercept } or null if degenerate.
  _olsFit(pts) {
    let T = 0, L = 0, TT = 0, TL = 0;
    const m = pts.length;
    for (const { idx, pos } of pts) {
      T += idx; L += pos; TT += idx * idx; TL += idx * pos;
    }
    const denom = m * TT - T * T;
    if (denom === 0) return null;
    const k0 = (m * TL - L * T) / denom;
    const intercept = (L - k0 * T) / m;
    return { k0, intercept };
  }

  // Median of |x_i - median(x)|. Robust scale estimator. Multiply by
  // 1.4826 to get a consistent estimator of σ under Gaussian noise.
  _mad(values) {
    if (values.length === 0) return 0;
    const sorted = values.slice().sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)];
    const dev = sorted.map(v => Math.abs(v - med)).sort((a, b) => a - b);
    return dev[Math.floor(dev.length / 2)];
  }

  // Compute slope (samples-per-line) with two-stage outlier rejection:
  //   1. Initial median-position filter (handles wraparound + gross outliers)
  //   2. MAD-of-residuals reject, then refit (data-driven robust pass)
  //
  // The static `tolerance` argument seeds the first stage; the second
  // stage uses 1.4826 × MAD ≈ σ to set an adaptive 3-σ band. This lets
  // the fit tighten on actual sync-jitter when it's small AND keep all
  // legitimate points when drift is high and the cone-from-median
  // approach would otherwise discard them.
  compute(lineWidthSamples, tolerance = Infinity) {
    if (this.lines.length < 8) return null;
    const unwrapped = this._unwrap(lineWidthSamples);
    // Stage 1: median-position cone (wraparound + gross outliers)
    const sorted = unwrapped.map(l => l.pos).slice().sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)];
    let kept = unwrapped.filter(l => Math.abs(l.pos - med) <= tolerance);
    if (kept.length < 8) return null;

    // Stage 2a: OLS fit on stage-1 kept points
    let fit = this._olsFit(kept);
    if (!fit) return null;

    // Stage 2b: residual-based MAD rejection. Compute each point's
    // distance from the regression line, MAD that vector, reject
    // points beyond 4 × 1.4826 × MAD (≈ 4σ for Gaussian). Floor the
    // reject threshold at 2 samples — pixel-content leakage routinely
    // gives ±1 sample jitter on legitimate sync columns, so a tighter
    // floor was over-pruning drift cases (sweep 2026-05-31: 3σ + 0.5
    // floor regressed robot72+1000 by 2 dB and scottie2-2000 by 3 dB).
    //
    // This stage exists to catch GROSS outliers (e.g. mis-detected
    // sync columns where pixel content fooled the BPF), not to fine-
    // tune sub-pixel residuals.
    const residuals = kept.map(({ idx, pos }) => pos - (fit.k0 * idx + fit.intercept));
    const madVal = this._mad(residuals);
    const rejectThresh = Math.max(2.0, 4 * 1.4826 * madVal);
    const keptRobust = kept.filter((_, i) => Math.abs(residuals[i]) <= rejectThresh);

    // Refit if we trimmed any points AND still have enough.
    if (keptRobust.length >= 8 && keptRobust.length < kept.length) {
      const refit = this._olsFit(keptRobust);
      if (refit) {
        fit = refit;
        kept = keptRobust;
      }
    }
    return { k0: fit.k0, intercept: fit.intercept, count: kept.length, median: med };
  }
}

module.exports = {
  BiquadBPF,
  BiquadLPF,
  ToneEnvelope,
  SlantRegressor,
};
