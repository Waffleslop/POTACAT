// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// APRS "Map view" (ECHOCAT handoff 2026-11-22, Casey: "build map view"): the
// internet stations follow the phone's map. A device sends aprs-view
// {n, s, e, w} once a pan or zoom settles; the read-only APRS-IS feed then asks
// for that area with the area filter (aprs-is.net javAPRSFilter.aspx, "Area
// filter": a/latN/lonW/latS/lonE) instead of, or beside, the range filter.
//
//  - parseView: the numbers are checked strictly (finite numbers, latitude
//    within +-90, longitude within +-180, north above south, some width), so
//    nothing else ever reaches the filter string. No fields at all = stop.
//  - w > e: the box crosses the antimeridian; areaTerms gives two terms.
//  - capBox: at most MAX_SIDE_KM (4000 km) on the longest side, centre kept.
//    A world view would otherwise ask APRS-IS for every station on earth.
//    capped: true says it was cut (aprs-state feed.area), so the phone can say
//    "Zoom in for more".
//  - Several devices: one area per device (each capped on its own), at most
//    MAX_VIEWS devices. A union of two phones far apart would be one huge box
//    that the cap would then centre over neither of them.
//
// Pure; lib/aprs-echocat.js keeps the per-device views, lib/aprs-is-feed.js
// builds the filter.

'use strict';

const MAX_SIDE_KM = 4000;
const MAX_VIEWS = 4;
const KM_PER_DEG = 111.32;

const FIELDS = ['n', 's', 'e', 'w'];

const isNum = (v) => typeof v === 'number' && isFinite(v);
const round2 = (v) => { const r = Math.round(v * 100) / 100; return r === 0 ? 0 : r; }; // no -0
/** A longitude into -180..180 (180 stays 180 when asked: an east edge). */
function wrapLon(x, east) {
  let r = ((x + 180) % 360 + 360) % 360 - 180;
  if (east && r === -180) r = 180;
  return r;
}

/** Degrees of longitude the box spans, 0 < span <= 360. */
function lonSpan(b) { return b.w <= b.e ? b.e - b.w : b.e - b.w + 360; }

/**
 * A box from the wire, or null when it is not one. Strict: numbers only (no
 * strings), finite, latitude within +-90, longitude within +-180, n > s, and
 * some width. An east edge of -180 is read as 180 and a west edge of 180 as
 * -180, so the box does not wrap the whole way round by accident.
 */
function validBox(b) {
  if (!b || typeof b !== 'object') return null;
  for (const k of FIELDS) if (!isNum(b[k])) return null;
  const n = round2(b.n), s = round2(b.s);
  let e = round2(b.e), w = round2(b.w);
  if (Math.abs(n) > 90 || Math.abs(s) > 90 || Math.abs(e) > 180 || Math.abs(w) > 180) return null;
  if (!(n > s)) return null;
  if (e === -180) e = 180;
  if (w === 180) w = -180;
  if (w === e) return null;
  return { n, s, e, w };
}

/**
 * aprs-view's fields: { stop: true } when none is given (`{}` stops),
 * { box } for a good box, { bad: true } for anything else (some fields only,
 * a string, out of range).
 */
function parseView(msg) {
  const m = msg && typeof msg === 'object' ? msg : {};
  if (FIELDS.every((k) => m[k] === undefined || m[k] === null)) return { stop: true };
  const box = validBox(m);
  return box ? { box } : { bad: true };
}

/** Same box (to two decimals)? */
function sameBox(a, b) {
  return !!a && !!b && FIELDS.every((k) => round2(a[k]) === round2(b[k]));
}

/**
 * The box cut to at most maxKm on its longest side, centre kept:
 * { n, s, e, w, capped }. Height is measured along a meridian, width along
 * the box's widest parallel (the one nearest the equator). null for a bad box.
 */
function capBox(raw, maxKm) {
  const b = validBox(raw);
  if (!b) return null;
  const max = isNum(maxKm) && maxKm > 0 ? maxKm : MAX_SIDE_KM;
  let { n, s, e, w } = b;
  let capped = false;
  const maxLat = max / KM_PER_DEG;
  if (n - s > maxLat) {
    const c = (n + s) / 2;
    n = Math.min(90, c + maxLat / 2);
    s = Math.max(-90, c - maxLat / 2);
    capped = true;
  }
  const refLat = s <= 0 && n >= 0 ? 0 : Math.min(Math.abs(n), Math.abs(s));
  const cos = Math.cos(refLat * Math.PI / 180);
  const span = lonSpan({ e, w });
  const maxSpan = cos > 1e-9 ? max / (KM_PER_DEG * cos) : Infinity;
  if (span > maxSpan) {
    const c = w + span / 2;
    w = wrapLon(c - maxSpan / 2, false);
    e = wrapLon(c + maxSpan / 2, true);
    capped = true;
  }
  const out = { n: round2(n), s: round2(s), e: round2(e), w: round2(w) };
  if (out.e === -180) out.e = 180;
  if (out.w === 180) out.w = -180;
  out.capped = capped;
  return out;
}

const fmt = (v) => round2(v).toFixed(2);

/**
 * The area filter terms for one box: one, or two when it crosses the
 * antimeridian (w > e). [] for a bad box: nothing unchecked reaches the filter.
 */
function areaTerms(raw) {
  const b = validBox(raw);
  if (!b) return [];
  const term = (w, e) => `a/${fmt(b.n)}/${fmt(w)}/${fmt(b.s)}/${fmt(e)}`;
  if (b.w < b.e) return [term(b.w, b.e)];
  return [term(b.w, 180), term(-180, b.e)];
}

/**
 * What the feed is asked for, from every device's view: { boxes, keepRange },
 * or null with no view. boxes: each capped, duplicates dropped, at most
 * MAX_VIEWS (the most recent last). keepRange: the range term stays beside
 * the areas (the APRS window is open, or a subscribed device has no view).
 */
function feedArea(boxes, keepRange) {
  const out = [];
  for (const raw of Array.isArray(boxes) ? boxes : []) {
    const c = capBox(raw);
    if (!c) continue;
    const box = { n: c.n, s: c.s, e: c.e, w: c.w };
    if (out.some((o) => sameBox(o, box))) continue;
    out.push(box);
  }
  const kept = out.slice(-MAX_VIEWS);
  return kept.length ? { boxes: kept, keepRange: !!keepRange } : null;
}

module.exports = { parseView, validBox, sameBox, capBox, areaTerms, feedArea, lonSpan, MAX_SIDE_KM, MAX_VIEWS, KM_PER_DEG };
