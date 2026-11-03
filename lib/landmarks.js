/**
 * Landmarks: signals you can dial into at any time (Casey 2026-10-29, from a
 * Discord thread with N0KAH and KC8DHX: "a new section in Directory for
 * notable things to dial into. Specifically WWV. What else should I add?").
 *
 * The third Directory tab, beside HF Nets and SWL Broadcasts. What sets these
 * rows apart is that most have no schedule: time stations, beacons, weather,
 * calling frequencies and a few famous oddities. Each one carries helper text
 * for someone who has never heard of it: a one-line "what it is" for the row,
 * and What you'll hear / Why it matters / Try this for the station panel.
 *
 * The catalog is data/landmarks.json (edit + push master = every install
 * within a day, the bundled copy is the fallback). `sanitizeCatalog` is the
 * gate both copies pass through: a remote copy with ANY error is refused
 * whole and the last good copy stays, so one typo never empties the tab.
 *
 * The NCDXF/IARU beacon rotation is fixed to the UTC clock (18 beacons, 10 s
 * each, a 3-minute cycle starting at 00:00:00 UTC, every band one beacon
 * behind the band below), so `beaconAt` names the beacon on the air from the
 * clock alone. The same table rides the ECHOCAT wire (`NCDXF`) so the phone
 * never keeps its own copy.
 *
 * Dual-mode: require() in main, window.Landmarks in the renderer (after
 * rig-bands.js), inlined into the ECHOCAT Web page.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./rig-bands'));
  else root.Landmarks = factory(root.RigBands);
})(typeof self !== 'undefined' ? self : this, function (RigBands) {
  'use strict';

  var CATEGORY_IDS = ['time', 'beacon', 'weather', 'calling', 'oddity'];
  var MODES = ['AM', 'FM', 'USB', 'LSB', 'CW'];
  var TEXT_MAX = { name: 60, region: 60, line: 90, hear: 400, why: 400, try: 400 };

  // ── Hours ────────────────────────────────────────────────────────────
  // "24h"  = on all day (Live, always)
  // ""     = no schedule (calling frequencies: no badge)
  // "HH:MM-HH:MM[, HH:MM-HH:MM]"            = daily UTC windows
  // "YYYY-MM-DD HH:MM-HH:MM[; YYYY-MM-DD …]" = dated UTC windows
  var HM = /^([01]?\d|2[0-4]):([0-5]\d)$/;
  function parseHm(s) {
    var m = HM.exec(String(s).trim());
    if (!m) return null;
    var v = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
    return v <= 1440 ? v : null;
  }
  function parseHours(hours) {
    var h = String(hours == null ? '' : hours).trim();
    if (!h) return { kind: 'none' };
    if (/^24\s*h$/i.test(h)) return { kind: 'always' };
    var parts = h.split(/[;,]/).map(function (p) { return p.trim(); }).filter(Boolean);
    var windows = [];
    for (var i = 0; i < parts.length; i++) {
      var m = /^(?:(\d{4})-(\d{2})-(\d{2})\s+)?(\S+)\s*-\s*(\S+)$/.exec(parts[i]);
      if (!m) return null;
      var start = parseHm(m[4]), end = parseHm(m[5]);
      if (start == null || end == null || start === end) return null;
      var date = null;
      if (m[1]) {
        date = Date.UTC(+m[1], +m[2] - 1, +m[3]);
        if (!isFinite(date) || new Date(date).getUTCDate() !== +m[3]) return null;
      }
      windows.push({ date: date, start: start, end: end });
    }
    return { kind: 'windows', windows: windows };
  }

  function fmtLeft(mins) {
    var h = Math.floor(mins / 60), m = mins % 60;
    return h > 0 ? h + 'h ' + m + 'm' : m + 'm';
  }
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /**
   * { status: 'live'|'soon'|'today'|'later'|'none', label, sortKey } for a
   * landmark at `nowMs`. sortKey orders live first, then by minutes until on.
   */
  function status(lm, nowMs) {
    var now = nowMs == null ? Date.now() : nowMs;
    var p = parseHours(lm && lm.hours);
    if (!p || p.kind === 'none') return { status: 'none', label: '', sortKey: 100000 };
    if (p.kind === 'always') return { status: 'live', label: 'On all day', sortKey: -1000 };
    var MIN = 60000, DAY = 86400000;
    var today = Math.floor(now / DAY) * DAY;
    var spans = [];
    p.windows.forEach(function (w) {
      var bases = w.date != null ? [w.date] : [today - DAY, today, today + DAY];
      bases.forEach(function (b) {
        var s = b + w.start * MIN;
        var e = b + (w.end > w.start ? w.end : w.end + 1440) * MIN;
        spans.push([s, e]);
      });
    });
    var next = null;
    for (var i = 0; i < spans.length; i++) {
      var s = spans[i][0], e = spans[i][1];
      if (now >= s && now < e) {
        return { status: 'live', label: 'On air, ' + fmtLeft(Math.ceil((e - now) / MIN)) + ' left', sortKey: -999 };
      }
      if (s > now && (next == null || s < next)) next = s;
    }
    if (next == null) return { status: 'none', label: '', sortKey: 100000 };
    var mins = Math.ceil((next - now) / MIN);
    if (mins <= 60) return { status: 'soon', label: 'in ' + mins + 'm', sortKey: mins };
    if (mins <= 1440) return { status: mins <= 120 ? 'soon' : 'today', label: 'in ' + fmtLeft(mins), sortKey: mins };
    var d = new Date(next);
    return {
      status: 'later',
      label: 'Next: ' + d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()] + ' ' + pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + ' UTC',
      sortKey: mins,
    };
  }

  // ── Bands and receive coverage ───────────────────────────────────────
  var HF_BANDS = ['2200m', '630m', '160m', '80m', '60m', '40m', '30m', '20m', '17m', '15m', '12m', '10m'];
  var LOW_VHF_BANDS = ['6m', '4m'];
  var VHF_BANDS = ['2m', '1.25m'];
  var UHF_BANDS = ['70cm', '33cm'];
  var MICRO_BANDS = ['23cm', '13cm', '9cm', '6cm', '3cm', '1.25cm'];

  function hamBand(khz) {
    return RigBands && RigBands.bandOfMhz ? RigBands.bandOfMhz(Number(khz) / 1000) : '';
  }
  /** The Band column: the ham band, else the part of the spectrum. */
  function bandLabel(khz) {
    var b = hamBand(khz);
    if (b) return b;
    var f = Number(khz);
    if (f < 300) return 'LF';
    if (f >= 530 && f <= 1700) return 'MW';
    if (f < 30000) return 'SW';
    if (f < 300000) return 'VHF';
    if (f < 3000000) return 'UHF';
    return 'SHF';
  }
  function anyOf(rigBands, list) {
    for (var i = 0; i < list.length; i++) if (rigBands.indexOf(list[i]) >= 0) return true;
    return false;
  }
  /**
   * Can the active radio tune this landmark? `rigBands` is the active rig's
   * band list (lib/rig-bands.js; null = not restricted). A landmark inside a
   * ham band needs that band. Outside the ham bands a rig's list says what it
   * TRANSMITS on, not what it receives, so coverage is judged by region: an HF
   * radio receives general coverage below 30 MHz (every current HF rig goes
   * down to 30-100 kHz), a VHF/UHF landmark needs a band in the same region.
   * The VHF split is at 100 MHz: an HF+6 m radio (IC-7300) stops near 74 MHz
   * and must not offer NOAA weather on 162.
   */
  function receivable(lm, rigBands) {
    if (!Array.isArray(rigBands)) return true;
    var f = Number(lm && lm.khz);
    var b = hamBand(f);
    if (b) return rigBands.indexOf(b) >= 0;
    if (f < 30000) return anyOf(rigBands, HF_BANDS);
    if (f < 100000) return anyOf(rigBands, LOW_VHF_BANDS);
    if (f < 300000) return anyOf(rigBands, VHF_BANDS);
    if (f < 1000000) return anyOf(rigBands, UHF_BANDS);
    return anyOf(rigBands, MICRO_BANDS);
  }

  // ── NCDXF / IARU International Beacon Project ────────────────────────
  // Order and sites from ncdxf.org/beacon (VE8AT moved from Eureka to
  // Inuvik). Coordinates are approximate, for a rounded distance only.
  var NCDXF = {
    cycleSec: 180,
    slotSec: 10,
    freqsKhz: [14100, 18110, 21150, 24930, 28200],
    beacons: [
      { call: '4U1UN', place: 'United Nations, New York', lat: 40.75, lon: -73.97 },
      { call: 'VE8AT', place: 'Inuvik, Canada', lat: 68.36, lon: -133.72 },
      { call: 'W6WX', place: 'Mt. Umunhum, California', lat: 37.16, lon: -121.90 },
      { call: 'KH6RS', place: 'Maui, Hawaii', lat: 20.76, lon: -156.24 },
      { call: 'ZL6B', place: 'Masterton, New Zealand', lat: -41.06, lon: 175.60 },
      { call: 'VK6RBP', place: 'Rolystone, Australia', lat: -32.11, lon: 116.05 },
      { call: 'JA2IGY', place: 'Mt. Asama, Japan', lat: 34.46, lon: 136.78 },
      { call: 'RR9O', place: 'Novosibirsk, Russia', lat: 54.98, lon: 82.90 },
      { call: 'VR2B', place: 'Hong Kong', lat: 22.27, lon: 114.15 },
      { call: '4S7B', place: 'Colombo, Sri Lanka', lat: 6.89, lon: 79.86 },
      { call: 'ZS6DN', place: 'Pretoria, South Africa', lat: -25.90, lon: 28.30 },
      { call: '5Z4B', place: 'Kikuyu, Kenya', lat: -1.25, lon: 36.67 },
      { call: '4X6TU', place: 'Tel Aviv, Israel', lat: 32.06, lon: 34.81 },
      { call: 'OH2B', place: 'Lohja, Finland', lat: 60.25, lon: 24.07 },
      { call: 'CS3B', place: 'Madeira, Portugal', lat: 32.82, lon: -17.25 },
      { call: 'LU4AA', place: 'Buenos Aires, Argentina', lat: -34.62, lon: -58.36 },
      { call: 'OA4B', place: 'Lima, Peru', lat: -12.07, lon: -76.95 },
      { call: 'YV5B', place: 'Caracas, Venezuela', lat: 10.42, lon: -66.87 },
    ],
  };

  function beaconBandIndex(khz) {
    var f = Number(khz);
    for (var i = 0; i < NCDXF.freqsKhz.length; i++) if (Math.abs(f - NCDXF.freqsKhz[i]) < 0.5) return i;
    return -1;
  }
  /**
   * Who is sending on an NCDXF frequency at `nowMs`, and who comes next.
   * Slot k of the cycle (k = 0 at 00:00:00, 00:03:00 … UTC) is beacon k on
   * 14100, beacon k-1 on 18110, and so on up the bands.
   */
  function beaconAt(khz, nowMs) {
    var band = beaconBandIndex(khz);
    if (band < 0) return null;
    var now = nowMs == null ? Date.now() : nowMs;
    var n = NCDXF.beacons.length;
    var secOfCycle = (((now / 1000) % NCDXF.cycleSec) + NCDXF.cycleSec) % NCDXF.cycleSec;
    var slot = Math.floor(secOfCycle / NCDXF.slotSec);
    var into = secOfCycle - slot * NCDXF.slotSec;
    var at = function (k) { return NCDXF.beacons[(((slot + k - band) % n) + n) % n]; };
    return {
      now: at(0), next: at(1), after: at(2),
      secondsInto: into, secondsLeft: NCDXF.slotSec - into,
    };
  }

  /** Great-circle distance in km (rounded use only). */
  function distanceKm(lat1, lon1, lat2, lon2) {
    var r = Math.PI / 180;
    var a = Math.sin((lat2 - lat1) * r / 2), b = Math.sin((lon2 - lon1) * r / 2);
    var h = a * a + Math.cos(lat1 * r) * Math.cos(lat2 * r) * b * b;
    return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  // ── The catalog gate ─────────────────────────────────────────────────
  function str(v, max) { return typeof v === 'string' ? v.trim().slice(0, max) : ''; }

  /**
   * Checks and resolves a catalog. Returns { categories, landmarks, errors }:
   * every landmark complete (helpFrom copied in), in file order. A caller
   * that must not show a half-broken list (the remote copy) refuses it when
   * errors is non-empty.
   */
  function sanitizeCatalog(json) {
    var errors = [];
    var cats = [];
    var srcCats = json && Array.isArray(json.categories) ? json.categories : [];
    CATEGORY_IDS.forEach(function (id) {
      var c = srcCats.filter(function (x) { return x && x.id === id; })[0];
      if (!c) { errors.push('category ' + id + ' missing'); return; }
      cats.push({ id: id, label: str(c.label, 40) || id, reason: str(c.reason, 120) });
    });
    srcCats.forEach(function (c) {
      if (c && CATEGORY_IDS.indexOf(c.id) < 0) errors.push('unknown category ' + (c && c.id));
    });

    var src = json && Array.isArray(json.landmarks) ? json.landmarks : null;
    if (!src || !src.length) errors.push('no landmarks');
    var byId = {};
    var out = [];
    (src || []).forEach(function (e, i) {
      var where = 'landmark ' + (e && e.id ? e.id : '#' + i);
      if (!e || typeof e !== 'object') { errors.push(where + ': not an object'); return; }
      var id = str(e.id, 60);
      if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) { errors.push(where + ': bad id'); return; }
      if (byId[id]) { errors.push(where + ': duplicate id'); return; }
      var khz = Number(e.khz);
      if (!isFinite(khz) || khz <= 0 || khz > 30000000) errors.push(where + ': bad khz');
      var mode = String(e.mode || '').toUpperCase();
      if (MODES.indexOf(mode) < 0) errors.push(where + ': bad mode ' + e.mode);
      if (CATEGORY_IDS.indexOf(e.category) < 0) errors.push(where + ': bad category ' + e.category);
      if (!parseHours(e.hours)) errors.push(where + ': bad hours "' + e.hours + '"');
      var name = str(e.name, TEXT_MAX.name);
      if (!name) errors.push(where + ': no name');
      var line = str(e.line, TEXT_MAX.line);
      if (!line) errors.push(where + ': no line');
      var url = str(e.url, 300);
      if (url && !/^https:\/\/[a-z0-9.-]+\.[a-z]{2,}(\/[^\s"'<>]*)?$/i.test(url)) { errors.push(where + ': url must be https'); url = ''; }
      var lm = {
        id: id, name: name, khz: khz, mode: mode, category: e.category,
        hours: str(e.hours, 200), region: str(e.region, TEXT_MAX.region), line: line,
        hear: str(e.hear, TEXT_MAX.hear), why: str(e.why, TEXT_MAX.why), try: str(e.try, TEXT_MAX.try),
        url: url, ncdxf: !!e.ncdxf, helpFrom: str(e.helpFrom, 60),
      };
      if (lm.ncdxf && beaconBandIndex(khz) < 0) errors.push(where + ': ncdxf on a frequency that is not a beacon frequency');
      byId[id] = lm;
      out.push(lm);
    });
    out.forEach(function (lm) {
      if (!lm.helpFrom) {
        if (!lm.hear && !lm.why) errors.push('landmark ' + lm.id + ': no helper text');
        return;
      }
      var from = byId[lm.helpFrom];
      if (!from || from.helpFrom) { errors.push('landmark ' + lm.id + ': helpFrom ' + lm.helpFrom + ' is not a landmark with its own text'); return; }
      if (!lm.hear) lm.hear = from.hear;
      if (!lm.why) lm.why = from.why;
      if (!lm.try) lm.try = from.try;
      if (!lm.url) lm.url = from.url;
    });
    out.forEach(function (lm) { delete lm.helpFrom; });
    return { categories: cats, landmarks: out, errors: errors };
  }

  return {
    CATEGORY_IDS: CATEGORY_IDS, MODES: MODES, NCDXF: NCDXF,
    parseHours: parseHours, status: status,
    hamBand: hamBand, bandLabel: bandLabel, receivable: receivable,
    beaconBandIndex: beaconBandIndex, beaconAt: beaconAt, distanceKm: distanceKm,
    sanitizeCatalog: sanitizeCatalog,
  };
});
