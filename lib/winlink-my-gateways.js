// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// Add a gateway (#585, plan docs/winlink-custom-gateways-plan.md 2.3 and 3.2).
// A gateway the operator types in is a My gateways entry marked as their own
// ("Mine"): this module holds the form's rules, so the mail window, ECHOCAT Web
// and the shack check it the same way.
//
//   isCall(c)                 a gateway call, -SSID 0 to 15
//   parseFreqKhz(text)        "145.05", "145050", "7101.4", "7.1014" -> kHz (below 1000 is MHz)
//   dialKhz(mode, center)     Pat's Dial: ARDOP, VARA HF, Mercury = center - 1.5 kHz; packet, VARA FM = channel
//   centerKhz(mode, dial)     back again, for Edit
//   dialLine(mode, text)      the line under Frequency: the dial POTACAT will set
//   parseVia(text)            packet digipeaters, 0 to 2 calls
//   cleanNote(s)              up to 60 printable characters, trimmed
//   validate(form, {modes})   { ok, entry, errors: { call, mode, freq, bw, via, note } }
//   pickerGroups(o)           the gateway list: Mine first, Pat's rows, starred ones Pat did not list
//   mineLabel(f)              "★ W2XYZ-10  Mine  145.050.00 MHz  club net"
//
// Dual-mode: require() in Node, window.WinlinkMine in the pages (after
// lib/freq-dots.js, which every page that shows a frequency already loads).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./freq-dots'));
  else root.WinlinkMine = factory(root.FreqDots);
})(typeof self !== 'undefined' ? self : this, function (FreqDots) {
  'use strict';

  var MODES = ['ardop', 'vara', 'varafm', 'packet', 'mercury'];
  // Pat's Dial (app/freq.go): these modes are written as the center of the
  // signal; the radio's USB dial sits 1.5 kHz below it.
  var CENTER_MODES = ['ardop', 'vara', 'mercury'];
  var OFFSET_KHZ = 1.5;
  var ARDOP_BWS = [200, 500, 1000, 2000];
  var MAX_NOTE = 60;
  var MAX_VIA = 2;
  var MAX_KHZ = 1.5e6;
  var MINE_GROUP = 'My own gateways';
  var MINE_TAG = 'Mine';

  var TEXT = {
    call: "That is not a callsign. Use the gateway's call, with -10 or similar if it has one.",
    freq: 'Enter the frequency, for example 145.05 or 7101.4.',
    via: 'Via takes up to two digipeater calls, for example W2ABC-1.',
    note: 'Keep the note to 60 characters or fewer.',
    mode: 'Pick a mode this station can use.',
    bw: 'Pick 200, 500, 1000 or 2000 Hz.',
  };

  function round1(n) { return Math.round(n * 10) / 10; }

  /** A gateway call with an optional -SSID from 0 to 15 (the shape Pat dials). */
  function isCall(c) {
    var s = String(c == null ? '' : c).trim();
    var m = /^[A-Z0-9]{1,3}[0-9][A-Z0-9]{0,4}(?:-(\d{1,2}))?$/i.exec(s);
    if (!m) return false;
    return m[1] == null || Number(m[1]) <= 15;
  }

  /**
   * What Winlink and club pages print, in kHz or MHz. A value below 1000 is
   * MHz. "145.050.00" (the way the VFO writes it) is MHz.kHz.tens. A unit after
   * the number is obeyed. Null when it is not a frequency up to 1.5 GHz.
   */
  function parseFreqKhz(text) {
    if (text == null) return null;
    var s = String(text).trim().toLowerCase().replace(/,/g, '').replace(/\s+/g, '');
    var unit = '';
    var um = /(mhz|khz)$/.exec(s);
    if (um) { unit = um[1]; s = s.slice(0, -unit.length); }
    var n;
    var dots = /^(\d+)\.(\d{3})\.(\d{1,2})$/.exec(s);
    if (dots) n = Number(dots[1]) * 1000 + Number(dots[2]) + Number(dots[3].padEnd(2, '0')) / 100;
    else if (/^\d+(\.\d+)?$/.test(s) || /^\.\d+$/.test(s)) {
      n = Number(s);
      if (unit === 'mhz' || (!unit && n < 1000)) n *= 1000;
    } else return null;
    if (!(n > 0) || n > MAX_KHZ) return null;
    return Math.round(n * 100) / 100;
  }

  function dialKhz(mode, center) {
    var c = Number(center);
    if (!(c > 0)) return null;
    return round1(CENTER_MODES.indexOf(mode) >= 0 ? c - OFFSET_KHZ : c);
  }
  function centerKhz(mode, dial) {
    var d = Number(dial);
    if (!(d > 0)) return null;
    return round1(CENTER_MODES.indexOf(mode) >= 0 ? d + OFFSET_KHZ : d);
  }

  /** The one line under Frequency, before Save. '' until the frequency reads. */
  function dialLine(mode, text) {
    var k = parseFreqKhz(text);
    if (k == null) return '';
    var d = dialKhz(mode, k);
    var f = FreqDots.khzMhz(d);
    return CENTER_MODES.indexOf(mode) >= 0
      ? 'The radio dial will be ' + f + ', 1.5 kHz below the center frequency.'
      : 'The radio dial will be ' + f + '.';
  }

  /** Digipeaters for packet: 0 to 2 calls, separated by spaces or commas. */
  function parseVia(v) {
    var parts = Array.isArray(v) ? v.map(String) : String(v == null ? '' : v).split(/[\s,]+/);
    parts = parts.map(function (p) { return p.trim().toUpperCase(); }).filter(Boolean);
    if (parts.length > MAX_VIA || !parts.every(isCall)) return { ok: false, error: TEXT.via };
    return { ok: true, via: parts };
  }

  /** Printable text only (control characters out, runs of space one space), trimmed. */
  function cleanNote(s) {
    return String(s == null ? '' : s)
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '')
      .replace(/ {2,}/g, ' ')
      .trim();
  }

  function modeAvailable(mode, modes) {
    if (MODES.indexOf(mode) < 0) return false;
    if (!Array.isArray(modes)) return true;
    return modes.some(function (m) { return m && m.id === mode && m.available !== false; });
  }

  /**
   * The form, checked. `form`: { call, mode, freq (as typed), bw, via, note }.
   * `modes`: the station's modes (winlink-state.modes); null skips that check.
   * The entry stores the DIAL, as every favourite does.
   */
  function validate(form, opts) {
    var f = form || {};
    var modes = opts && opts.modes;
    var errors = {};
    var call = String(f.call == null ? '' : f.call).trim().toUpperCase();
    if (!isCall(call)) errors.call = TEXT.call;
    var mode = String(f.mode || '');
    if (!modeAvailable(mode, modes)) errors.mode = TEXT.mode;
    var khz = parseFreqKhz(f.freq);
    if (khz == null) errors.freq = TEXT.freq;
    var bw = 0;
    if (mode === 'ardop' && f.bw != null && String(f.bw) !== '' && String(f.bw) !== '0') {
      bw = Number(f.bw);
      if (ARDOP_BWS.indexOf(bw) < 0) { errors.bw = TEXT.bw; bw = 0; }
    }
    var via = [];
    if (mode === 'packet') {
      var pv = parseVia(f.via);
      if (pv.ok) via = pv.via; else errors.via = pv.error;
    }
    var rawNote = String(f.note == null ? '' : f.note);
    var note = cleanNote(rawNote);
    if (note.length > MAX_NOTE) errors.note = TEXT.note;
    var ok = Object.keys(errors).length === 0;
    var entry = {
      call: call, mode: mode, dialKhz: khz == null ? null : dialKhz(mode, khz),
      centerKhz: khz, mine: true, note: note.slice(0, MAX_NOTE), via: via, bw: bw,
    };
    return { ok: ok, entry: entry, errors: errors };
  }

  function sameGw(a, b) {
    if (!a || !b) return false;
    var ka = Number(a.khz != null ? a.khz : a.dialKhz);
    var kb = Number(b.khz != null ? b.khz : b.dialKhz);
    return String(a.call).toUpperCase() === String(b.call).toUpperCase() && Math.abs(ka - kb) < 0.05;
  }

  /**
   * The gateway list's groups for one mode (and band, '' = all):
   *   mine    the operator's own gateways, their own group above the ranking
   *   ranked  Pat's rows, less any that is a Mine entry (it shows once, as Mine)
   *   missing starred gateways Pat did not list this time
   */
  function pickerGroups(o) {
    var favs = Array.isArray(o && o.favourites) ? o.favourites : [];
    var rows = Array.isArray(o && o.gateways) ? o.gateways : [];
    var mode = o && o.mode;
    var band = (o && o.band) || '';
    var here = favs.filter(function (f) { return f && f.mode === mode && (!band || f.band === band); });
    var mine = here.filter(function (f) { return f.mine === true; });
    var ranked = rows.filter(function (g) { return !mine.some(function (f) { return sameGw(f, g); }); });
    var missing = here.filter(function (f) { return f.mine !== true && !rows.some(function (g) { return sameGw(g, f); }); });
    return { mine: mine, ranked: ranked, missing: missing };
  }

  /** One Mine row: star, call, Mine, dial, then the note (or the via path). */
  function mineLabel(f) {
    var parts = ['★ ' + String(f.call).toUpperCase(), MINE_TAG, FreqDots.khzMhz(f.khz != null ? f.khz : f.dialKhz)];
    if (f.note) parts.push(f.note);
    else if (Array.isArray(f.via) && f.via.length) parts.push('via ' + f.via.join(' '));
    return parts.join('  ');
  }

  return {
    MODES: MODES, CENTER_MODES: CENTER_MODES, ARDOP_BWS: ARDOP_BWS, MAX_NOTE: MAX_NOTE, MAX_VIA: MAX_VIA,
    MINE_GROUP: MINE_GROUP, MINE_TAG: MINE_TAG, TEXT: TEXT,
    isCall: isCall, parseFreqKhz: parseFreqKhz, dialKhz: dialKhz, centerKhz: centerKhz, dialLine: dialLine,
    parseVia: parseVia, cleanNote: cleanNote, validate: validate, pickerGroups: pickerGroups, mineLabel: mineLabel,
    sameGw: sameGw,
  };
});
