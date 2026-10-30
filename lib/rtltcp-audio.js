'use strict';
// lib/rtltcp-audio.js — listen through an rtl_tcp server (an RTL-SDR, or an
// SDRplay behind rsp_tcp) from the same SDR menu as a KiwiSDR or a WebSDR.org
// (Casey 2026-10-29: "add support for RTL_TCP nodes").
//
// RtlTcpAudioClient has the KiwiSdrClient / WebSdrClient shape that main.js's
// kiwi-connect wiring and its four auto-tune sites already drive:
//   connect(host, port) · tune(freqKhz, mode) · setAgc() · disconnect() · connected
//   events: log, connected, disconnected, error, audio(Float32Array, rate), smeter(dBm), info
//
// The server sends raw IQ, so lib/rtltcp-demod.js does the receiving (in a
// worker, lib/rtltcp-demod-worker.js; `worker:false` runs it inline for tests).
//
// Where the SDR is tuned:
//   - on its own connection, the SDR sits 25 kHz BELOW the wanted signal
//     (ifShiftHz), so the dongle's DC spike is never under an AM carrier;
//     a QSY inside the 250 kHz it receives only moves the demodulator, and
//     the SDR is retuned when the signal leaves that window;
//   - when the same server is already the band scope (rtl_tcp takes one
//     client), the scope keeps the server: its rate, its centre on the dial.
//     The listener takes the scope's IQ (attach) and demodulates wherever the
//     signal sits in it, and goes back to a connection of its own (detach)
//     when the scope stops.
//
// The SDR's settings (gain, ppm, direct sampling, the IF / upconverter
// offset) are the rig's "Band scope from an SDR" block when that names the
// same server, else the defaults (lib/sdr-scope.js normalizeSdrSettings).

const net = require('net');
const path = require('path');
const { EventEmitter } = require('events');
const SdrScope = require('./sdr-scope');
const ListenSource = require('./listen-source');
const { Demodulator, RelativeMeter, normalizeMode } = require('./rtltcp-demod');

const OWN_RATE = 250000;
const IF_SHIFT_HZ = 25000;
// Own connection: the signal may sit this far either side of the SDR's centre
// before the SDR is retuned (the usable band at 250 kS/s is about +-100 kHz).
const OWN_WINDOW = { lo: -70000, hi: 90000 };
const SMETER_EVERY_MS = 200;
const AUDIO_PACKET = 1024;
const GIVE_UP_AFTER = 3; // failed attempts before the first connection = an error

function sameHost(a, b) {
  const n = (h) => {
    const s = String(h || '').trim().toLowerCase();
    return s === 'localhost' || s === '::1' || s === '[::1]' ? '127.0.0.1' : s;
  };
  return n(a) === n(b);
}

/**
 * Is there an rtl_tcp server at host:port? It greets with "RTL0" the moment
 * the socket opens; a WebSDR.org (an HTTP server) says nothing until asked.
 * Resolves the parsed greeting, or null.
 */
function probeRtlTcp(host, port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    let done = false;
    let buf = Buffer.alloc(0);
    const sock = net.connect({ host, port });
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { sock.destroy(); } catch { /* gone */ }
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length >= SdrScope.HEADER_BYTES) finish(SdrScope.parseHeader(buf));
    });
    sock.on('error', () => finish(null));
    sock.on('close', () => finish(null));
  });
}

class RtlTcpAudioClient extends EventEmitter {
  /**
   * @param {{sdr?: object, worker?: boolean, ownRate?: number, ifShiftHz?: number, backoffMs?: number, headerTimeoutMs?: number}} opts
   */
  constructor(opts = {}) {
    super();
    this.sdr = SdrScope.normalizeSdrSettings(opts.sdr || {});
    this.ownRate = opts.ownRate || OWN_RATE;
    this.ifShiftHz = opts.ifShiftHz != null ? opts.ifShiftHz : IF_SHIFT_HZ;
    this._useWorker = opts.worker !== false;
    this._clientOpts = { backoffMs: opts.backoffMs || 1000, headerTimeoutMs: opts.headerTimeoutMs || 3000 };
    this.host = '';
    this.port = 0;
    this._connected = false;
    this._everLive = false;
    this._failures = 0;
    this._own = null;          // our RtlTcpClient
    this._ownCenterHz = 0;
    this._shared = null;       // { client, sampleRate, centerHz(), onIq }
    this._targetHz = 0;
    this._mode = 'usb';
    this._engine = null;
    this._sent = null;         // last {inputRate, mode, offsetHz} handed to the engine
    this._meter = new RelativeMeter();
    this._lastMeterAt = 0;
    this._infoSent = false;
    this._pend = [];
    this._pendLen = 0;
    this._pendRate = 0;
    this._elsewhereLogged = false;
    this.kind = 'rtl_tcp';
  }

  get connected() { return this._connected; }
  /** What this SDR receives, [[loHz, hiHz], ...] (lib/listen-source.js); the
   *  assumed rtl_tcp range until the greeting names the tuner. */
  get reach() {
    const h = (this._own && this._own.header) || (this._shared && this._shared.client && this._shared.client.header) || null;
    return ListenSource.sdrReach({ kind: 'rtl_tcp', tunerType: h ? h.tunerType : null, directSampling: this.sdr.directSampling });
  }
  get shared() { return !!this._shared; }

  sameServer(host, port) { return sameHost(host, this.host) && Number(port) === Number(this.port); }

  // ── Connection ────────────────────────────────────────────────────────────

  connect(host, port) {
    this.host = host;
    this.port = Number(port) || SdrScope.DEFAULT_PORT;
    this._startOwn();
    return this;
  }

  _startOwn() {
    if (this._own) return;
    const c = new SdrScope.RtlTcpClient({ host: this.host, port: this.port, ...this._clientOpts });
    this._own = c;
    this._ownCenterHz = 0;
    c.on('header', (h) => {
      if (this._own !== c) return;
      this._failures = 0;
      const center = this._targetHz > 0 ? this._centerFor(this._targetHz) : 0;
      this._ownCenterHz = center;
      // Every greeting: a restarted server comes back at its own defaults.
      for (const b of SdrScope.setupCommands({ ...this.sdr, sampleRate: this.ownRate }, center)) c.send(b);
      this.emit('log', `rtl_tcp ${this.host}:${this.port}: ${h.tunerName}, ${(this.ownRate / 1000).toFixed(0)} kS/s, gain ${this.sdr.gain === 'auto' ? 'auto' : this.sdr.gain + ' dB'}`
        + (this.sdr.directSampling !== 'off' ? `, direct sampling ${this.sdr.directSampling.toUpperCase()}` : '')
        + (this.sdr.offsetHz ? `, offset ${this.sdr.offsetHz} Hz` : ''));
      if (!this._everLive) {
        this._everLive = true;
        this.emit('log', 'The S-meter is relative: an RTL-SDR reports no calibrated level, so S1 is the noise and S9 is 48 dB above it');
        if (this._targetHz > 0 && this._targetHz < 24e6 && this.sdr.directSampling === 'off' && h.tunerType === 5 && !this.sdr.offsetHz) {
          this.emit('log', 'Below 24 MHz an R820T dongle needs an RTL-SDR Blog V4, direct sampling, or an upconverter; if HF is silent, set it in Settings > My Rigs > Band scope from an SDR for this server');
        }
      }
      this._setConnected(true);
    });
    c.on('iq', (chunk) => { if (this._own === c) this._feed(chunk, this.ownRate, this._ownCenterHz); });
    c.on('problem', (info) => {
      if (this._own !== c) return;
      if (!this._everLive && ++this._failures >= GIVE_UP_AFTER) {
        const msg = `${info.headline}. ${info.action || info.detail || ''}`.trim();
        this._stopOwn();
        this.emit('error', msg);
        this._setConnected(false, true);
        return;
      }
      this.emit('log', `rtl_tcp: ${info.headline}${info.detail ? ' (' + info.detail + ')' : ''}`);
    });
    c.start();
  }

  _stopOwn() {
    const c = this._own;
    this._own = null;
    if (c) { c.removeAllListeners(); c.stop(); }
  }

  /**
   * Share the band scope's stream: the scope owns the server (its rate, its
   * centre). `centerHz()` is where the scope has the SDR tuned right now.
   */
  attach(client, { sampleRate, centerHz }) {
    this.detach({ reconnect: false });
    this._stopOwn();
    const onIq = (chunk) => { if (this._shared && this._shared.client === client) this._feed(chunk, this._shared.sampleRate, this._shared.centerHz()); };
    this._shared = { client, sampleRate: Number(sampleRate) || 1024000, centerHz, onIq };
    client.on('iq', onIq);
    this._elsewhereLogged = false;
    this.emit('log', `Listening through the band scope's SDR (${(this._shared.sampleRate / 1000).toFixed(0)} kS/s)`);
    this._everLive = true;
    this._setConnected(true);
  }

  /** The scope stopped: take a connection of our own again. */
  detach({ reconnect = true } = {}) {
    const s = this._shared;
    if (!s) return;
    this._shared = null;
    s.client.removeListener('iq', s.onIq);
    if (reconnect && this.host) {
      this.emit('log', 'The band scope closed; listening on a connection of its own');
      this._startOwn();
    }
  }

  disconnect() {
    this.detach({ reconnect: false });
    this._stopOwn();
    if (this._engine && this._engine.terminate) { try { this._engine.terminate(); } catch { /* gone */ } }
    this._engine = null;
    this._sent = null;
    this._setConnected(false, true);
  }

  _setConnected(on, force) {
    if (this._connected === on && !force) return;
    const was = this._connected;
    this._connected = on;
    if (on && !was) this.emit('connected');
    if (!on && was) this.emit('disconnected');
  }

  // ── Tuning ────────────────────────────────────────────────────────────────

  /** Where the SDR goes so `targetHz` sits ifShiftHz above its centre. */
  _centerFor(targetHz) {
    return Math.max(0, Math.round(targetHz + this.sdr.offsetHz - this.ifShiftHz));
  }

  tune(freqKhz, mode) {
    const hz = Math.round(Number(freqKhz) * 1000);
    if (!(hz > 0)) return;
    this._targetHz = hz;
    this._mode = normalizeMode(mode);
    this._elsewhereLogged = false;
    if (this._own && this._own.header) {
      const off = hz + this.sdr.offsetHz - this._ownCenterHz;
      if (!this._ownCenterHz || off < OWN_WINDOW.lo || off > OWN_WINDOW.hi) {
        this._ownCenterHz = this._centerFor(hz);
        this._own.setFrequency(this._ownCenterHz);
      }
    }
  }

  setAgc() { /* the demodulator's AGC is always on */ }

  // ── Samples ───────────────────────────────────────────────────────────────

  _feed(chunk, rate, centerHz) {
    if (!(this._targetHz > 0) || !(centerHz > 0)) return;
    const offsetHz = this._targetHz + this.sdr.offsetHz - centerHz;
    if (Math.abs(offsetHz) > rate * 0.45) {
      if (!this._elsewhereLogged) {
        this._elsewhereLogged = true;
        this.emit('log', `${(this._targetHz / 1000).toFixed(1)} kHz is outside what the SDR receives at ${(centerHz / 1000).toFixed(1)} kHz`
          + (this._shared ? ' (the band scope has it tuned to the radio\'s dial)' : ''));
      }
      return;
    }
    this._ensureEngine();
    const s = this._sent;
    if (!s || s.inputRate !== rate || s.mode !== this._mode || s.offsetHz !== offsetHz) {
      this._sent = { inputRate: rate, mode: this._mode, offsetHz };
      this._engineSend({ type: 'config', ...this._sent });
    }
    // A copy: the scope reads the same chunk, and the worker takes ownership.
    const copy = new Uint8Array(chunk.length);
    copy.set(chunk);
    this._engineSend({ type: 'iq', buf: copy.buffer }, [copy.buffer]);
  }

  _ensureEngine() {
    if (this._engine) return;
    if (this._useWorker) {
      const { Worker } = require('worker_threads');
      const w = new Worker(path.join(__dirname, 'rtltcp-demod-worker.js'));
      w.unref(); // never what keeps POTACAT from quitting
      w.on('message', (m) => { if (this._engine === w && m && m.type === 'audio') this._onAudio(m.audio, m.sampleRate, m.powerDb); });
      w.on('error', (e) => { this.emit('log', 'demodulator worker error: ' + (e && e.message)); if (this._engine === w) { this._engine = null; this._sent = null; } });
      this._engine = w;
    } else {
      // Inline (tests): the same Demodulator, called synchronously.
      let demod = null;
      this._engine = {
        postMessage: (msg) => {
          if (msg.type === 'config') {
            if (!demod || demod.inputRate !== msg.inputRate) demod = new Demodulator(msg);
            else { demod.setMode(msg.mode); demod.setOffset(msg.offsetHz); }
          } else if (msg.type === 'iq' && demod) {
            const r = demod.processU8(new Uint8Array(msg.buf));
            if (r.audio.length) this._onAudio(r.audio, r.sampleRate, r.powerDb);
          }
        },
      };
    }
  }

  _engineSend(msg, transfer) {
    try { this._engine.postMessage(msg, transfer); } catch (e) { this.emit('log', 'demodulator: ' + e.message); }
  }

  _flushAudio() {
    if (!this._pendLen) return;
    const out = new Float32Array(this._pendLen);
    let k = 0;
    for (const p of this._pend) { out.set(p, k); k += p.length; }
    this._pend = [];
    this._pendLen = 0;
    this.emit('audio', out, this._pendRate);
  }

  _onAudio(audio, sampleRate, powerDb) {
    if (!this._connected) return;
    if (!this._infoSent) { this._infoSent = true; this.emit('info', { sampleRate }); }
    // Packets of >= 1024 samples (~80 ms), like a Kiwi's: every packet goes
    // to the VFO window, the main window, the WebRTC bridge and ECHOCAT.
    if (this._pendRate !== sampleRate) this._flushAudio();
    this._pendRate = sampleRate;
    this._pend.push(audio);
    this._pendLen += audio.length;
    if (this._pendLen >= AUDIO_PACKET) this._flushAudio();
    const now = Date.now();
    const dt = this._lastMeterAt ? (now - this._lastMeterAt) / 1000 : 0;
    if (!this._lastMeterAt || now - this._lastMeterAt >= SMETER_EVERY_MS) {
      const dbm = this._meter.update(powerDb, dt);
      this._lastMeterAt = now;
      if (dbm != null) this.emit('smeter', dbm);
    }
  }
}

module.exports = { RtlTcpAudioClient, probeRtlTcp, sameHost, OWN_RATE, IF_SHIFT_HZ, OWN_WINDOW };
