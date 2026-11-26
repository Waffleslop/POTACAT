'use strict';
// lib/sdrconnect-audio.js — listen through SDRconnect (an SDRplay nRSP-ST, or
// any SDRplay that SDRconnect has open) from the same SDR menu as a KiwiSDR,
// a WebSDR.org or an rtl_tcp server.
//
// SdrConnectAudioClient has the KiwiSdrClient / RtlTcpAudioClient shape that
// main.js's kiwi-connect wiring, the listen-source arbiter and JTCAT's WebSDR
// receive source already drive:
//   connect(host, port) · tune(freqKhz, mode, opts) · setAgc(on) · disconnect() · connected
//   events: log, connected, disconnected, error, audio(Float32Array, 48000), smeter(dB), info
//
// SDRconnect does the receiving (its own demodulator and noise reduction);
// POTACAT sets the demodulator, filter and frequency, and plays the 48 kHz
// audio it streams (SDRconnect WebSocket API 1.0.3, binary type 1,
// https://api.sdrplay.com/docs/SDRconnect_WebSocket_API.pdf).
//
// The connection is shared with the band scope when both use the same
// SDRconnect (lib/sdrconnect-client.js SessionRegistry). While the scope runs
// it holds the receiver's centre on the rig's dial; the listener then moves
// only SDRconnect's VFO inside that window, as the rtl_tcp listener does.

const { EventEmitter } = require('events');
const P = require('./sdrconnect-protocol');
const C = require('./sdrconnect-client');
const ListenSource = require('./listen-source');

const AUDIO_PACKET = 2048;       // ~43 ms at 48 kHz, the size every surface already plays
const SMETER_EVERY_MS = 250;
const SMETER_POLL_MS = 500;      // when SDRconnect does not push signal_power by itself
const GIVE_UP_AFTER = 3;         // failed attempts before the first connection = an error
const IF_SHIFT_HZ = 25000;       // on its own connection, the receiver sits this far below the signal

class SdrConnectAudioClient extends EventEmitter {
  /**
   * @param {{sdr?: object, registry?: object, giveUpAfter?: number, sessionOpts?: object, smeterPollMs?: number}} opts
   *   sdr: the rig's normalised sdrScope block when it names this SDRconnect (device, gain), else {}
   */
  constructor(opts = {}) {
    super();
    this.sdr = opts.sdr || {};
    this.registry = opts.registry || C.defaultRegistry;
    this.giveUpAfter = opts.giveUpAfter || GIVE_UP_AFTER;
    this._sessionOpts = opts.sessionOpts || {};
    this._smeterPollMs = opts.smeterPollMs || SMETER_POLL_MS;
    this.host = '';
    this.port = 0;
    this.session = null;
    this.kind = 'sdrconnect';
    this._connected = false;
    this._everLive = false;
    this._failures = 0;
    this._targetHz = 0;
    this._mode = 'usb';
    this._opts = null;
    this._pend = [];
    this._pendLen = 0;
    this._infoSent = false;
    this._lastMeterAt = 0;
    this._lastPushAt = 0;
    this._pollTimer = null;
    this._elsewhereLogged = false;
    this._off = [];
  }

  get connected() { return this._connected; }
  /** SDRplay receivers cover 1 kHz to 2 GHz (lib/listen-source.js). */
  get reach() { return ListenSource.sdrReach({ kind: 'sdrconnect' }); }
  sameServer(host, port) { return C.normHost(host) === C.normHost(this.host) && Number(port) === Number(this.port); }

  connect(host, port) {
    if (this.session) return this;
    this.host = host;
    this.port = Number(port) || P.DEFAULT_PORT;
    const s = this.registry.acquire(this.host, this.port, { ...this._sessionOpts, device: this.sdr.device || '' });
    this.session = s;
    s.listeners++;
    const on = (ev, fn) => { s.on(ev, fn); this._off.push([ev, fn]); };
    on('ready', (info) => this._onReady(info));
    on('state', (st, info) => {
      if (st === 'live' || !this._connected) return;
      if (st === 'retrying' || st === 'failed') {
        this.emit('log', `SDRconnect: ${info ? info.headline : st}`);
      }
    });
    on('problem', (info) => this._onProblem(info));
    on('control', (ok) => this.emit('log', ok ? 'SDRconnect: POTACAT has control of the receiver again' : `SDRconnect: ${P.describeSdrConnectError('no-control').headline}. ${P.describeSdrConnectError('no-control').detail}`));
    on('audio', (payload) => this._onAudio(payload));
    on('property', (p, v) => {
      if (p !== P.PROP.SIGNAL_POWER) return;
      this._lastPushAt = Date.now();
      this._meter(v);
    });
    s.enableStream('audio', true);
    // Already live (the band scope holds it): ready on the next turn, so a
    // caller attaching listeners after connect() still hears 'connected'.
    if (s.live) setImmediate(() => { if (this.session === s && s.live && !this._connected) this._onReady(s.info); });
    return this;
  }

  _onReady(info) {
    this._failures = 0;
    if (!this._everLive) {
      this._everLive = true;
      this.emit('log', `SDRconnect ${this.host}:${this.port}: ${info && info.activeDevice ? info.activeDevice : 'receiver'}`
        + (info && info.apiVersion ? `, API ${info.apiVersion}` : '')
        + (info && info.canControl === false ? ', someone else is in control (listening only)' : ', in control'));
    }
    const lna = P.lnaForGain(this.sdr.gain, info && info.lnaMin, info && info.lnaMax);
    if (lna != null && !(this.session && this.session.centerOwner)) this.session.set(P.PROP.LNA, lna);
    if (this._targetHz > 0) this._apply();
    this._startPoll();
    this._setConnected(true);
  }

  _onProblem(info) {
    if (!this._everLive && (info.key === 'api-version' || ++this._failures >= this.giveUpAfter)) {
      const msg = `${info.headline}. ${info.action || info.detail || ''}`.trim();
      this.emit('error', msg);
      this.disconnect();
      return;
    }
    this.emit('log', `SDRconnect: ${info.headline}${info.detail ? ' (' + info.detail + ')' : ''}`);
  }

  _setConnected(on, force) {
    if (this._connected === on && !force) return;
    const was = this._connected;
    this._connected = on;
    if (on && !was) this.emit('connected');
    if (!on && was) this.emit('disconnected');
  }

  // ── Tuning ────────────────────────────────────────────────────────────────

  /**
   * tune(freqKhz, mode, opts): opts.lo/hi in kHz (JTCAT's passband,
   * lib/jtcat-rx-source.js websdrTuneForDial) set the filter width.
   */
  tune(freqKhz, mode, opts) {
    const hz = Math.round(Number(freqKhz) * 1000);
    if (!(hz > 0)) return;
    this._targetHz = hz;
    this._mode = String(mode || 'usb');
    this._opts = opts || null;
    this._elsewhereLogged = false;
    if (this.session && this.session.live) this._apply();
  }

  _apply() {
    const s = this.session;
    if (!s) return;
    const { demodulator, bandwidthHz } = P.demodFor(this._mode, this._opts);
    s.set(P.PROP.DEMOD, demodulator);
    s.set(P.PROP.BANDWIDTH, bandwidthHz);
    const target = this._targetHz + (Number(this.sdr.offsetHz) || 0);
    const center = s.num(P.PROP.CENTER);
    const rate = s.num(P.PROP.SAMPLE_RATE) || 0;
    const inside = center > 0 && rate > 0 && Math.abs(target - center) < rate * 0.45;
    if (s.centerOwner) {
      // The band scope holds the centre on the rig's dial: move only the VFO.
      if (!inside && center > 0 && rate > 0) {
        if (!this._elsewhereLogged) {
          this._elsewhereLogged = true;
          this.emit('log', `${(this._targetHz / 1000).toFixed(1)} kHz is outside what the SDR receives at ${(center / 1000).toFixed(1)} kHz (the band scope has it tuned to the radio's dial)`);
        }
        return;
      }
    } else if (!inside) {
      s.set(P.PROP.CENTER, Math.max(0, target - IF_SHIFT_HZ));
    }
    s.set(P.PROP.VFO, target);
  }

  setAgc(on) {
    if (this.session) this.session.set(P.PROP.AGC, on !== false);
  }

  // ── Audio and meter ───────────────────────────────────────────────────────

  _onAudio(payload) {
    if (!this._connected) return;
    const mono = P.stereoToMono(payload);
    if (!mono.length) return;
    if (!this._infoSent) { this._infoSent = true; this.emit('info', { sampleRate: P.AUDIO_RATE }); }
    this._pend.push(mono);
    this._pendLen += mono.length;
    if (this._pendLen >= AUDIO_PACKET) this._flush();
  }

  _flush() {
    if (!this._pendLen) return;
    const out = new Float32Array(this._pendLen);
    let k = 0;
    for (const p of this._pend) { out.set(p, k); k += p.length; }
    this._pend = [];
    this._pendLen = 0;
    this.emit('audio', out, P.AUDIO_RATE);
  }

  /**
   * signal_power is "Measured signal power", in dB (API 1.0.3).
   * UNCONFIRMED: whether it is calibrated dBm; it is passed on as the S-meter's dBm.
   */
  _meter(v) {
    const db = P.parseNum(v);
    if (db == null) return;
    const now = Date.now();
    if (now - this._lastMeterAt < SMETER_EVERY_MS) return;
    this._lastMeterAt = now;
    this.emit('smeter', db);
  }

  _startPoll() {
    if (this._pollTimer) return;
    this._pollTimer = setInterval(() => {
      const s = this.session;
      if (!s || !s.live || !this._connected) return;
      if (Date.now() - this._lastPushAt < this._smeterPollMs * 2) return;
      s.get(P.PROP.SIGNAL_POWER, this._smeterPollMs).then((v) => { if (v != null && this.session === s) this._meter(v); });
    }, this._smeterPollMs);
    if (this._pollTimer.unref) this._pollTimer.unref();
  }

  /** Resolves when the connection is released (and closed, when nobody else uses it). */
  disconnect() {
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
    this._pend = [];
    this._pendLen = 0;
    const s = this.session;
    this.session = null;
    let p = Promise.resolve();
    if (s) {
      for (const [ev, fn] of this._off.splice(0)) s.removeListener(ev, fn);
      s.listeners = Math.max(0, s.listeners - 1);
      s.enableStream('audio', false);
      p = this.registry.release(s);
    }
    this._setConnected(false, true);
    return p;
  }
}

module.exports = { SdrConnectAudioClient, AUDIO_PACKET, IF_SHIFT_HZ, GIVE_UP_AFTER };
