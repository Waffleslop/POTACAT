// lib/jtcat-quiet-freq.js: where an FT8/FT4 CQ goes out when nobody picked a
// frequency. Dual-mode: `require()` in main, `window.JtcatQuietFreq` via a
// <script> tag in the main window and the JTCAT pop-out. No dependencies.
//
// The rule (unchanged from the waterfall loops in renderer/app.js and
// renderer/jtcat-popout.js, which now call pickQuietFreq): the quietest 50 Hz
// window between 200 and 2800 Hz, its centre snapped to 10 Hz, 1500 Hz when
// nothing beats it. The input is the 0..255 dB-scaled bins of
// AnalyserNode.getByteFrequencyData, or lib/spectrum-fft.js's computeSpectrumBins
// (the same -100..-30 dB scale) in main.
//
// Why main measures too: the waterfall loops are canvas draw loops, and
// Chromium pauses them while the window is hidden or minimised. On an
// unattended shack (FT8 driven from ECHOCAT) no loop ran, so the pick never left
// 1500 Hz and every CQ landed there (ECHOCAT_TO_DESKTOP_HANDOFF_2026-11-16).
// Main now measures the engine's own audio and uses that whenever the windows
// have gone quiet; the tracker below decides which measurement a CQ uses.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.JtcatQuietFreq = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LOW_HZ = 200;
  var HIGH_HZ = 2800;
  var WINDOW_HZ = 50;
  var SNAP_HZ = 10;
  var DEFAULT_HZ = 1500;
  /** A window's report older than this gives way to main's own measurement. */
  var WINDOW_FRESH_MS = 3000;

  /**
   * The quietest 50 Hz window in 200..2800 Hz.
   * @param {ArrayLike<number>} bins  dB-scaled magnitudes, bin 0 = 0 Hz
   * @param {number} binHz            width of one bin in Hz
   * @returns {number} Hz, snapped to 10 Hz, within 200..2800
   */
  function pickQuietFreq(bins, binHz) {
    if (!bins || !bins.length || !(binHz > 0)) return DEFAULT_HZ;
    var windowBins = Math.round(WINDOW_HZ / binHz);
    var startBin = Math.round(LOW_HZ / binHz);
    var endBin = Math.round(HIGH_HZ / binHz);
    var bestEnergy = Infinity;
    var bestBin = Math.round(DEFAULT_HZ / binHz);
    for (var b = startBin; b <= endBin - windowBins; b++) {
      var energy = 0;
      for (var j = 0; j < windowBins; j++) energy += bins[b + j];
      if (energy < bestEnergy) {
        bestEnergy = energy;
        bestBin = b + Math.floor(windowBins / 2);
      }
    }
    var quietHz = Math.round(bestBin * binHz / SNAP_HZ) * SNAP_HZ;
    return Math.max(LOW_HZ, Math.min(HIGH_HZ, quietHz));
  }

  /**
   * Holds the two measurements: 'window' (a waterfall loop's report) and
   * 'main' (main's measurement of the engine audio). A fresh window report
   * wins, so nothing changes while a waterfall is on screen; otherwise the
   * newer of the two; with neither, 1500 Hz.
   */
  function createQuietFreqTracker(opts) {
    var freshMs = (opts && opts.windowFreshMs) || WINDOW_FRESH_MS;
    var last = { window: null, main: null };

    function report(source, hz, now) {
      hz = Number(hz);
      if (!isFinite(hz) || hz <= 0) return;
      last[source === 'window' ? 'window' : 'main'] = { hz: hz, at: now };
    }

    /** True when a waterfall reported recently: main need not measure. */
    function windowFresh(now) {
      return !!(last.window && now - last.window.at <= freshMs);
    }

    /** @returns {{hz:number, source:'window'|'main'|'default', ageMs:number|null}} */
    function current(now) {
      var w = last.window, m = last.main, pick = null;
      if (windowFresh(now)) pick = w;
      else if (w && m) pick = w.at >= m.at ? w : m;
      else pick = w || m;
      if (!pick) return { hz: DEFAULT_HZ, source: 'default', ageMs: null };
      return { hz: pick.hz, source: pick === w ? 'window' : 'main', ageMs: Math.max(0, now - pick.at) };
    }

    return { report: report, windowFresh: windowFresh, current: current };
  }

  /** "1730 Hz (quiet, measured 3 s ago from the shack audio)" for the CQ log lines. */
  function describePick(p) {
    if (!p || p.source === 'default') return DEFAULT_HZ + ' Hz (default ' + DEFAULT_HZ + ', no measurement yet)';
    var s = Math.round((p.ageMs || 0) / 1000);
    var from = p.source === 'window' ? 'the waterfall' : 'the shack audio';
    return p.hz + ' Hz (quiet, measured ' + s + ' s ago from ' + from + ')';
  }

  return {
    LOW_HZ: LOW_HZ, HIGH_HZ: HIGH_HZ, WINDOW_HZ: WINDOW_HZ, DEFAULT_HZ: DEFAULT_HZ, WINDOW_FRESH_MS: WINDOW_FRESH_MS,
    pickQuietFreq: pickQuietFreq, createQuietFreqTracker: createQuietFreqTracker, describePick: describePick,
  };
});
