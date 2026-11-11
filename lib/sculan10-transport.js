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
 * TX audio (voice): startVoiceTx() / pushVoiceChunk(16 kHz mono) /
 * stopVoiceTx(), the same contract as lib/rsba1-transport.js. The format is
 * the one Yaesu's own Remote software sends (see txAudioBody in
 * lib/sculan10-protocol.js), verified on an FT-710 on the air (#227). PTT
 * stays CAT TX1;/TX0;: the stream alone never keys the radio, and a radio
 * keyed when the stream stops sends a silent carrier until TX0; arrives.
 * So a session lost while keyed (RF on the unit's USB cable did that at
 * 100 W, 2026-11-10) sends TX0; as soon as the next session is up.
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
    // One DNS lookup per session (IPv4 only: the unit has no IPv6), so a
    // name that does not resolve fails that session once, not per packet.
    this._lookup = deps.lookup || ((host, cb) => require('dns').lookup(host, { family: 4 }, cb));
    // main.js forwards this transport's log lines itself; RigController must
    // not forward them too, or every line prints twice (the RS-BA1 lesson).
    this.routesOwnLog = true;
    this._earlyLosses = 0;
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
    this._keyed = false;
    this._releaseOnReconnect = false;
  }

  get connected() { return this._connected; }
  get isOpen() { return this._connected; }
  get txReady() { return this._connected; }
  get voiceTxActive() { return !!(this._session && this._session.tx); }
  get sessionId() { return this._session ? this._session.sid : null; }

  // ---- lifecycle ---------------------------------------------------------

  connect(opts = {}) {
    // A second connect() replaces the first session and any pending retry.
    this._wantDisconnect = true;
    this._teardown('reconnect requested');
    this._clearReconnect();
    this._wantDisconnect = false;
    this._reconnects = 0;
    this._earlyLosses = 0;
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
      stableMs: opts.stableMs || 30000,
      // "Early" = lost within this long of logging in; the same window clears
      // the early-loss count when a session outlives it (they were 60 s and
      // 30 s, so a session lost at 45 s both counted and had just been cleared).
      earlyMs: opts.earlyMs || 60000,
      inUseLimit: opts.inUseLimit || 3,
      dataWaitMs: opts.dataWaitMs || 1500,
    };
    // What RigController reads back as its target: never the password.
    this._target = { type: 'yaesu-lan', host: this._opts.host, basePort: this._opts.basePort, username: this._opts.username };
    const bad = validateConnectOptions(this._opts);
    if (bad) {
      // A setting that can never work: said once, no retries.
      const err = new Error('SCU-LAN10: ' + bad.message);
      err.code = bad.code;
      this.emit('error', err);
      return;
    }
    this._startSession();
  }

  disconnect() {
    // Never leave the radio keyed behind us: the codec's TX0; may still be
    // queued when the rig is switched or POTACAT quits.
    const release = this._keyed && this._connected;
    if (release) { this.write('TX0;'); this._log('disconnect while keyed: TX0; sent first'); }
    this._wantDisconnect = true;
    this._lingerClose = release;
    this._clearReconnect();
    this._teardown('disconnect');
  }

  _clearReconnect() {
    if (this._reconnectTimer) { this._clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
  }

  // ---- outbound ----------------------------------------------------------

  /** CAT ASCII from the codec. Each command is its own packet, sent twice with one cmd_seq. */
  write(data) {
    const s = this._session;
    if (!this._connected || !s) return false;
    const text = Buffer.isBuffer(data) ? data.toString('latin1') : String(data);
    for (const cmd of P.splitCatCommands(text)) {
      // Track the PTT the codec asked for: a session lost while keyed must
      // send TX0; once the unit is back (see _teardown / _runSetup).
      if (/^TX[12];$/i.test(cmd)) this._keyed = true;
      else if (/^TX0;$/i.test(cmd)) this._keyed = false;
      s.cmdSeq = (s.cmdSeq % 255) + 1;
      const body = P.catCommandBody(s.sid, s.cmdSeq, cmd);
      this._send('cat', P.CHANNEL.CAT, P.MSG.DATA, body);
      this._send('cat', P.CHANNEL.CAT, P.MSG.DATA, body);
      if (s.catLogged < CAT_LOG_FIRST) { s.catLogged++; this._log(`CAT > ${cmd}`); }
    }
    return true;
  }

  /** Open the TX audio stream (an empty packet first, as Yaesu's software does). */
  startVoiceTx() {
    const s = this._session;
    if (!this._connected || !s) throw new Error('SCU-LAN10 not connected');
    if (s.tx) return;
    s.tx = { seq: 0, pending: new Float32Array(0), frames: 0, dropped: 0, startedAt: this._now() };
    this._sendTxAudio(s, Buffer.alloc(0));
    this._log('TX audio: stream opened (16 kHz stereo S16LE, 10 ms frames, each sent twice)');
  }

  /**
   * Mono Float32 at 16 kHz from the mic. Sent as full 10 ms frames as soon as
   * they fill; the mic's own clock paces the stream. More than 300 ms backed
   * up means the mic outran the network: the oldest audio is dropped rather
   * than letting the delay grow for the rest of the over.
   */
  pushVoiceChunk(samples) {
    const s = this._session;
    if (!s || !s.tx || !samples || !samples.length) return;
    const tx = s.tx;
    const joined = new Float32Array(tx.pending.length + samples.length);
    joined.set(tx.pending, 0);
    joined.set(samples, tx.pending.length);
    const F = P.TX_AUDIO_FRAME_SAMPLES;
    let off = 0;
    const max = Math.round(P.TX_AUDIO_RATE * 0.3);
    if (joined.length > max) { off = joined.length - max - ((joined.length - max) % F); tx.dropped += off; }
    for (; off + F <= joined.length; off += F) this._sendTxAudio(s, P.txAudioPcm(joined.subarray(off, off + F)));
    tx.pending = joined.slice(off);
  }

  stopVoiceTx() {
    const s = this._session;
    if (!s || !s.tx) return;
    const tx = s.tx;
    // The last partial frame, padded with silence, so the over's tail is not lost.
    if (tx.pending.length) {
      const last = new Float32Array(P.TX_AUDIO_FRAME_SAMPLES);
      last.set(tx.pending.subarray(0, P.TX_AUDIO_FRAME_SAMPLES));
      this._sendTxAudio(s, P.txAudioPcm(last));
    }
    s.tx = null;
    this._log(`TX audio: stream closed after ${((this._now() - tx.startedAt) / 1000).toFixed(1)} s, ${tx.frames} frames${tx.dropped ? `, ${tx.dropped} samples dropped (mic ran ahead)` : ''}`);
  }

  _sendTxAudio(s, pcm) {
    const body = P.txAudioBody(s.sid, s.tx.seq, pcm);
    s.tx.seq = (s.tx.seq + 1) & 0xFFFF;
    if (pcm.length) s.tx.frames++;
    // Resend mode 1: the same frame (same frame seq) twice, as Yaesu sends it.
    this._send('audio', P.CHANNEL.AUDIO, P.MSG.DATA, body);
    this._send('audio', P.CHANNEL.AUDIO, P.MSG.DATA, body);
  }

  // ---- session -----------------------------------------------------------

  _startSession() {
    this._attempt++;
    const o = this._opts;
    const s = this._session = {
      sockets: null, addr: null,
      sid: null, caps: '', phase: 1, startedAt: this._now(), cmdSeq: 0,
      seq: { ctrl: 0, cat: 0, audio: 0, scope: 0 }, setupAcks: 0, dataSeen: false, unknownLogged: {},
      stats: Object.fromEntries(PORTS.map((p) => [p, { txPk: 0, rxPk: 0, rxMin: 0, rxMax: 0, rxLast: 0 }])),
      lastRxAt: 0, kaSent: 0, kaAcked: 0, kaMisses: 0, kaPending: false,
      catLogged: 0, catRxLogged: 0, catDupes: 0, recent: new Map(),
      audioFrames: 0, audioLost: 0, lastFrameSeq: null, waitAck: null, scopePk: 0, scopeLost: 0, lastScopeSeq: null, firstScopeAt: 0,
    };
    this._log(`connecting to ${o.host} ports ${o.basePort}-${o.basePort + 3} as "${o.username}" (attempt ${this._attempt}${this._reconnects ? `, reconnect ${this._reconnects}` : ''})`);
    const begin = (addr) => {
      if (this._session !== s) return;
      s.addr = addr;
      try {
        s.sockets = {};
        this._sockets = s.sockets;
        for (const name of PORTS) {
          const sock = this._createSocket('udp4');
          // Every handler is tied to THIS session: an error or packet that
          // lands after it ended is ignored, so one bad session can never
          // schedule more than one retry (the reviewer's reconnect storm).
          sock.on('message', (msg, rinfo) => { if (this._session === s) this._onMessage(name, msg, rinfo); });
          sock.on('error', (err) => this._onSocketError(name, err, s));
          s.sockets[name] = sock;
          sock.bind(0);
        }
      } catch (err) {
        this._fail(new Error(`SCU-LAN10: could not open UDP sockets: ${err.message || err}`), s);
        return;
      }
      this._beginLogin(s);
    };
    if (IPV4_RE.test(o.host)) { begin(o.host); return; }
    this._lookup(o.host, (err, address) => {
      if (this._session !== s) return;
      if (err || !address) {
        const e = new Error(`SCU-LAN10: the address "${o.host}" does not resolve to an IPv4 address (${err && err.code ? err.code : 'no address'}): check the Address field.`);
        e.code = 'SCULAN10_DNS';
        this._fail(e, s);
        return;
      }
      begin(address);
    });
  }

  _beginLogin(s) {
    const o = this._opts;
    // Phase 1: the five fixed packets, verbatim.
    for (const pkt of P.INIT_PACKETS) this._sendRaw('ctrl', pkt, s);
    s.seq.ctrl = 5;
    this._log('phase 1: 5 init packets sent on CTRL');
    // Phase 2: login. The packet carries the password: it is never logged.
    s.phase = 2;
    s.seq.ctrl = P.AUTH_SEQ;
    this._sendRaw('ctrl', P.buildAuthPacket(o.username, o.password), s);
    this._log(`phase 2: login sent as "${o.username}" (password not logged)`);
    s.loginTimer = this._timer(() => {
      if (this._session !== s || s.phase !== 2) return;
      const err = new Error(`SCU-LAN10: no answer from the SCU-LAN10 at ${o.host}:${o.basePort} after ${Math.round(o.loginTimeoutMs / 1000)} s: check the address, port and user/password (a wrong password gets no reply at all), and close PCC-LAN10 or any other program using the unit (one client at a time).`);
      err.code = 'SCULAN10_LOGIN_TIMEOUT';
      this._fail(err, s);
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
      if (acked) s.setupAcks++;
      this._log(`phase ${step.name === 'continuation' ? 4 : 5}: ${step.name} ${acked ? `acked in ${this._now() - t0} ms` : `no ack within ${o.ackWaitMs} ms (continuing)`}`);
      if (o.stepGapMs) await this._sleep(o.stepGapMs);
    }
    if (this._session !== s) return;
    // Phase 6: one keepalive per channel, then every second.
    s.phase = 6;
    this._keepalives(s);
    // "Connected" needs evidence the unit took the session: a setup ack or
    // data on a channel. A unit that answers only the login would otherwise
    // be announced, dropped, and announced again forever.
    if (!s.setupAcks && !s.dataSeen) {
      await this._sleep(o.dataWaitMs);
      if (this._session !== s) return;
      if (!s.setupAcks && !s.dataSeen) {
        const err = new Error(`SCU-LAN10: logged in to ${o.host}, but the unit acknowledged none of the channel setup and sent no CAT, audio or scope data within ${Math.round(o.dataWaitMs / 100) / 10} s; retrying. If this repeats, check that no other program is using the unit, and send a bug report.`);
        err.code = 'SCULAN10_NO_SETUP';
        this._fail(err, s);
        return;
      }
    }
    this._interval(() => { if (this._session === s) this._keepalives(s); }, o.keepaliveMs);
    this._interval(() => this._watchdog(s), 1000);
    this._interval(() => { if (this._session === s) this._logStats('periodic'); }, o.statsEveryMs);
    this._timer(() => { if (this._session === s) this._logStats('10 s after connect'); }, 10000);
    s.phase = 7;
    s.readyAt = this._now();
    this._connected = true;
    // The retry backoff starts over only once a session has held for a while,
    // so a unit that drops us every few seconds is not hammered every 2 s.
    this._timer(() => { if (this._session === s) this._reconnects = 0; }, o.stableMs);
    this._timer(() => { if (this._session === s) this._earlyLosses = 0; }, o.earlyMs);
    this._log(`phase 7: session 0x${s.sid.toString(16).padStart(2, '0')} up in ${s.readyAt - s.startedAt} ms: CAT (and RX audio when selected) streaming`);
    if (this._releaseOnReconnect) {
      // The last session ended with the radio keyed and its TX0; may never
      // have arrived: the radio could still be sending a silent carrier.
      this._releaseOnReconnect = false;
      this._log('the previous session was lost while keyed: sending TX0; now');
      this.write('TX0;');
    }
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
      // Lost within a minute of logging in, again and again: the unit takes
      // one client at a time and a new login takes it, so another program
      // (PCC-LAN10, FT-Control, a second POTACAT) is on it. Two programs
      // retrying would take it from each other every few seconds: stop.
      const early = this._now() - s.readyAt < this._opts.earlyMs;
      this._earlyLosses = early ? this._earlyLosses + 1 : 0;
      if (this._earlyLosses >= this._opts.inUseLimit) {
        const err = new Error(`SCU-LAN10: the unit at ${this._opts.host} dropped POTACAT within a minute of logging in ${this._earlyLosses} times in a row. Another program (PCC-LAN10, FT-Control or a second POTACAT) is probably using it: the unit takes one client at a time and each new login takes it over. POTACAT stopped trying. Close the other program, then reconnect (save the rig in Settings > My Rigs, or pick it again in the CAT menu).`);
        err.code = 'SCULAN10_IN_USE';
        this._fail(err, s, { noRetry: true });
        return;
      }
      const err = new Error(`SCU-LAN10: nothing received from ${this._opts.host} for ${Math.round(quiet / 1000)} s: session lost (another program may have logged in, the network dropped, or the unit restarted); reconnecting with a full handshake.`);
      err.code = 'SCULAN10_SESSION_LOST';
      this._fail(err, s);
    }
  }

  // ---- inbound -----------------------------------------------------------

  _onMessage(port, msg, rinfo) {
    const s = this._session;
    if (!s || !this._sockets) return;
    // Only the unit's own datagrams: anything else on these ports is ignored.
    if (rinfo && s.addr && rinfo.address && rinfo.address !== s.addr) {
      if (!s.strangerLogged) { s.strangerLogged = true; this._log(`ignored a datagram from ${rinfo.address} on ${port.toUpperCase()}: not the unit (${s.addr}); logged once`); }
      return;
    }
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
    if (!KNOWN_IN.has(p.msgType)) {
      if (!s.unknownLogged[port]) {
        s.unknownLogged[port] = true;
        this._log(`${port.toUpperCase()}: a packet of unknown type 0x${p.msgType.toString(16).padStart(2, '0')} (${p.body.length}-byte body) was ignored; logged once per channel`);
      }
      return;
    }
    if (p.msgType !== P.MSG.DATA_IN) return;
    if (port !== 'ctrl') s.dataSeen = true;
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
    if (s.audioFrames === 1) this._log(`RX audio: first frame ${a.payloadBytes} bytes, ${a.sampleRate} Hz stereo (format ${a.format})${a.rateTrusted ? '' : `; the header said ${a.headerRate} Hz, which no PCM stream has, so 16000 is used`}; channel 0 (speaker) is used`);
    this.emit('audio-frame', { pcm: a.pcm, sampleRate: a.sampleRate, frameSeq: a.frameSeq, payloadBytes: a.payloadBytes, recvMs: this._now() });
  }

  // ---- plumbing ----------------------------------------------------------

  _send(port, channel, msgType, body) {
    const s = this._session;
    if (!s) return;
    s.seq[port] = (s.seq[port] + 1) & 0xFF;
    this._sendRaw(port, P.buildPacket({ seq: s.seq[port], channel, msgType, body }), s);
  }

  _sendRaw(port, buf, s = this._session) {
    if (!s || this._session !== s || !s.sockets) return;
    const sock = s.sockets[port];
    if (!sock) return;
    s.stats[port].txPk++;
    try {
      sock.send(buf, this._opts.basePort + P.PORT_OFFSET[port], s.addr, (err) => {
        if (err) this._onSocketError(port, err, s);
      });
    } catch (err) { this._onSocketError(port, err, s); }
  }

  _onSocketError(port, err, s) {
    if (this._wantDisconnect) return;
    if (s && this._session !== s) return; // a session that already ended: its errors are moot
    const e = new Error(`SCU-LAN10: ${port.toUpperCase()} socket error: ${err && err.message ? err.message : err}`);
    e.code = err && err.code;
    this._fail(e, s);
  }

  /** End session `s` (the current one when omitted) and retry once, unless told not to. */
  _fail(err, s, { noRetry = false } = {}) {
    if (s && this._session !== s) return;   // stale: that session is already gone
    if (this._failing) return;
    this._failing = true;
    try {
      this.emit('error', err);
      this._teardown(err.code || 'error');
      if (!this._wantDisconnect && !noRetry) this._scheduleReconnect();
    } finally { this._failing = false; }
  }

  _scheduleReconnect() {
    if (this._reconnectTimer) return; // one pending retry at a time
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
    if (this._wantDisconnect) this._clearReconnect();
    if (s && s.waitAck) s.waitAck.resolve();
    if (s && s.tx) { s.tx = null; this._log('TX audio: stream ended with the session'); }
    if (this._keyed && !this._wantDisconnect) this._releaseOnReconnect = true;
    this._session = null;
    if (s && s.sockets) {
      const close = () => { for (const sock of Object.values(s.sockets)) { try { sock.close(); } catch {} } };
      // A TX0; just written is still in the socket's queue: closing at once drops it.
      if (this._lingerClose) { this._lingerClose = false; this._setTimeout(close, 100); } else close();
    }
    this._sockets = null;
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

const IPV4_RE = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const KNOWN_IN = new Set([P.MSG.SETUP_ACK, P.MSG.AUTH_RESP, P.MSG.KEEPALIVE_ACK, P.MSG.PORT_INIT_ACK, P.MSG.DATA_IN]);

/**
 * A setting that can never connect, in words, or null. Checked before any
 * packet goes out, so it is said once and never retried.
 */
function validateConnectOptions(o) {
  const host = String(o.host || '');
  if (!host) return { code: 'SCULAN10_NO_ADDRESS', message: 'no address set for the unit (factory default 192.168.49.1)' };
  if (host.includes(':')) return { code: 'SCULAN10_BAD_ADDRESS', message: `"${host}" looks like an IPv6 address or has a port in it; the SCU-LAN10 uses IPv4 only. Enter its IPv4 address (factory default 192.168.49.1) and put the port in the Base port box.` };
  if (/\s/.test(host) || host === '255.255.255.255' || /^0\./.test(host)) return { code: 'SCULAN10_BAD_ADDRESS', message: `"${host}" is not an address the unit can have; check the Address field.` };
  const port = Number(o.basePort);
  if (!Number.isInteger(port) || port < 1 || port > 65532) return { code: 'SCULAN10_BAD_PORT', message: `base port ${o.basePort} is not usable: it must be 1 to 65532 (the unit uses it and the three ports after it; factory default 50000).` };
  const loginProblem = P.loginFieldProblem(o.username, 'user') || P.loginFieldProblem(o.password, 'password');
  if (loginProblem) return { code: 'SCULAN10_BAD_LOGIN', message: loginProblem };
  return null;
}

module.exports = { Sculan10Transport, validateConnectOptions };
