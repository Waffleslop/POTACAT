// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// "Heard you": who heard my radio beacon (ECHOCAT handoff 2026-11-22, Casey's go).
//
// After a radio beacon the radio reported transmitting, the read-only APRS-IS
// feed stays up for WATCH_MS (15 minutes from the last such beacon) and asks
// for packets FROM the beacon's own source call (a budlist term). When our
// packet comes back:
//   - the call after qAR / qAO / qAr / qAo is an iGate that heard it on RF
//     (aprs-is.net q.aspx; qAC, qAS, qAX, qAI, qAZ are not RF reports);
//   - each path call marked '*' before the q construct is a digipeater that
//     heard and repeated it (generic aliases and calls with no digit skipped).
// A packet from the beacon call that OUR radio heard via a digipeater names
// that digipeater too. Each reporter is followed (budlist) so its next
// position beacon arrives, and stays a reporter for KEEP_MS (60 minutes) after
// it last heard us.
//
// APRS-IS drops duplicates, so each beacon names the FIRST iGate in (plus any
// digipeaters); several beacons collect more. Nothing here transmits or
// writes to APRS-IS: it reads packets the feed already passed.
'use strict';

const WATCH_MS = 15 * 60 * 1000;
const KEEP_MS = 60 * 60 * 1000;
const MAX_CALLS = 10;   // budlist terms for this: the beacon call + up to 9 reporters (beside aprs-find's 10)

const RF_Q = /^qA[ROro]$/;            // qAR, qAO, qAr, qAo: heard on RF by the call that follows
const ALIAS = /^(WIDE|TRACE|RELAY|ECHO|GATE|TEMP)\d*(-\d+)?$/i;
const CALL = /^[A-Z0-9]{3,7}(-[A-Z0-9]{1,2})?$/;

/** A station call worth naming: letters and digits with a digit, not an alias. */
function stationCall(c) {
  const s = String(c || '').toUpperCase().replace(/\*$/, '');
  if (!CALL.test(s) || !/\d/.test(s) || !/[A-Z]/.test(s) || ALIAS.test(s)) return '';
  return s;
}

/**
 * Who heard this packet on RF, from its APRS-IS path.
 * @returns {{igate: string, digis: string[]}} igate '' when the q construct is not an RF report.
 */
function reporters(path) {
  const p = Array.isArray(path) ? path.map(String) : [];
  const qi = p.findIndex((h) => /^q[A-Z][A-Za-z]$/.test(h));
  const before = qi >= 0 ? p.slice(0, qi) : p;
  const digis = [];
  for (const h of before) {
    if (!h.endsWith('*')) continue;
    const c = stationCall(h);
    if (c && digis.indexOf(c) < 0) digis.push(c);
  }
  const igate = qi >= 0 && RF_Q.test(p[qi]) ? stationCall(p[qi + 1]) : '';
  return { igate, digis };
}

/**
 * The watch. opts: now(), watchMs, keepMs, maxCalls.
 *  beaconSent(source)  a confirmed radio beacon from `source`: (re)starts the watch
 *  offer(packet, {ownLogin})  -> [{call, heardMe}] reporters learned from it ([] = none)
 *  heardMe(call)       {at, by, beacons, lastBeaconAt} or null (older than keepMs)
 *  state()             {until, count, lastAt} for aprs-state.beacon.rf.heard
 *  calls()             exact calls for the budlist: the beacon call while watching, then
 *                      reporters still kept, newest first, at most maxCalls in all
 *  active()            the internet watch is on
 *  prune()             drops reporters older than keepMs; returns their calls
 */
function createWatch(opts) {
  const o = opts || {};
  const now = o.now || Date.now;
  const watchMs = o.watchMs || WATCH_MS;
  const keepMs = o.keepMs || KEEP_MS;
  const maxCalls = o.maxCalls || MAX_CALLS;
  let source = '';
  let until = 0;
  let beaconAt = 0;
  let lastAt = 0;
  const heard = new Map(); // call -> {at, by, beacons, lastBeaconAt}

  function active() { return !!source && now() < until; }

  function beaconSent(src) {
    const s = stationCall(src) || String(src || '').toUpperCase();
    if (!/^[A-Z0-9-]{3,10}$/.test(s)) return false;
    source = s;
    beaconAt = now();
    until = beaconAt + watchMs;
    return true;
  }

  function note(call, by, t) {
    const prev = heard.get(call);
    const sameBeacon = prev && prev.lastBeaconAt === beaconAt;
    const h = {
      at: t,
      by: prev && prev.by === 'igate' && by === 'digi' && sameBeacon ? 'igate' : by,
      beacons: (prev ? prev.beacons : 0) + (sameBeacon ? 0 : 1),
      lastBeaconAt: beaconAt,
    };
    heard.set(call, h);
    lastAt = t;
    return { call, heardMe: Object.assign({}, h) };
  }

  function offer(p, { ownLogin } = {}) {
    if (!p || !source || !beaconAt || !active()) return [];
    if (String(p.from || '').toUpperCase() !== source) return [];
    const t = now();
    const own = String(ownLogin || '').toUpperCase();
    const out = [];
    if (p.rf) {
      // Our own radio heard it back: only a used digipeater says anything.
      const d = p.rf.kind === 'digi' ? stationCall(p.rf.digi) : '';
      if (d && d !== own) out.push(note(d, 'digi', t));
      return out;
    }
    const r = reporters(p.path);
    if (r.igate && r.igate !== own) out.push(note(r.igate, 'igate', t));
    for (const d of r.digis) if (d !== own && d !== r.igate) out.push(note(d, 'digi', t));
    return out;
  }

  function fresh(h) { return h && now() - h.at < keepMs; }
  function heardMe(call) {
    const h = heard.get(String(call || '').toUpperCase());
    return fresh(h) ? Object.assign({}, h) : null;
  }

  function prune() {
    const gone = [];
    for (const [c, h] of heard) if (!fresh(h)) { heard.delete(c); gone.push(c); }
    return gone;
  }

  function state() {
    let count = 0;
    for (const h of heard.values()) if (h.lastBeaconAt === beaconAt && fresh(h)) count++;
    return { until: active() ? until : 0, count: beaconAt ? count : 0, lastAt };
  }

  function calls() {
    const out = [];
    if (active()) out.push(source);
    const rows = [...heard].filter(([, h]) => fresh(h)).sort((a, b) => b[1].at - a[1].at);
    for (const [c] of rows) { if (out.length >= maxCalls) break; if (out.indexOf(c) < 0) out.push(c); }
    return out;
  }

  /** The operator switched APRS-IS off: the watch ends now (reporters keep their marks). */
  function stop() { until = 0; }

  return {
    beaconSent, offer, heardMe, state, calls, active, prune, stop,
    get source() { return source; },
    get until() { return active() ? until : 0; },
  };
}

module.exports = { createWatch, reporters, stationCall, WATCH_MS, KEEP_MS, MAX_CALLS };
