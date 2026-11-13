// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// How each sent Winlink message went out (#442): the gateway, dial and mode,
// or the internet, and when.
//
// Pat moves a message from out/ to sent/ when a session delivers it, and
// records nothing about the route. POTACAT knows the session, so when one
// ends it notes which messages left the Outbox in it: a message that was in
// the Outbox when the session started, is no longer there, and is now in
// Sent. Each gets one record, kept by message id in one small file in the
// profile's Winlink folder, beside session-summaries.json: sent-routes.json.
//
// Keyed by message id, so Archive and Deleted (which keep the id) still show
// it. A message sent before this existed has no record and shows nothing:
// nothing is guessed.
//
//   sentThisSession({outBefore, outAfter, sentAfter})   the ids this session sent
//   makeRoute(session, sentAtMs)    one record: {mode, transport, gateway?, dialKhz?, sentAt}
//   record(map, mids, route)        the map with these ids added, within MAX
//   clean(raw) / load(file) / save(file, map)   the file, whole or not at all
//   get(map, mid)                   one id's record, or null
//
// Bounded: at most MAX records (the oldest sent go first), about 120 bytes
// each, so the file stays under about 250 kB.

'use strict';

const fs = require('fs');
const path = require('path');

const FILE_NAME = 'sent-routes.json';
const VERSION = 1;
const MAX = 2000;
const MID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const RADIO_MODES = ['ardop', 'packet', 'mercury', 'vara', 'varafm'];
const MODES = ['telnet'].concat(RADIO_MODES);

function fileIn(dir) {
  return path.join(String(dir || ''), FILE_NAME);
}

function mids(list) {
  const out = [];
  for (const m of Array.isArray(list) ? list : []) {
    const id = m && typeof m === 'object' ? m.mid : m;
    if (typeof id === 'string' && MID_RE.test(id)) out.push(id);
  }
  return out;
}

/**
 * The messages a session sent: in the Outbox when it started, gone from the
 * Outbox when it ended, and in Sent now. A message deleted from the Outbox
 * during the session is not in Sent, so it is not counted. Each list may be
 * Pat's message rows or bare ids. Without the Outbox from before, nothing.
 * @returns {string[]}
 */
function sentThisSession({ outBefore, outAfter, sentAfter } = {}) {
  if (!Array.isArray(outBefore) || !Array.isArray(sentAfter)) return [];
  const still = new Set(mids(outAfter));
  const sent = new Set(mids(sentAfter));
  const seen = new Set();
  const out = [];
  for (const id of mids(outBefore)) {
    if (seen.has(id) || still.has(id) || !sent.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** One record, or null when the session is not one that can send (no mode, no time). */
function makeRoute(session, sentAtMs) {
  const s = session || {};
  const mode = String(s.mode || '');
  const t = Number(sentAtMs);
  if (!MODES.includes(mode) || !Number.isFinite(t) || t <= 0) return null;
  const sentAt = new Date(t).toISOString();
  if (mode === 'telnet') return { mode, transport: 'internet', sentAt };
  const r = { mode, transport: 'radio', sentAt };
  const gw = String(s.gateway || '').trim().toUpperCase();
  if (/^[A-Z0-9/-]{3,20}$/.test(gw)) r.gateway = gw;
  const khz = Number(s.dialKhz);
  if (Number.isFinite(khz) && khz > 0) r.dialKhz = Math.round(khz * 100) / 100;
  return r;
}

/** One record as it may be kept, or null. Anything else is dropped, never repaired. */
function cleanRoute(r) {
  if (!r || typeof r !== 'object') return null;
  const t = new Date(r.sentAt).getTime();
  if (!Number.isFinite(t) || t <= 0) return null;
  return makeRoute(r, t);
}

/** A map {mid: record} as it may be kept: whole records, valid ids, the newest MAX. */
function clean(raw) {
  const rows = [];
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const id of Object.keys(raw)) {
      if (!MID_RE.test(id)) continue;
      const r = cleanRoute(raw[id]);
      if (r) rows.push([id, r]);
    }
  }
  rows.sort((a, b) => new Date(b[1].sentAt) - new Date(a[1].sentAt));
  const out = {};
  for (const [id, r] of rows.slice(0, MAX)) out[id] = r;
  return out;
}

/** The map with each of `ids` given `route` (a record already kept for an id is replaced). */
function record(map, ids, route) {
  const r = cleanRoute(route);
  const next = { ...(map || {}) };
  if (!r) return clean(next);
  for (const id of mids(ids)) next[id] = { ...r };
  return clean(next);
}

/** One id's record, or null. */
function get(map, mid) {
  if (!map || typeof mid !== 'string' || !MID_RE.test(mid)) return null;
  return Object.prototype.hasOwnProperty.call(map, mid) ? cleanRoute(map[mid]) : null;
}

/** The records kept in `file`. {} when there is no file, or it cannot be read as one. */
function load(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!j || typeof j !== 'object' || j.v !== VERSION) return {};
    return clean(j.routes);
  } catch { return {}; }
}

/**
 * Write `map` to `file`, whole or not at all (a temporary file, then a
 * rename), so a crash mid-write never leaves half a file.
 * @returns {boolean} written
 */
function save(file, map) {
  const tmp = `${file}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ v: VERSION, routes: clean(map) }));
    fs.renameSync(tmp, file);
    return true;
  } catch {
    try { fs.unlinkSync(tmp); } catch {}
    return false;
  }
}

module.exports = { FILE_NAME, VERSION, MAX, fileIn, sentThisSession, makeRoute, clean, record, get, load, save };
