// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// The APRS beacon over APRS-IS (phase 5): the operator's position, sent to the
// internet only. Nothing here keys a radio. Pure; main.js sends the packet
// through the one APRS-IS uplink (lib/aprs-is.js) under a verified login.
//
//   K3ABC-10>APZPCT,TCPIP*:!4142.  N/07239.  W-POTACAT
//
//  - Source: the Settings callsign with SSID -10 (lib/aprs-igate.js
//    uplinkLogin). aprs.org/aprs11/SSIDs.txt: "-10 internet, Igates,
//    echolink, winlink, AVRS, APRN, etc". The beacon is an internet-only
//    station, and -10 is also the uplink's login, so the server sees the
//    packet come from the station that logged in.
//  - Destination (tocall): APZPCT. POTACAT has no registered tocall; APZxxx
//    is the experimental block (the JS8 gateway's APZJS8 is the same kind).
//  - Path: TCPIP*, as for any packet that starts on APRS-IS.
//  - Data: '!' = position without timestamp, no APRS messaging (POTACAT does
//    not take APRS messages) (APRS 1.0.1, chapter 8). The comment follows
//    the symbol code: at most 43 characters, printable ASCII without | or ~
//    (both are reserved in APRS text).
//  - Approximate position (on by default): APRS 1.0.1 chapter 6, position
//    ambiguity: "4903.  N represents latitude to nearest minute", one minute
//    of latitude being one nautical mile. The minutes are cut (never rounded
//    towards the true point) and the same two spaces go in the longitude
//    ("it is permissible but not necessary to include any [space]
//    characters in the longitude"; some parsers refuse a mismatch).
//  - Symbols (APRS 1.0.1 appendix 2, primary table): /- house, /; campground
//    (portable ops), /> car, /[ human (hiker), /s ship (power boat). The
//    window draws them with the phase 1 icons (lib/aprs-symbols.js).
//  - Timer: Off, 10, 20 or 30 minutes. Nothing under 10 minutes, whatever
//    is asked, and a timed beacon never comes sooner than the interval after
//    the last beacon, manual or timed. Picking an interval, or opening the
//    window with one saved, never sends at once (Casey 2026-11-19): the first
//    timed beacon goes one interval after the later of the last beacon and
//    the pick/open. The last beacon's time is kept in settings
//    (aprsBeaconLastAt), so a restart never beacons early.
//
// Dual-mode: require() in main and tests, window.AprsBeacon in the APRS window.
(function (root, factory) {
  const api = factory(typeof require === 'function' ? require : null);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AprsBeacon = api;
})(typeof self !== 'undefined' ? self : this, function (req) {
  'use strict';

  const TOCALL = 'APZPCT';
  const PATH = 'TCPIP*';
  const DEFAULT_COMMENT = 'POTACAT';
  const MAX_COMMENT = 43;
  const AMBIGUITY_SPACES = 2;
  const INTERVALS = [0, 10, 20, 30];
  const MIN_INTERVAL_MIN = 10;
  const MAX_INTERVAL_MIN = 30;
  const SYMBOLS = [
    { id: 'house', table: '/', code: '-', label: 'House', icon: 'house' },
    { id: 'portable', table: '/', code: ';', label: 'Portable', icon: 'other' },
    { id: 'car', table: '/', code: '>', label: 'Car', icon: 'car' },
    { id: 'hiker', table: '/', code: '[', label: 'Hiker', icon: 'hiker' },
    { id: 'boat', table: '/', code: 's', label: 'Boat', icon: 'boat' },
  ];
  // "My APRS SSID" for the radio beacon (Casey 2026-11-19: "shouldn't I be
  // able to change my callsign addendum?"). The meanings are the APRS SSID
  // recommendations (aprs.org/aprs11/SSIDs.txt, 6 Feb 2012), in short words.
  // null (the default) keeps the rule from before the picker: the Settings
  // callsign's own SSID if it has one, else none. The Settings callsign is
  // never changed (logging uses it). The internet beacon stays on the iGate
  // login's -10 (lib/aprs-igate.js uplinkLogin): APRS-IS documents a verified
  // client's packets only for FROMCALL = login (aprs-is.net/q.aspx, qAC).
  const SSID_CHOICES = Object.freeze([
    { ssid: 0, label: 'none: primary or home station' },
    { ssid: 1, label: 'extra station (digi, mobile, weather)' },
    { ssid: 2, label: 'extra station (digi, mobile, weather)' },
    { ssid: 3, label: 'extra station (digi, mobile, weather)' },
    { ssid: 4, label: 'extra station (digi, mobile, weather)' },
    { ssid: 5, label: 'other networks (D-STAR, phone apps)' },
    { ssid: 6, label: 'special activity, satellite, camping' },
    { ssid: 7, label: 'handheld radio' },
    { ssid: 8, label: 'boat, RV or second mobile' },
    { ssid: 9, label: 'primary mobile' },
    { ssid: 10, label: 'internet, iGate' },
    { ssid: 11, label: 'balloon, aircraft, spacecraft' },
    { ssid: 12, label: 'one-way tracker or device' },
    { ssid: 13, label: 'weather station' },
    { ssid: 14, label: 'trucker, full-time driver' },
    { ssid: 15, label: 'extra station (digi, mobile, weather)' },
  ].map(Object.freeze));
  /** A picked SSID 0-15, or null (none picked: the default rule). */
  function cleanSsid(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isInteger(n) && n >= 0 && n <= 15 ? n : null;
  }
  /** BASE or BASE-n (no -0: APRS-IS and AX.25 treat a missing SSID as 0). */
  function withSsid(base, ssid) {
    const b = String(base || '').toUpperCase().replace(/-.*$/, '');
    return ssid > 0 ? b + '-' + ssid : b;
  }

  // Position precision (Casey 2026-11-20, the APRS settings panel). Each is
  // the existing pair of code paths: the grid centre or the point picked on
  // the map, and the approximate (whole-minute) position.
  //   grid4  the centre of the 4-character square (FN20), to the minute
  //   grid6  the centre of the 6-character square (FN20jb), to the minute
  //   exact  the point picked on the map (else the grid centre), to the
  //          hundredth of a minute
  // Not set (null): today's behaviour, unchanged (the picked point if any,
  // else the grid centre; approximate unless turned off).
  const PRECISIONS = Object.freeze(['grid4', 'grid6', 'exact']);
  function cleanPrecision(v) { return PRECISIONS.indexOf(v) >= 0 ? v : null; }
  /** What beaconPosition gets for a precision: grid4/grid6 never use a picked point. */
  function positionInputs({ precision, lat, lon, grid }) {
    const g = String(grid || '');
    if (precision === 'grid4') return { lat: null, lon: null, grid: g.slice(0, 4) };
    if (precision === 'grid6') return { lat: null, lon: null, grid: g };
    return { lat, lon, grid: g };
  }

  const SENTENCES = {
    position: 'Your position is not set. Set a grid square in Settings, or pick a point on the map.',
  };

  function symbolOf(id) { return SYMBOLS.find((s) => s.id === id) || SYMBOLS[0]; }

  function cleanComment(c) {
    if (c === undefined || c === null) return DEFAULT_COMMENT;
    return String(c).replace(/[\r\n\t]+/g, ' ').replace(/[^\x20-\x7e]|[|~]/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_COMMENT);
  }

  /** 0 (off), else 10 to 30 minutes. */
  function intervalMinutes(v) {
    const n = Number(v);
    if (!isFinite(n) || n <= 0) return 0;
    return Math.min(MAX_INTERVAL_MIN, Math.max(MIN_INTERVAL_MIN, Math.round(n)));
  }

  /**
   * ms until the next timed beacon (0 = now), or -1 with the timer off. One
   * interval after the later of the last beacon (lastAt) and the pick or open
   * that started the timer (armedAt); with neither, one interval from now.
   */
  function nextDueMs({ intervalMin, lastAt, armedAt, now }) {
    const min = intervalMinutes(intervalMin);
    if (!min) return -1;
    const from = Math.max(Number(lastAt) || 0, Number(armedAt) || 0) || now;
    return Math.max(0, from + min * 60000 - now);
  }

  /** The last beacon's time from settings (aprsBeaconLastAt): 0 when none, never later than now. */
  function lastBeaconAt(st, now) {
    const t = st && Number(st.aprsBeaconLastAt);
    if (!t || !isFinite(t) || t < 0) return 0;
    return Math.min(t, now);
  }

  function validPoint(lat, lon) {
    return typeof lat === 'number' && typeof lon === 'number' && isFinite(lat) && isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
  }

  /** The point picked on the map when saved and valid, else the Settings grid's centre, else null. */
  function beaconPosition({ lat, lon, grid, gridToLatLon }) {
    if (validPoint(lat, lon)) return { lat, lon, source: 'map' };
    const g = grid && typeof gridToLatLon === 'function' ? gridToLatLon(grid) : null;
    if (g && validPoint(g.lat, g.lon)) return { lat: g.lat, lon: g.lon, source: 'grid' };
    return null;
  }

  // DDMM.mm / DDDMM.mm, rounded to hundredths; with ambiguity the minutes
  // are cut to whole minutes and the hundredths become two spaces.
  function fmt(v, isLat, approx) {
    const hemi = isLat ? (v >= 0 ? 'N' : 'S') : (v >= 0 ? 'E' : 'W');
    const a = Math.abs(v);
    let deg = Math.floor(a);
    let min;
    if (approx) {
      min = Math.floor((a - deg) * 60 + 1e-9);
      if (min >= 60) { deg++; min = 0; }
    } else {
      let hund = Math.round((a - deg) * 6000);
      if (hund >= 6000) { deg++; hund = 0; }
      min = hund / 100;
    }
    const d = String(deg).padStart(isLat ? 2 : 3, '0');
    const m = approx ? String(min).padStart(2, '0') + '.  ' : min.toFixed(2).padStart(5, '0');
    return d + m + hemi;
  }

  function login(settingsCall) {
    const ig = req ? req('./aprs-igate') : null;
    if (ig) return ig.uplinkLogin(settingsCall);
    return { ok: false, reason: 'no-call', sentence: 'Set your callsign in Settings first.' };
  }

  /**
   * The beacon packet, or a refusal: { ok, packet, call } | { ok: false, reason, sentence }.
   * Reasons: no-call, placeholder, invalid (lib/aprs-igate.js uplinkLogin), position.
   */
  function buildBeacon({ settingsCall, lat, lon, symbol, comment, approx }) {
    const l = login(settingsCall);
    if (!l.ok) return { ok: false, reason: l.reason, sentence: l.sentence };
    if (!validPoint(lat, lon)) return { ok: false, reason: 'position', sentence: SENTENCES.position };
    const s = symbolOf(symbol);
    const a = approx === true;
    const packet = `${l.call}>${TOCALL},${PATH}:!${fmt(lat, true, a)}${s.table}${fmt(lon, false, a)}${s.code}${cleanComment(comment)}`;
    return { ok: true, packet, call: l.call };
  }

  /** The beacon's settings with their defaults. */
  function beaconSettings(st) {
    const s = st || {};
    const lat = typeof s.aprsBeaconLat === 'number' ? s.aprsBeaconLat : null;
    const lon = typeof s.aprsBeaconLon === 'number' ? s.aprsBeaconLon : null;
    const ok = validPoint(lat, lon);
    return {
      symbol: symbolOf(s.aprsBeaconSymbol).id,
      comment: cleanComment(s.aprsBeaconComment),
      approx: s.aprsBeaconApprox !== false,
      intervalMin: intervalMinutes(s.aprsBeaconIntervalMin),
      activation: s.aprsBeaconActivation === true, // extra 1: the running activation in the comment (lib/aprs-activation.js), off by default
      rfSsid: cleanSsid(s.aprsRfSsid), // "My APRS SSID" for the radio beacon; null = the Settings call's own SSID, else none
      precision: cleanPrecision(s.aprsBeaconPrecision), // null = today's behaviour (see PRECISIONS)
      lat: ok ? lat : null,
      lon: ok ? lon : null,
    };
  }

  /** A change from the window → the settings keys to save, each cleaned; anything else is dropped. */
  function settingsPatch(p) {
    const o = {};
    const x = p || {};
    if ('symbol' in x && SYMBOLS.some((s) => s.id === x.symbol)) o.aprsBeaconSymbol = x.symbol;
    if ('comment' in x) o.aprsBeaconComment = cleanComment(x.comment === null ? '' : x.comment);
    if ('approx' in x) o.aprsBeaconApprox = x.approx === true;
    // A precision sets the approximate position with it: the grids to the minute, exact not.
    if ('precision' in x && cleanPrecision(x.precision)) { o.aprsBeaconPrecision = x.precision; o.aprsBeaconApprox = x.precision !== 'exact'; }
    if ('intervalMin' in x) o.aprsBeaconIntervalMin = intervalMinutes(x.intervalMin);
    if ('activation' in x) o.aprsBeaconActivation = x.activation === true;
    if ('rfSsid' in x && (x.rfSsid === null || x.rfSsid === '' || cleanSsid(x.rfSsid) !== null)) o.aprsRfSsid = cleanSsid(x.rfSsid);
    if ('lat' in x || 'lon' in x) {
      if (x.lat === null && x.lon === null) { o.aprsBeaconLat = null; o.aprsBeaconLon = null; }
      else if (validPoint(x.lat, x.lon)) {
        o.aprsBeaconLat = Math.round(x.lat * 1e6) / 1e6;
        o.aprsBeaconLon = Math.round(x.lon * 1e6) / 1e6;
      }
    }
    return o;
  }

  /** A packet from the feed that is our own beacon coming back. */
  function isOwnBeacon(p, call) {
    return !!(p && call && String(p.from || '').toUpperCase() === String(call).toUpperCase() && String(p.to || '').toUpperCase() === TOCALL);
  }

  return {
    PRECISIONS, cleanPrecision, positionInputs,
    TOCALL, PATH, DEFAULT_COMMENT, MAX_COMMENT, AMBIGUITY_SPACES, INTERVALS, MIN_INTERVAL_MIN, SYMBOLS, SENTENCES, SSID_CHOICES, cleanSsid, withSsid,
    cleanComment, intervalMinutes, nextDueMs, lastBeaconAt, beaconPosition, buildBeacon, beaconSettings, settingsPatch, isOwnBeacon, validPoint,
  };
});
