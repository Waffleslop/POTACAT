// lib/scope-axis.js — the band scope's axis and CAT tables, shared by main
// (lib/yaesu-scope.js re-exports these), the desktop pop-out and the ECHOCAT
// web client. Dual-mode: `require()` in Node, `window.ScopeAxis` via a
// <script> tag or the remote-server inliner. No dependencies.
//
// Every table here is from the FT-710 CAT Operation Reference Manual
// (2306-C), SS SPECTRUM SCOPE and EX MENU. See lib/yaesu-scope.js for the
// rest of the story.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ScopeAxis = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var BINS = 850;

  /** SS05 P3 → span in Hz. */
  var SPAN_HZ_BY_CODE = {
    0: 1000, 1: 2000, 2: 5000, 3: 10000, 4: 20000,
    5: 50000, 6: 100000, 7: 200000, 8: 500000, 9: 1000000,
  };

  /** SS06 P3 → how the scope window is anchored. */
  var MODE_BY_CODE = {
    0: { anchor: 'center', display: '3DSS' },
    1: { anchor: 'cursor', display: '3DSS' },
    2: { anchor: 'fix',    display: '3DSS' },
    3: { anchor: 'center', display: 'W/F', expand: true },
    4: { anchor: 'center', display: 'W/F' },
    6: { anchor: 'cursor', display: 'W/F', expand: true },
    7: { anchor: 'cursor', display: 'W/F' },
    9: { anchor: 'fix',    display: 'W/F', expand: true },
    A: { anchor: 'fix',    display: 'W/F' },
  };

  /** SS00 P3 → sweep speed; 5 is STOP (the picture freezes). */
  var SPEED_BY_CODE = { 0: 'SLOW1', 1: 'SLOW2', 2: 'FAST1', 3: 'FAST2', 4: 'FAST3', 5: 'STOP' };

  /** Parse an `SS` reply such as `SS0530000;` → { p2: 5, p3: '3', rest }. */
  function parseSsReply(text) {
    var m = String(text || '').trim().match(/^SS0([0-7])([0-9A-Fa-f])([0-9A-Fa-f.+\-]*);?$/);
    if (!m) return null;
    return { p2: Number(m[1]), p3: m[2].toUpperCase(), rest: m[3] };
  }

  /** Parse an `EX` reply, e.g. `EX0301261` → { menu: '030126', value: '1' }. */
  function parseExReply(text) {
    var m = String(text || '').trim().match(/^EX(\d{6})(.*?);?$/);
    if (!m) return null;
    return { menu: m[1], value: m[2] };
  }

  function spanHzFromCode(code) { return SPAN_HZ_BY_CODE[String(code)] || null; }

  function modeFromCode(code) {
    var m = MODE_BY_CODE[String(code).toUpperCase()];
    if (!m) return null;
    var out = { code: String(code).toUpperCase() };
    for (var k in m) out[k] = m[k];
    return out;
  }

  function speedFromCode(code) { return SPEED_BY_CODE[String(code)] || null; }

  /**
   * Where each bin sits in RF. Only CENTER mode is honest — the radio centres
   * on the VFO. CURSOR and FIX hold the window still while the VFO moves and
   * their edges are not readable over CAT, so the axis is ASSUMED and
   * `known` is false: the UI labels it and click-to-tune declines.
   */
  function scopeAxis(o) {
    var c = Number(o.centerHz) || 0;
    var s = Number(o.spanHz) || 0;
    var anchor = o.anchor || 'center';
    var bins = o.bins || BINS;
    return {
      startHz: c - s / 2,
      endHz: c + s / 2,
      hzPerBin: bins > 1 ? s / (bins - 1) : 0,
      bins: bins,
      known: anchor === 'center' && c > 0 && s > 0,
      anchor: anchor,
    };
  }

  function binToHz(axis, bin) { return axis.startHz + bin * axis.hzPerBin; }

  function hzToBin(axis, hz) {
    if (!axis.hzPerBin) return null;
    var b = (hz - axis.startHz) / axis.hzPerBin;
    if (b < 0 || b > axis.bins - 1) return null;
    return b;
  }

  /** 850 bins → `width`, keeping each group's PEAK so a narrow carrier survives. */
  function downsampleBins(bins, width) {
    var n = bins.length;
    var w = Math.max(1, Math.min(n, Math.floor(width)));
    var out = new Uint8Array(w);
    for (var x = 0; x < w; x++) {
      var a = Math.floor(x * n / w);
      var b = Math.max(a + 1, Math.floor((x + 1) * n / w));
      var m = 0;
      for (var i = a; i < b; i++) if (bins[i] > m) m = bins[i];
      out[x] = m;
    }
    return out;
  }

  /**
   * Noise floor for the display: everything at or below `floor` (0..255 level
   * units) becomes 0 and the rest is stretched back to full scale, so the
   * waterfall goes black between signals instead of blue-speckled. Display
   * only — the radio's data is untouched. The first FT-710 owner to see the
   * scope asked for exactly this (2026-09-21).
   */
  function applyFloor(bins, floor) {
    var f = Math.max(0, Math.min(250, Math.round(Number(floor) || 0)));
    if (!f) return bins;
    var out = new Uint8Array(bins.length);
    var scale = 255 / (255 - f);
    for (var i = 0; i < bins.length; i++) {
      var v = bins[i] - f;
      out[i] = v <= 0 ? 0 : Math.min(255, Math.round(v * scale));
    }
    return out;
  }

  /** "14.074.000" style label for an axis tick. */
  function formatHz(hz) {
    var v = Math.round(hz);
    var mhz = Math.floor(v / 1e6);
    var khz = Math.floor((v % 1e6) / 1e3);
    var h = v % 1e3;
    return mhz + '.' + String(khz).padStart(3, '0') + '.' + String(h).padStart(3, '0');
  }

  /** "10 kHz" / "1 MHz" for a span. */
  function formatSpan(hz) {
    if (!hz) return '—';
    return hz >= 1e6 ? (hz / 1e6) + ' MHz' : (hz / 1e3) + ' kHz';
  }

  return {
    BINS: BINS,
    SPAN_HZ_BY_CODE: SPAN_HZ_BY_CODE, MODE_BY_CODE: MODE_BY_CODE, SPEED_BY_CODE: SPEED_BY_CODE,
    parseSsReply: parseSsReply, parseExReply: parseExReply,
    spanHzFromCode: spanHzFromCode, modeFromCode: modeFromCode, speedFromCode: speedFromCode,
    scopeAxis: scopeAxis, binToHz: binToHz, hzToBin: hzToBin, downsampleBins: downsampleBins, applyFloor: applyFloor,
    formatHz: formatHz, formatSpan: formatSpan,
  };
});
