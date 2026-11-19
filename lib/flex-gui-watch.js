'use strict';

// A NON-GUI LAN connection to a Flex that only watches its GUI clients.
//
// While the radio is with ECHOCAT over FlexRadio's SmartLink (lib/flex-route.js
// 'released'), POTACAT must not hold a GUI slot, yet it has to notice when the
// radio has had no GUI client for 60 s (the mobile device went away) so it can
// take the radio back. A plain TCP client on 4992 that sends `sub client all`
// and nothing else costs no licence slot: it never sends `client gui` or
// `client bind`. The radio then reports every client:
//
//   S<h>|client 0x4E1DDC50 connected local_ptt=1 client_id=FC77859A-... program=SmartSDR-Win station=DESK
//   S<h>|client 0x4E1DDC50 disconnected forced=0 wan_disconnect=0 ...
//
// A GUI client is one with a real client_id (a UUID). A connected line with no
// client_id is a non-GUI client (this watch, a DAX or CAT client); client_id=0
// is the radio's placeholder for a GUI registration being torn down (the
// "zombie" lib/smartsdr.js also skips). Spaces in a station name arrive as
// 0x7F.

const EventEmitter = require('events');
const net = require('net');

/** Parse one client status line. Returns null when the line is not one. */
function parseClientStatus(line) {
  const s = String(line || '');
  const m = s.match(/\|client\s+0x([0-9A-Fa-f]+)\s*(.*)$/);
  if (!m) return null;
  const handle = m[1].toUpperCase();
  const rest = m[2] || '';
  const disconnected = /(?:^|\s)disconnected(?:\s|$)/.test(rest) || /(?:^|\s)connected=0\b/.test(rest);
  const connected = !disconnected && /(?:^|\s)connected(?:\s|=1\b|$)/.test(rest);
  const kv = {};
  for (const part of rest.split(/\s+/)) {
    const eq = part.indexOf('=');
    if (eq > 0) kv[part.slice(0, eq)] = part.slice(eq + 1).replace(/\x7f/g, ' ');
  }
  const hasId = Object.prototype.hasOwnProperty.call(kv, 'client_id');
  const clientId = hasId ? kv.client_id : undefined;
  return {
    handle,
    state: disconnected ? 'disconnected' : (connected ? 'connected' : 'update'),
    clientId,
    program: kv.program || '',
    station: kv.station || '',
  };
}

/** A real GUI registration: a client_id that is not empty and not 0. */
function isGuiClientId(id) {
  if (id == null) return false;
  const s = String(id).trim();
  return s !== '' && s !== '0' && s.toLowerCase() !== '0x0';
}

class FlexGuiWatch extends EventEmitter {
  /**
   * opts.connect(host) → a net.Socket-like object (tests pass a fake).
   * opts.retryMs: redial delay after a drop. opts.settleMs: how long after
   * connecting the radio gets to list its clients before the first 'clients'.
   */
  constructor(opts = {}) {
    super();
    this._connectFn = opts.connect || ((host) => net.connect(4992, host));
    this._retryMs = opts.retryMs != null ? opts.retryMs : 5000;
    this._settleMs = opts.settleMs != null ? opts.settleMs : 1500;
    this._host = null;
    this._sock = null;
    this._buf = '';
    this._seq = 1;
    this._ownHandle = null;
    this._gui = new Map();     // handle -> { clientId, program, station }
    this._settled = false;
    this._settleTimer = null;
    this._retryTimer = null;
    this.connected = false;
  }

  get running() { return !!this._host; }
  /** The radio has had time to list its clients since this connection opened. */
  get settled() { return this._settled; }

  /** GUI clients on the radio right now (never this watch). */
  guiClients() {
    return [...this._gui.entries()].map(([handle, c]) => ({ handle, ...c }));
  }

  start(host) {
    if (this._host === host && (this._sock || this._retryTimer)) return;
    this.stop();
    this._host = host;
    this._dial();
  }

  stop() {
    this._host = null;
    if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null; }
    if (this._settleTimer) { clearTimeout(this._settleTimer); this._settleTimer = null; }
    const s = this._sock;
    this._sock = null;
    this.connected = false;
    this._gui.clear();
    this._settled = false;
    if (s) { try { s.removeAllListeners(); s.on('error', () => {}); s.destroy(); } catch { /* gone */ } }
  }

  _dial() {
    if (!this._host) return;
    let sock;
    try { sock = this._connectFn(this._host); } catch (err) { this._lost(err); return; }
    this._sock = sock;
    this._buf = '';
    this._gui.clear();
    this._settled = false;
    this._ownHandle = null;
    sock.on('connect', () => {
      if (this._sock !== sock) return;
      this.connected = true;
      // The only command this connection ever sends. No `client gui`, no
      // `client bind`: it must never take the radio's one GUI slot.
      this._write('sub client all');
      this.emit('connected');
      this._settleTimer = setTimeout(() => {
        this._settleTimer = null;
        this._settled = true;
        this._emitClients();
      }, this._settleMs);
    });
    sock.on('data', (chunk) => {
      if (this._sock !== sock) return;
      this._buf += chunk.toString();
      let nl;
      while ((nl = this._buf.indexOf('\n')) !== -1) {
        const line = this._buf.slice(0, nl).replace(/\r$/, '');
        this._buf = this._buf.slice(nl + 1);
        this._line(line);
      }
    });
    sock.on('error', (err) => { if (this._sock === sock) this.emit('error', err); });
    sock.on('close', () => { if (this._sock === sock) this._lost(); });
  }

  _write(cmd) {
    if (!this._sock) return;
    try { this._sock.write(`C${this._seq++}|${cmd}\n`); } catch { /* close follows */ }
  }

  _lost(err) {
    const was = this.connected;
    this._sock = null;
    this.connected = false;
    this._gui.clear();
    this._settled = false;
    if (this._settleTimer) { clearTimeout(this._settleTimer); this._settleTimer = null; }
    if (was || err) this.emit('lost', err || null);
    if (this._host && !this._retryTimer) {
      this._retryTimer = setTimeout(() => { this._retryTimer = null; this._dial(); }, this._retryMs);
    }
  }

  _line(line) {
    const h = line.match(/^H([0-9A-Fa-f]+)/);
    if (h) { this._ownHandle = h[1].toUpperCase(); this._gui.delete(this._ownHandle); return; }
    if (!line.startsWith('S')) return;
    const c = parseClientStatus(line);
    if (!c || c.handle === this._ownHandle) return;
    const had = this._gui.has(c.handle);
    if (c.state === 'disconnected') {
      this._gui.delete(c.handle);
    } else if (c.clientId !== undefined) {
      if (isGuiClientId(c.clientId)) {
        const prev = this._gui.get(c.handle) || {};
        this._gui.set(c.handle, {
          clientId: c.clientId,
          program: c.program || prev.program || '',
          station: c.station || prev.station || '',
        });
      } else {
        this._gui.delete(c.handle);
      }
    }
    if (this._settled && had !== this._gui.has(c.handle)) this._emitClients();
  }

  _emitClients() { this.emit('clients', this.guiClients()); }
}

module.exports = { FlexGuiWatch, parseClientStatus, isGuiClientId };
