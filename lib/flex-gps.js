// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// A FlexRadio's GPS, read only. After `sub gps all` the radio sends status
// lines on the API connection POTACAT already holds:
//
//   S<handle>|gps lat=0#lon=0#grid=#altitude=0 m#tracked=0#visible=12#speed=0 kts#freq_error=0 ppb#status=Warming Up#time=04:49:39Z#track=0.0
//   S<handle>|gps gnss_powered_ant=false
//
// (FLEX-8600M, 2026-11-20.) The pairs are separated by '#', not spaces, and a
// value may hold spaces ("0 m", "Warming Up"). A later line carries only the
// keys that changed, so each line is merged into the state before it.
// FlexLib 1.6.17 Radio.cs (ParseGPSStatus) reads lat, lon, grid, altitude,
// tracked, visible, speed, freq_error, status and time; it keeps every value
// as the radio's text and documents no status words for a lock.
//
// Installed: FlexLib sets GPSInstalled from the `info` reply, gps=<value>,
// false when the value is "Not Present". Here a GPS also counts as installed
// once the radio sends a gps status whose status is not "Not Present".
//
// The fix rule (FlexLib names no "locked" status): a fix is at least 4
// satellites tracked and a latitude and longitude that are numbers, in range
// and not 0. A position of 0,0 is never a fix.
'use strict';

const { latLonToGrid } = require('./grid');

const MIN_TRACKED = 4;
const NOT_PRESENT = 'not present';

/** The '#'-separated pairs of a gps status body as { key: text }; a value keeps its spaces. */
function parseGpsBody(body) {
  const out = {};
  for (const part of String(body || '').split('#')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    if (!key) continue;
    out[key] = part.slice(eq + 1).trim();
  }
  return out;
}

/** The gps body of a status line (`S<h>|gps ...`), or null when the line is not a gps status. */
function gpsBodyOf(line) {
  const m = /^S[0-9A-Fa-f]*\|gps(?:\s+(.*))?$/.exec(String(line || '').replace(/\r?\n$/, ''));
  return m ? (m[1] || '') : null;
}

/** The `info` reply's gps value (FlexLib UpdateInfo: comma-separated key=value, quotes trimmed), or null. */
function infoGpsValue(payload) {
  for (const kv of String(payload || '').split(',')) {
    const eq = kv.indexOf('=');
    if (eq <= 0) continue;
    if (kv.slice(0, eq).trim() === 'gps') return kv.slice(eq + 1).trim().replace(/^[\\"]+|[\\"]+$/g, '');
  }
  return null;
}

function num(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = parseFloat(String(v));
  return isFinite(n) ? n : null;
}

function cleanGrid(g) {
  const s = String(g || '').trim();
  if (!/^[A-Ra-r]{2}[0-9]{2}([A-Xa-x]{2})?/.test(s)) return '';
  const six = s.slice(0, 6);
  return six.slice(0, 2).toUpperCase() + six.slice(2, 4) + six.slice(4, 6).toLowerCase();
}

function validFixPoint(lat, lon) {
  return lat !== null && lon !== null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && lat !== 0 && lon !== 0;
}

/**
 * The GPS state from the merged raw pairs (and the info reply's gps value):
 * { installed, fix, lat, lon, grid, altitude, tracked, visible, status, time, antennaPowered }.
 */
function gpsState(raw, infoGps) {
  const r = raw || {};
  const status = r.status !== undefined ? String(r.status) : '';
  const notPresent = status.toLowerCase() === NOT_PRESENT || String(infoGps || '').toLowerCase() === NOT_PRESENT;
  const heard = Object.keys(r).length > 0;
  const installed = !notPresent && (heard || (infoGps !== null && infoGps !== undefined && infoGps !== ''));
  const lat = num(r.lat);
  const lon = num(r.lon);
  const tracked = num(r.tracked);
  const visible = num(r.visible);
  const fix = installed && tracked !== null && tracked >= MIN_TRACKED && validFixPoint(lat, lon);
  // The radio's grid when it gives all 6 characters, else one from the fix; no fix, no grid.
  let grid = '';
  if (fix) {
    grid = cleanGrid(r.grid);
    if (grid.length < 6) grid = cleanGrid(latLonToGrid(lat, lon));
  }
  const ant = r.gnss_powered_ant;
  return {
    installed,
    fix,
    lat: fix ? lat : null,
    lon: fix ? lon : null,
    grid,
    altitude: r.altitude !== undefined ? String(r.altitude) : '',
    tracked: tracked === null ? 0 : Math.round(tracked),
    visible: visible === null ? 0 : Math.round(visible),
    status,
    time: r.time !== undefined ? String(r.time) : '',
    antennaPowered: ant === undefined ? null : /^(1|true|yes)$/i.test(String(ant)),
  };
}

/**
 * The tracker: feed it every status line (and the info reply); it keeps the
 * merged pairs and says whether the state changed.
 */
function createGpsTracker() {
  let raw = {};
  let infoGps = null;
  let last = null;
  const api = {
    /** A radio line; true when it was a gps status. */
    line(l) {
      const body = gpsBodyOf(l);
      if (body === null) return false;
      raw = Object.assign({}, raw, parseGpsBody(body));
      return true;
    },
    /** The `info` reply payload. */
    info(payload) { infoGps = infoGpsValue(payload); },
    state() { return gpsState(raw, infoGps); },
    /** The state when it differs from the last one taken this way, else null. The clock alone is no change. */
    changed() {
      const s = api.state();
      const k = JSON.stringify(Object.assign({}, s, { time: '' }));
      if (k === last) return null;
      last = k;
      return s;
    },
    reset() { raw = {}; infoGps = null; last = null; },
  };
  return api;
}

/** One line for people: "Warming Up, 0 of 12 satellites". */
function statusLine(s) {
  if (!s || !s.installed) return 'No GPS in this radio';
  const words = s.status || (s.fix ? 'Fix' : 'No fix');
  return `${words}, ${s.tracked || 0} of ${s.visible || 0} satellites`;
}

module.exports = { MIN_TRACKED, parseGpsBody, gpsBodyOf, infoGpsValue, gpsState, createGpsTracker, statusLine, cleanGrid };
