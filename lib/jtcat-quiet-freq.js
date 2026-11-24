// lib/jtcat-quiet-freq.js: where an FT8/FT4 CQ goes out when nobody picked a
// frequency. Dual-mode: `require()` in main, `window.JtcatQuietFreq` via a
// <script> tag in the main window and the JTCAT pop-out. No dependencies.
//
// The rule (the waterfall loops in renderer/app.js and renderer/jtcat-popout.js
// call pickQuietFreq): the quietest 50 Hz window whose centre lies in
// AUTO_LOW_HZ..AUTO_HIGH_HZ (500..2400 Hz), the centre snapped to 10 Hz, 1500 Hz
// when nothing beats it.
//
// Why 500..2400 (#1032): the pick is the LOWEST tone of the signal, and a radio
// in DATA mode transmits only inside its TX filter. Until #1032 the range was
// 200..2800 Hz, and N4RLW's IC-7100 sent every CQ on 230 Hz: low, swinging
// power. The common DATA-mode TX filters, from the manufacturers' manuals:
//   - Icom IC-7100: "Fixed to the default value of 300 Hz to 2700 Hz" in any
//     data mode (Full Manual rev 5, p.18-3 printed / PDF p.343).
//   - Icom IC-7300, IC-7300MK2, IC-7610: SSB-D TX bandwidth default 300-2700 Hz;
//     the narrowest SSB preset (NAR) is 500-2500 Hz (IC-7300 Full Manual rev 12b
//     PDF p.49; IC-7300MK2 Basic Manual rev 2c PDF p.35; IC-7610 Basic Manual
//     rev 10 PDF p.40).
//   - Yaesu FT-710, FTDX10, FTDX101, FT-991A, FT-891: TX BPF choices run from
//     50-3050 down to 400-2600 Hz (FT-710 Operating Manual, DATA mode TX BPF
//     SEL, PDF p.85, default 50-3050; FT-991A Operating Manual, menu 110 SSB TX
//     BPF, PDF p.152, and FT-891 Operating Manual, menu 11-09, PDF p.55, both
//     default 300-2700).
// So the whole signal stays within 500-2500 Hz: 200 Hz inside the Icom fixed
// 300-2700, 100 Hz inside the narrowest Yaesu choice (400-2600), clear of the
// filter skirts. FT8 is 50 Hz wide and FT4 83 Hz above the lowest tone, so the
// highest pick is 2400 Hz. The bound applies ONLY to this automatic pick: a
// tone the operator chooses (waterfall click, TX box, phone) is never bounded,
// and Fake It (lib/jtcat-fake-it.js) is unchanged. The input is the 0..255 dB-scaled bins of
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

  /** The automatic pick's range for the lowest tone (see the header, #1032). */
  var AUTO_LOW_HZ = 500;
  var AUTO_HIGH_HZ = 2400;
  var WINDOW_HZ = 50;
  var SNAP_HZ = 10;
  var DEFAULT_HZ = 1500;
  /** A window's report older than this gives way to main's own measurement. */
  var WINDOW_FRESH_MS = 3000;

  /** An automatic tone, held inside AUTO_LOW_HZ..AUTO_HIGH_HZ. Never for an operator's choice. */
  function clampAutoTone(hz) {
    return Math.max(AUTO_LOW_HZ, Math.min(AUTO_HIGH_HZ, hz));
  }

  /**
   * The quietest 50 Hz window whose centre is in 500..2400 Hz.
   * @param {ArrayLike<number>} bins  dB-scaled magnitudes, bin 0 = 0 Hz
   * @param {number} binHz            width of one bin in Hz
   * @returns {number} Hz, snapped to 10 Hz, within AUTO_LOW_HZ..AUTO_HIGH_HZ
   */
  function pickQuietFreq(bins, binHz) {
    if (!bins || !bins.length || !(binHz > 0)) return DEFAULT_HZ;
    var windowBins = Math.max(1, Math.round(WINDOW_HZ / binHz));
    var half = Math.floor(windowBins / 2);
    var firstCentre = Math.ceil(AUTO_LOW_HZ / binHz);
    var lastCentre = Math.min(Math.floor(AUTO_HIGH_HZ / binHz), bins.length - windowBins + half);
    var bestEnergy = Infinity;
    var bestBin = Math.round(DEFAULT_HZ / binHz);
    for (var c = firstCentre; c <= lastCentre; c++) {
      var b = c - half;
      var energy = 0;
      for (var j = 0; j < windowBins; j++) energy += bins[b + j];
      if (energy < bestEnergy) {
        bestEnergy = energy;
        bestBin = c;
      }
    }
    return clampAutoTone(Math.round(bestBin * binHz / SNAP_HZ) * SNAP_HZ);
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
      // Both sources are automatic measurements, so both are bounded here:
      // whatever reports, no CQ path can be handed a tone outside the range.
      last[source === 'window' ? 'window' : 'main'] = { hz: clampAutoTone(hz), at: now };
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
    AUTO_LOW_HZ: AUTO_LOW_HZ, AUTO_HIGH_HZ: AUTO_HIGH_HZ, WINDOW_HZ: WINDOW_HZ, DEFAULT_HZ: DEFAULT_HZ, WINDOW_FRESH_MS: WINDOW_FRESH_MS,
    clampAutoTone: clampAutoTone, pickQuietFreq: pickQuietFreq, createQuietFreqTracker: createQuietFreqTracker, describePick: describePick,
  };
});
