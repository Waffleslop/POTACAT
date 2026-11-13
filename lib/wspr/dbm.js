// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// The power a WSPR beacon REPORTS in its message, in dBm (GitHub #268).
//
// WSPR carries the sender's power as dBm, and the protocol only allows values
// ending in 0, 3 or 7, from 0 dBm (1 mW) to 60 dBm (1 kW). Each one stands for
// a round wattage: 30 = 1 W, 33 = 2 W, 37 = 5 W, 40 = 10 W, and so on.
//
// Until 2026-11-13 the beacon reported at most 30 dBm, because it was always
// held at 1 W. Since #268 the operator can run the beacon at the power they
// set (5 W on an IC-7100 at 2 m, where 1 W makes nothing), and a 5 W beacon
// that says "1 W" on WSPRnet gives everyone wrong numbers. So by default the
// report follows the beacon's own RF power: the highest WSPR value whose
// wattage is not above it (5 W -> 37, 4 W -> 33, 1 W -> 30). The operator can
// still pick a fixed value (Auto off), which is reported as chosen.
//
// Dual-mode like stats.js: Node `require()` gets module.exports; the JTCAT
// pop-out loads it with <script> and ECHOCAT Web has it inlined by
// remote-server, both as window.WsprDbm. No DOM or Node dependencies.
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WsprDbm = api;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MIN_DBM = 0;
  var MAX_DBM = 60;
  var DEFAULT_DBM = 30; // 1 W, the beacon's default power

  // 0, 3, 7, 10, 13, 17 ... 60: every value the protocol allows.
  var LEVELS = [];
  for (var d = MIN_DBM; d <= MAX_DBM; d++) {
    var u = d % 10;
    if (u === 0 || u === 3 || u === 7) LEVELS.push(d);
  }

  function isValid(dbm) {
    return typeof dbm === 'number' && LEVELS.indexOf(dbm) !== -1;
  }

  /** The round wattage a WSPR value stands for: 30 -> 1, 33 -> 2, 37 -> 5. */
  function nominalWatts(dbm) {
    var n = Number(dbm);
    if (!Number.isFinite(n)) return NaN;
    var decade = Math.floor(n / 10);
    var u = n - decade * 10;
    var mant = u === 3 ? 2 : u === 7 ? 5 : u === 0 ? 1 : Math.pow(10, u / 10);
    return mant * Math.pow(10, decade - 3);
  }

  /** The highest WSPR value whose wattage is not above `watts`. Below 1 mW
   *  (or no usable number) it is 0 dBm, the lowest the protocol has. */
  function dbmForWatts(watts) {
    var w = Number(watts);
    if (!(Number.isFinite(w) && w > 0)) return MIN_DBM;
    var best = MIN_DBM;
    for (var i = 0; i < LEVELS.length; i++) {
      // A hair of tolerance so 5 W is 37 dBm, not 33 (37 dBm is 5.01 W).
      if (nominalWatts(LEVELS[i]) <= w * (1 + 1e-9)) best = LEVELS[i];
    }
    return best;
  }

  /** An operator's fixed choice as a WSPR value: the highest valid value not
   *  above it, inside 0..60. A saved value from before (always 0..30, and
   *  always valid) comes through unchanged. */
  function normalizeManual(dbm) {
    var n = Number(dbm);
    if (!Number.isFinite(n)) return DEFAULT_DBM;
    n = Math.max(MIN_DBM, Math.min(MAX_DBM, Math.floor(n)));
    for (var i = LEVELS.length - 1; i >= 0; i--) if (LEVELS[i] <= n) return LEVELS[i];
    return MIN_DBM;
  }

  /** Auto is the default; only an explicit false (the operator picked a
   *  fixed value) turns it off. */
  function isAuto(flag) {
    return flag !== false;
  }

  /** The dBm the beacon puts in its message. */
  function reportedDbm(o) {
    o = o || {};
    if (isAuto(o.auto)) return dbmForWatts(o.beaconWatts);
    return normalizeManual(o.manualDbm != null ? o.manualDbm : DEFAULT_DBM);
  }

  /**
   * One beacon control message (pop-out IPC or the ECHOCAT wire) applied to
   * the saved choice {auto, dbm}. Returns the new {auto, dbm}.
   *   dBmAuto true  -> Auto
   *   dBmAuto false -> fixed, at dBm when given
   *   dBm alone     -> fixed at dBm (the operator picked a value)
   *   dBm riding an on/off toggle with no dBmAuto -> a client from before Auto
   *     repeating what its menu shows; it never turns Auto off.
   */
  function applyControl(cur, msg) {
    cur = cur || {};
    msg = msg || {};
    var next = { auto: isAuto(cur.auto), dbm: cur.dbm != null ? normalizeManual(cur.dbm) : DEFAULT_DBM };
    var hasDbm = msg.dBm != null && msg.dBm !== '' && Number.isFinite(Number(msg.dBm));
    if (msg.dBmAuto === true) { next.auto = true; return next; }
    if (msg.dBmAuto === false) {
      next.auto = false;
      if (hasDbm) next.dbm = normalizeManual(msg.dBm);
      return next;
    }
    if (!hasDbm) return next;
    if (msg.enabled !== undefined && msg.enabled !== null) {
      if (!next.auto) next.dbm = normalizeManual(msg.dBm);
      return next;
    }
    next.auto = false;
    next.dbm = normalizeManual(msg.dBm);
    return next;
  }

  /**
   * Audio drive for a frame, 0.05..1. Auto reports what the radio is set to,
   * so the drive stays full. A fixed value below the radio's power turns the
   * drive down toward it (power goes as amplitude squared), as the beacon
   * always did for milliwatt reports; the radio's power setting is the real
   * limit and this is secondary.
   */
  function driveScale(o) {
    o = o || {};
    if (isAuto(o.auto)) return 1;
    var bw = Number(o.beaconWatts);
    var rw = nominalWatts(o.reportedDbm);
    if (!(bw > 0) || !(rw > 0)) return 1;
    return Math.max(0.05, Math.min(1, Math.sqrt(rw / bw)));
  }

  /** "1 W", "5 W", "200 mW", "1 kW". */
  function formatWatts(w) {
    var n = Number(w);
    if (!(Number.isFinite(n) && n > 0)) return '';
    if (n >= 1000) return trim(n / 1000) + ' kW';
    if (n >= 1) return trim(n) + ' W';
    return trim(n * 1000) + ' mW';
  }
  function trim(n) {
    return String(Math.round(n * 10) / 10);
  }

  /** "37 dBm (5 W)" */
  function label(dbm) {
    return dbm + ' dBm (' + formatWatts(nominalWatts(dbm)) + ')';
  }

  /**
   * The Reported menu, the same in the JTCAT window and ECHOCAT Web, from the
   * host's beacon state {dBmAuto, dBm}: Auto first, naming the value it
   * reports now, then every WSPR value 0..60 dBm.
   * @returns {{options: Array<{value:string,text:string}>, value: string}}
   */
  function menu(state) {
    state = state || {};
    var auto = isAuto(state.dBmAuto);
    var now = state.dBm != null && Number.isFinite(Number(state.dBm)) ? normalizeManual(state.dBm) : null;
    var options = [{ value: 'auto', text: auto && now != null ? 'Auto: ' + label(now) : 'Auto' }];
    for (var i = 0; i < LEVELS.length; i++) options.push({ value: String(LEVELS[i]), text: label(LEVELS[i]) });
    return { options: options, value: auto ? 'auto' : String(now != null ? now : DEFAULT_DBM) };
  }

  /** What a pick in that menu sends: {dBmAuto: true} or {dBmAuto: false, dBm}. */
  function controlFromMenu(value) {
    if (value === 'auto') return { dBmAuto: true };
    return { dBmAuto: false, dBm: normalizeManual(value) };
  }

  return {
    MIN_DBM: MIN_DBM, MAX_DBM: MAX_DBM, DEFAULT_DBM: DEFAULT_DBM, LEVELS: LEVELS,
    isValid: isValid, nominalWatts: nominalWatts, dbmForWatts: dbmForWatts,
    normalizeManual: normalizeManual, isAuto: isAuto, reportedDbm: reportedDbm,
    applyControl: applyControl, driveScale: driveScale, formatWatts: formatWatts, label: label,
    menu: menu, controlFromMenu: controlFromMenu,
  };
}));
