'use strict';
/**
 * The Winlink waterfall's shared rules: the modem's band on the 0–3000 Hz
 * span and the Busy / Clear verdict. Dual-mode: `require` in main (which
 * decides the badge for ECHOCAT devices on the SHACK, so a phone draws what
 * it is sent and needs no DSP of its own) and `window.WinlinkSpectrum` in the
 * mail window (renderer/winlink-popout.js), so both surfaces answer alike.
 * Same numbers everywhere: 0–3000 Hz of the receiver's passband at 24 kHz,
 * a 2048-point Hann FFT (85 ms), 256 magnitude bins of ln(power).
 *
 * Busy (K3SBP 2026-10-23: the first rule blinked "clear - clear - busy -
 * busy - clear", one hot 85 ms frame set Busy for 3 s and a marginal signal
 * toggled it at will):
 *  - The reference is the noise. Two estimates, the HIGHER wins: the 90th
 *    percentile of the bins OUTSIDE the band (like with like — the 20th-to-
 *    90th spread of one frame of noise is ~10 dB on its own, so a floor from
 *    a different percentile called every quiet band Busy) and the lowest
 *    in-band 90th percentile seen over the last 15 s (a VARA band 2750 Hz
 *    wide leaves only the receiver's filter skirts outside it, which read
 *    far below the noise and would make every frame Busy). The tracked floor
 *    needs 1 s of history; until then the outside bins decide alone.
 *  - Busy ENTERS when the band's 90th percentile stands ≥ 8 dB over the
 *    reference (a modem or voice filling the band), or its peak ≥ 20 dB (one
 *    strong carrier), SUSTAINED for 150 ms — a static crash is one frame.
 *  - Busy STAYS while the band is ≥ 5 dB / the peak ≥ 14 dB (hysteresis), and
 *    for 4 s after the last such frame, so an ARQ turnaround or the pause
 *    between a station's overs still reads Busy. Then Clear.
 *
 * Pure except for the FFT plan cache in lib/sdr-scope.js (main only). Tests:
 * test/winlink-spectrum-test.js.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./sdr-scope'));
  else root.WinlinkSpectrum = factory(null);
}(typeof self !== 'undefined' ? self : this, function (sdr) {
  var RATE = 24000;          // frames are analysed at this rate whatever arrives
  var N = 2048;              // FFT size → 11.72 Hz per bin
  var SPAN_HZ = 3000;
  var MAGS = 256;            // bins 0..255 cover 0..3000 Hz
  var WIRE_BINS = 128;       // what goes to a phone (peak-held pairs)
  var BUSY_DB = 8;           // enter: band 90th percentile over the reference
  var BUSY_STAY_DB = 5;      // stay: the same measure, lower (hysteresis)
  var CARRIER_DB = 20;       // enter: band peak over the reference — one strong carrier
  var CARRIER_STAY_DB = 14;
  var BUSY_ENTER_MS = 150;   // the signal has to last this long
  var BUSY_HOLD_MS = 4000;   // Busy outlives the last qualifying frame by this
  var FLOOR_WINDOW_MS = 15000;
  var FLOOR_BUCKET_MS = 250;
  var FLOOR_WARM_MS = 1000;
  var WIRE_RANGE_DB = 50;    // 0..255 spans this many dB above the floor
  var LN_TO_DB = 4.3429;     // mags are ln(power): 10·log10 = 4.343·ln

  /** Accumulates PCM at any rate, decimates to 24 kHz and emits one magnitude frame per 2048 samples (main only). */
  function SpectrumAccumulator(onFrame) {
    this._onFrame = onFrame;
    this._acc = new Float32Array(N);
    this._len = 0;
    this._re = new Float32Array(N);
    this._im = new Float32Array(N);
    this._mags = new Float32Array(MAGS);
  }
  SpectrumAccumulator.prototype.reset = function () { this._len = 0; };
  SpectrumAccumulator.prototype.push = function (pcm, rate) {
    var step = (Number(rate) || RATE) / RATE;
    for (var i = 0; i < pcm.length; i += step) {
      this._acc[this._len++] = pcm[i | 0];
      if (this._len >= N) { this._len = 0; this._frame(); }
    }
  };
  SpectrumAccumulator.prototype._frame = function () {
    var win = sdr.fftPlan(N).win;
    for (var i = 0; i < N; i++) { this._re[i] = this._acc[i] * win[i]; this._im[i] = 0; }
    sdr.fftInPlace(this._re, this._im);
    for (var b = 0; b < MAGS; b++) this._mags[b] = Math.log(this._re[b] * this._re[b] + this._im[b] * this._im[b] + 1e-12);
    this._onFrame(this._mags);
  };

  var MODEM_NAMES = { ardop: 'ARDOP', vara: 'VARA HF', mercury: 'Mercury' };
  var BW_DEFAULT = { ardop: 500, vara: 2300, mercury: 2300 };

  /**
   * The modem's band as fractions of the 3000 Hz span, and the label the
   * surfaces show. `bw` = {ardop, vara, mercury} in Hz (each optional).
   * ARDOP, VARA HF and Mercury sit on 1500 Hz, their bandwidth either side;
   * packet (1200 baud AFSK) on 1200/2200 with its sidebands; VARA FM fills the
   * audio passband.
   */
  function markerBand(mode, bw) {
    bw = bw || {};
    if (mode === 'packet') return { lo: 1000 / SPAN_HZ, hi: 2400 / SPAN_HZ, label: 'Packet tones 1200 / 2200 Hz' };
    if (mode === 'varafm') return { lo: 300 / SPAN_HZ, hi: 2700 / SPAN_HZ, label: 'VARA FM, the whole audio passband' };
    var id = MODEM_NAMES[mode] ? mode : 'ardop';
    var hz = Number(bw[id]) || BW_DEFAULT[id];
    return { lo: (1500 - hz / 2) / SPAN_HZ, hi: (1500 + hz / 2) / SPAN_HZ, label: MODEM_NAMES[id] + ' center 1500 Hz, ' + hz + ' Hz wide' };
  }

  /**
   * The Busy / Clear state machine (rules at the top). One per band; call
   * `update(mags, now)` on EVERY frame (the entry and hold are clocked by
   * `now` in ms, so a 12 frames/s feed and a 47 frames/s feed decide alike).
   */
  function BusyDetector(lo, hi, bins) {
    this._bins = bins || MAGS;
    this._in = new Float32Array(this._bins);
    this._out = new Float32Array(this._bins);
    this.setBand(lo, hi);
  }
  BusyDetector.prototype.setBand = function (lo, hi) {
    this.loBin = Math.max(0, Math.floor((Number(lo) || 0) * this._bins));
    this.hiBin = Math.min(this._bins, Math.ceil((Number(hi) || 1) * this._bins));
    this.reset();
  };
  BusyDetector.prototype.reset = function () {
    this.busy = false;
    this.peakDb = 0;       // the strongest measure over the current Busy episode
    this._hotSince = 0;
    this._until = 0;
    this._floor = [];      // [{t, v}] per FLOOR_BUCKET_MS: the lowest in-band 90th percentile
    this._floorFrom = 0;
  };
  /** @returns {{busy:boolean, peakDb:number, db:number, changed:boolean}} */
  BusyDetector.prototype.update = function (mags, now) {
    var n = 0, m = 0, b;
    for (b = 0; b < this._bins; b++) { if (b >= this.loBin && b < this.hiBin) this._in[n++] = mags[b]; else this._out[m++] = mags[b]; }
    if (!n || !m) return { busy: false, peakDb: 0, db: 0, changed: false };
    var band = this._in.subarray(0, n).sort();
    var out = this._out.subarray(0, m).sort();
    var p90 = band[(n * 0.9) | 0];
    var ref = out[(m * 0.9) | 0];
    // the tracked floor: the lowest in-band 90th percentile of the last 15 s
    var fl = this._floor, bt = now - (now % FLOOR_BUCKET_MS);
    if (!fl.length || fl[fl.length - 1].t !== bt) { fl.push({ t: bt, v: p90 }); if (!this._floorFrom) this._floorFrom = now; }
    else if (p90 < fl[fl.length - 1].v) fl[fl.length - 1].v = p90;
    while (fl.length && fl[0].t < now - FLOOR_WINDOW_MS) fl.shift();
    if (now - this._floorFrom >= FLOOR_WARM_MS) {
      var floor = Infinity;
      for (var i = 0; i < fl.length; i++) if (fl[i].v < floor) floor = fl[i].v;
      if (floor > ref) ref = floor;
    }
    var db = (p90 - ref) * LN_TO_DB;
    var pk = (band[n - 1] - ref) * LN_TO_DB;
    var measure = Math.max(db, pk);
    var hot = db >= BUSY_DB || pk >= CARRIER_DB;
    var warm = db >= BUSY_STAY_DB || pk >= CARRIER_STAY_DB;
    var was = this.busy;
    if (!this.busy) {
      if (hot) {
        if (!this._hotSince) this._hotSince = now;
        if (now - this._hotSince >= BUSY_ENTER_MS) { this.busy = true; this._until = now + BUSY_HOLD_MS; this.peakDb = measure; }
      } else this._hotSince = 0;
    } else {
      if (warm) { this._until = now + BUSY_HOLD_MS; if (measure > this.peakDb) this.peakDb = measure; }
      if (now >= this._until) { this.busy = false; this.peakDb = 0; this._hotSince = 0; }
    }
    return { busy: this.busy, peakDb: this.busy ? Math.round(this.peakDb) : 0, db: Math.round(db), changed: this.busy !== was };
  };

  /** 256 ln-power magnitudes → 128 peak-held bytes, 0 at the noise floor, 255 at +50 dB. */
  function wireBins(mags) {
    var sorted = Array.prototype.slice.call(mags).sort(function (a, b) { return a - b; });
    var floor = sorted[(sorted.length * 0.2) | 0];
    var out = new Array(WIRE_BINS);
    var per = mags.length / WIRE_BINS;
    for (var i = 0; i < WIRE_BINS; i++) {
      var m = -Infinity;
      for (var j = Math.floor(i * per); j < Math.floor((i + 1) * per); j++) if (mags[j] > m) m = mags[j];
      var db = (m - floor) * LN_TO_DB;
      out[i] = Math.max(0, Math.min(255, Math.round(db / WIRE_RANGE_DB * 255)));
    }
    return out;
  }

  return {
    RATE: RATE, N: N, SPAN_HZ: SPAN_HZ, MAGS: MAGS, WIRE_BINS: WIRE_BINS,
    BUSY_DB: BUSY_DB, BUSY_STAY_DB: BUSY_STAY_DB, CARRIER_DB: CARRIER_DB, CARRIER_STAY_DB: CARRIER_STAY_DB,
    BUSY_ENTER_MS: BUSY_ENTER_MS, BUSY_HOLD_MS: BUSY_HOLD_MS, FLOOR_WINDOW_MS: FLOOR_WINDOW_MS, FLOOR_WARM_MS: FLOOR_WARM_MS,
    SpectrumAccumulator: SpectrumAccumulator, markerBand: markerBand, BusyDetector: BusyDetector, wireBins: wireBins,
  };
}));
