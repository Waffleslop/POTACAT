// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// WinlinkClient — POTACAT's HTTP + websocket client for a local Pat
// ("pat http", see lib/winlink-pat.js). Every decision about what the bytes
// mean lives in winlink-pat.js; this class only moves them.
//
// Events: 'ws-open', 'ws-closed', 'event' (a classifyPatEvent result — the
// caller decides what each kind means), 'error'.
//
// The websocket must answer Pat's Ping with {"Pong":true} or Pat closes it
// after KeepaliveInterval (4 min) + 10 s; a closed socket reconnects with
// backoff while the client is open.

'use strict';

const { EventEmitter } = require('events');
const WebSocket = require('ws');
const { classifyPatEvent, normalizeMailbox, normalizeMessage, normalizeRmslist } = require('./winlink-pat');

class PatHttpError extends Error {
  constructor(status, body, op) {
    super(`${op}: HTTP ${status}${body ? ' — ' + String(body).trim().slice(0, 200) : ''}`);
    this.status = status;
    this.body = body;
  }
}

class WinlinkClient extends EventEmitter {
  /**
   * @param {object} o
   * @param {number} o.port           Pat's http port on 127.0.0.1
   * @param {number} [o.timeoutMs]    per-request timeout (not /api/connect)
   */
  constructor({ port, timeoutMs = 10000 } = {}) {
    super();
    this.base = `http://127.0.0.1:${port}`;
    this.timeoutMs = timeoutMs;
    this._ws = null;
    this._wantWs = false;
    this._wsBackoff = 1000;
    this._wsTimer = null;
  }

  async _req(method, path, { body, headers, timeoutMs, op } = {}) {
    const ctl = new AbortController();
    const ms = timeoutMs === 0 ? 0 : (timeoutMs || this.timeoutMs);
    const t = ms ? setTimeout(() => ctl.abort(), ms) : null;
    try {
      const res = await fetch(this.base + path, { method, body, headers, signal: ctl.signal });
      const text = await res.text();
      if (!res.ok) throw new PatHttpError(res.status, text, op || `${method} ${path}`);
      if (!text) return null;
      try { return JSON.parse(text); } catch { return text; }
    } catch (e) {
      if (e.name === 'AbortError') throw new Error(`${op || path}: Pat did not answer within ${Math.round(ms / 1000)} s`);
      throw e;
    } finally {
      if (t) clearTimeout(t);
    }
  }

  async status() { return this._req('GET', '/api/status', { op: 'status', timeoutMs: 3000 }); }

  async mailbox(box) {
    return normalizeMailbox(await this._req('GET', `/api/mailbox/${encodeURIComponent(box)}`, { op: `list ${box}` }), box);
  }

  async message(box, mid) {
    return normalizeMessage(await this._req('GET', `/api/mailbox/${encodeURIComponent(box)}/${encodeURIComponent(mid)}`, { op: 'read message' }), box);
  }

  /** Raw attachment bytes (Buffer). */
  async attachment(box, mid, name) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.base}/api/mailbox/${encodeURIComponent(box)}/${encodeURIComponent(mid)}/${encodeURIComponent(name)}`, { signal: ctl.signal });
      if (!res.ok) throw new PatHttpError(res.status, await res.text(), 'attachment');
      return Buffer.from(await res.arrayBuffer());
    } finally { clearTimeout(t); }
  }

  /** Pat's readHandler decodes {"Read": bool} — an empty body is a 400 ("EOF") and nothing is saved. */
  async markRead(box, mid, read = true) {
    return this._req('POST', `/api/mailbox/${encodeURIComponent(box)}/${encodeURIComponent(mid)}/read`, {
      body: JSON.stringify({ Read: !!read }), headers: { 'Content-Type': 'application/json' }, op: 'mark read',
    });
  }

  async delete(box, mid) {
    return this._req('DELETE', `/api/mailbox/${encodeURIComponent(box)}/${encodeURIComponent(mid)}`, { op: 'delete' });
  }

  /** Queue a message in the outbox. `fields` from composeFields(); files [{name, data:Buffer}]. */
  async send(fields, files = []) {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields || {})) fd.append(k, String(v));
    for (const f of files) fd.append('files', new Blob([f.data]), f.name);
    return this._req('POST', '/api/mailbox/out', { body: fd, op: 'send' });
  }

  /**
   * Run a session. Resolves with the number of messages received. Long —
   * a radio session can take many minutes — so no request timeout; the
   * caller's cap/abort ends it through disconnect().
   */
  async connect(url) {
    const r = await this._req('GET', `/api/connect?url=${encodeURIComponent(url)}`, { op: 'connect', timeoutMs: 0 });
    return r && typeof r === 'object' ? Number(r.NumReceived) || 0 : 0;
  }

  /** Ask Pat to end the session (dirty=true aborts at once). */
  async disconnect(dirty = false) {
    return this._req('POST', `/api/disconnect${dirty ? '?dirty=true' : ''}`, { op: 'disconnect', timeoutMs: 5000 });
  }

  /** Re-read config.json. Pat restarts in-process: the API and /ws drop for a moment. */
  async reload() {
    return this._req('POST', '/api/reload', { op: 'reload', timeoutMs: 5000 });
  }

  async rmslist({ mode, band, prefix, forceDownload } = {}) {
    const q = new URLSearchParams();
    if (mode) q.set('mode', mode);
    if (prefix) q.set('prefix', prefix);
    if (forceDownload) q.set('force-download', 'true');
    const list = await this._req('GET', `/api/rmslist?${q}`, { op: 'gateway list', timeoutMs: 30000 });
    return normalizeRmslist(list, { band });
  }

  async posreport({ lat, lon, comment } = {}) {
    // wl2k-go catalog.PosReport has no json tags: Lat, Lon, Comment (≤80 chars).
    const body = JSON.stringify({ Lat: Number(lat), Lon: Number(lon), Comment: String(comment || '').slice(0, 80) });
    return this._req('POST', '/api/posreport', { body, headers: { 'Content-Type': 'application/json' }, op: 'position report' });
  }

  async accountExists(callsign) {
    return this._req('GET', `/api/winlink-account/registration?callsign=${encodeURIComponent(callsign)}`, { op: 'account lookup', timeoutMs: 15000 });
  }

  async register({ callsign, password, recoveryEmail }) {
    const body = JSON.stringify({ callsign, password, recovery_email: recoveryEmail || '' });
    return this._req('POST', '/api/winlink-account/registration', { body, headers: { 'Content-Type': 'application/json' }, op: 'register', timeoutMs: 20000 });
  }

  async recoveryEmail() {
    return this._req('GET', '/api/winlink-account/password-recovery-email', { op: 'recovery email', timeoutMs: 15000 });
  }

  async setRecoveryEmail(email) {
    const body = JSON.stringify({ recovery_email: String(email || '') });
    return this._req('PUT', '/api/winlink-account/password-recovery-email', { body, headers: { 'Content-Type': 'application/json' }, op: 'recovery email', timeoutMs: 15000 });
  }

  // ── websocket ───────────────────────────────────────────────────────────

  openEvents() {
    this._wantWs = true;
    this._openWs();
  }

  _openWs() {
    if (!this._wantWs || this._ws) return;
    const ws = new WebSocket(this.base.replace(/^http/, 'ws') + '/ws');
    this._ws = ws;
    ws.on('open', () => { this._wsBackoff = 1000; this.emit('ws-open'); });
    ws.on('message', (data) => {
      let frame;
      try { frame = JSON.parse(String(data)); } catch { return; }
      const ev = classifyPatEvent(frame);
      if (ev.kind === 'ping') { try { ws.send(JSON.stringify({ Pong: true })); } catch {} return; }
      this.emit('event', ev);
    });
    ws.on('error', () => {});
    ws.on('close', () => {
      if (this._ws === ws) this._ws = null;
      this.emit('ws-closed');
      if (!this._wantWs) return;
      clearTimeout(this._wsTimer);
      this._wsTimer = setTimeout(() => this._openWs(), this._wsBackoff);
      this._wsBackoff = Math.min(this._wsBackoff * 2, 15000);
    });
  }

  /** Answer a Pat prompt (password, busy-channel "abort"/"continue", account-activation "accept"). */
  respondPrompt(id, value) {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return false;
    this._ws.send(JSON.stringify({ prompt_response: { id: String(id), value: String(value) } }));
    return true;
  }

  get eventsOpen() {
    return !!(this._ws && this._ws.readyState === WebSocket.OPEN);
  }

  close() {
    this._wantWs = false;
    clearTimeout(this._wsTimer);
    if (this._ws) { try { this._ws.terminate(); } catch {} this._ws = null; }
    this.removeAllListeners();
  }
}

module.exports = { WinlinkClient, PatHttpError };
