'use strict';
/**
 * Yaesu SCU-LAN10 transport (EXPERIMENTAL, written from the spec; nobody on
 * the team owns a unit). Same contract as the other transports
 * (lib/transport.js, lib/rsba1-transport.js): connect(opts) / write(buf) /
 * disconnect(), events 'connect' 'data' 'close' 'error' 'log', plus
 * 'audio-frame' for RX audio and 'scope-frame' for band-scope frames. RigController and the Yaesu (Kenwood-style)
 * codec attach unchanged: CAT ASCII goes in through write(), replies come out
 * on 'data'.
 *
 * Four UDP sockets, one per channel (CTRL base+0, CAT +1, AUDIO +2, SCOPE +3).
 * Session: (1) five fixed init packets, (2) login, (3) the unit answers with a
 * session id (a wrong user/password gets NO answer), (4)-(5) channel setup,
 * (6) a keepalive on every channel, then keepalives every second. Missing
 * traffic for a few seconds ends the session on both sides; the only way
 * back is the full handshake, which this transport redoes by itself until
 * disconnect().
 *
 * TX audio is not implemented (the spec has not decoded its inner header):
 * txReady is always false, and main refuses a key-down that would put a
 * silent carrier on the air.
 *
 * Logging is for testers: every phase with its timing, packet counts and
 * sizes per channel, keepalive misses, reconnects, and the first CAT
 * exchanges. Never the password, never the auth packet.
 */

const EventEmitter = require('events');
const P = require('./sculan10-protocol');

const PORTS = ['ctrl', 'cat', 'audio', 'scope'];
const CAT_LOG_FIRST = 16;        // CAT lines logged verbatim at the start of a session
const CAT_DEDUPE_MS = 1000;      // the same reply (resp_seq + text) inside this window is a duplicate

class Sculan10Transport extends EventEmitter {
  /**
   * @param {object} [deps] injectable for tests: createSocket(type) -> dgram-like
   *   socket, setTimeout/clearTimeout/setInterval/clearInterval, now()
   */
  constructor(deps = {}) {
    super();
    this._createSocket = deps.createSocket || ((type) => require('dgram').createSocket(type));
    this._setTimeout = deps.setTimeout || setTimeout;
    this._clearTimeout = deps.clearTimeout || clearTimeout;
    this._setInterval = deps.setInterval || setInterval;
    this._clearInterval = deps.clearInterval || clearInterval;
    this._now = deps.now || Date.now;
    this._connected = false;
    this._wantDisconnect = false;
    this._sockets = null;
    this._timers = new Set();
    this._intervals = new Set();
    this._reconnects = 0;
    this._attempt = 0;
    this._target = null;
    this._session = null;
  }

  get connected() { return this._connected; }
  get isOpen() { return this._connected; }
  get txReady() { return false; } // no TX audio over the SCU-LAN10 yet
  get sessionId() { return this._session ? this._session.sid : null; }

  // ---- lifecycle ---------------------------------------------------------

  connect(opts = {}) {
    this._wantDisconnect = false;
    this._opts = {
      host: String(opts.host || '').trim(),
      basePort: Number(opts.basePort) || P.DEFAULT_BASE_PORT,
      username: opts.username == null || opts.username === '' ? P.DEFAULT_USER : String(opts.username),
      password: opts.password == null || opts.password === '' ? P.DEFAULT_USER : String(opts.password),
      loginTimeoutMs: opts.loginTimeoutMs || 5000,
      ackWaitMs: opts.ackWaitMs || 400,
      stepGapMs: opts.stepGapMs == null ? 180 : opts.stepGapMs,
      keepaliveMs: opts.keepaliveMs || 1000,
      sessionLossMs: opts.sessionLossMs || 6000,
      reconnectMinMs: opts.reconnectMinMs || 2000,
      reconnectMaxMs: opts.reconnectMaxMs || 30000,
      statsEveryMs: opts.statsEveryMs || 300000,
    };
    // What RigController reads back as its target: never the password.
    this._target = { type: 'yaesu-lan', host: this._opts.host, basePort: this._opts.basePort, username: this._opts.username };
    if (!this._opts.host) {
      this.emit('error', new Error('SCU-LAN10: no address set for the unit (factory default 192.168.49.1)'));
      return;
    }
    this._startSession();
  }

  disconnect() {
    this._wantDisconnect = true;
    this._teardown('disconnect');
  }

  // ---- outbound ----------------------------------------------------------

  /** CAT ASCII from the codec. Each command is its own packet, sent twice with one cmd_seq. */
  write(data) {
    const s = this._session;
    if (!this._connected || !s) return false;
    const text = Buffer.isBuffer(data) ? data.toString('latin1') : String(data);
    for (const cmd of P.splitCatCommands(text)) {
      s.cmdSeq = (s.cmdSeq % 255) + 1;
      const body = P.catCommandBody(s.sid, s.cmdSeq, cmd);
      this._send('cat', P.CHANNEL.CAT, P.MSG.DATA, body);
      this._send('cat', P.CHANNEL.CAT, P.MSG.DATA, body);
      if (s.catLogged < CAT_LOG_FIRST) { s.catLogged++; this._log(`CAT > ${cmd}`); }
    }
    return true;
  }

  // ---- session -----------------------------------------------------------

  _startSession() {
    this._attempt++;
    const o = this._opts;
    const s = this._session = {
      sid: null, caps: '', phase: 1, startedAt: this._now(), cmdSeq: 0,
      seq: { ctrl: 0, cat: 0, audio: 0, scope: 0 },
      stats: Object.fromEntries(PORTS.map((p) => [p, { txPk: 0, rxPk: 0, rxMin: 0, rxMax: 0, rxLast: 0 }])),
      lastRxAt: 0, kaSent: 0, kaAcked: 0, kaMisses: 0, kaPending: false,
      catLogged: 0, catRxLogged: 0, catDupes: 0, recent: new Map(),
      audioFrames: 0, audioLost: 0, lastFrameSeq: null, waitAck: null, scopePk: 0, scopeLost: 0, lastScopeSeq: null, firstScopeAt: 0,
    };
    this._log(`connecting to ${o.host} ports ${o.basePort}-${o.basePort + 3} as "${o.username}" (attempt ${this._attempt}${this._reconnects ? `, reconnect ${this._reconnects}` : ''})`);
    try {
      this._sockets = {};
      for (const name of PORTS) {
        const sock = this._createSocket('udp4');
        sock.on('message', (msg, rinfo) => this._onMessage(name, msg, rinfo));
        sock.on('error', (err) => this._onSocketError(name, err));
        this._sockets[name] = sock;
        sock.bind(0);
      }
    } catch (err) {
      this._fail(new Error(`SCU-LAN10: could not open UDP sockets: ${err.message || err}`));
      return;
    }
    // Phase 1: the five fixed packets, verbatim.
    for (const pkt of P.INIT_PACKETS) this._sendRaw('ctrl', pkt);
    s.seq.ctrl = 5;
    this._log('phase 1: 5 init packets sent on CTRL');
    // Phase 2: login. The packet carries the password: it is never logged.
    s.phase = 2;
    s.seq.ctrl = P.AUTH_SEQ;
    this._sendRaw('ctrl', P.buildAuthPacket(o.username, o.password));
    this._log(`phase 2: login sent as "${o.username}" (password not logged)`);
    s.loginTimer = this._timer(() => {
      if (this._session !== s || s.phase !== 2) return;
      const err = new Error(`SCU-LAN10: no answer from the SCU-LAN10 at ${o.host}:${o.basePort} after ${Math.round(o.loginTimeoutMs / 1000)} s: check the address, port and user/password (a wrong password gets no reply at all), and close PCC-LAN10 or any other program using the unit (one client at a time).`);
      err.code = 'SCULAN10_LOGIN_TIMEOUT';
      this._fail(err);
    }, o.loginTimeoutMs);
  }

  async _runSetup(s) {
    const o = this._opts;
    s.phase = 4;
    for (const step of P.setupSteps(s.sid)) {
      if (this._session !== s) return;
      const t0 = this._now();
      const acked = await this._sendAndWait(s, step);
      if (this._session !== s) return;
      this._log(`phase ${step.name === 'continuation' ? 4 : 5}: ${step.name} ${acked ? `acked in ${this._now() - t0} ms` : `no ack within ${o.ackWaitMs} ms (continuing)`}`);
      if (o.stepGapMs) await this._sleep(o.stepGapMs);
    }
    if (this._session !== s) return;
    // Phase 6: one keepalive per channel, then every second.
    s.phase = 6;
    this._keepalives(s);
    this._interval(() => { if (this._session === s) this._keepalives(s); }, o.keepaliveMs);
    this._interval(() => this._watchdog(s), 1000);
    this._interval(() => { if (this._session === s) this._logStats('periodic'); }, o.statsEveryMs);
    this._timer(() => { if (this._session === s) this._logStats('10 s after connect'); }, 10000);
    s.phase = 7;
    s.readyAt = this._now();
    this._connected = true;
    this._reconnects = 0;
    this._log(`phase 7: session 0x${s.sid.toString(16).padStart(2, '0')} up in ${s.readyAt - s.startedAt} ms: CAT and RX audio streaming`);
    this.emit('connect');
  }

  _sendAndWait(s, step) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok) => { if (done) return; done = true; s.waitAck = null; resolve(ok); };
      s.waitAck = { port: step.port, msgType: step.ack, resolve: () => finish(true) };
      this._send(step.port, step.channel, step.msgType, step.body);
      this._timer(() => finish(false), this._opts.ackWaitMs);
    });
  }

  _keepalives(s) {
    // A CTRL keepalive that was never acked before the next one is a miss.
    if (s.kaPending) {
      s.kaMisses++;
      if (s.kaMisses <= 3 || s.kaMisses % 30 === 0) this._log(`keepalive miss #${s.kaMisses} (CTRL keepalive not acked within ${this._opts.keepaliveMs} ms)`);
    }
    s.kaPending = true;
    s.kaSent++;
    this._send('ctrl', P.CHANNEL.CTRL, P.MSG.KEEPALIVE, P.KEEPALIVE_BODY);
    this._send('cat', P.CHANNEL.CAT, P.MSG.KEEPALIVE, P.KEEPALIVE_BODY);
    this._send('audio', P.CHANNEL.AUDIO, P.MSG.KEEPALIVE, P.KEEPALIVE_BODY);
    this._send('scope', P.CHANNEL.SCOPE, P.MSG.KEEPALIVE, P.KEEPALIVE_BODY);
  }

  _watchdog(s) {
    if (this._session !== s || !this._connected) return;
    const quiet = this._now() - (s.lastRxAt || s.readyAt);
    if (quiet >= this._opts.sessionLossMs) {
      const err = new Error(`SCU-LAN10: nothing received from ${this._opts.host} for ${Math.round(quiet / 1000)} s: session lost (another program may have logged in, the network dropped, or the unit restarted); reconnecting with a full handshake.`);
      err.code = 'SCULAN10_SESSION_LOST';
      this._fail(err);
    }
  }

  // ---- inbound -----------------------------------------------------------

  _onMessage(port, msg, rinfo) {
    const s = this._session;
    if (!s || !this._sockets) return;
    const st = s.stats[port];
    st.rxPk++;
    st.rxLast = msg.length;
    st.rxMin = st.rxMin ? Math.min(st.rxMin, msg.length) : msg.length;
    st.rxMax = Math.max(st.rxMax, msg.length);
    const p = P.parsePacket(msg);
    if (!p) {
      if (!s.badLogged) { s.badLogged = true; this._log(`dropped a malformed ${msg.length}-byte packet on ${port.toUpperCase()} (bad header; logged once)`); }
      return;
    }
    s.lastRxAt = this._now();
    if (s.waitAck && s.waitAck.port === port && s.waitAck.msgType === p.msgType) s.waitAck.resolve();

    if (port === 'ctrl' && p.msgType === P.MSG.AUTH_RESP) {
      if (s.phase !== 2) return;
      const r = P.parseAuthResponse(p.body);
      if (!r) return;
      s.sid = r.sessionId;
      s.caps = r.caps;
      if (s.loginTimer) this._clearTimeout(s.loginTimer);
      s.phase = 3;
      this._log(`phase 3: logged in after ${this._now() - s.startedAt} ms: session 0x${s.sid.toString(16).padStart(2, '0')}, capability bytes ${s.caps || '(none)'}${s.caps && s.caps !== '0125013f51' ? ' (differs from the spec\'s 0125013f51: please include this line in a report)' : ''}`);
      this._runSetup(s).catch((e) => this._fail(e));
      return;
    }
    if (port === 'ctrl' && p.msgType === P.MSG.KEEPALIVE_ACK) { s.kaPending = false; s.kaAcked++; return; }
    if (p.msgType !== P.MSG.DATA_IN) return;
    if (port === 'cat') return this._onCat(s, p.body);
    if (port === 'audio') return this._onAudio(s, p.body);
    if (port === 'scope') return this._onScope(s, p);
  }

  _onCat(s, body) {
    const r = P.parseCatResponse(body);
    if (!r || !r.text) return;
    // The same reply twice (resp_seq and text) inside a second is a UDP
    // duplicate. Unsolicited meters (RM...) repeat on purpose, with new seqs.
    const now = this._now();
    const k = `${r.respSeq}|${r.text}`;
    const seen = s.recent.get(k);
    if (seen && now - seen < CAT_DEDUPE_MS) { s.catDupes++; return; }
    s.recent.set(k, now);
    if (s.recent.size > 64) for (const [kk, t] of s.recent) if (now - t >= CAT_DEDUPE_MS) s.recent.delete(kk);
    if (s.catRxLogged < CAT_LOG_FIRST) { s.catRxLogged++; this._log(`CAT < ${r.text.replace(/[^\x20-\x7E]/g, '.')}`); }
    this.emit('data', Buffer.from(r.text, 'latin1'));
  }

  // Scope frames are decoded in lib/sculan10-scope.js; the transport only
  // counts them (rate, and gaps in the unit's own packet sequence) and hands
  // them on.
  _onScope(s, p) {
    if (s.lastScopeSeq != null) {
      const gap = (p.seq - s.lastScopeSeq - 1 + 256) & 0xFF;
      if (gap && gap < 128) s.scopeLost += gap;
    }
    s.lastScopeSeq = p.seq;
    s.scopePk++;
    if (!s.firstScopeAt) s.firstScopeAt = this._now();
    this.emit('scope-frame', { body: p.body, seq: p.seq, recvMs: this._now() });
  }

  _onAudio(s, body) {
    const a = P.parseRxAudio(body);
    if (!a || !a.pcm.length) return;
    if (s.lastFrameSeq != null) {
      const gap = (a.frameSeq - s.lastFrameSeq - 1 + 256) & 0xFF;
      if (gap && gap < 128) s.audioLost += gap;
    }
    s.lastFrameSeq = a.frameSeq;
    s.audioFrames++;
    if (s.audioFrames === 1) this._log(`RX audio: first frame ${a.payloadBytes} bytes, ${a.sampleRate} Hz stereo (format ${a.format}); channel 0 (speaker) is used`);
    this.emit('audio-frame', { pcm: a.pcm, sampleRate: a.sampleRate, frameSeq: a.frameSeq, payloadBytes: a.payloadBytes, recvMs: this._now() });
  }

  // ---- plumbing ----------------------------------------------------------

  _send(port, channel, msgType, body) {
    const s = this._session;
    if (!s) return;
    s.seq[port] = (s.seq[port] + 1) & 0xFF;
    this._sendRaw(port, P.buildPacket({ seq: s.seq[port], channel, msgType, body }));
  }

  _sendRaw(port, buf) {
    const sock = this._sockets && this._sockets[port];
    if (!sock) return;
    const s = this._session;
    if (s) s.stats[port].txPk++;
    try {
      sock.send(buf, this._opts.basePort + P.PORT_OFFSET[port], this._opts.host, (err) => {
        if (err) this._onSocketError(port, err);
      });
    } catch (err) { this._onSocketError(port, err); }
  }

  _onSocketError(port, err) {
    if (this._wantDisconnect) return;
    const e = new Error(`SCU-LAN10: ${port.toUpperCase()} socket error: ${err && err.message ? err.message : err}`);
    e.code = err && err.code;
    this._fail(e);
  }

  _fail(err) {
    if (this._failing) return;
    this._failing = true;
    try {
      this.emit('error', err);
      this._teardown(err.code || 'error');
      if (!this._wantDisconnect) this._scheduleReconnect();
    } finally { this._failing = false; }
  }

  _scheduleReconnect() {
    this._reconnects++;
    const o = this._opts;
    const delay = Math.min(o.reconnectMaxMs, o.reconnectMinMs * Math.pow(2, Math.min(this._reconnects - 1, 4)));
    this._log(`reconnect #${this._reconnects} in ${Math.round(delay / 1000)} s`);
    this._reconnectTimer = this._setTimeout(() => {
      this._reconnectTimer = null;
      if (!this._wantDisconnect) this._startSession();
    }, delay);
  }

  _teardown(reason) {
    const s = this._session;
    if (s && s.phase >= 6) this._logStats(`session end (${reason})`);
    for (const t of this._timers) this._clearTimeout(t);
    for (const t of this._intervals) this._clearInterval(t);
    this._timers.clear();
    this._intervals.clear();
    if (this._wantDisconnect && this._reconnectTimer) { this._clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    if (s && s.waitAck) s.waitAck.resolve();
    this._session = null;
    if (this._sockets) {
      for (const sock of Object.values(this._sockets)) { try { sock.close(); } catch {} }
      this._sockets = null;
    }
    const was = this._connected;
    this._connected = false;
    if (was) this.emit('close');
  }

  _logStats(when) {
    const s = this._session;
    if (!s) return;
    const ch = PORTS.map((p) => {
      const t = s.stats[p];
      return `${p.toUpperCase()} tx ${t.txPk} rx ${t.rxPk}${t.rxPk ? ` (${t.rxMin === t.rxMax ? `${t.rxMax} B` : `${t.rxMin}-${t.rxMax} B`})` : ''}`;
    }).join(', ');
    const scopeSecs = s.firstScopeAt ? (this._now() - s.firstScopeAt) / 1000 : 0;
    const scopeRate = scopeSecs >= 1 ? ` (${(s.scopePk / scopeSecs).toFixed(1)}/s)` : '';
    this._log(`stats, ${when}: ${ch}; keepalives ${s.kaAcked}/${s.kaSent} acked, ${s.kaMisses} missed; CAT duplicates dropped ${s.catDupes}; RX audio frames ${s.audioFrames}, lost ${s.audioLost}; scope frames ${s.scopePk}${scopeRate}, lost ${s.scopeLost}; reconnects so far ${this._reconnectsTotal()}`);
  }

  _reconnectsTotal() { return Math.max(0, this._attempt - 1); }

  _timer(fn, ms) {
    const t = this._setTimeout(() => { this._timers.delete(t); fn(); }, ms);
    this._timers.add(t);
    return t;
  }

  _interval(fn, ms) {
    const t = this._setInterval(fn, ms);
    this._intervals.add(t);
    return t;
  }

  _sleep(ms) { return new Promise((r) => this._timer(r, ms)); }

  _log(msg) { this.emit('log', `[SCU-LAN10] ${msg}`); }
}

module.exports = { Sculan10Transport };
