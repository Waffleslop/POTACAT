'use strict';
/**
 * The Winlink waterfall for ECHOCAT devices: "is the gateway frequency in
 * use?" decided on the SHACK, so a phone draws what it is sent and needs no
 * DSP of its own. Same numbers as the mail window's own waterfall
 * (renderer/winlink-popout.js): 0–3000 Hz of the receiver's passband at
 * 24 kHz, a 2048-point Hann FFT (85 ms), 256 magnitude bins of ln(power).
 * Busy compares LIKE WITH LIKE: the 90th percentile of the marked band
 * against the 90th percentile of the bins OUTSIDE it, so noise reads 0 dB
 * whatever its level (the 20th-to-90th percentile spread of one frame of
 * noise is ~10 dB on its own — a floor taken from a different percentile
 * called every quiet band Busy). A modem or voice filling ≥10 % of the band
 * trips at +8 dB; a lone carrier (CW, a tuner) trips at +20 dB on the band's
 * peak. Held 3 s so a pause between a station's overs still reads Busy.
 *
 * Pure except for the FFT plan cache in lib/sdr-scope.js. Tests:
 * test/winlink-spectrum-test.js.
 */
const { fftInPlace, fftPlan } = require('./sdr-scope');

const RATE = 24000;          // frames are analysed at this rate whatever arrives
const N = 2048;              // FFT size → 11.72 Hz per bin
const SPAN_HZ = 3000;
const MAGS = 256;            // bins 0..255 cover 0..3000 Hz
const WIRE_BINS = 128;       // what goes to a phone (peak-held pairs)
const BUSY_DB = 8;           // band 90th percentile over the outside 90th percentile
const CARRIER_DB = 20;       // band peak over the same reference: one strong carrier
const BUSY_HOLD_MS = 3000;
const WIRE_RANGE_DB = 50;    // 0..255 spans this many dB above the floor

/** Accumulates PCM at any rate, decimates to 24 kHz and emits one magnitude frame per 2048 samples. */
class SpectrumAccumulator {
  constructor(onFrame) {
    this._onFrame = onFrame;
    this._acc = new Float32Array(N);
    this._len = 0;
    this._re = new Float32Array(N);
    this._im = new Float32Array(N);
    this._mags = new Float32Array(MAGS);
  }
  reset() { this._len = 0; }
  push(pcm, rate) {
    const step = (Number(rate) || RATE) / RATE;
    for (let i = 0; i < pcm.length; i += step) {
      this._acc[this._len++] = pcm[i | 0];
      if (this._len >= N) { this._len = 0; this._frame(); }
    }
  }
  _frame() {
    const { win } = fftPlan(N);
    for (let i = 0; i < N; i++) { this._re[i] = this._acc[i] * win[i]; this._im[i] = 0; }
    fftInPlace(this._re, this._im);
    for (let b = 0; b < MAGS; b++) this._mags[b] = Math.log(this._re[b] * this._re[b] + this._im[b] * this._im[b] + 1e-12);
    this._onFrame(this._mags);
  }
}

/** The modem's band as fractions of the 3000 Hz span, and the label the window shows. */
function markerBand(mode, ardopBw) {
  if (mode === 'packet') return { lo: 1200 / SPAN_HZ, hi: 2200 / SPAN_HZ, label: 'packet tones 1200 / 2200 Hz' };
  const bw = Number(ardopBw) || 500;
  return { lo: (1500 - bw / 2) / SPAN_HZ, hi: (1500 + bw / 2) / SPAN_HZ, label: `ARDOP centre 1500 Hz, ${bw} Hz wide` };
}

/**
 * The Busy / Clear verdict. `st` carries the hold between calls
 * ({until, peakDb}); `now` in ms. Returns {busy, peakDb}.
 */
function busyVerdict(mags, lo, hi, st, now) {
  const n = mags.length;
  const loBin = Math.max(0, Math.floor(lo * n)), hiBin = Math.min(n, Math.ceil(hi * n));
  const inB = [], outB = [];
  for (let b = 0; b < n; b++) (b >= loBin && b < hiBin ? inB : outB).push(mags[b]);
  if (!inB.length || !outB.length) return { busy: false, peakDb: 0 };
  inB.sort((a, b) => a - b); outB.sort((a, b) => a - b);
  const ref = outB[(outB.length * 0.9) | 0];
  const db = (inB[(inB.length * 0.9) | 0] - ref) * 4.3429;     // ln(power) → dB
  const peak = (inB[inB.length - 1] - ref) * 4.3429;
  if (db >= BUSY_DB || peak >= CARRIER_DB) {
    st.until = now + BUSY_HOLD_MS;
    const d = Math.max(db, peak);
    if (d > st.peakDb) st.peakDb = d;
  }
  const busy = now < st.until;
  if (!busy) st.peakDb = 0;
  return { busy, peakDb: busy ? Math.round(st.peakDb) : 0 };
}

/** 256 ln-power magnitudes → 128 peak-held bytes, 0 at the noise floor, 255 at +50 dB. */
function wireBins(mags) {
  const sorted = Array.from(mags).sort((a, b) => a - b);
  const floor = sorted[(sorted.length * 0.2) | 0];
  const out = new Array(WIRE_BINS);
  const per = mags.length / WIRE_BINS;
  for (let i = 0; i < WIRE_BINS; i++) {
    let m = -Infinity;
    for (let j = Math.floor(i * per); j < Math.floor((i + 1) * per); j++) if (mags[j] > m) m = mags[j];
    const db = (m - floor) * 4.3429;
    out[i] = Math.max(0, Math.min(255, Math.round(db / WIRE_RANGE_DB * 255)));
  }
  return out;
}

module.exports = { RATE, N, SPAN_HZ, MAGS, WIRE_BINS, BUSY_DB, CARRIER_DB, BUSY_HOLD_MS, SpectrumAccumulator, markerBand, busyVerdict, wireBins };
