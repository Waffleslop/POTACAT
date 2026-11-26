'use strict';
// lib/sdrconnect-client.js — one connection to SDRconnect's WebSocket API,
// shared by the band scope and the listener (lib/sdrconnect-audio.js).
//
// SdrConnectSession keeps the WebSocket alive with backoff, says WHICH thing
// is wrong (not running, not SDRconnect, a newer API, no receiver, someone
// else in control, stalled), keeps a property cache fed by property_changed,
// and puts back on the way out every property POTACAT changed: the receiver
// is often shared, and its owner finds it as they left it.
//
// SdrConnectScope turns the spectrum bins into the band scope's 850-level
// frames (the lib/yaesu-scope.js shape), with the receiver centred on the
// rig's dial.
//
// The message formats are SDRplay's published "SDRconnect WebSocket API
// 1.0.3" (https://api.sdrplay.com/docs/SDRconnect_WebSocket_API.pdf); the
// pure encode / decode lives in lib/sdrconnect-protocol.js. Nothing here
// transmits: SDRconnect is a receiver.

const { EventEmitter } = require('events');
const P = require('./sdrconnect-protocol');

function normHost(h) {
  const s = String(h || '').trim().toLowerCase();
  return s === 'localhost' || s === '::1' || s === '[::1]' ? '127.0.0.1' : s;
}

function wsImpl(opts) {
  return (opts && opts.WebSocket) || require('ws');
}

class SdrConnectSession extends EventEmitter {
  /**
   * @param {{host?, port?, device?, backoffMs?, maxBackoffMs?, connectTimeoutMs?, getTimeoutMs?, stallMs?, snapshot?, WebSocket?}} opts
   *   device: the display name to open (from valid_devices); '' = whatever SDRconnect has open
   *   snapshot: false for a probe (read only, nothing changed, nothing to restore)
   */
  constructor(opts = {}) {
    super();
    this.host = opts.host || '127.0.0.1';
    this.port = Number(opts.port) || P.DEFAULT_PORT;
    this.device = String(opts.device || '').trim();
    this.backoffMs = opts.backoffMs || 2000;
    this.maxBackoffMs = opts.maxBackoffMs || 30000;
    this.connectTimeoutMs = opts.connectTimeoutMs || 5000;
    this.getTimeoutMs = opts.getTimeoutMs || 2000;
    this.stallMs = opts.stallMs || 8000;
    this.doSnapshot = opts.snapshot !== false;
    this._WS = wsImpl(opts);
    this.state = 'idle';           // idle | connecting | handshake | live | retrying | failed | closed
    this.props = {};               // the property cache (primary device)
    this.info = null;              // { apiVersion, devices, activeDevice, canControl, lnaMin, lnaMax }
    this.canControl = true;
    this.centerOwner = null;       // the band scope, while it holds the receiver's centre
    this.listeners = 0;            // listeners attached (lib/sdrconnect-audio.js)
    this.unknownFrames = 0;
    this.frames = { spectrum: 0, audio: 0, iq: 0 };
    this._snapshot = null;         // what the receiver was at the first connect
    this._touched = new Set();     // properties POTACAT changed
    this._desired = new Map();     // property -> the value POTACAT wants
    this._streams = { spectrum: 0, audio: 0, iq: 0 };
    this._startedByUs = false;
    this._ws = null;
    this._want = false;
    this._attempt = 0;
    this._opened = false;
    this._lastErr = null;
    this._retryTimer = null;
    this._stallTimer = null;
    this._gets = new Map();        // property -> [{ resolve, timer }]
  }

  get live() { return this.state === 'live'; }

  start() {
    this._want = true;
    if (!this._ws && !this._retryTimer && this.state !== 'live') this._connect();
    return this;
  }

  // ── Requests ──────────────────────────────────────────────────────────────

  _send(text) {
    const ws = this._ws;
    if (!ws || ws.readyState !== 1) return false;
    try { ws.send(text); return true; } catch { return false; }
  }

  /** get_property: resolves the value (a string), or null after the timeout. */
  get(prop, timeoutMs) {
    return new Promise((resolve) => {
      if (!this._ws || this._ws.readyState !== 1) { resolve(null); return; }
      const entry = { resolve, timer: null };
      entry.timer = setTimeout(() => {
        const list = this._gets.get(prop) || [];
        const i = list.indexOf(entry);
        if (i >= 0) list.splice(i, 1);
        resolve(null);
      }, timeoutMs || this.getTimeoutMs);
      if (!this._gets.has(prop)) this._gets.set(prop, []);
      this._gets.get(prop).push(entry);
      this._send(P.buildMessage(P.EVENT.GET_PROPERTY, prop, ''));
    });
  }

  /**
   * set_property, remembered: applied now if live and in control, else when
   * the connection (or control) comes back. Marks the property for restore.
   */
  set(prop, value) {
    const v = String(value);
    this._desired.set(prop, v);
    if (this.doSnapshot) this._touched.add(prop);
    if (this.live && this.canControl) this._send(P.buildMessage(P.EVENT.SET_PROPERTY, prop, v));
  }

  /** What POTACAT last asked for, else the cache. */
  value(prop) {
    return this._desired.has(prop) ? this._desired.get(prop) : this.props[prop];
  }

  num(prop) { return P.parseNum(this.value(prop)); }

  /** Reference-counted stream switches: spectrum (scope), audio (listener), iq. */
  enableStream(kind, on) {
    if (!(kind in this._streams)) return;
    const before = this._streams[kind];
    this._streams[kind] = Math.max(0, before + (on ? 1 : -1));
    const now = this._streams[kind];
    if (this.live && (before === 0) !== (now === 0)) {
      this._sendStream(kind, now > 0);
      if (now > 0) this._ensureStarted();
    }
    this._armStall();
  }

  _sendStream(kind, on) {
    const ev = kind === 'spectrum' ? P.EVENT.SPECTRUM_ENABLE : kind === 'audio' ? P.EVENT.AUDIO_STREAM_ENABLE : P.EVENT.IQ_STREAM_ENABLE;
    this._send(P.buildMessage(ev, '', on));
  }

  _anyStream() { return this._streams.spectrum + this._streams.audio + this._streams.iq > 0; }

  /** The receiver must be running for anything to stream; start it if it is not (and stop it again at the end). */
  _ensureStarted() {
    if (!this._anyStream() || !this.doSnapshot) return;
    if (this.props[P.PROP.STARTED] != null && !P.parseBool(this.props[P.PROP.STARTED]) && !this._startedByUs) {
      this._startedByUs = true;
      this._send(P.buildMessage(P.EVENT.DEVICE_STREAM_ENABLE, '', true));
    }
  }

  // ── Connection ────────────────────────────────────────────────────────────

  _setState(s, info) {
    if (this.state === s && !info) return;
    this.state = s;
    this.emit('state', s, info || null);
  }

  _connect() {
    this._setState('connecting');
    this._opened = false;
    this._lastErr = null;
    let ws;
    try {
      ws = new this._WS(`ws://${this.host.includes(':') && !this.host.startsWith('[') ? '[' + this.host + ']' : this.host}:${this.port}`,
        { handshakeTimeout: this.connectTimeoutMs, perMessageDeflate: false });
    } catch (e) {
      this._fail('unreachable', e && e.message);
      return;
    }
    this._ws = ws;
    try { ws.binaryType = 'nodebuffer'; } catch { /* fine */ }
    ws.on('open', () => {
      if (this._ws !== ws) return;
      this._opened = true;
      this._handshake(ws).catch((e) => { if (this._ws === ws) this._fail('not-sdrconnect', e && e.message); });
    });
    ws.on('message', (data, isBinary) => {
      if (this._ws !== ws) return;
      if (isBinary) this._onBinary(data);
      else this._onText(data.toString());
    });
    ws.on('unexpected-response', (_req, res) => {
      if (this._ws !== ws) return;
      this._fail('not-sdrconnect', `it answered HTTP ${res && res.statusCode}, not a WebSocket`);
    });
    ws.on('error', (err) => { if (this._ws === ws) this._lastErr = err; });
    ws.on('close', () => {
      if (this._ws !== ws) return;
      if (this._opened) { this._fail('stalled', 'the connection closed'); return; }
      const code = this._lastErr && this._lastErr.code;
      const msg = this._lastErr && this._lastErr.message;
      if (code === 'ECONNREFUSED') this._fail('refused', msg);
      else if (/Unexpected server response|Invalid WebSocket frame|Invalid Sec-WebSocket|parse error/i.test(msg || '')) this._fail('not-sdrconnect', msg);
      else this._fail('unreachable', msg || 'no answer');
    });
  }

  async _handshake(ws) {
    this._setState('handshake');
    const g = (p, t) => this.get(p, t);
    // API version first: a newer major version is refused, not guessed at.
    const verText = await g(P.PROP.API_VERSION);
    if (this._ws !== ws) return;
    let apiVersion = null;
    if (verText != null) {
      apiVersion = P.parseApiVersion(verText);
      if (apiVersion && !P.apiVersionSupported(apiVersion)) {
        this._fail('api-version', '', { version: apiVersion.text, final: true });
        return;
      }
    }
    const devText = await g(P.PROP.VALID_DEVICES);
    if (this._ws !== ws) return;
    if (verText == null && devText == null) { this._fail('not-sdrconnect', 'it did not answer get_property'); return; }
    const devices = P.parseValidDevices(devText);
    let active = String((await g(P.PROP.ACTIVE_DEVICE)) || '').trim();
    if (this._ws !== ws) return;
    // Open the receiver the operator picked (by display name, API 1.0.3
    // selected_device_name), or the first one when none is open.
    const wanted = this.doSnapshot ? (this.device || (!active && devices.length ? devices[0] : '')) : '';
    if (wanted && wanted !== active) {
      if (this.device && devices.length && !devices.includes(this.device)) {
        this._fail('no-device', '', { device: this.device });
        return;
      }
      this._send(P.buildMessage(P.EVENT.SELECTED_DEVICE_NAME, '', wanted));
      // UNCONFIRMED: whether SDRconnect pushes active_device after a switch; wait briefly, then carry on.
      await this._waitProp(P.PROP.ACTIVE_DEVICE, (v) => String(v).trim() === wanted, 3000);
      active = wanted;
      if (this._ws !== ws) return;
    }
    if (!active && !devices.length && this.doSnapshot) { this._fail('no-device'); return; }
    const ctl = await g(P.PROP.CAN_CONTROL);
    const lnaMin = P.parseNum(await g(P.PROP.LNA_MIN));
    const lnaMax = P.parseNum(await g(P.PROP.LNA_MAX));
    const started = await g(P.PROP.STARTED);
    if (this._ws !== ws) return;
    this.canControl = ctl == null ? true : P.parseBool(ctl);
    if (started != null) this.props[P.PROP.STARTED] = started;
    if (this.doSnapshot) {
      // What the receiver is set to now, read before POTACAT changes anything.
      const props = P.snapshotProps();
      const vals = await Promise.all(props.map((p) => g(p)));
      if (this._ws !== ws) return;
      if (!this._snapshot) this._snapshot = {};
      props.forEach((p, i) => { if (vals[i] != null && !(p in this._snapshot)) this._snapshot[p] = vals[i]; });
    }
    this.info = { apiVersion: apiVersion ? apiVersion.text : (verText || ''), devices, activeDevice: active, canControl: this.canControl, lnaMin, lnaMax };
    this._attempt = 0;
    this._setState('live', this.info);
    // Everything POTACAT wants, again: a restarted SDRconnect comes back at its own settings.
    if (this.canControl) for (const [p, v] of this._desired) this._send(P.buildMessage(P.EVENT.SET_PROPERTY, p, v));
    for (const k of Object.keys(this._streams)) if (this._streams[k] > 0) this._sendStream(k, true);
    this._ensureStarted();
    this.emit('ready', this.info);
    if (!this.canControl) this.emit('control', false);
    this._armStall();
  }

  /** Resolves the value once `test` passes on a pushed or answered value, or null after ms. */
  _waitProp(prop, test, ms) {
    return new Promise((resolve) => {
      const on = (p, v) => { if (p === prop && test(v)) { done(v); } };
      const timer = setTimeout(() => done(null), ms);
      const done = (v) => { clearTimeout(timer); this.removeListener('property', on); resolve(v); };
      this.on('property', on);
    });
  }

  _onText(text) {
    const m = P.parseText(text);
    if (!m || m.device !== 'primary') return;
    if (m.eventType !== P.EVENT.PROPERTY_CHANGED && m.eventType !== P.EVENT.GET_PROPERTY_RESPONSE) return;
    const prop = m.property;
    this.props[prop] = m.value;
    if (m.eventType === P.EVENT.GET_PROPERTY_RESPONSE) {
      const list = this._gets.get(prop);
      const entry = list && list.shift();
      if (entry) { clearTimeout(entry.timer); entry.resolve(m.value); }
    }
    if (prop === P.PROP.CAN_CONTROL && this.live) {
      const was = this.canControl;
      this.canControl = P.parseBool(m.value);
      if (this.info) this.info.canControl = this.canControl;
      if (was !== this.canControl) {
        // Control came back: what POTACAT wants is sent again.
        if (this.canControl) for (const [p, v] of this._desired) this._send(P.buildMessage(P.EVENT.SET_PROPERTY, p, v));
        this.emit('control', this.canControl);
      }
    }
    if (prop === P.PROP.STARTED && this.live) this._ensureStarted();
    this.emit('property', prop, m.value);
  }

  _onBinary(data) {
    const f = P.parseBinary(data);
    if (!f) return;
    if (f.device !== 'primary') return;
    this._armStall();
    if (f.kind === 'unknown') { this.unknownFrames++; this.emit('unknown-binary', f.type, f.payload.length); return; }
    this.frames[f.kind]++;
    this.emit(f.kind, f.payload);
  }

  _armStall() {
    if (this._stallTimer) { clearTimeout(this._stallTimer); this._stallTimer = null; }
    if (!this.live || !this._anyStream()) return;
    this._stallTimer = setTimeout(() => { if (this.live && this._anyStream()) this._fail('stalled'); }, this.stallMs);
  }

  _teardown() {
    if (this._stallTimer) { clearTimeout(this._stallTimer); this._stallTimer = null; }
    for (const list of this._gets.values()) for (const e of list) { clearTimeout(e.timer); e.resolve(null); }
    this._gets.clear();
    const ws = this._ws;
    this._ws = null;
    if (ws) { try { ws.removeAllListeners('message'); ws.terminate(); } catch { /* gone */ } }
  }

  _fail(key, detail, extra = {}) {
    this._teardown();
    const info = P.describeSdrConnectError(key, { host: this.host, port: this.port, detail, ...extra });
    this.emit('problem', info);
    if (extra.final) { this._want = false; this._setState('failed', info); return; }
    if (!this._want) { this._setState('closed'); return; }
    const delay = Math.min(this.maxBackoffMs, this.backoffMs * Math.pow(2, this._attempt++));
    this._setState('retrying', { ...info, retryInMs: delay });
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      if (this._want) this._connect();
    }, delay);
  }

  /**
   * Put back what POTACAT changed, switch off the streams it switched on,
   * stop the receiver if POTACAT started it, and close. Resolves when the
   * socket is closed; nothing is left running.
   */
  stop() {
    this._want = false;
    if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null; }
    if (this._stallTimer) { clearTimeout(this._stallTimer); this._stallTimer = null; }
    const ws = this._ws;
    if (ws && ws.readyState === 1 && this.live) {
      if (this.canControl && this._snapshot) {
        const now = { ...this.props };
        for (const [p, v] of this._desired) now[p] = v;
        for (const msg of P.restoreMessages(this._snapshot, now, this._touched)) this._send(msg);
      }
      for (const k of Object.keys(this._streams)) if (this._streams[k] > 0) this._sendStream(k, false);
      if (this._startedByUs) this._send(P.buildMessage(P.EVENT.DEVICE_STREAM_ENABLE, '', false));
    }
    this._startedByUs = false;
    this._streams = { spectrum: 0, audio: 0, iq: 0 };
    for (const list of this._gets.values()) for (const e of list) { clearTimeout(e.timer); e.resolve(null); }
    this._gets.clear();
    this._ws = null;
    this._setState('closed');
    if (!ws) return Promise.resolve();
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (done) return; done = true; clearTimeout(t); try { ws.removeAllListeners(); ws.on('error', () => {}); } catch { /* gone */ } resolve(); };
      const t = setTimeout(() => { try { ws.terminate(); } catch { /* gone */ } finish(); }, 1000);
      ws.once('close', finish);
      try {
        if (ws.readyState === 1) ws.close(1000, 'POTACAT done');
        else if (ws.readyState === 0) ws.terminate();
        else finish();
      } catch { finish(); }
    });
  }
}

/**
 * One session per host:port, shared by the band scope and the listener
 * (the rtl_tcp share in main.js is the model). The last release stops it.
 */
class SessionRegistry {
  constructor(defaults = {}) {
    this.defaults = defaults;
    this._map = new Map();
  }

  key(host, port) { return `${normHost(host)}:${Number(port) || P.DEFAULT_PORT}`; }

  acquire(host, port, opts = {}) {
    const k = this.key(host, port);
    let e = this._map.get(k);
    if (!e) {
      const s = new SdrConnectSession({ ...this.defaults, ...opts, host, port });
      e = { session: s, refs: 0 };
      this._map.set(k, e);
      s.start();
    } else if (opts.device && !e.session.device) {
      e.session.device = String(opts.device);
    }
    e.refs++;
    return e.session;
  }

  /** Resolves when the session has stopped (or another user still holds it). */
  release(session) {
    for (const [k, e] of this._map) {
      if (e.session !== session) continue;
      if (--e.refs > 0) return Promise.resolve();
      this._map.delete(k);
      return session.stop();
    }
    return Promise.resolve();
  }

  find(host, port) {
    const e = this._map.get(this.key(host, port));
    return e ? e.session : null;
  }

  get size() { return this._map.size; }

  /** POTACAT is quitting: every receiver back as it was, every socket closed. */
  closeAll() {
    const all = [...this._map.values()].map((e) => e.session);
    this._map.clear();
    return Promise.all(all.map((s) => s.stop()));
  }
}

const defaultRegistry = new SessionRegistry();

/**
 * Settings > Radio: is SDRconnect at host:port, and which receivers does it
 * have? Read-only (nothing is changed). A session POTACAT already holds is
 * asked instead of opening a second connection.
 * Resolves { ok: true, apiVersion, devices, activeDevice, canControl, lnaMin, lnaMax }
 * or { ok: false, problem }.
 */
function probeSdrConnect(host, port, { timeoutMs = 4000, registry = defaultRegistry, WebSocket } = {}) {
  const live = registry && registry.find(host, port);
  if (live && live.live && live.info) return Promise.resolve({ ok: true, ...live.info, canControl: live.canControl });
  return new Promise((resolve) => {
    const s = new SdrConnectSession({ host, port, snapshot: false, connectTimeoutMs: timeoutMs, getTimeoutMs: Math.min(1500, timeoutMs), WebSocket });
    let done = false;
    const finish = (v) => { if (done) return; done = true; clearTimeout(t); s.stop().then(() => resolve(v)); };
    const t = setTimeout(() => finish({ ok: false, problem: P.describeSdrConnectError('unreachable', { host, port, detail: 'no answer in time' }) }), timeoutMs + 2000);
    s.on('ready', (info) => finish({ ok: true, ...info }));
    s.on('problem', (info) => finish({ ok: false, problem: info }));
    s.start();
  });
}

/**
 * The band scope from SDRconnect's spectrum bins. Same outward shape as the
 * rtl_tcp path in main.js: 'frame' events of { seq, kind: 0, wf1: Uint8Array(850), aligned },
 * 'state' (state, info) with the describe* info, setFrequency(hz), stop().
 */
class SdrConnectScope extends EventEmitter {
  /**
   * @param {{cfg: object, registry?: SessionRegistry, fps?: number, sessionOpts?: object}} opts
   *   cfg: the rig's normalised sdrScope block (lib/sdr-scope.js normalizeSdrSettings, kind 'sdrconnect')
   */
  constructor({ cfg, registry = defaultRegistry, fps = 12, sessionOpts = {} } = {}) {
    super();
    this.cfg = cfg || {};
    this.registry = registry;
    this.span = P.spanFor(this.cfg.spanHz);
    this.spanHz = this.span.spanHz;
    this.tunedHz = 0;
    this.session = null;
    this._sessionOpts = sessionOpts;
    this._minGapMs = Math.floor(1000 / Math.max(1, Math.min(30, fps)));
    this._lastFrameAt = 0;
    this._seq = 0;
    this._levelState = {};
    this._off = [];
  }

  start(tunedHz) {
    if (this.session) return;
    this.tunedHz = Number(tunedHz) || 0;
    const s = this.registry.acquire(this.cfg.host, this.cfg.port, { ...this._sessionOpts, device: this.cfg.device || '' });
    this.session = s;
    s.centerOwner = this;
    const on = (ev, fn) => { s.on(ev, fn); this._off.push([ev, fn]); };
    on('ready', (info) => {
      this._apply();
      this.emit('ready', info);
      if (!s.canControl) this.emit('state', 'live', P.describeSdrConnectError('no-control'));
    });
    on('state', (st, info) => this.emit('state', st, info));
    on('control', (ok) => this.emit('control', ok));
    on('property', (p) => { if (p === P.PROP.SAMPLE_RATE) this._spanFromRate(); });
    on('spectrum', (payload) => this._onSpectrum(payload));
    s.enableStream('spectrum', true);
    if (s.live) { this._apply(); this.emit('ready', s.info); }
  }

  /** Rate, gain and centre, as the settings say. */
  _apply() {
    const s = this.session;
    if (!s) return;
    s.set(P.PROP.SAMPLE_RATE, this.span.sampleRate);
    const lna = P.lnaForGain(this.cfg.gain, s.info && s.info.lnaMin, s.info && s.info.lnaMax);
    if (lna != null) s.set(P.PROP.LNA, lna);
    if (this.tunedHz > 0) this._tune(this.tunedHz);
    this._spanFromRate();
  }

  _tune(hz) {
    const s = this.session;
    s.set(P.PROP.CENTER, Math.round(hz));
    // No listener: keep SDRconnect's own demodulator on the centre too, so it
    // never drags the window somewhere else.
    if (!s.listeners) s.set(P.PROP.VFO, Math.round(hz));
  }

  _spanFromRate() {
    const s = this.session;
    const rate = s && s.num(P.PROP.SAMPLE_RATE);
    const drawn = P.drawnSpanHz(this.span.spanHz, rate);
    if (drawn !== this.spanHz) { this.spanHz = drawn; this.emit('span', drawn); }
  }

  /** The dial moved (main.js debounces). */
  setFrequency(hz) {
    const h = Math.round(Number(hz) || 0);
    if (!(h > 0)) return;
    this.tunedHz = h;
    if (this.session) this._tune(h);
  }

  _onSpectrum(payload) {
    const now = Date.now();
    if (now - this._lastFrameAt < this._minGapMs) return;
    this._lastFrameAt = now;
    const s = this.session;
    // The bins are centred where the receiver really is (the cache follows
    // property_changed); the scope is centred on the dial.
    const binsCenter = P.parseNum(s.props[P.PROP.CENTER]) || this.tunedHz;
    const rate = P.parseNum(s.props[P.PROP.SAMPLE_RATE]) || this.span.sampleRate;
    const wf1 = P.levelsFromBins(payload, rate, this.spanHz, {
      shiftHz: this.tunedHz > 0 && binsCenter > 0 ? this.tunedHz - binsCenter : 0,
      topDb: P.parseNum(s.props[P.PROP.SPECTRUM_TOP]),
      bottomDb: P.parseNum(s.props[P.PROP.SPECTRUM_BOTTOM]),
      state: this._levelState,
    });
    this.emit('frame', { seq: (this._seq = (this._seq + 1) >>> 0), kind: 0, wf1, aligned: true });
  }

  stop() {
    const s = this.session;
    this.session = null;
    if (!s) return Promise.resolve();
    for (const [ev, fn] of this._off.splice(0)) s.removeListener(ev, fn);
    if (s.centerOwner === this) s.centerOwner = null;
    s.enableStream('spectrum', false);
    return this.registry.release(s);
  }
}

module.exports = { SdrConnectSession, SessionRegistry, SdrConnectScope, defaultRegistry, probeSdrConnect, normHost };
