// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// The APRS map's arithmetic, kept out of the window so it can be tested:
//
//  - cluster(): a light grid clusterer. Points in screen pixels (at the map's
//    current zoom) fall into square cells; a cell holding two or more becomes
//    one cluster at the members' mean, and clusters whose circles would
//    overlap merge. Linear in the number of points, so a few thousand
//    stations recluster in a millisecond or two. With opts.ring(point), a
//    cluster holding any point it accepts has ring: true (phase 2: a cluster
//    with a station the radio heard draws the heard-by-me ring, Casey
//    2026-11-19).
//  - glide(): where a moving marker is part-way between two fixes, eased, and
//    the short way round the date line.
//  - fade(): 0..1 opacity for a marker that is arriving or leaving.
//  - the view (Casey 2026-11-20): the first open centres on home at a local
//    zoom, about 25 miles (40 km) across (localZoom); after that the map
//    opens where it was left (cleanView/sameView keep settings.aprsMapView
//    tidy; startView picks between the two).
//
// Dual-mode: require() in tests, window.AprsMap in the APRS window.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AprsMap = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * points: [{ x, y, ... }] in pixels. opts: { cell = 60, min = 2, merge = cell * 0.75, ring(point) }.
   * Returns { singles: [point], clusters: [{ x, y, count, members: [point], ring }] }.
   * A cluster's members keep the caller's objects, so a click can fit their bounds.
   */
  function cluster(points, opts) {
    const o = opts || {};
    const cell = o.cell || 60;
    const min = o.min || 2;
    const merge = o.merge != null ? o.merge : cell * 0.75;
    const ringOf = typeof o.ring === 'function' ? o.ring : null;
    const cells = new Map();
    for (const p of points) {
      if (!p || !isFinite(p.x) || !isFinite(p.y)) continue;
      const k = Math.floor(p.x / cell) + ':' + Math.floor(p.y / cell);
      let b = cells.get(k);
      if (!b) { b = []; cells.set(k, b); }
      b.push(p);
    }
    const singles = [];
    let groups = [];
    for (const b of cells.values()) {
      if (b.length < min) { for (const p of b) singles.push(p); continue; }
      let sx = 0, sy = 0, ring = false;
      for (const p of b) { sx += p.x; sy += p.y; if (ringOf && !ring && ringOf(p)) ring = true; }
      groups.push({ x: sx / b.length, y: sy / b.length, count: b.length, members: b, ring });
    }
    // Two clusters either side of a cell edge would sit on top of each other:
    // merge them, the larger absorbing the smaller, until none are that close.
    if (merge > 0 && groups.length > 1) {
      groups.sort((a, b) => b.count - a.count);
      const out = [];
      for (const g of groups) {
        let host = null;
        for (const h of out) {
          const dx = h.x - g.x, dy = h.y - g.y;
          if (dx * dx + dy * dy < merge * merge) { host = h; break; }
        }
        if (!host) { out.push(g); continue; }
        const n = host.count + g.count;
        host.x = (host.x * host.count + g.x * g.count) / n;
        host.y = (host.y * host.count + g.y * g.count) / n;
        host.count = n;
        host.members = host.members.concat(g.members);
        host.ring = host.ring || g.ring;
      }
      groups = out;
    }
    return { singles, clusters: groups };
  }

  /** Smooth start and stop, 0..1 in and out. */
  function ease(t) {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  /** Position part-way (frac 0..1, eased) from {lat, lon} to {lat, lon}. */
  function glide(from, to, frac) {
    const e = ease(frac);
    let dLon = to.lon - from.lon;
    if (dLon > 180) dLon -= 360;
    else if (dLon < -180) dLon += 360;
    let lon = from.lon + dLon * e;
    if (lon > 180) lon -= 360;
    else if (lon < -180) lon += 360;
    return { lat: from.lat + (to.lat - from.lat) * e, lon };
  }

  /** Opacity of a marker that started arriving (or leaving) at t0, over ms. */
  function fade(t0, now, ms, leaving) {
    const f = ms > 0 ? Math.min(1, Math.max(0, (now - t0) / ms)) : 1;
    return leaving ? 1 - f : f;
  }

  // ── clicks: the pin and its label flag (Casey 2026-11-20: "the pin points are
  // clickable (good) but the flags are not") ──────────────────────────────────
  /**
   * The label flag's box beside a pin at (x, y): the same numbers the window
   * draws it with (renderer/aprs-popout.js drawLabel). textW: the text's width.
   */
  function labelBox(x, y, textW, iconPx) {
    return { x: Math.round(x + iconPx / 2 + 4), y: Math.round(y - 9), w: (Number(textW) || 0) + 10, h: 18 };
  }
  /**
   * What a click at pt lands on, from the last frame's hits (drawn order, the
   * last drawn on top). A hit is a circle { x, y, rad } and may carry a label
   * box { box: {x, y, w, h} }; either part counts.
   */
  function hitTest(hits, pt) {
    for (let i = (hits || []).length - 1; i >= 0; i--) {
      const h = hits[i];
      const dx = h.x - pt.x, dy = h.y - pt.y;
      if (dx * dx + dy * dy <= h.rad * h.rad) return h;
      const b = h.box;
      if (b && pt.x >= b.x && pt.x <= b.x + b.w + 1 && pt.y >= b.y && pt.y <= b.y + b.h + 1) return h;
    }
    return null;
  }

  // ── the view: home at a local zoom, then wherever it was left ─────────────
  const LOCAL_KM = 40;          // "about 25 miles across"
  const LOCAL_ZOOM_FALLBACK = 11;
  const MIN_ZOOM = 2, MAX_ZOOM = 17;
  /**
   * The whole zoom at which a map widthPx wide shows about km across at lat
   * (Web Mercator: 156.543 km per pixel at zoom 0 on the equator, times cos(lat)).
   */
  function localZoom(widthPx, lat, km) {
    const w = Number(widthPx), k = Number(km) || LOCAL_KM;
    const c = Math.cos((Number(lat) || 0) * Math.PI / 180);
    if (!(w > 50) || !(c > 0.01)) return LOCAL_ZOOM_FALLBACK;
    const z = Math.round(Math.log2((w * 156.543 * c) / k));
    return Math.min(15, Math.max(5, z));
  }
  /** A saved view { lat, lon, zoom } with sane numbers (lon wrapped, 5 decimals, whole zoom), or null. */
  function cleanView(v) {
    if (!v || typeof v !== 'object') return null;
    const lat = Number(v.lat), lon0 = Number(v.lon), zoom = Number(v.zoom);
    if (!isFinite(lat) || !isFinite(lon0) || !isFinite(zoom)) return null;
    if (Math.abs(lat) > 85.1) return null;
    let lon = ((lon0 + 180) % 360 + 360) % 360 - 180;
    if (lon === -180 && lon0 > 0) lon = 180;
    const r5 = (x) => Math.round(x * 1e5) / 1e5;
    return { lat: r5(lat), lon: r5(lon), zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(zoom))) };
  }
  function sameView(a, b) {
    const x = cleanView(a), y = cleanView(b);
    return !!(x && y && x.lat === y.lat && x.lon === y.lon && x.zoom === y.zoom);
  }
  /**
   * Where the map opens: the saved view; else home at the local zoom; else
   * null (the caller keeps its whole-country view). { lat, lon, zoom, from }.
   */
  function startView({ saved, home, widthPx }) {
    const v = cleanView(saved);
    if (v) return Object.assign(v, { from: 'saved' });
    if (home && isFinite(home.lat) && isFinite(home.lon)) return { lat: home.lat, lon: home.lon, zoom: localZoom(widthPx, home.lat), from: 'home' };
    return null;
  }

  return { cluster, ease, glide, fade, labelBox, hitTest, LOCAL_KM, localZoom, cleanView, sameView, startView };
});
