// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// APRS-IS uplink client + pure packet builders for the JS8 → APRS gateway.
//
// POTACAT's gateway role is RECEIVE-ONLY on RF: it decodes @APRSIS directed
// messages other stations transmit over JS8 and forwards ("gates") them to
// the APRS-IS internet backbone under the operator's callsign. Nothing here
// ever keys a transmitter — the risk surface is an internet socket, which is
// why the feature can default to a persisted setting rather than the
// session-only posture automatic TX requires.
//
// Why this matters: JS8's APRS features (SMS/email out, position reports)
// have a SUPPLY problem — few RF→IS gateways listen at any moment, so
// packets vanish silently. Every POTACAT home station that opts in makes the
// feature work better for everyone, including non-POTACAT users.
//
// Wire format notes (aprs-is.net):
//  - login line: "user CALL pass PASSCODE vers NAME VERSION"
//  - a verified login is required to inject packets; the passcode is the
//    standard public algorithm every APRS client ships.
//  - gated packet: SRC>APZJS8,TCPIP*,qAR,GATE:payload  (qAR = gated from RF
//    by a verified station; APZJS8 = experimental tocall for JS8).
//  - server lines starting with '#' are comments/keepalives.

'use strict';

const net = require('net');
const { EventEmitter } = require('events');

// The passcode: one implementation, lib/aprs-passcode.js (APRS phase 4).
const { aprsPasscode } = require('./aprs-passcode');

/** A gated third-party packet: the RF sender stays the source, our call
 *  appears in the qAR path (we vouch we heard it on RF). */
function buildGatePacket(srcCall, gateCall, payload) {
  const src = String(srcCall || '').toUpperCase().trim();
  const gate = String(gateCall || '').toUpperCase().trim();
  const body = String(payload || '').replace(/[\r\n]/g, ' ').trim();
  if (!src || !gate || !body) return null;
  return `${src}>APZJS8,TCPIP*,qAR,${gate}:${body}`;
}

/** Maidenhead (4 or 6 chars) → APRS uncompressed lat/lon strings, centered
 *  on the (sub)square. Returns null on a malformed grid. */
function gridToAprsLatLon(grid) {
  const g = String(grid || '').toUpperCase().trim();
  if (!/^[A-R]{2}[0-9]{2}([A-X]{2})?$/.test(g)) return null;
  let lon = (g.charCodeAt(0) - 65) * 20 - 180 + parseInt(g[2], 10) * 2;
  let lat = (g.charCodeAt(1) - 65) * 10 - 90 + parseInt(g[3], 10);
  if (g.length >= 6) {
    lon += (g.charCodeAt(4) - 65) * (2 / 24) + (1 / 24);
    lat += (g.charCodeAt(5) - 65) * (1 / 24) + (0.5 / 24);
  } else {
    lon += 1; lat += 0.5; // center of the square
  }
  const fmt = (v, isLat) => {
    const hemi = isLat ? (v >= 0 ? 'N' : 'S') : (v >= 0 ? 'E' : 'W');
    const a = Math.abs(v);
    const deg = Math.floor(a);
    const min = (a - deg) * 60;
    const degStr = String(deg).padStart(isLat ? 2 : 3, '0');
    const minStr = min.toFixed(2).padStart(5, '0');
    return `${degStr}${minStr}${hemi}`;
  };
  return { lat: fmt(lat, true), lon: fmt(lon, false) };
}

/** A position report gated on behalf of an RF station that sent
 *  "@APRSIS GRID <grid>". Symbol: house ('/-'), comment marks the source. */
function buildPositionPacket(srcCall, gateCall, grid, comment) {
  const pos = gridToAprsLatLon(grid);
  if (!pos) return null;
  const body = `=${pos.lat}/${pos.lon}-${String(comment || 'JS8').slice(0, 36)}`;
  return buildGatePacket(srcCall, gateCall, body);
}

const APRS_IS_HOST = 'rotate.aprs2.net';
const APRS_IS_PORT = 14580;

/**
 * The one APRS-IS uplink: connect, log in with the passcode, send packets.
 * Used by the JS8 gateway, the receive-only iGate (APRS phase 4) and the
 * beacon (phase 5), all through one connection in main.js. It never reads a
 * packet: lines from the server are only checked for the login answer.
 *
 * - login: lib/aprs-igate.js loginLine ("user CALL pass N vers POTACAT V",
 *   no filter); the passcode exists only inside that one write.
 * - 'verified' fires on "# logresp CALL verified" for this call; an
 *   "unverified" answer leaves send() refusing everything (status
 *   'unverified').
 * - reconnects with backoff (2 s doubling to 60 s); a "#" keep-alive after
 *   keepaliveMs with nothing sent; a connection silent for idleMs is dropped
 *   (servers send their own "#" line about every 20 s).
 * - the socket is injectable (createSocket), so the tests drive it against a
 *   local fake server (test/fixtures/fake-aprs-is-server.js).
 * status(): { state: 'stopped'|'connecting'|'connected'|'verified'|'unverified'|'waiting', call, server }
 */
class AprsIsClient extends EventEmitter {
  constructor({ call, host, port, version, createSocket, keepaliveMs, idleMs, retryBaseMs } = {}) {
    super();
    this.call = String(call || '').toUpperCase();
    this.host = host || APRS_IS_HOST;
    this.port = port || APRS_IS_PORT;
    this.version = version || '0.0.0';
    this.connected = false;
    this.verified = false;
    this.state = 'stopped';
    this.server = '';
    this._createSocket = createSocket || ((h, p) => net.createConnection({ host: h, port: p }));
    this._keepaliveMs = keepaliveMs || 120000;
    this._idleMs = idleMs || 90000;
    this._retryBaseMs = retryBaseMs || 2000;
    this._sock = null;
    this._wantDisconnect = true;
    this._retry = 0;
    this._timer = null;
    this._tick = null;
    this._lastRx = 0;
    this._lastTx = 0;
  }

  status() { return { state: this.state, call: this.call, server: this.server }; }

  _setState(st) {
    if (st === this.state) return;
    this.state = st;
    this.emit('status', this.status());
  }

  connect() {
    this._wantDisconnect = false;
    if (this._sock) return;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    let sock;
    try { sock = this._createSocket(this.host, this.port); } catch (e) { this.emit('error', e); this._drop(); return; }
    this._sock = sock;
    this._setState('connecting');
    if (typeof sock.setEncoding === 'function') sock.setEncoding('utf8');
    let buf = '';
    sock.on('connect', () => {
      if (sock !== this._sock) return;
      this.connected = true;
      this._retry = 0;
      this._lastRx = this._lastTx = Date.now();
      // No filter: this is an uplink-only session (we inject, we don't feed).
      this._write(require('./aprs-igate').loginLine({ call: this.call, version: this.version }));
      this._setState('connected');
      this.emit('connected');
      this._startTick();
    });
    sock.on('data', (chunk) => {
      if (sock !== this._sock) return;
      this._lastRx = Date.now();
      buf += chunk;
      if (buf.length > 16384 && buf.indexOf('\n') < 0) buf = '';
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        if (/^#\s*logresp\b/i.test(line)) {
          const m = /server\s+(\S+)/i.exec(line);
          if (m) this.server = m[1];
          if (require('./aprs-igate').logrespVerified(line, this.call)) {
            this.verified = true;
            this._setState('verified');
            this.emit('verified');
          } else {
            this.verified = false;
            this._setState('unverified');
          }
        }
        this.emit('line', line);
      }
    });
    sock.on('error', (err) => { if (sock === this._sock) { this.emit('error', err); this._drop(); } });
    sock.on('close', () => { if (sock === this._sock) this._drop(); });
  }

  _write(line) {
    if (!this._sock) return false;
    try { this._sock.write(line + '\r\n'); this._lastTx = Date.now(); return true; } catch { return false; }
  }

  _startTick() {
    this._stopTick();
    const every = Math.max(20, Math.min(10000, this._keepaliveMs, this._idleMs));
    this._tick = setInterval(() => {
      if (!this._sock || !this.connected) return;
      const now = Date.now();
      if (now - this._lastRx >= this._idleMs) { this.emit('error', new Error('no data from the server for ' + Math.round(this._idleMs / 1000) + ' s')); this._drop(); return; }
      if (now - this._lastTx >= this._keepaliveMs) this._write('#keepalive');
    }, every);
    if (typeof this._tick.unref === 'function') this._tick.unref();
  }

  _stopTick() { if (this._tick) { clearInterval(this._tick); this._tick = null; } }

  _drop() {
    this._stopTick();
    const was = this.connected;
    this.connected = false; this.verified = false; this.server = '';
    const sock = this._sock;
    this._sock = null;
    if (sock) { try { sock.removeAllListeners(); sock.on('error', () => {}); sock.destroy(); } catch { /* gone */ } }
    if (was) this.emit('disconnected');
    if (this._wantDisconnect) { this._setState('stopped'); return; }
    const delay = Math.min(60000, this._retryBaseMs * Math.pow(2, this._retry++));
    this._setState('waiting');
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => { this._timer = null; this.connect(); }, delay);
    if (typeof this._timer.unref === 'function') this._timer.unref();
  }

  disconnect() {
    this._wantDisconnect = true;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    this._stopTick();
    const sock = this._sock;
    this._sock = null;
    if (sock) { try { sock.removeAllListeners(); sock.on('error', () => {}); sock.destroy(); } catch { /* gone */ } }
    const was = this.connected;
    this.connected = false; this.verified = false; this.server = '';
    if (was) this.emit('disconnected');
    this._setState('stopped');
  }

  /** Inject one packet line. Returns false when not connected+verified. */
  send(packet) {
    if (!this._sock || !this.connected || !this.verified) return false;
    const line = String(packet || '');
    if (!line || /[\r\n]/.test(line)) return false;
    return this._write(line);
  }
}

module.exports = { AprsIsClient, aprsPasscode, buildGatePacket, gridToAprsLatLon, buildPositionPacket, APRS_IS_HOST, APRS_IS_PORT };

// ── outbound SMS/email builders (the JS8 sender side) ───────────────────────
// The addressee field is EXACTLY 9 chars space-padded — wrong padding is
// dropped silently by the backbone, which is why these exist as code.
function padAddressee(call) {
  const c = String(call || '').toUpperCase().trim().slice(0, 9);
  return c.padEnd(9, ' ');
}
/** ":GATEWAY  :body{NN" — an APRS message to a service gateway. seq 1..99. */
function buildAprsServiceMessage(gatewayCall, body, seq) {
  const gw = padAddressee(gatewayCall);
  if (!gw.trim()) return null;
  const text = String(body || '').replace(/[{}\r\n|~]/g, ' ').trim();
  if (!text) return null;
  const n = Math.max(1, Math.min(99, Math.round(Number(seq) || 1)));
  return ':' + gw + ':' + text + '{' + String(n).padStart(2, '0');
}
function buildSmsMessage(gatewayCall, number, text, seq) {
  const num = String(number || '').replace(/[^0-9+]/g, '');
  if (num.replace(/\D/g, '').length < 7) return null;
  return buildAprsServiceMessage(gatewayCall || 'SMSGTE', `@${num} ${text}`, seq);
}
function buildEmailMessage(gatewayCall, address, text, seq) {
  const addr = String(address || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) return null;
  return buildAprsServiceMessage(gatewayCall || 'EMAIL-2', `${addr} ${text}`, seq);
}
module.exports.padAddressee = padAddressee;
module.exports.buildSmsMessage = buildSmsMessage;
module.exports.buildEmailMessage = buildEmailMessage;
