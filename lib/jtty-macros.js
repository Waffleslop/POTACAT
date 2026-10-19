// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// JTTY macros — ONE model for the JTCAT pop-out, ECHOCAT Web (inlined by
// remote-server.js like scope-axis.js) and the mobile handoff. A macro is
// { label, text, key }: a name the operator reads on the button, the text
// that is composed (with %M my call, %H their call, %E exchange, %Q next
// call, %G my grid, %N serial, %R the report), and an optional hotkey
// (F1–F12, unique).
//
// Two STYLES, as WSJT-X 3.3 has them (Message style: FT8 | Contest), each
// with its own saved list (settings.jttyFt8Macros / settings.jttyMacros):
//   ft8     — the ordinary QSO, and the DEFAULT (K3SBP 2026-10-18: the
//             contest exchange is not how a normal QSO goes). WSJT-X
//             3.3.0-beta1's ft8StyleMacroTemplate() verbatim: grid, report,
//             R+report, RRR, 73, CQ with grid. %R = the SNR we measured on
//             their signal, "%+03d" ("-07").
//   contest — WSJT-X 3.2's F1–F8 RTTY-contest templates (599 + serial).
//             Their text is what makes a message "native" (packed as typed
//             call + exchange atoms, a frame shorter), so isNativeText()
//             compares text alone, never the label or the key, and an edited
//             text is literal, exactly as WSJT-X treats it. FT8-style texts
//             are never native (WSJT-X packs them literally too).
//
// Dual-mode: `require()` in main / tests, `window.JttyMacros` in renderers.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.JttyMacros = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MAX_MACROS = 12;
  var MAX_LABEL = 12;
  var MAX_TEXT = 80;
  var HOTKEYS = ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12'];

  var STYLES = ['ft8', 'contest'];
  var DEFAULT_STYLE = 'ft8';

  // jtty_design.md "Native message templates", in F-key order.
  var DEFAULTS = [
    { label: 'CQ',         text: 'CQ %M CQ',         key: 'F1' },
    { label: 'Reply',      text: '%H %E',            key: 'F2' },
    { label: 'TU CQ',      text: '%H TU CQ %M CQ',   key: 'F3' },
    { label: 'My call',    text: '%M',               key: 'F4' },
    { label: 'Their call', text: '%H',               key: 'F5' },
    { label: 'TU Now',     text: 'TU NOW %Q %E',     key: 'F6' },
    { label: 'Agn?',       text: '%H AGN?',          key: 'F7' },
    { label: 'Exch',       text: '%E',               key: 'F8' },
  ];
  var NATIVE_TEXTS = DEFAULTS.map(function (d) { return d.text; });

  // WSJT-X 3.3 widgets/JttyMessages.hpp ft8StyleMacroTemplate(), F-key order
  // (F7/F8 are blank there, so there are six).
  var FT8_DEFAULTS = [
    { label: 'Reply',    text: '%H %M %G',  key: 'F1' },
    { label: 'Report',   text: '%H %M %R',  key: 'F2' },
    { label: 'R+Report', text: '%H %M R%R', key: 'F3' },
    { label: 'RRR',      text: '%H %M RRR', key: 'F4' },
    { label: '73',       text: '%H %M 73',  key: 'F5' },
    { label: 'CQ',       text: 'CQ %M %G',  key: 'F6' },
  ];

  function styleOf(style) { return style === 'contest' ? 'contest' : DEFAULT_STYLE; }
  function defaultsFor(style) { return styleOf(style) === 'contest' ? DEFAULTS : FT8_DEFAULTS; }
  /** The settings key that holds a style's own list. */
  function settingsKey(style) { return styleOf(style) === 'contest' ? 'jttyMacros' : 'jttyFt8Macros'; }

  // No style = contest, like normalize(): the two-argument callers predate styles.
  function defaults(style) { return defaultsFor(style == null ? 'contest' : style).map(function (d) { return { label: d.label, text: d.text, key: d.key }; }); }

  function cleanKey(k) {
    var u = String(k == null ? '' : k).toUpperCase().trim();
    return HOTKEYS.indexOf(u) >= 0 ? u : '';
  }
  function cleanText(t) { return String(t == null ? '' : t).replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT); }
  function cleanLabel(l) { return String(l == null ? '' : l).trim().slice(0, MAX_LABEL); }

  /**
   * Canonicalize what settings hold. `saved` is the macro array
   * (settings.jttyMacros); `legacy` is the pre-macro settings.jttyTemplates
   * (eight strings) and is honoured only when there is no macro array, and
   * only for the contest style (it never held anything else). No saved data
   * at all = that style's defaults. A saved entry with no usable text is
   * dropped; a label-less entry gets the default label when its text is a
   * default's, else "M<n>". Hotkeys are made unique in list order.
   * The style defaults to 'contest' here so the old two-argument call keeps
   * meaning what it always did; forSettings() is what picks the style.
   */
  function normalize(saved, legacy, style) {
    if (style == null) style = 'contest';
    var out = [];
    var src = null;
    var base = defaultsFor(style);
    var baseTexts = base.map(function (d) { return d.text; });
    if (Array.isArray(saved) && saved.length) src = saved;
    else if (styleOf(style) === 'contest' && Array.isArray(legacy) && legacy.length) {
      src = legacy.map(function (t, i) {
        var d = DEFAULTS[i];
        var text = cleanText(t) || (d ? d.text : '');
        var nativeIdx = NATIVE_TEXTS.indexOf(text);
        // An edited legacy slot keeps its F-key but not the default's name —
        // a button called "TU CQ" that sends something else is a trap.
        return { label: nativeIdx >= 0 ? DEFAULTS[nativeIdx].label : 'M' + (i + 1), text: text, key: d ? d.key : '' };
      });
    }
    if (!src) return defaults(style);
    var used = {};
    for (var i = 0; i < src.length && out.length < MAX_MACROS; i++) {
      var m = src[i] || {};
      var text = cleanText(typeof m === 'string' ? m : m.text);
      if (!text) continue;
      var baseIdx = baseTexts.indexOf(text);
      var label = cleanLabel(m.label) || (baseIdx >= 0 ? base[baseIdx].label : 'M' + (out.length + 1));
      var key = cleanKey(m.key);
      if (key && used[key]) key = '';
      if (key) used[key] = true;
      out.push({ label: label, text: text, key: key });
    }
    return out.length ? out : defaults(style);
  }

  /** The active style and its macro list, from a settings object. */
  function forSettings(s) {
    var v = s || {};
    var style = styleOf(v.jttyMacroStyle);
    return {
      style: style,
      macros: style === 'contest' ? normalize(v.jttyMacros, v.jttyTemplates, 'contest') : normalize(v.jttyFt8Macros, null, 'ft8'),
    };
  }

  /** True when this text is one of WSJT-X's eight templates (native packing applies). */
  function isNativeText(text) { return NATIVE_TEXTS.indexOf(cleanText(text)) >= 0; }

  /** Give macro `idx` hotkey `key`, taking it from whichever macro held it. Returns a new list. */
  function assignHotkey(list, idx, key) {
    var k = cleanKey(key);
    return list.map(function (m, i) {
      if (i === idx) return { label: m.label, text: m.text, key: k };
      if (k && m.key === k) return { label: m.label, text: m.text, key: '' };
      return { label: m.label, text: m.text, key: m.key };
    });
  }

  /** The macro bound to a keyboard event's key ("F3"), or -1. */
  function indexForKey(list, eventKey) {
    var k = cleanKey(eventKey);
    if (!k) return -1;
    for (var i = 0; i < list.length; i++) if (list[i].key === k) return i;
    return -1;
  }

  /**
   * Expand placeholders. fields: { myCall, theirCall, exchange, nextCall, grid, serial }.
   * Both WSJT-X's % tokens and the $ spellings used by the PSK31 macros.
   */
  function substitute(text, f) {
    var v = f || {};
    var up = function (x) { return String(x == null ? '' : x).toUpperCase().trim(); };
    return String(text == null ? '' : text)
      .replace(/%M|\$MYCALL/g, up(v.myCall))
      .replace(/%H|\$CALL/g, up(v.theirCall))
      .replace(/%E|\$EXCH/g, up(v.exchange))
      .replace(/%Q|\$NEXT/g, up(v.nextCall))
      // WSJT-X truncates %G to a 4-character locator (GRID4 is what JTTY packs).
      .replace(/%G|\$GRID/g, up(v.grid).slice(0, 4))
      .replace(/%N|\$SERIAL/g, up(v.serial))
      .replace(/%R|\$RPT/g, up(v.report))
      .replace(/\s+/g, ' ').trim();
  }

  /** Which fields a macro's text needs filled before it can be composed. */
  function needs(text) {
    var t = String(text || '');
    return {
      theirCall: /%H|\$CALL/.test(t),
      nextCall: /%Q|\$NEXT/.test(t),
      myCall: /%M|\$MYCALL/.test(t),
      report: /%R|\$RPT/.test(t),
      grid: /%G|\$GRID/.test(t),
    };
  }

  /** A measured SNR as an FT8-style report: "%+03d", -30..+49 ("-07", "+03"). '' when unknown. */
  function formatReport(db) {
    if (db === null || db === undefined || db === '') return '';
    var n = Math.round(Number(db));
    if (!isFinite(n)) return '';
    n = Math.max(-30, Math.min(49, n));
    var a = Math.abs(n);
    return (n < 0 ? '-' : '+') + (a < 10 ? '0' : '') + a;
  }

  var GRID_RE = /^[A-R]{2}\d{2}$/;
  var REPORT_RE = /^R?[+-]\d{2}$/;
  function isCall(w) {
    return /^[A-Z0-9/]{3,11}$/.test(w) && /\d/.test(w) && /[A-Z]/.test(w)
      && !GRID_RE.test(w) && w !== 'RR73';
  }
  function words(text) { return String(text == null ? '' : text).toUpperCase().trim().split(/\s+/).filter(Boolean); }

  /**
   * Who SENT a decoded message, by the "TO FROM ..." order the FT8 style
   * uses: "CQ K1ABC FN20" and "CQ K1ABC CQ" → K1ABC; two leading calls → the
   * second; a message that is one bare call (a contest reply to a CQ) → that
   * call. Anything else ("W9XYZ 599 101", free text) → '' — one call followed
   * by an exchange is the sender addressing someone, so a guess would credit
   * the wrong station with the SNR.
   */
  function senderOf(text) {
    var w = words(text);
    if (!w.length) return '';
    if (w[0] === 'CQ') return w[1] && isCall(w[1]) ? w[1] : '';
    if (w.length >= 2 && isCall(w[0]) && isCall(w[1])) return w[1];
    if (w.length === 1 && isCall(w[0])) return w[0];
    return '';
  }

  /** Their grid from "MYCALL HIS EN52" / "CQ HIS EN52" (the last token, when it is a grid). */
  function gridOf(text) {
    var w = words(text);
    var last = w[w.length - 1] || '';
    // RR73 is a legal locator in the Arctic Ocean and always an ack on air.
    return w.length >= 3 && GRID_RE.test(last) && last !== 'RR73' ? last : '';
  }

  /**
   * The report a station sent US: "MYCALL HIS -07" or "MYCALL HIS R-07" →
   * "-07". '' when the message is not addressed to myCall or carries none.
   */
  function reportTo(text, myCall) {
    var w = words(text);
    var me = String(myCall || '').toUpperCase().trim();
    if (!me || w[0] !== me || w.length < 3) return '';
    var last = w[w.length - 1];
    return REPORT_RE.test(last) ? last.replace(/^R/, '') : '';
  }

  // ---- Frequency etiquette (K3SBP 2026-10-18) ----
  // JTTY has no T/R slots, so two QSOs on one audio frequency collide for
  // their whole length: "everyone on 1500 Hz" is a pile-up, and a random
  // offset throws away the receiver's QSO-window advantage. The RTTY
  // convention instead: transceive (TX = RX), a station ANSWERING moves onto
  // the station it answers (zero beat, the lowest tone, which is what every
  // decode row reports), a station being CALLED stays put, and a CQ goes out
  // on a spot the operator chose — "Clear spot" only suggests the quietest.
  var JTTY_BW = 127;          // occupied bandwidth, Hz (lowest tone + 127)
  var TONE_MIN = 200;         // lowest-tone limits the engine accepts
  var TONE_MAX = 2700;

  /**
   * Clicking a decoded row: does our TX/RX move onto that station? No under
   * Hold TX; no when the message is addressed to US (they are already on our
   * frequency, and an off-frequency caller must not drag a running station
   * around); yes for a CQ we are answering, or a station we want to call
   * after its QSO ("THEM SOMEONE -07"). A lone call, or free text with no
   * recognisable sender, does not move.
   */
  function shouldFollowStation(text, myCall, hold) {
    if (hold) return false;
    var w = words(text);
    var me = String(myCall || '').toUpperCase().trim();
    // A lone call is a station answering a CQ — usually ours (Contest style's
    // reply), and a running station never follows its callers either.
    if (w.length < 2) return false;
    if (me && w[0] === me) return false;
    return !!senderOf(text);
  }

  /**
   * Fold one spectrum frame into a running average (exponential, weight
   * alpha). acc and frame are arrays of the same length; acc is changed and
   * returned. A fresh/mismatched acc starts from this frame.
   */
  function accumulateLevels(acc, frame, alpha) {
    var n = frame ? frame.length : 0;
    if (!acc || acc.length !== n) {
      acc = new Float32Array(n);
      for (var i = 0; i < n; i++) acc[i] = Number(frame[i]) || 0;
      return acc;
    }
    var a = Math.max(0, Math.min(1, alpha));
    for (var j = 0; j < n; j++) acc[j] += a * ((Number(frame[j]) || 0) - acc[j]);
    return acc;
  }

  /**
   * The quietest place for a JTTY signal. levels[i] is the average level of
   * the bin starting at i * hzPerBin Hz (0 Hz up). Every lowest-tone f0 in
   * TONE_MIN..TONE_MAX (10 Hz steps) is scored by the mean level over
   * [f0 - guard, f0 + 127 + guard]; the lowest score wins, and among spots
   * within 1 level unit of it the one nearest "prefer" (the current
   * frequency) — a clear spot next door beats a marginally clearer one
   * across the passband. Returns { hz, level } or null without data.
   */
  function clearestSpot(levels, hzPerBin, opts) {
    var o = opts || {};
    if (!levels || !levels.length || !(hzPerBin > 0)) return null;
    var guard = o.guardHz != null ? o.guardHz : 15;
    var lo = Math.max(TONE_MIN, o.loHz || TONE_MIN);
    var hi = Math.min(TONE_MAX, o.hiHz || TONE_MAX);
    var prefer = Number(o.prefer) || 1500;
    var span = levels.length * hzPerBin;
    var cands = [];
    for (var f0 = lo; f0 <= hi; f0 += 10) {
      var a = f0 - guard, b = f0 + JTTY_BW + guard;
      if (b > span) break;
      var i0 = Math.max(0, Math.floor(a / hzPerBin));
      var i1 = Math.min(levels.length - 1, Math.ceil(b / hzPerBin) - 1);
      var sum = 0, n = 0;
      for (var i = i0; i <= i1; i++) { sum += Number(levels[i]) || 0; n++; }
      if (n) cands.push({ hz: f0, level: sum / n });
    }
    if (!cands.length) return null;
    var best = Infinity;
    for (var c = 0; c < cands.length; c++) if (cands[c].level < best) best = cands[c].level;
    var pick = null;
    for (var d = 0; d < cands.length; d++) {
      if (cands[d].level > best + 1) continue;
      if (!pick || Math.abs(cands[d].hz - prefer) < Math.abs(pick.hz - prefer)) pick = cands[d];
    }
    return pick;
  }

  return {
    MAX_MACROS: MAX_MACROS, MAX_LABEL: MAX_LABEL, MAX_TEXT: MAX_TEXT, HOTKEYS: HOTKEYS,
    STYLES: STYLES, DEFAULT_STYLE: DEFAULT_STYLE, styleOf: styleOf, settingsKey: settingsKey, forSettings: forSettings,
    DEFAULTS: DEFAULTS, FT8_DEFAULTS: FT8_DEFAULTS, defaults: defaults, normalize: normalize, isNativeText: isNativeText,
    formatReport: formatReport, senderOf: senderOf, gridOf: gridOf, reportTo: reportTo,
    JTTY_BW: JTTY_BW, TONE_MIN: TONE_MIN, TONE_MAX: TONE_MAX,
    shouldFollowStation: shouldFollowStation, accumulateLevels: accumulateLevels, clearestSpot: clearestSpot,
    assignHotkey: assignHotkey, indexForKey: indexForKey, substitute: substitute, needs: needs, cleanKey: cleanKey,
  };
}));
