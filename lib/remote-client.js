// POTACAT laptop-side ECHOCAT WebSocket client.
//
// Mirrors what the mobile app's EchocatClient.ts does, but for the
// desktop renderer's main process: dials a paired shack, authenticates
// with the long-lived deviceToken minted at pair time, and proxies
// rig control (tune/mode/PTT) + status reads as the renderer's "rig
// backend." Phase 1 of the desktop-to-desktop initiative — see
// docs/remote-desktop-plan.md.
//
// Lifecycle (events emitted):
//   'log'         — diagnostic messages routed to sendCatLog in main.js
//   'connecting'  — dial attempt started against {leg, host}
//   'connected'   — auth-ok received; useful payload fields surfaced
//   'disconnected'— socket closed, reconnect scheduled
//   'kicked'      — shack displaced us (another client took over)
//   'auth-fail'   — credentials rejected (token expired or revoked)
//   'status'      — status snapshot from shack {freq, mode, smeter, …}
//   'spots'       — spots-update push (legacy 'spots' type for v1.9)
//   'rig-state'   — radio meter snapshot for the renderer's rig panel
//   'error'       — transport error, transient
//
// Three-leg dial chain: LAN → Tailscale → Cloud Tunnel. First leg that
// connects + authenticates wins. Cert pinning on the first two (the
// shack's TLS is self-signed or a Tailscale-issued LE cert; we verify
// the fingerprint we got at pair time). Cloud leg uses the standard
// CA chain (Cloudflare edge cert).

'use strict';

const EventEmitter = require('events');
const WebSocket = require('ws');
const https = require('https');
const protocol = require('./echocat-protocol');

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const PING_INTERVAL_MS = 25000;
const PING_TIMEOUT_MS = 8000;
const DIAL_TIMEOUT_MS = 6000;

class RemoteClient extends EventEmitter {
  constructor(target, opts = {}) {
    super();
    if (!target || typeof target !== 'object') {
      throw new Error('RemoteClient requires a target row');
    }
    this._target = target;
    this._clientVersion = String(opts.clientVersion || '');
    this._clientPlatform = String(opts.clientPlatform || ('desktop-' + process.platform));
    this._ws = null;
    this._closed = false;
    this._reconnectTimer = null;
    this._pingTimer = null;
    this._pingTimeoutTimer = null;
    this._reconnectAttempts = 0;
    this._authed = false;
    this._currentLeg = null; // 'lan' | 'tailscale' | 'cloud'
    this._lastError = '';
  }

  /** Snapshot of connection state for the renderer's status chip. */
  state() {
    return {
      targetId: this._target.id,
      name: this._target.name,
      authed: this._authed,
      leg: this._currentLeg,
      lastError: this._lastError,
      readyState: this._ws ? this._ws.readyState : -1,
    };
  }

  /**
   * Open a connection. Walks the three legs in priority order; the
   * first leg that completes the v1 hello + auth handshake wins. On
   * failure, schedules a reconnect with exponential backoff (capped
   * at 30s). Idempotent — calling connect() while already connected
   * is a no-op.
   */
  connect() {
    if (this._closed) {
      this._closed = false; // re-arming
    }
    if (this._ws && this._ws.readyState <= WebSocket.OPEN) return;
    this._dial();
  }

  /**
   * Tear down the connection and stop reconnecting. After close()
   * the client can be discarded — re-connecting requires constructing
   * a new RemoteClient instance, since the target row may have
   * changed.
   */
  close() {
    this._closed = true;
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    this._teardownPing();
    if (this._ws) {
      try { this._ws.close(1000, 'client close'); } catch {}
      try { this._ws.terminate(); } catch {}
      this._ws = null;
    }
    this._authed = false;
    this._currentLeg = null;
  }

  /** Send a tune frame. Mirrors the renderer's IPC `tune` shape. */
  sendTune({ frequency, mode, bearing }) {
    if (!frequency) return;
    // Wire format: freqKhz as STRING (see docs/echocat-protocol.md Gap 5).
    const freqKhz = (Number(frequency) / 1000).toFixed(3);
    const msg = { type: 'tune', freqKhz: String(freqKhz) };
    if (mode) msg.mode = String(mode);
    if (typeof bearing === 'number') msg.bearing = bearing;
    this._send(msg);
  }

  sendSetMode(mode) {
    if (!mode) return;
    this._send({ type: 'set-mode', mode: String(mode) });
  }

  sendPtt(state) {
    this._send({ type: 'ptt', state: !!state });
  }

  sendEstop() {
    this._send({ type: 'estop' });
  }

  sendSetVfo(vfo) {
    this._send({ type: 'set-vfo', vfo: String(vfo || 'A') });
  }

  sendSwapVfo() {
    this._send({ type: 'swap-vfo' });
  }

  sendRaw(msg) {
    if (!msg || typeof msg !== 'object' || !msg.type) return;
    this._send(msg);
  }

  // ───────────────────────── internal ─────────────────────────────

  _candidates() {
    const t = this._target;
    const out = [];
    if (t.lanHost) out.push({ leg: 'lan', wssUrl: t.lanHost, pin: t.fingerprint });
    if (t.tsHost) out.push({ leg: 'tailscale', wssUrl: `wss://${t.tsHost}:7300`, pin: t.fingerprint });
    if (t.cloudHost) out.push({ leg: 'cloud', wssUrl: `wss://${t.cloudHost}`, pin: '' });
    return out;
  }

  _dial() {
    if (this._closed) return;
    const candidates = this._candidates();
    if (candidates.length === 0) {
      this.emit('log', `[RemoteClient] No dialable legs on target ${this._target.id}`);
      this._scheduleReconnect();
      return;
    }
    this._dialNext(candidates, 0);
  }

  _dialNext(candidates, idx) {
    if (this._closed) return;
    if (idx >= candidates.length) {
      this._scheduleReconnect();
      return;
    }
    const cand = candidates[idx];
    this._currentLeg = cand.leg;
    this.emit('connecting', { leg: cand.leg, host: cand.wssUrl });
    this.emit('log', `[RemoteClient] dialing ${cand.leg} ${cand.wssUrl}`);

    let httpsUrl;
    try {
      httpsUrl = new URL(cand.wssUrl.replace(/^wss:/i, 'https:'));
    } catch {
      this._dialNext(candidates, idx + 1);
      return;
    }

    // Cert-pinning agent for LAN / Tailscale legs. The shack's TLS
    // cert is self-signed or a Tailscale-issued LE cert; we
    // authenticate it by SHA-256 fingerprint we captured at pair
    // time. The `ws` library accepts an `agent` option via the
    // request options it forwards to https.
    let agent;
    if (cand.pin) {
      agent = new https.Agent({
        rejectUnauthorized: false, // we'll verify the fingerprint ourselves
      });
    }

    const ws = new WebSocket(cand.wssUrl, {
      agent,
      handshakeTimeout: DIAL_TIMEOUT_MS,
      headers: {
        'User-Agent': 'POTACAT-Desktop/' + this._clientVersion,
      },
    });

    let opened = false;
    let pinChecked = false;

    // Verify the pin on first response. ws emits 'upgrade' carrying
    // the underlying http.IncomingMessage from which we can pull the
    // peer cert. Pre-upgrade is the only time we can refuse cleanly
    // before any frames flow.
    ws.on('upgrade', (res) => {
      if (!cand.pin) { pinChecked = true; return; }
      try {
        const cert = res.socket && res.socket.getPeerCertificate ? res.socket.getPeerCertificate() : null;
        const got = (cert && cert.fingerprint256 || '').toUpperCase().replace(/:/g, '');
        const want = String(cand.pin || '').toUpperCase().replace(/:/g, '');
        if (!got || got !== want) {
          this.emit('log', `[RemoteClient] ${cand.leg} fingerprint mismatch (got ${got.slice(0, 16) || 'none'}…, want ${want.slice(0, 16)}…)`);
          try { ws.terminate(); } catch {}
          this._dialNext(candidates, idx + 1);
          return;
        }
        pinChecked = true;
      } catch (err) {
        this.emit('log', `[RemoteClient] ${cand.leg} cert read failed: ${err.message || err}`);
      }
    });

    ws.on('open', () => {
      opened = true;
      this._reconnectAttempts = 0;
      this._lastError = '';
      // Send our v1 client hello first; the server's auth-mode arrives
      // after its hello reply.
      this._ws = ws;
      this._send(protocol.buildClientHello({
        clientVersion: this._clientVersion,
        clientPlatform: this._clientPlatform,
      }));
    });

    ws.on('message', (raw) => this._handleMessage(raw));

    ws.on('close', (code, reasonBuf) => {
      const reason = reasonBuf ? reasonBuf.toString('utf8').slice(0, 200) : '';
      this._teardownPing();
      if (!opened) {
        // Dial failed before we ever got a frame — try the next leg.
        this.emit('log', `[RemoteClient] ${cand.leg} close before open (code=${code} reason="${reason}")`);
        this._dialNext(candidates, idx + 1);
        return;
      }
      // We were live and lost it — emit and schedule reconnect.
      const wasAuthed = this._authed;
      this._authed = false;
      this._ws = null;
      this._currentLeg = null;
      this.emit('disconnected', { code, reason, wasAuthed });
      if (!this._closed) this._scheduleReconnect();
    });

    ws.on('error', (err) => {
      this._lastError = err.message || String(err);
      this.emit('log', `[RemoteClient] ${cand.leg} error: ${this._lastError}`);
      this.emit('error', err);
      // Close handler runs after error; reconnect scheduling lives there.
    });
  }

  _handleMessage(raw) {
    let msg;
    try { msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8')); }
    catch { return; }
    if (!msg || typeof msg !== 'object' || !msg.type) return;

    switch (msg.type) {
      case 'hello': {
        // Server hello — record protocol version and rigModel.
        const compat = protocol.checkCompatibility(msg.protocolVersion);
        if (!compat.compatible) {
          this.emit('log', `[RemoteClient] protocol incompatible: ${compat.reason}`);
          try { this._ws.close(protocol.CLOSE_CODES.PROTOCOL_VERSION_UNSUPPORTED, compat.reason); } catch {}
          return;
        }
        if (msg.rigModel) this._target.rigModel = String(msg.rigModel);
        this.emit('hello', { serverVersion: msg.serverVersion, rigModel: msg.rigModel });
        break;
      }
      case 'auth-mode': {
        // Server asking for credentials. We always present the
        // deviceToken we got at pair-link redemption time.
        this._send({ type: 'auth', token: this._target.deviceToken });
        break;
      }
      case 'auth-ok': {
        this._authed = true;
        this._target.lastConnectedAt = Date.now();
        this._target.lastReachableLeg = this._currentLeg;
        this._setupPing();
        this.emit('connected', {
          expiresAt: msg.expiresAt,
          accountLinked: !!msg.accountLinked,
          trusted: !!msg.trusted,
          settings: msg.settings,
        });
        break;
      }
      case 'auth-fail': {
        const reason = msg.reason || 'unknown';
        this.emit('log', `[RemoteClient] auth-fail: ${reason}`);
        this.emit('auth-fail', { reason });
        // 'expired' / 'revoked' shouldn't bounce-reconnect. Close.
        this._closed = true;
        try { this._ws.close(1000, 'auth failed'); } catch {}
        break;
      }
      case 'kicked': {
        this.emit('kicked', {
          reason: msg.reason || 'displaced',
          byPlatform: msg.byPlatform || '',
          byVersion: msg.byVersion || '',
          byHost: msg.byHost || '',
        });
        // The shack will close the socket on its end momentarily.
        break;
      }
      case 'status': {
        this.emit('status', msg);
        break;
      }
      case 'rig-state': {
        this.emit('rig-state', msg);
        break;
      }
      case 'spots': {
        if (Array.isArray(msg.data)) this.emit('spots', msg.data);
        break;
      }
      case 'spots:update': {
        if (Array.isArray(msg.data)) this.emit('spots', msg.data);
        break;
      }
      case 'alt-hosts': {
        // Shack refreshed its alternate hostnames — update our row so
        // future reconnects use the new ones.
        if (msg.tsHost) this._target.tsHost = String(msg.tsHost);
        if (msg.cloudHost) this._target.cloudHost = String(msg.cloudHost);
        this.emit('alt-hosts', { tsHost: msg.tsHost, cloudHost: msg.cloudHost });
        break;
      }
      case 'tune-blocked': {
        this.emit('tune-blocked', { reason: msg.reason || 'blocked' });
        break;
      }
      case 'pong': {
        if (this._pingTimeoutTimer) {
          clearTimeout(this._pingTimeoutTimer);
          this._pingTimeoutTimer = null;
        }
        break;
      }
      default: {
        // Forward unhandled types so the renderer-side (if it cares)
        // can wire them in later. Keeps the wire bidirectional without
        // forcing this module to track every protocol message type.
        this.emit('message', msg);
      }
    }
  }

  _send(msg) {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    try {
      this._ws.send(JSON.stringify(msg));
    } catch (err) {
      this.emit('log', `[RemoteClient] send failed: ${err.message || err}`);
    }
  }

  _setupPing() {
    this._teardownPing();
    this._pingTimer = setInterval(() => {
      if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
      this._send({ type: 'ping', ts: Date.now() });
      // Watch for pong arrival; if it doesn't land, the link is dead
      // and we tear the socket down so reconnect kicks in.
      if (this._pingTimeoutTimer) clearTimeout(this._pingTimeoutTimer);
      this._pingTimeoutTimer = setTimeout(() => {
        this.emit('log', '[RemoteClient] ping timeout — terminating');
        try { this._ws.terminate(); } catch {}
      }, PING_TIMEOUT_MS);
    }, PING_INTERVAL_MS);
  }

  _teardownPing() {
    if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
    if (this._pingTimeoutTimer) { clearTimeout(this._pingTimeoutTimer); this._pingTimeoutTimer = null; }
  }

  _scheduleReconnect() {
    if (this._closed) return;
    if (this._reconnectTimer) return;
    this._reconnectAttempts++;
    const base = Math.min(RECONNECT_BASE_MS * Math.pow(2, this._reconnectAttempts - 1), RECONNECT_MAX_MS);
    // ±25% jitter so a fleet of laptops doesn't synchronize on the
    // shack after a network blip.
    const jitter = base * (0.75 + Math.random() * 0.5);
    const delay = Math.floor(jitter);
    this.emit('log', `[RemoteClient] reconnect in ${delay}ms (attempt ${this._reconnectAttempts})`);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._dial();
    }, delay);
  }
}

module.exports = { RemoteClient };
