// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// APRS-IS receive feed for the APRS window (phase 1: read-only).
//
// lib/aprs-is.js is the JS8 gateway's uplink: it logs in with a passcode and
// injects. This is the other direction: it logs in with passcode -1, which
// APRS-IS treats as read-only (the server never accepts a packet from it),
// asks for the stations within a range of the operator's grid, and hands
// each line up. Nothing here sends a packet or keys a transmitter.
//
//  - login: "user CALL pass -1 vers POTACAT <version> filter r/<lat>/<lon>/<km>"
//    (the server-side range filter, aprs-is.net "Server-side filter commands").
//    With no callsign in Settings the login is PCAT plus four random digits:
//    aprsc answers N0CALL (and N0CALL-n) with "Login by user not allowed"
//    (checked against rotate.aprs2.net on 2026-11-17), while any other
//    read-only name is served.
//  - a refused login is shown as 'refused' and retried only every 60 s.
//  - the rotate address (rotate.aprs2.net, shared with lib/aprs-is.js) picks a
//    server; every reconnect asks it again.
//  - reconnects with backoff (2 s doubling to 60 s), sends a "#" keep-alive
//    every 2 minutes, and drops a connection that has been silent for 90 s
//    (servers send their own "#" line about every 20 s).
//  - stop() ends it for good: no reconnect timer is left behind.
//  - APRS messages (A1): with a callsign, the filter also asks for messages
//    addressed to it, any SSID: "g/K3SBP/K3SBP-*" (the group message filter,
//    aprs-is.net/javAPRSFilter.aspx: "passes all message packets with the
//    specified callsign-SSID(s) as the addressee of the message. Supports *
//    wildcard."; "Multiple filter definitions can be setup separated by
//    spaces. If any of the filters find a match the packet is passed.").
//    lib/aprs-message.js messageFilter builds it. Still read-only (pass -1).
//  - Follow a call beyond the range (ECHOCAT aprs-find, 2026-11-21): the
//    budlist filter "b/K5ABC/K5ABC-*" passes every packet FROM those calls
//    wherever they are (aprs-is.net/javAPRSFilter.aspx: "b/call1/call2...
//    Budlist filter. Pass all traffic from exact call: call1, call2, ...
//    (* wild card allowed)"). A call with no SSID follows the call and every
//    SSID of it; with one, that station only. Each call is checked by
//    findCall (letters, digits, one '-SSID'), so nothing else reaches the
//    filter string; at most MAX_FOLLOW calls. setFollow() sends "#filter" on a
//    live connection, as setRange() does.
//  - "Heard you" (2026-11-22, lib/aprs-heard-you.js): setWatch() adds EXACT
//    calls (no SSID wildcard) to the same budlist: the radio beacon's own
//    source call and the iGates and digipeaters that heard it, at most
//    MAX_WATCH, alongside (not inside) aprs-find's MAX_FOLLOW.
//
// The socket and the timers are injectable so the test drives it with a fake
// socket and no network.

'use strict';

const { EventEmitter } = require('events');
const { APRS_IS_HOST, APRS_IS_PORT } = require('./aprs-is');

const DEFAULT_RANGE_KM = 150;
const MIN_RANGE_KM = 10;
const MAX_RANGE_KM = 1000;
const MAX_LINE = 8192;
const MAX_FOLLOW = 10;   // calls followed beyond the range at once (every device's aprs-find together)
const MAX_WATCH = 10;    // exact calls for "heard you" (lib/aprs-heard-you.js), beside MAX_FOLLOW, not inside it

/** The operator's callsign when it looks like one (and is not N0CALL), else null. */
function feedCallsign(call) {
  const c = String(call || '').toUpperCase().trim();
  if (!/^[A-Z0-9]{3,7}(-[A-Z0-9]{1,2})?$/.test(c) || !/\d/.test(c)) return null;
  if (/^N0CALL(-|$)|^NOCALL(-|$)/.test(c)) return null;
  return c;
}

/** The read-only login for an operator with no callsign: PCAT plus four digits. */
function anonymousLogin(random) {
  const r = typeof random === 'function' ? random() : Math.random();
  return 'PCAT' + String(Math.floor(r * 10000)).padStart(4, '0');
}

/**
 * A callsign to follow on APRS-IS, upper case, or null. Letters and digits
 * (3 to 7, at least one of each), optionally '-' and a 1 or 2 character
 * SSID. Nothing else: no '/', '*', space or filter syntax gets through.
 */
function findCall(raw) {
  if (typeof raw !== 'string') return null;
  const c = raw.trim().toUpperCase();
  const m = /^([A-Z0-9]{3,7})(-[A-Z0-9]{1,2})?$/.exec(c);
  if (!m || !/\d/.test(m[1]) || !/[A-Z]/.test(m[1])) return null;
  return c;
}

/**
 * "b/W1AW-9/K5ABC/K5ABC-*" (K5ABC with no SSID: every SSID) for the calls to follow (findCall-checked,
 * duplicates dropped, at most MAX_FOLLOW), or null with none.
 */
function budlistFilter(calls, exact) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(calls) ? calls : []) {
    const c = findCall(raw);
    if (!c || seen.has(c)) continue;
    if (seen.size >= MAX_FOLLOW) break;
    seen.add(c);
    out.push(c);
    if (c.indexOf('-') < 0) out.push(c + '-*'); // no SSID given: every SSID of the call
  }
  // exact: "heard you" calls, as they are (no wildcard), never one already above
  let n = 0;
  for (const raw of Array.isArray(exact) ? exact : []) {
    const c = findCall(raw);
    if (!c || out.indexOf(c) >= 0) continue;
    if (n >= MAX_WATCH) break;
    out.push(c); n++;
  }
  return out.length ? 'b/' + out.join('/') : null;
}

/** The exact calls setWatch keeps: findCall-checked, deduplicated, capped at MAX_WATCH. */
function watchList(calls) {
  const out = [];
  for (const raw of Array.isArray(calls) ? calls : []) {
    const c = findCall(raw);
    if (c && out.indexOf(c) < 0 && out.length < MAX_WATCH) out.push(c);
  }
  return out;
}

/** The calls setFollow keeps: findCall-checked, deduplicated, capped. */
function followList(calls) {
  const out = [];
  for (const raw of Array.isArray(calls) ? calls : []) {
    const c = findCall(raw);
    if (c && out.indexOf(c) < 0 && out.length < MAX_FOLLOW) out.push(c);
  }
  return out;
}

function clampRangeKm(km) {
  const n = Math.round(Number(km));
  if (!isFinite(n) || n <= 0) return DEFAULT_RANGE_KM;
  return Math.max(MIN_RANGE_KM, Math.min(MAX_RANGE_KM, n));
}

/** "r/41.50/-72.50/150", or null with no usable centre. */
function buildRangeFilter(lat, lon, km) {
  const la = Number(lat), lo = Number(lon);
  if (lat === null || lon === null || !isFinite(la) || !isFinite(lo) || Math.abs(la) > 90 || Math.abs(lo) > 180) return null;
  return `r/${la.toFixed(2)}/${lo.toFixed(2)}/${clampRangeKm(km)}`;
}

function buildLoginLine({ call, version, filter }) {
  const v = String(version || '0.0.0').replace(/\s+/g, '');
  const login = /^[A-Z0-9-]{3,9}$/.test(String(call || '')) ? call : anonymousLogin();
  return `user ${login} pass -1 vers POTACAT ${v}` + (filter ? ` filter ${filter}` : '');
}

/** 2 s, 4 s, 8 s ... capped at 60 s. */
function reconnectDelay(retry) {
  return Math.min(60000, 2000 * Math.pow(2, Math.max(0, retry | 0)));
}

/** Frame a byte stream into lines. A runaway line with no newline is dropped. */
function splitLines(buf, chunk) {
  let s = buf + chunk;
  const lines = [];
  let i;
  while ((i = s.indexOf('\n')) >= 0) {
    const line = s.slice(0, i).replace(/\r$/, '');
    s = s.slice(i + 1);
    if (line.length) lines.push(line);
  }
  if (s.length > MAX_LINE) s = '';
  return { lines, rest: s };
}

/** Collect items and hand them over in one batch every `ms`. */
function createBatcher(flush, ms, timers) {
  const t = timers || { setTimeout, clearTimeout };
  let items = [];
  let timer = null;
  function flushNow() {
    if (timer) { t.clearTimeout(timer); timer = null; }
    if (!items.length) return;
    const out = items;
    items = [];
    flush(out);
  }
  return {
    push(item) {
      items.push(item);
      if (!timer) timer = t.setTimeout(() => { timer = null; flushNow(); }, ms);
    },
    flushNow,
    stop() { if (timer) { t.clearTimeout(timer); timer = null; } items = []; },
    get pending() { return items.length; },
  };
}

class AprsIsFeed extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.call = feedCallsign(opts.call) || anonymousLogin(opts.random);
    this.anonymous = !feedCallsign(opts.call);
    this.version = opts.version || '0.0.0';
    this.host = opts.host || APRS_IS_HOST;
    this.port = opts.port || APRS_IS_PORT;
    this.lat = opts.lat; this.lon = opts.lon;
    this.km = clampRangeKm(opts.km);
    // A1: messages to the operator's call; none for the anonymous PCAT login.
    this.messages = this.anonymous ? null : require('./aprs-message').messageFilter(this.call);
    this.follow = followList(opts.follow); // ECHOCAT aprs-find: calls passed wherever they are
    this.watch = watchList(opts.watch);    // "heard you": exact calls (my beacon's source, who heard it)
    this.idleMs = opts.idleMs || 90000;
    this.keepaliveMs = opts.keepaliveMs || 120000;
    this._createSocket = opts.createSocket || ((host, port) => require('net').createConnection({ host, port }));
    this._t = opts.timers || { setTimeout, clearTimeout, setInterval, clearInterval };
    this._now = opts.now || Date.now;
    this.state = 'stopped';
    this.server = null;
    this._sock = null;
    this._buf = '';
    this._retry = 0;
    this._retryTimer = null;
    this._tick = null;
    this._lastRx = 0;
    this._lastTx = 0;
    this._running = false;
    this._refused = false;
  }

  filter() {
    const r = buildRangeFilter(this.lat, this.lon, this.km);
    if (!r) return null;
    return [r, this.messages, budlistFilter(this.follow, this.watch)].filter(Boolean).join(' ');
  }

  status() {
    return { state: this.state, server: this.server, call: this.call, anonymous: this.anonymous, filter: this.filter(), km: this.km, follow: this.follow.slice(), watch: this.watch.slice() };
  }

  _setState(s) {
    this.state = s;
    this.emit('status', this.status());
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._connect();
  }

  _connect() {
    if (!this._running || this._sock) return;
    this._buf = '';
    this.server = null;
    this._setState('connecting');
    let sock;
    try { sock = this._createSocket(this.host, this.port); } catch (e) { this._drop(e); return; }
    this._sock = sock;
    if (typeof sock.setEncoding === 'function') sock.setEncoding('utf8');
    sock.on('connect', () => {
      if (sock !== this._sock) return;
      this._retry = 0;
      this._lastRx = this._lastTx = this._now();
      this._write(buildLoginLine({ call: this.call, version: this.version, filter: this.filter() }));
      this._setState('connected');
      this._startTick();
    });
    sock.on('data', (chunk) => {
      if (sock !== this._sock) return;
      this._lastRx = this._now();
      const r = splitLines(this._buf, String(chunk));
      this._buf = r.rest;
      for (const line of r.lines) {
        if (line[0] === '#') {
          if (/login by user not allowed/i.test(line)) { this._refused = true; this.emit('comment', line); continue; }
          const m = line.match(/server\s+([A-Za-z0-9-]+)/);
          if (/logresp/.test(line) && m) { this.server = m[1]; this.emit('status', this.status()); }
          this.emit('comment', line);
        } else {
          this.emit('line', line);
        }
      }
    });
    sock.on('error', (err) => { if (sock === this._sock) this._drop(err); });
    sock.on('close', () => { if (sock === this._sock) this._drop(null); });
  }

  _write(line) {
    if (!this._sock) return false;
    try { this._sock.write(line + '\r\n'); this._lastTx = this._now(); return true; } catch { return false; }
  }

  _startTick() {
    this._stopTick();
    const every = Math.min(10000, this.idleMs, this.keepaliveMs);
    this._tick = this._t.setInterval(() => this._check(), every);
    if (this._tick && typeof this._tick.unref === 'function') this._tick.unref();
  }

  _stopTick() {
    if (this._tick) { this._t.clearInterval(this._tick); this._tick = null; }
  }

  /** Keep-alive out, silence watchdog in. */
  _check() {
    if (!this._sock || this.state !== 'connected') return;
    const now = this._now();
    if (now - this._lastRx >= this.idleMs) { this._drop(new Error('no data from the server for ' + Math.round(this.idleMs / 1000) + ' s')); return; }
    if (now - this._lastTx >= this.keepaliveMs) this._write('#keepalive');
  }

  _drop(err) {
    this._stopTick();
    const sock = this._sock;
    this._sock = null;
    if (sock) { try { sock.removeAllListeners(); sock.on('error', () => {}); sock.destroy(); } catch { /* gone */ } }
    if (err) this.emit('error', err);
    if (!this._running) { this._setState('stopped'); return; }
    const refused = this._refused;
    this._refused = false;
    const delay = refused ? 60000 : reconnectDelay(this._retry++);
    this._retryTimer = this._t.setTimeout(() => { this._retryTimer = null; this._connect(); }, delay);
    if (this._retryTimer && typeof this._retryTimer.unref === 'function') this._retryTimer.unref();
    this.state = refused ? 'refused' : 'waiting';
    this.emit('status', Object.assign(this.status(), { retryInMs: delay }));
  }

  /** Move or resize the range. Sent at once on a live connection (#filter). */
  setRange(lat, lon, km) {
    if (lat != null) this.lat = lat;
    if (lon != null) this.lon = lon;
    if (km != null) this.km = clampRangeKm(km);
    this._sendFilter();
  }

  /** The filter now, on a live connection ("#filter", aprsc's in-session filter change). */
  _sendFilter() {
    const f = this.filter();
    if (f && this._sock && this.state === 'connected') this._write('#filter ' + f);
    this.emit('status', this.status());
  }

  /** The calls followed beyond the range (aprs-find). Sent at once on a live connection (#filter). */
  setFollow(calls) {
    const next = followList(calls);
    if (next.join(',') === this.follow.join(',')) return false;
    this.follow = next;
    this._sendFilter();
    return true;
  }

  /** The exact "heard you" calls. Sent at once on a live connection (#filter). */
  setWatch(calls) {
    const next = watchList(calls);
    if (next.join(',') === this.watch.join(',')) return false;
    this.watch = next;
    this._sendFilter();
    return true;
  }

  stop() {
    this._running = false;
    if (this._retryTimer) { this._t.clearTimeout(this._retryTimer); this._retryTimer = null; }
    this._stopTick();
    const sock = this._sock;
    this._sock = null;
    if (sock) { try { sock.removeAllListeners(); sock.on('error', () => {}); sock.destroy(); } catch { /* gone */ } }
    this._setState('stopped');
  }
}

module.exports = {
  AprsIsFeed, feedCallsign, anonymousLogin, clampRangeKm, buildRangeFilter, buildLoginLine, reconnectDelay,
  splitLines, createBatcher, findCall, budlistFilter, followList, watchList, DEFAULT_RANGE_KM, MIN_RANGE_KM, MAX_RANGE_KM, MAX_FOLLOW, MAX_WATCH,
};
