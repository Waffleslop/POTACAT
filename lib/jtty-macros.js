// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// JTTY macros — ONE model for the JTCAT pop-out, ECHOCAT Web (inlined by
// remote-server.js like scope-axis.js) and the mobile handoff. A macro is
// { label, text, key }: a name the operator reads on the button, the text
// that is composed (with %M my call, %H their call, %E exchange, %Q next
// call, %G my grid, %N serial), and an optional hotkey (F1–F12, unique).
//
// The eight defaults are WSJT-X 3.2's F1–F8 templates VERBATIM — their text
// is what makes a message "native" (packed as typed call + exchange atoms,
// a frame shorter), so isNativeText() compares text alone, never the label
// or the key, and an edited text is literal, exactly as WSJT-X treats it.
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

  function defaults() { return DEFAULTS.map(function (d) { return { label: d.label, text: d.text, key: d.key }; }); }

  function cleanKey(k) {
    var u = String(k == null ? '' : k).toUpperCase().trim();
    return HOTKEYS.indexOf(u) >= 0 ? u : '';
  }
  function cleanText(t) { return String(t == null ? '' : t).replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT); }
  function cleanLabel(l) { return String(l == null ? '' : l).trim().slice(0, MAX_LABEL); }

  /**
   * Canonicalize what settings hold. `saved` is the macro array
   * (settings.jttyMacros); `legacy` is the pre-macro settings.jttyTemplates
   * (eight strings) and is honoured only when there is no macro array. No
   * saved data at all = the eight defaults. A saved entry with no usable text
   * is dropped; a label-less entry gets the default label when its text is a
   * default's, else "M<n>". Hotkeys are made unique in list order.
   */
  function normalize(saved, legacy) {
    var out = [];
    var src = null;
    if (Array.isArray(saved) && saved.length) src = saved;
    else if (Array.isArray(legacy) && legacy.length) {
      src = legacy.map(function (t, i) {
        var d = DEFAULTS[i];
        var text = cleanText(t) || (d ? d.text : '');
        var nativeIdx = NATIVE_TEXTS.indexOf(text);
        // An edited legacy slot keeps its F-key but not the default's name —
        // a button called "TU CQ" that sends something else is a trap.
        return { label: nativeIdx >= 0 ? DEFAULTS[nativeIdx].label : 'M' + (i + 1), text: text, key: d ? d.key : '' };
      });
    }
    if (!src) return defaults();
    var used = {};
    for (var i = 0; i < src.length && out.length < MAX_MACROS; i++) {
      var m = src[i] || {};
      var text = cleanText(typeof m === 'string' ? m : m.text);
      if (!text) continue;
      var nativeIdx = NATIVE_TEXTS.indexOf(text);
      var label = cleanLabel(m.label) || (nativeIdx >= 0 ? DEFAULTS[nativeIdx].label : 'M' + (out.length + 1));
      var key = cleanKey(m.key);
      if (key && used[key]) key = '';
      if (key) used[key] = true;
      out.push({ label: label, text: text, key: key });
    }
    return out.length ? out : defaults();
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
      .replace(/%G|\$GRID/g, up(v.grid))
      .replace(/%N|\$SERIAL/g, up(v.serial))
      .replace(/\s+/g, ' ').trim();
  }

  /** Which fields a macro's text needs filled before it can be composed. */
  function needs(text) {
    var t = String(text || '');
    return {
      theirCall: /%H|\$CALL/.test(t),
      nextCall: /%Q|\$NEXT/.test(t),
      myCall: /%M|\$MYCALL/.test(t),
    };
  }

  return {
    MAX_MACROS: MAX_MACROS, MAX_LABEL: MAX_LABEL, MAX_TEXT: MAX_TEXT, HOTKEYS: HOTKEYS,
    DEFAULTS: DEFAULTS, defaults: defaults, normalize: normalize, isNativeText: isNativeText,
    assignHotkey: assignHotkey, indexForKey: indexForKey, substitute: substitute, needs: needs, cleanKey: cleanKey,
  };
}));
