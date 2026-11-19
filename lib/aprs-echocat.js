// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// APRS on the phone through the desktop (phase 6): what an ECHOCAT client
// that lists the capability `aprs` gets, and what it may ask for.
//
//  - aprs-stations: a snapshot when the client subscribes (chunked by bytes,
//    like worked-qsos), then deltas batched every 1.5 s: add, update and gone
//    (aged out after an hour, or a killed object). Rows come from the same
//    store the APRS window keeps (lib/aprs-stations.js), cut to the fields a
//    phone draws (slimStation).
//  - aprs-state: the feed's link, "Listen on my radio", the iGate and the
//    internet beacon, the same payloads the APRS window gets, coalesced to
//    at most one message every 500 ms.
//  - aprs-subscribe / aprs-listen / aprs-igate / aprs-beacon-is go to the
//    desktop's own functions (deps), the ones the APRS window and Settings
//    call, so every gate and every refusal sentence is the window's.
//
// The feed runs while the APRS window is open OR a client is subscribed.
// Listening a client turned on stops when that client leaves, unless the APRS
// window is open (then the window's rule applies: closing it stops listening).
// A Guest Pass may watch and listen, never beacon or change the iGate: both
// go out under the owner's callsign. Listening a guest turned on never gates
// (guestListening), so a guest cannot put the owner's iGate to work either.
//
// No radio beacon here: that is phase 7 and is not on the wire.
'use strict';

const Stations = require('./aprs-stations');

const FLUSH_MS = 1500;
const STATE_MS = 500;
const PRUNE_IDLE_MS = 60 * 1000;   // the store ages out at least this often with nobody subscribed
const CHUNK_BYTES = 200 * 1024;
const BANDS = ['2m', '30m'];

const PassWording = require('./pass-wording');
// What a Guest Pass may not ask for here: both act under the owner's callsign.
// remote-server refuses them at the wall (lib/guest-pass-authority.js) with
// the sentence from lib/pass-wording.js; handle() refuses them a second time.
const GUEST_REFUSED = new Set(['aprs-beacon-is', 'aprs-igate']);

/** The fields a phone draws for one station row (lib/aprs-stations.js row). */
function slimStation(r) {
  const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
  return {
    key: r.key,
    call: r.call,
    label: r.label || r.call,
    type: r.type || 'position',
    lat: num(r.lat), lon: num(r.lon),
    symbol: (r.symbolTable || '') + (r.symbol || ''),
    cls: r.cls || 'other',
    course: num(r.course), speed: num(r.speed), altitude: num(r.altitude),
    comment: r.comment || '',
    status: r.status || '',
    lastHeard: r.lastHeard || 0,
    isHeard: r.isHeard || null,
    heardByMe: !!r.rf,
    rf: r.rf ? { kind: r.rf.kind === 'digi' ? 'digi' : 'direct', digi: r.rf.digi || '', lastHeard: r.rf.lastHeard || 0, packets: r.rf.packets || 0 } : null,
    distanceKm: num(r.distanceKm), bearing: num(r.bearing),
  };
}

function byteLen(o) {
  try { return Buffer.byteLength(JSON.stringify(o)) + 1; } catch { return 1; }
}

/** Rows in slices whose JSON stays under maxBytes (one oversized row gets its own slice). */
function chunkRows(rows, maxBytes) {
  const limit = Math.max(1, maxBytes || CHUNK_BYTES);
  const out = [];
  let cur = [], size = 2;
  for (const r of rows) {
    const n = byteLen(r);
    if (cur.length && size + n > limit) { out.push(cur); cur = []; size = 2; }
    cur.push(r); size += n;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** The C2S messages, cleaned. null = not one of ours. */
function parseRequest(msg) {
  if (!msg || typeof msg !== 'object') return null;
  switch (msg.type) {
    case 'aprs-subscribe': {
      const km = Math.round(Number(msg.rangeKm));
      return { type: msg.type, on: msg.on === true, rangeKm: isFinite(km) && km > 0 ? km : null };
    }
    case 'aprs-listen':
      return { type: msg.type, on: msg.on === true, band: BANDS.indexOf(msg.band) >= 0 ? msg.band : '' };
    case 'aprs-igate':
      return { type: msg.type, on: msg.on === true };
    case 'aprs-beacon-is':
      return { type: msg.type };
    default:
      return null;
  }
}

/** A Guest Pass may not do this: the sentence it is told, or '' when it may. */
function guestRefusal(type) { return GUEST_REFUSED.has(type) ? PassWording.refusalText(type) : ''; }

/** A coordinate cut to whole minutes, as the approximate beacon packet sends it (lib/aprs-beacon.js). */
function wholeMinutes(v) {
  const a = Math.abs(v);
  let deg = Math.floor(a);
  let min = Math.floor((a - deg) * 60 + 1e-9);
  if (min >= 60) { deg++; min = 0; }
  return (v < 0 ? -1 : 1) * (deg + min / 60);
}

/**
 * The beacon position for the wire: never more exact than the packet. With
 * "approximate" on (the default) it is cut to whole minutes, as on the air.
 */
function wirePosition(p, approx) {
  if (!p || !isFinite(p.lat) || !isFinite(p.lon)) return null;
  return approx
    ? { lat: wholeMinutes(p.lat), lon: wholeMinutes(p.lon), source: p.source || '', approx: true }
    : { lat: p.lat, lon: p.lon, source: p.source || '', approx: false };
}

/** One aprs-state from the window's own payloads. */
function buildState({ feed, listen, igate, beacon, subscribers } = {}) {
  const f = feed || {};
  const l = listen || {};
  const i = igate || {};
  const b = beacon || {};
  const out = {
    feed: { state: f.state || 'off', server: f.server || '', km: f.km || null, anonymous: !!f.anonymous, subscribers: subscribers || 0 },
    listen: {
      on: !!l.on, state: l.state || 'off', band: l.band || '', bands: Array.isArray(l.bands) ? l.bands.slice() : [],
      modeLabel: l.modeLabel || '', mhz: l.mhz || '', heard: l.heard || 0, lastAt: l.lastAt || 0,
      sentence: l.sentence || '', note: l.note || '',
    },
    igate: {
      on: !!i.on, active: !!i.active, call: i.call || '', link: i.link || 'stopped',
      gated: i.gated || 0, lastAt: i.lastAt || 0, lastFrom: i.lastFrom || '', sentence: i.sentence || '',
    },
    beacon: {
      call: b.call || '', lastAt: b.lastAt || 0, lastPacket: b.lastPacket || '', sending: !!b.sending,
      sentence: b.sentence || '', backAt: b.backAt || 0, timerOn: !!b.timerOn, nextAt: b.nextAt || 0,
      position: wirePosition(b.position, !(b.settings && b.settings.approx === false)),
    },
  };
  // The one sentence to show when something could not be done; listening first.
  out.refusal = (l.state === 'refused' || l.state === 'paused' ? out.listen.sentence : '') || out.beacon.sentence || out.igate.sentence || '';
  return out;
}

/**
 * The controller main.js wires to the remote server. deps (all optional in
 * tests): startFeed(), stopFeed(), feedRunning(), setFeedRange(km),
 * windowOpen(), listenSet(on), listenSetBand(band), igateSet(on),
 * beaconNow(), getState() -> {listen, igate, beacon}, sendState(state),
 * sendStations(clientId|null, msg) (null = every subscribed client),
 * markUserActive(), log(s), home() -> {lat, lon} | null,
 * timers {setTimeout, clearTimeout, setInterval, clearInterval}, now().
 */
function createController(deps) {
  const d = deps || {};
  const t = d.timers || { setTimeout, clearTimeout, setInterval, clearInterval };
  const now = d.now || Date.now;
  const flushMs = d.flushMs || FLUSH_MS;
  const stateMs = d.stateMs || STATE_MS;
  const call = (fn, ...a) => (typeof d[fn] === 'function' ? d[fn](...a) : undefined);
  const log = (s) => call('log', '[APRS ECHOCAT] ' + s);

  // Built at main.js load, before settings exist: no dep is called until a device asks.
  const store = Stations.createStore({ now, maxAgeMs: d.maxAgeMs, home: null });
  const subs = new Map();          // clientId -> { guest }
  const sent = new Set();          // keys the subscribed clients know
  const changed = new Set();       // keys changed since the last delta
  const gone = new Set();          // keys gone since the last delta
  let flushTimer = null;
  let stateTimer = null;
  let feed = { state: 'off' };
  let lastPrune = now();           // packets() ages the store out while nobody is subscribed
  let listenOwner = null;          // { clientId, guest }: the client that turned listening on

  function flush() {
    for (const k of store.prune()) { changed.delete(k); if (sent.has(k)) gone.add(k); }
    if (!subs.size || (!changed.size && !gone.size)) { changed.clear(); gone.clear(); return null; }
    const add = [], update = [];
    for (const k of changed) {
      const r = store.get(k);
      if (!r) { if (sent.has(k)) gone.add(k); continue; }
      if (sent.has(k)) update.push(slimStation(r)); else { sent.add(k); add.push(slimStation(r)); }
    }
    const g = [...gone].filter((k) => sent.has(k));
    for (const k of g) sent.delete(k);
    changed.clear(); gone.clear();
    if (!add.length && !update.length && !g.length) return null;
    const msg = { type: 'aprs-stations', op: 'delta', add, update, gone: g, total: store.size };
    call('sendStations', null, msg);
    return msg;
  }

  function startFlushing() { if (!flushTimer) flushTimer = t.setInterval(flush, flushMs); }
  function stopFlushing() { if (flushTimer) { t.clearInterval(flushTimer); flushTimer = null; } }

  /** Parsed packets, as the APRS window gets them (internet and radio). */
  function packets(list) {
    // Nobody subscribed: flush() is not running, so age the store out here
    // (once a minute), or it keeps every station heard while the window is open.
    if (!subs.size && now() - lastPrune >= PRUNE_IDLE_MS) {
      lastPrune = now();
      for (const k of store.prune()) sent.delete(k);
    }
    for (const p of Array.isArray(list) ? list : []) {
      if (!p || !p.from) continue;
      const key = Stations.stationKey(p);
      const had = !!store.get(key);
      const r = store.add(p);
      if (!subs.size) continue;
      if (r) changed.add(r.key);
      else if (had && !store.get(key)) { changed.delete(key); gone.add(key); }
    }
  }

  function snapshot(clientId, chunkBytes) {
    store.prune();
    const rows = store.list({ sort: 'distance' }).map(slimStation);
    for (const r of rows) sent.add(r.key);
    const chunks = chunkRows(rows, chunkBytes || d.chunkBytes);
    if (!chunks.length) chunks.push([]);
    const msgs = chunks.map((stations, i) => ({ type: 'aprs-stations', op: 'snapshot', stations, chunk: i, totalChunks: chunks.length, total: rows.length }));
    for (const m of msgs) call('sendStations', clientId, m);
    return msgs;
  }

  function currentState() {
    const s = (typeof d.getState === 'function' && d.getState()) || {};
    return buildState({ feed, listen: s.listen, igate: s.igate, beacon: s.beacon, subscribers: subs.size });
  }
  function stateNow() { if (stateTimer) { t.clearTimeout(stateTimer); stateTimer = null; } const s = currentState(); call('sendState', s); return s; }
  /** Something the window shows changed: one aprs-state within 500 ms. */
  function stateChanged() { if (!stateTimer) stateTimer = t.setTimeout(() => { stateTimer = null; stateNow(); }, stateMs); }

  /** The window's channels, seen as they are sent (main.js aprsWinSend / aprsSend). */
  function tap(channel, data) {
    if (channel === 'aprs-packets') { packets(data); return; }
    if (channel === 'aprs-status') { feed = Object.assign({}, data || {}); stateChanged(); return; }
    if (channel === 'aprs-listen') {
      if (data && !data.on) listenOwner = null;
      stateChanged();
      return;
    }
    if (channel === 'aprs-igate' || channel === 'aprs-beacon') stateChanged();
  }

  function feedOff() {
    if (subs.size || call('windowOpen')) return false;
    call('stopFeed');
    feed = { state: 'off' };
    return true;
  }

  function subscribe(clientId, { on, rangeKm, guest } = {}) {
    if (on) {
      const first = !subs.has(clientId);
      subs.set(clientId, { guest: !!guest });
      const h = call('home');
      if (h) store.setHome(h); // distance and bearing from the shack's grid, as in the window
      if (!call('feedRunning')) { call('startFeed'); log('feed started for device ' + clientId); }
      if (rangeKm && !call('windowOpen')) call('setFeedRange', rangeKm);
      startFlushing();
      if (first) snapshot(clientId);
    } else {
      leave(clientId, 'unsubscribed');
    }
    stateNow();
  }

  function leave(clientId, why) {
    const had = subs.delete(clientId);
    if (!subs.size) { stopFlushing(); sent.clear(); changed.clear(); gone.clear(); }
    if (listenOwner && listenOwner.clientId === clientId && !call('windowOpen')) {
      listenOwner = null;
      log('listening stops: the device that turned it on ' + (why === 'gone' ? 'left' : 'stopped watching'));
      call('listenSet', false);
    }
    if (had && feedOff()) log('feed stopped: no device is watching and the APRS window is closed');
    return had;
  }

  /** A client's connection went away. */
  function clientGone(clientId) { const had = leave(clientId, 'gone'); if (had) stateNow(); }

  function listen(clientId, { on, band, guest } = {}) {
    call('markUserActive');
    if (band) call('listenSetBand', band);
    if (on) listenOwner = { clientId, guest: !!guest };
    else listenOwner = null;
    call('listenSet', !!on);
    stateChanged();
  }

  /** Owner devices only (remote-server refuses a guest before this). */
  function igate(on) { call('igateSet', !!on); stateChanged(); }
  function beaconNow() { call('beaconNow'); stateChanged(); }

  /** Closing the APRS window: what keeps running for the phones. */
  function keepsFeed() { return subs.size > 0; }
  function keepsListen() { return !!listenOwner && subs.has(listenOwner.clientId); }
  /** Listening a Guest Pass turned on never gates under the owner's callsign. */
  function guestListening() { return !!(listenOwner && listenOwner.guest); }

  function handle(clientId, req, meta) {
    const m = meta || {};
    if (!req) return false;
    if (req.type === 'aprs-subscribe') subscribe(clientId, { on: req.on, rangeKm: req.rangeKm, guest: m.guest });
    else if (req.type === 'aprs-listen') listen(clientId, { on: req.on, band: req.band, guest: m.guest });
    else if (req.type === 'aprs-igate') { if (m.guest) return false; igate(req.on); }
    else if (req.type === 'aprs-beacon-is') { if (m.guest) return false; beaconNow(); }
    else return false;
    return true;
  }

  return {
    tap, packets, flush, snapshot, subscribe, clientGone, listen, igate, beaconNow, handle,
    stateChanged, stateNow, currentState, keepsFeed, keepsListen, guestListening,
    setHome(h) { store.setHome(h); },
    get subscribers() { return subs.size; },
    get size() { return store.size; },
    stop() { stopFlushing(); if (stateTimer) { t.clearTimeout(stateTimer); stateTimer = null; } },
  };
}

module.exports = { createController, slimStation, chunkRows, parseRequest, guestRefusal, buildState, GUEST_REFUSED, FLUSH_MS, STATE_MS, CHUNK_BYTES };
