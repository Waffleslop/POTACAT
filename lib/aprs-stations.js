// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// The APRS window's station list: parsed packets (lib/aprs-parser.js) in, one
// row per station or object out, with distance and bearing from home, sorted
// and searched. Stations not heard for an hour leave the list.
//
//  - a station is keyed by its callsign; an object or item by its name, so a
//    net's "LEADER" object is one row however many stations send it.
//  - a killed object or item leaves at once.
//  - a status packet (no position) updates the station's status line but
//    never adds a row: a row needs a place on the map.
//  - messages are parsed only (phase 1) and change nothing here.
//  - each row carries its icon (lib/aprs-symbols.js) as r.cls.
//  - phase 2: a packet the radio heard carries `rf: {kind, digi}` (lib/aprs-rf-frames.js).
//    The row keeps both marks: `isHeard` (time APRS-IS last reported it) and
//    `rf` ({kind: 'direct'|'digi', digi, lastHeard, packets}); a station seen
//    both ways is one row. list({heardByMe: true}) shows only rows with `rf`.
//
// Dual-mode: require() in tests, window.AprsStations in the APRS window.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AprsStations = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MAX_AGE_MS = 60 * 60 * 1000;
  const toRad = (d) => d * Math.PI / 180;

  function distanceKm(lat1, lon1, lat2, lon2) {
    const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function bearingDeg(lat1, lon1, lat2, lon2) {
    const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
    const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }

  const POINTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  function compass(deg) {
    if (deg == null || !isFinite(deg)) return '';
    return POINTS[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
  }

  /** "now", "4 min", "1 h 5 min". */
  function formatAge(ms) {
    const m = Math.floor(Math.max(0, ms) / 60000);
    if (m < 1) return 'now';
    if (m < 60) return m + ' min';
    const h = Math.floor(m / 60);
    return h + ' h' + (m % 60 ? ' ' + (m % 60) + ' min' : '');
  }

  function stationKey(p) {
    return (p.type === 'object' || p.type === 'item') && p.name ? 'obj:' + p.name.toUpperCase() : p.from;
  }

  function iconOf(p) {
    const Y = (typeof module === 'object' && module.exports) ? require('./aprs-symbols') : (typeof self !== 'undefined' ? self.AprsSymbols : null);
    return Y ? Y.iconFor(p.symbolTable, p.symbol) : 'other';
  }

  /**
   * The rows a scrolled list needs to draw: with every row rowH tall, a view
   * viewH tall scrolled to scrollTop over total rows, plus overscan either
   * side. Returns { start, end (exclusive), top, bottom } where top and bottom
   * are the heights of the empty space above and below the drawn rows.
   */
  function visibleRange(scrollTop, viewH, rowH, total, overscan) {
    const n = Math.max(0, total | 0);
    const h = rowH > 0 ? rowH : 1;
    const extra = overscan == null ? 8 : Math.max(0, overscan | 0);
    let start = Math.floor(Math.max(0, scrollTop) / h) - extra;
    let end = Math.ceil((Math.max(0, scrollTop) + Math.max(0, viewH)) / h) + extra;
    start = Math.max(0, Math.min(start, n));
    end = Math.max(start, Math.min(end, n));
    return { start, end, top: start * h, bottom: (n - end) * h };
  }

  /** Note how this packet arrived on the row: the radio (p.rf) or APRS-IS. */
  function markSource(r, p, t) {
    if (p.rf) {
      const prev = r.rf;
      r.rf = { kind: p.rf.kind === 'digi' ? 'digi' : 'direct', digi: p.rf.digi || '', lastHeard: t, packets: (prev ? prev.packets : 0) + 1 };
    } else {
      r.isHeard = t;
    }
  }

  function createStore(opts) {
    const o = opts || {};
    const maxAge = o.maxAgeMs || MAX_AGE_MS;
    const now = o.now || Date.now;
    const rows = new Map();
    let home = o.home || null;

    function measure(r) {
      if (home && r.lat != null) {
        r.distanceKm = distanceKm(home.lat, home.lon, r.lat, r.lon);
        r.bearing = bearingDeg(home.lat, home.lon, r.lat, r.lon);
      } else { r.distanceKm = null; r.bearing = null; }
    }

    /** Add one parsed packet. Returns the row it changed, or null. */
    function add(p) {
      if (!p || !p.from) return null;
      const key = stationKey(p);
      const t = now();
      if ((p.type === 'object' || p.type === 'item') && p.live === false) { rows.delete(key); return null; }
      const existing = rows.get(key);
      if (p.type === 'status') {
        if (!existing) return null;
        existing.status = p.status;
        existing.lastHeard = t;
        existing.packets++;
        markSource(existing, p, t);
        return existing;
      }
      if (p.lat == null || p.lon == null) return null;
      const r = existing || { key, packets: 0, status: '', rf: null, isHeard: null };
      r.call = p.from;
      r.name = (p.type === 'object' || p.type === 'item') ? p.name : '';
      r.label = r.name || p.from;
      r.type = p.type;
      r.lat = p.lat; r.lon = p.lon;
      r.symbolTable = p.symbolTable; r.symbol = p.symbol;
      r.cls = iconOf(p);
      r.comment = p.comment || '';
      r.course = p.course; r.speed = p.speed; r.altitude = p.altitude;
      r.weather = p.weather || null;
      r.micEMessage = p.micEMessage || null;
      r.igate = p.igate || null;
      r.path = p.path || [];
      r.raw = p.raw;
      r.lastHeard = t;
      r.packets++;
      markSource(r, p, t);
      measure(r);
      rows.set(key, r);
      return r;
    }

    /** Drop rows older than an hour; returns the keys removed. */
    function prune() {
      const cut = now() - maxAge;
      const gone = [];
      for (const [k, r] of rows) if (r.lastHeard < cut) { rows.delete(k); gone.push(k); }
      return gone;
    }

    const SORTS = {
      call: (a, b) => a.label.localeCompare(b.label),
      distance: (a, b) => (a.distanceKm == null ? 1e9 : a.distanceKm) - (b.distanceKm == null ? 1e9 : b.distanceKm),
      bearing: (a, b) => (a.bearing == null ? 999 : a.bearing) - (b.bearing == null ? 999 : b.bearing),
      age: (a, b) => b.lastHeard - a.lastHeard,
      comment: (a, b) => (a.comment || a.status || '').localeCompare(b.comment || b.status || ''),
      symbol: (a, b) => a.cls.localeCompare(b.cls) || a.label.localeCompare(b.label),  // by icon
    };

    /** Rows matching the search (callsign, name or comment), sorted. */
    function list(q) {
      const opt = q || {};
      const needle = String(opt.query || '').trim().toUpperCase();
      let out = [...rows.values()];
      if (opt.heardByMe) out = out.filter((r) => !!r.rf);
      if (needle) {
        out = out.filter((r) => r.label.toUpperCase().includes(needle) || r.call.toUpperCase().includes(needle)
          || (r.comment || '').toUpperCase().includes(needle) || (r.status || '').toUpperCase().includes(needle));
      }
      const cmp = SORTS[opt.sort] || SORTS.distance;
      out.sort(cmp);
      if (opt.desc) out.reverse();
      return out;
    }

    return {
      add, prune, list,
      get: (k) => rows.get(k) || null,
      setHome(h) { home = h; for (const r of rows.values()) measure(r); },
      clear() { rows.clear(); },
      get size() { return rows.size; },
    };
  }

  return { createStore, distanceKm, bearingDeg, compass, formatAge, stationKey, visibleRange, MAX_AGE_MS };
});
