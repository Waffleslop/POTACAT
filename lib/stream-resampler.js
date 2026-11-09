'use strict';
// A streaming resampler for mono Float32 audio: windowed-sinc interpolation
// that keeps its phase and history across chunks, so a stream cut into
// network frames of any size resamples to exactly the same samples as the
// whole stream would (GitHub #243: WebSDR audio, 7119 Hz in LZ3AW's log, into
// the FT8 engine's 12 kHz).
//
// main.js resampleMonoFloat32 is linear and per-chunk: each chunk restarts its
// phase and rounds its length, and linear interpolation leaves images of the
// passband in the output (a 1500 Hz tone at 7119 Hz also shows at 5619 Hz,
// about -24 dB). This low-passes at 92 % of the lower Nyquist, so it is
// also a correct decimator (48 kHz -> 12 kHz).

const TABLE_RES = 256; // kernel samples per input sample

class StreamResampler {
  /**
   * @param {number} fromRate input sample rate (Hz)
   * @param {number} toRate   output sample rate (Hz)
   * @param {object} [o]
   * @param {number} [o.halfTaps=24] kernel half-width, in samples of the lower rate
   */
  constructor(fromRate, toRate, o = {}) {
    if (!(fromRate > 0) || !(toRate > 0)) throw new Error('StreamResampler: rates must be > 0');
    this.fromRate = fromRate;
    this.toRate = toRate;
    this._step = fromRate / toRate;            // input samples per output sample
    const r = Math.min(1, toRate / fromRate);  // < 1 when decimating
    const halfTaps = o.halfTaps || 24;
    this._W = Math.ceil(halfTaps / r);         // half-width in input samples
    this._fc = 0.5 * r * 0.92;                 // cutoff, cycles per input sample
    // h(x) for x in [0, W], TABLE_RES points per input sample.
    const n = this._W * TABLE_RES + 2;
    this._table = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const x = i / TABLE_RES;
      if (x >= this._W) { this._table[i] = 0; continue; }
      const a = 2 * this._fc * x;
      const sinc = a === 0 ? 1 : Math.sin(Math.PI * a) / (Math.PI * a);
      const win = 0.42 + 0.5 * Math.cos(Math.PI * x / this._W) + 0.08 * Math.cos(2 * Math.PI * x / this._W); // Blackman
      this._table[i] = 2 * this._fc * sinc * win;
    }
    this.reset();
  }

  /** Forget the stream (a new one starts with silence before it). */
  reset() {
    this._hist = new Float32Array(this._W); // W samples of silence before the first input
    this._t = this._W;                      // next output position, in input samples into _hist
  }

  _h(x) {
    const ax = Math.abs(x) * TABLE_RES;
    const i = Math.floor(ax);
    if (i + 1 >= this._table.length) return 0;
    const f = ax - i;
    return this._table[i] + (this._table[i + 1] - this._table[i]) * f;
  }

  /**
   * @param {Float32Array|number[]} input the next chunk
   * @returns {Float32Array} every output sample now computable (the last
   *   W input samples wait for the next chunk)
   */
  process(input) {
    const src = input instanceof Float32Array ? input : Float32Array.from(input || []);
    const buf = new Float32Array(this._hist.length + src.length);
    buf.set(this._hist);
    buf.set(src, this._hist.length);
    const W = this._W, step = this._step;
    const last = buf.length - 1 - W;
    const out = new Float32Array(Math.max(0, Math.floor((last - this._t) / step) + 2));
    let t = this._t, n = 0;
    while (t <= last) {
      const k0 = Math.floor(t);
      let acc = 0;
      for (let k = k0 - W + 1; k <= k0 + W; k++) acc += buf[k] * this._h(t - k);
      out[n++] = acc;
      t += step;
    }
    const keep = Math.max(0, Math.floor(t) - W);
    this._hist = buf.slice(keep);
    this._t = t - keep;
    return n === out.length ? out : out.slice(0, n);
  }
}

module.exports = { StreamResampler };
