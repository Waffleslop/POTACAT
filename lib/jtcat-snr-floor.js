// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// Hunt's signal floor (a POTACAT user, 2026-10-27: "if I know my
// station/antenna has trouble working stations below -20 then don't call
// anyone ... below that signal level. An addition would be to set that level
// by band"). Applied in main.js jtcatWorkableCallers, the one "who can I work"
// check Hunt, the Hunt->Run fallback, mode hopping and Run's pause share, so
// they all agree. A manual double-click always calls: the floor is for the
// automatic answer only.
//
// Settings (per profile, strings so the remote pref path carries them as-is):
//   jtcatHuntMinDb        '' = off, else a whole dB value ('-20')
//   jtcatHuntMinDbByBand  '20m -18, 6m -12' (a band with none uses the default)
'use strict';

const MIN_DB = -30;
const MAX_DB = 20;

function clampDb(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return null;
  return Math.max(MIN_DB, Math.min(MAX_DB, n));
}

/** '' / 'off' -> null; '-20' -> -20 (clamped to -30..+20). */
function parseDefault(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s || /^off$/i.test(s)) return null;
  return clampDb(s.replace(/\s*dB$/i, ''));
}

/**
 * '20m -18, 6m -12' -> { '20m': -18, '6m': -12 }. Separators: comma, semicolon
 * or newline; "20m: -18", "20m=-18" and "20M -18 dB" all read the same.
 * @returns {{ map: object, bad: string[] }} bad = the pieces it could not read
 */
function parseByBand(v) {
  const map = {};
  const bad = [];
  for (const raw of String(v == null ? '' : v).split(/[,;\n]+/)) {
    const part = raw.trim();
    if (!part) continue;
    const m = /^(\d+(?:\.\d+)?)\s*(m|cm)\s*[:=]?\s*([+-]?\d+)\s*(?:db)?$/i.exec(part);
    if (!m) { bad.push(part); continue; }
    const db = clampDb(m[3]);
    if (db == null) { bad.push(part); continue; }
    map[(m[1] + m[2]).toLowerCase()] = db;
  }
  return { map, bad };
}

/** The floor for a band: its own value, else the default, else null (off). */
function floorFor(settings, band) {
  const s = settings || {};
  const b = String(band || '').toLowerCase();
  const byBand = parseByBand(s.jtcatHuntMinDbByBand).map;
  if (b && Object.prototype.hasOwnProperty.call(byBand, b)) return byBand[b];
  return parseDefault(s.jtcatHuntMinDb);
}

/** A decode at `db` may be called under `floor` (null = no floor; no reading = allowed). */
function passes(db, floor) {
  if (floor == null) return true;
  const n = Number(db);
  if (!Number.isFinite(n)) return true;
  return n >= floor;
}

/** Normalise the by-band text for display ("20m -18, 6m -12"). */
function formatByBand(map) {
  return Object.keys(map || {}).map((b) => `${b} ${map[b]}`).join(', ');
}

const api = { MIN_DB, MAX_DB, parseDefault, parseByBand, floorFor, passes, formatByBand };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.JtcatSnrFloor = api;
