// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// Mercury HF data modem — TCP TNC client.
//
// Speaks Mercury's VARA-compatible TNC over two sockets (docs/TNC.md):
//   - control port (default 8300): CR-terminated ASCII commands out, and an
//     async status stream in (PTT ON/OFF, CONNECTED, BUFFER, SN, BUSY, …).
//   - data port    (default 8301): raw application payload, both directions;
//     only carries bytes while an ARQ session is CONNECTED.
//
// Modeled on lib/dxcluster.js (stale-socket guard, `_wantDisconnect` intent
// flag, exponential-backoff reconnect). The control-line PARSER is a pure
// exported function so it can be unit-tested without sockets.
//
// This is the transport only — no PTT/audio/arbiter policy lives here; that is
// main.js's job (a later phase drives handleRemotePtt off the 'ptt' event).

'use strict';

const net = require('net');
const { EventEmitter } = require('events');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_CONTROL_PORT = 8300;

/**
 * Parse one Mercury control-port line into a typed event, or null for blank.
 * Keywords are matched case-insensitively; callsigns keep their original case.
 * @param {string} raw
 * @returns {{type:string,[k:string]:any}|null}
 */
function parseControlLine(raw) {
  const line = String(raw == null ? '' : raw).replace(/[\r\n]+$/, '').trim();
  if (!line) return null;
  const up = line.toUpperCase();
  const parts = line.split(/\s+/);
  const key = parts[0].toUpperCase();

  switch (key) {
    case 'OK': return { type: 'ack', ok: true };
    case 'WRONG': return { type: 'ack', ok: false };
    case 'PENDING': return { type: 'pending' };
    case 'CANCELPENDING': return { type: 'cancelpending' };
    case 'DISCONNECTED': return { type: 'disconnected' };
    case 'IAMALIVE': return { type: 'iamalive' };
    case 'PTT':
      // PTT ON | PTT OFF
      return { type: 'ptt', on: (parts[1] || '').toUpperCase() === 'ON' };
    case 'BUSY':
      return { type: 'busy', on: (parts[1] || '').toUpperCase() === 'ON' };
    case 'CONNECTED': {
      // CONNECTED <source> <dest> <bandwidth>
      const bandwidth = parseInt(parts[parts.length - 1], 10);
      return { type: 'connected', source: parts[1] || '', dest: parts[2] || '', bandwidth: Number.isFinite(bandwidth) ? bandwidth : null };
    }
    case 'CQFRAME': {
      // CQFRAME <source> <bandwidth>
      const bandwidth = parseInt(parts[2], 10);
      return { type: 'cqframe', source: parts[1] || '', bandwidth: Number.isFinite(bandwidth) ? bandwidth : null };
    }
    case 'BUFFER': {
      // BUFFER <bytes>
      const bytes = parseInt(parts[1], 10);
      return { type: 'buffer', bytes: Number.isFinite(bytes) ? bytes : 0 };
    }
    case 'SN': {
      const value = parseFloat(parts[1]);
      return { type: 'sn', value: Number.isFinite(value) ? value : null };
    }
    case 'BITRATE': {
      // BITRATE (<level>) <bps> BPS
      const lvl = up.match(/\((\d+)\)/);
      const bps = up.match(/\)\s*(\d+)\s*BPS/);
      return { type: 'bitrate', level: lvl ? parseInt(lvl[1], 10) : null, bps: bps ? parseInt(bps[1], 10) : null };
    }
    default:
      // VERSION replies and anything else — surface verbatim.
      return { type: 'other', text: line };
  }
}

class MercuryClient extends EventEmitter {
  constructor() {
    super();
    this._ctrl = null;
    this._data = null;
    this._ctrlBuf = '';
    this._target = null; // { host, controlPort, dataPort }
    this.connected = false;      // control socket up
    this.dataConnected = false;  // data socket up
    this.arqConnected = false;   // inside an ARQ session
    // Intent flag — true while we WANT to be disconnected; stops a socket
    // 'close' from scheduling a reconnect after an intentional disconnect().
    this._wantDisconnect = true;
    this._reconnectTimer = null;
    this._reconnectAttempt = 0;
    this._reconnectBaseMs = 3000;
    this._reconnectMaxMs = 60 * 1000;
    // Half-open detection: Mercury emits IAMALIVE periodically, so a control
    // socket with no bytes for this long is treated as dead and recycled.
    this._watchdogTimer = null;
    this._lastCtrlAt = 0;
    this._watchdogMs = 120 * 1000;
  }

  connect({ host, controlPort, dataPort } = {}) {
    this.disconnect();
    const cp = controlPort || DEFAULT_CONTROL_PORT;
    this._target = { host: host || DEFAULT_HOST, controlPort: cp, dataPort: dataPort || cp + 1 };
    this._wantDisconnect = false;
    this._openControl();
    this._openData();
  }

  disconnect() {
    this._wantDisconnect = true;
    this._target = null;
    this._reconnectAttempt = 0;
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    this._stopWatchdog();
    this._teardownSockets();
    this._ctrlBuf = '';
    this.connected = false;
    this.dataConnected = false;
    this.arqConnected = false;
  }

  // ---- sockets ----

  _openControl() {
    const sock = new net.Socket();
    this._ctrl = sock;
    sock.on('data', (chunk) => { if (this._ctrl !== sock) return; this._onCtrlData(chunk); });
    sock.on('connect', () => {
      if (this._ctrl !== sock) return;
      this.connected = true;
      this._reconnectAttempt = 0;
      this._lastCtrlAt = Date.now();
      this._startWatchdog();
      this.emit('status', { connected: true, host: this._target.host, port: this._target.controlPort });
    });
    sock.on('error', () => { /* handled in close */ });
    sock.on('close', () => { if (this._ctrl !== sock) return; this._handleDrop(); });
    sock.connect(this._target.controlPort, this._target.host);
  }

  _openData() {
    const sock = new net.Socket();
    this._data = sock;
    sock.on('data', (chunk) => { if (this._data !== sock) return; this.emit('data', chunk); });
    sock.on('connect', () => { if (this._data !== sock) return; this.dataConnected = true; });
    sock.on('error', () => { /* handled in close */ });
    sock.on('close', () => { if (this._data !== sock) return; this._handleDrop(); });
    sock.connect(this._target.dataPort, this._target.host);
  }

  // Either socket dropping recycles the whole link (both sockets belong to one
  // Mercury session). Reconnect unless the user asked us to stop.
  _handleDrop() {
    const wasConnected = this.connected;
    this._teardownSockets();
    this.connected = false;
    this.dataConnected = false;
    this.arqConnected = false;
    this._stopWatchdog();
    if (wasConnected) {
      this.emit('status', { connected: false, host: this._target && this._target.host, port: this._target && this._target.controlPort });
    }
    if (this._wantDisconnect) return;
    this._scheduleReconnect();
  }

  _teardownSockets() {
    for (const key of ['_ctrl', '_data']) {
      const sock = this[key];
      if (sock) {
        this[key] = null; // drop ref BEFORE destroy so stale handlers bail
        try { sock.removeAllListeners(); } catch {}
        try { sock.destroy(); } catch {}
      }
    }
  }

  _scheduleReconnect() {
    if (this._reconnectTimer || !this._target || this._wantDisconnect) return;
    const delay = Math.min(this._reconnectBaseMs * Math.pow(2, this._reconnectAttempt), this._reconnectMaxMs);
    this._reconnectAttempt++;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (this._target && !this._wantDisconnect) {
        const t = this._target;
        // connect() calls disconnect() first, which nulls _target — re-pass it.
        this.connect(t);
      }
    }, delay);
  }

  // ---- control RX ----

  _onCtrlData(chunk) {
    this._lastCtrlAt = Date.now();
    this._ctrlBuf += chunk.toString('latin1');
    // Mercury terminates lines with CR; tolerate CRLF/LF too.
    let m;
    while ((m = this._ctrlBuf.search(/[\r\n]/)) !== -1) {
      const line = this._ctrlBuf.slice(0, m);
      this._ctrlBuf = this._ctrlBuf.slice(m + 1);
      if (line) this._dispatchLine(line);
    }
    // Guard against unbounded growth if a peer never sends a terminator.
    if (this._ctrlBuf.length > 4096) this._ctrlBuf = this._ctrlBuf.slice(-4096);
  }

  _dispatchLine(line) {
    this.emit('line', line); // raw, for debug/log
    const ev = parseControlLine(line);
    if (!ev) return;
    switch (ev.type) {
      case 'connected': this.arqConnected = true; this.emit('connected', ev); break;
      case 'disconnected': this.arqConnected = false; this.emit('disconnected', ev); break;
      case 'ptt': this.emit('ptt', ev); break;
      case 'busy': this.emit('busy', ev); break;
      case 'pending': this.emit('pending', ev); break;
      case 'cancelpending': this.emit('cancelpending', ev); break;
      case 'cqframe': this.emit('cqframe', ev); break;
      case 'buffer': this.emit('buffer', ev); break;
      case 'sn': this.emit('sn', ev); break;
      case 'bitrate': this.emit('bitrate', ev); break;
      case 'iamalive': this.emit('iamalive', ev); break;
      case 'ack': this.emit('ack', ev); break;
      default: this.emit('other', ev); break;
    }
  }

  // ---- watchdog ----

  _startWatchdog() {
    this._stopWatchdog();
    this._watchdogTimer = setInterval(() => {
      if (!this.connected) return;
      if (Date.now() - this._lastCtrlAt > this._watchdogMs) {
        // Half-open — force the control socket closed so 'close' recycles it.
        if (this._ctrl) { try { this._ctrl.destroy(); } catch {} }
      }
    }, 30 * 1000);
  }

  _stopWatchdog() {
    if (this._watchdogTimer) { clearInterval(this._watchdogTimer); this._watchdogTimer = null; }
  }

  // ---- commands (control port, CR-terminated) ----

  _writeCtrl(line) {
    if (this._ctrl && this.connected) { this._ctrl.write(line + '\r'); return true; }
    return false;
  }

  myCall(call, secondaries = []) { return this._writeCtrl(['MYCALL', call, ...secondaries].filter(Boolean).join(' ')); }
  listen(mode = 'ON') { return this._writeCtrl('LISTEN ' + String(mode).toUpperCase()); }
  setPublic(on) { return this._writeCtrl('PUBLIC ' + (on ? 'ON' : 'OFF')); }
  setBandwidth(bw) { return this._writeCtrl('BW' + String(bw)); } // 500 | 2300 | 2750
  arqConnect(mine, theirs) { return this._writeCtrl(`CONNECT ${mine} ${theirs}`); }
  arqDisconnect() { return this._writeCtrl('DISCONNECT'); }
  abort() { return this._writeCtrl('ABORT'); }
  cqFrame(call, bw) { return this._writeCtrl(`CQFRAME ${call} ${bw}`); }
  queryBuffer() { return this._writeCtrl('BUFFER'); }
  querySn() { return this._writeCtrl('SN'); }
  queryBitrate() { return this._writeCtrl('BITRATE'); }
  sendCommand(raw) { return this._writeCtrl(String(raw)); }

  // ---- data port ----

  /** Queue application bytes for ARQ transmission (only meaningful when CONNECTED). */
  sendData(buf) {
    if (this._data && this.dataConnected) { this._data.write(buf); return true; }
    return false;
  }
}

module.exports = { MercuryClient, parseControlLine, DEFAULT_HOST, DEFAULT_CONTROL_PORT };
