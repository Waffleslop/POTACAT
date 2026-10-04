// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// JTTY engine — the JTCAT engine for WSJT-X 3.2's JTTY mode (K1JT): 4-GFSK at
// 31.25 baud, 127 Hz wide, 1.888 s frames, keyboard-to-keyboard with no timed
// T/R sequence. Phase 3 of docs/jtty-integration-plan.md.
//
// Contract: drop-in sibling of PskEngine (lib/psk-engine.js) and Ft8Engine.
// JtcatManager and main.js reach into the same public underscore fields
// (_running, _txEnabled, _txActive, _txFreq, _mode, _txMessage) and call the
// same method names. Like PSK31 it is a continuous mode: RX runs all the time
// and emits one 'jtty-rx' per decoder update; TX is one shot — requestTx()
// emits a single 'tx-start' with the FT2-immediate payload shape and main.js's
// existing dispatch (PTT, SmartSDR/Icom/renderer routes, failsafe) does the
// rest.
//
// Unlike PSK31 the receiver is heavy (lib/jtty/decoder.js: a sync search over
// the whole passband every quarter frame), so it runs in a worker thread
// (lib/jtty/decoder-worker.js) and this class is the thin host: it keeps the
// stream clock, swaps silence in for our own transmission, and turns the
// decoder's updates into events with a UTC stamp.
//
// The transmit side never alters meaning: a message the grammar cannot carry
// (bad character, too many frames, over the TX cap) is REFUSED with an
// 'encode-failed', exactly as WSJT-X refuses it — never trimmed the way a
// PSK31 over is, because a JTTY frame is a packed sentence, not a byte stream.

const { EventEmitter } = require('events');
const path = require('path');
const { Worker } = require('worker_threads');
const J = require('./jtty');
const { JttyDecoder } = require('./jtty/decoder');

const SAMPLE_RATE = 12000;
const F0_MIN = 200;              // lowest tone; the receiver's band windows run 200..2800
const F0_MAX = 2700;             // plus 127 Hz of signal stays under 2800
// main.js's TX failsafe hard-drops PTT at 130 s (armJtcatTxFailsafe clamp).
// A message is refused, not shortened, when it would not fit under this.
const TX_MAX_SEC = 120;
const TX_SAFETY_GRACE_MS = 5000; // engine's own tx-end backstop = bufDur + this

const PROFILES = ['unknown', 'field-day', 'rtty-roundup'];

/**
 * Pure: the answer to "will this text transmit, and how long will it take".
 * Shared by setTxMessage and main.js's jtcat-validate-tx-msg so what the
 * composer accepts is exactly what the engine keys.
 * @returns {{ok:true, text, nframes, durationSec} | {ok:false, reason}}
 */
function validateMessage(text, profile) {
  const raw = String(text == null ? '' : text);
  if (!raw.trim()) return { ok: false, reason: 'Empty message' };
  // The reference packer truncates to character*80 because WSJT-X's text box
  // cannot hold more; a composer that can must refuse, or the other station
  // reads the first 80 characters of a longer sentence as the whole of it.
  const squeezed = raw.trim().replace(/\s+/g, ' ');
  if (squeezed.length > J.codec.MAX_MESSAGE) {
    return { ok: false, reason: `${squeezed.length} characters — JTTY carries at most ${J.codec.MAX_MESSAGE} in one message; send it in two parts` };
  }
  const p = J.pack(raw, profile);
  if (!p.ok) return { ok: false, reason: p.error };
  if (p.nframes === 0) return { ok: false, reason: 'Empty message' };
  if (p.durationSec > TX_MAX_SEC) {
    return { ok: false, reason: `${p.nframes} frames (${Math.round(p.durationSec)} s) is over the ${TX_MAX_SEC} s transmit cap — send it in two parts` };
  }
  return { ok: true, text: p.text, nframes: p.nframes, durationSec: p.durationSec };
}

class JttyEngine extends EventEmitter {
  /**
   * @param {object} [opts] { profile: 'unknown'|'field-day'|'rtty-roundup', worker: true }
   *   worker:false runs the decoder inline (tests); the app always uses the thread.
   */
  constructor(opts) {
    super();
    const o = opts || {};
    // Contract fields (read/written externally by jtcat-manager / main.js)
    this._running = false;
    this._txEnabled = false;
    this._txActive = false;
    this._txFreq = 1500;    // lowest tone, the frequency WSJT-X and rjtty report
    this._rxFreq = 1500;    // QSO window centre — transceive, like PSK31
    this._mode = 'JTTY';
    this._txMessage = '';
    this._txSamples = null;
    this._txRenderedMsg = '';
    this._txRenderedFreq = 0;
    this._txRenderedProfile = '';
    this._txEndTimer = null;
    this._holdTxFreq = false;
    this._profile = PROFILES.includes(o.profile) ? o.profile : 'unknown';
    this._useWorker = o.worker !== false;

    this._worker = null;
    this._workerReady = false;
    this._inline = null;      // JttyDecoder when worker:false
    this._samplesFed = 0;     // stream clock: samples handed to the decoder since start
    this._streamStartMs = 0;  // wall clock of stream sample 0
    this._lastRxCompleteAt = 0;
  }

  // ---- lifecycle -------------------------------------------------------------

  start() {
    if (this._running) return;
    this._running = true;
    this._samplesFed = 0;
    this._streamStartMs = 0;
    if (this._useWorker) this._startWorker();
    else this._inline = new JttyDecoder({ qsoFreq: this._rxFreq, qsoTol: 50 });
    this.emit('status', { state: 'running', mode: this._mode });
  }

  stop() {
    this._running = false;
    if (this._txEndTimer) {
      clearTimeout(this._txEndTimer);
      this._txEndTimer = null;
    }
    if (this._txActive) {
      this._txActive = false;
      this.emit('tx-end', {});
    }
    this._txSamples = null;
    this._txRenderedMsg = '';
    if (this._worker) {
      const w = this._worker;
      this._worker = null;
      this._workerReady = false;
      try { w.terminate(); } catch { /* already gone */ }
    }
    this._inline = null;
    this.emit('status', { state: 'stopped' });
  }

  _startWorker() {
    const w = new Worker(path.join(__dirname, 'jtty', 'decoder-worker.js'));
    this._worker = w;
    this._workerReady = false;
    w.on('message', (msg) => this._onWorkerMessage(w, msg));
    w.on('error', (err) => {
      this.emit('error', { message: 'jtty worker: ' + (err && err.message ? err.message : err) });
    });
    w.on('exit', (code) => {
      if (this._running && this._worker === w) {
        // A dead decoder is a silent radio — restart it, loudly.
        this.emit('error', { message: `jtty worker exited (${code}) — restarting` });
        this._workerReady = false;
        setTimeout(() => { if (this._running && this._worker === w) this._startWorker(); }, 1000);
      }
    });
  }

  _onWorkerMessage(w, msg) {
    if (w !== this._worker) return; // a terminated worker's last words
    switch (msg.type) {
      case 'ready':
        this._workerReady = true;
        w.postMessage({ type: 'reset', qsoFreq: this._rxFreq });
        // The decoder's time base restarts with it.
        this._samplesFed = 0;
        this._streamStartMs = 0;
        break;
      case 'updates':
        this._emitUpdates(msg.updates);
        break;
      case 'error':
        this.emit('error', { message: 'jtty decoder: ' + msg.message });
        break;
      default:
        break;
    }
  }

  // ---- receive ---------------------------------------------------------------

  /**
   * Feed mono 12 kHz audio. During our own transmission the same number of
   * samples goes in as SILENCE: the decoder's clock stays continuous (a
   * message spanning our over still assembles) and we never decode our own
   * sidetone or a loopback echo as a station calling us.
   * @param {Float32Array} samples
   */
  feedAudio(samples) {
    if (!this._running || !samples || !samples.length) return;
    if (!this._streamStartMs) {
      this._streamStartMs = Date.now();
    }
    let out = samples;
    if (this._txActive) out = new Float32Array(samples.length);
    else if (!(samples instanceof Float32Array)) out = Float32Array.from(samples);
    this._samplesFed += out.length;
    if (this._inline) {
      this._emitUpdates(this._inline.feed(out));
      return;
    }
    if (!this._worker || !this._workerReady) return; // audio before the thread is up is lost, like FT8's
    // Copy so the caller's buffer (an audio-bridge ring) is never detached.
    const copy = out === samples ? Float32Array.from(out) : out;
    this._worker.postMessage({ type: 'feed', samples: copy }, [copy.buffer]);
  }

  _emitUpdates(updates) {
    if (!updates || !updates.length) return;
    for (const u of updates) {
      const utcMs = this._streamStartMs ? this._streamStartMs + Math.round(u.tStart * 1000) : Date.now();
      const ev = {
        id: u.id,
        text: u.text,
        complete: !!u.complete,
        freqHz: u.freqHz,
        snrDb: u.snrDb,
        tStart: u.tStart,
        utcMs,
        mode: 'JTTY',
      };
      if (ev.complete) this._lastRxCompleteAt = Date.now();
      this.emit('jtty-rx', ev);
    }
  }

  // ---- frequency / profile ---------------------------------------------------

  /**
   * Move the audio frequency (lowest tone). Transceive: the receiver's QSO
   * window follows, as PSK31's does. A pending message is re-rendered.
   */
  setTxFreq(hz) {
    const f = Math.max(F0_MIN, Math.min(F0_MAX, Math.round(Number(hz) || 1500)));
    if (f === this._txFreq && f === this._rxFreq) return;
    this._txFreq = f;
    this._rxFreq = f;
    if (this._inline) this._inline.setQsoFreq(f);
    if (this._worker && this._workerReady) this._worker.postMessage({ type: 'qso-freq', qsoFreq: f });
    if (this._txMessage && this._txRenderedFreq !== f) this._renderTx();
  }

  /** Alias — same audio frequency for both directions. */
  setRxFreq(hz) { this.setTxFreq(hz); }

  /** Exchange profile: 'unknown' | 'field-day' | 'rtty-roundup'. Re-renders a pending message. */
  setProfile(profile) {
    const p = PROFILES.includes(profile) ? profile : 'unknown';
    if (p === this._profile) return;
    this._profile = p;
    if (this._txMessage) this._renderTx();
  }

  get profile() { return this._profile; }

  // ---- transmit --------------------------------------------------------------

  /**
   * Store + pre-render the TX message. Resolves with the PCM buffer, or null
   * when the message is refused (an 'encode-failed' is emitted — the rig will
   * not key until the text changes). Returns a Promise for contract parity.
   */
  setTxMessage(text) {
    const msg = String(text == null ? '' : text);
    this._txMessage = msg;
    if (!msg.trim()) {
      this._txMessage = '';
      this._txSamples = null;
      this._txRenderedMsg = '';
      return Promise.resolve(null);
    }
    this._renderTx();
    return Promise.resolve(this._txSamples);
  }

  _renderTx() {
    const v = validateMessage(this._txMessage, this._profile);
    if (!v.ok) {
      this._txSamples = null;
      this._txRenderedMsg = '';
      this.emit('encode-failed', { mode: 'JTTY', message: this._txMessage, reason: v.reason });
      return;
    }
    const e = J.encode(this._txMessage, { profile: this._profile, f0: this._txFreq, sampleRate: SAMPLE_RATE });
    if (!e.ok) {
      this._txSamples = null;
      this._txRenderedMsg = '';
      this.emit('encode-failed', { mode: 'JTTY', message: this._txMessage, reason: e.error });
      return;
    }
    this._txSamples = e.pcm;
    this._txRenderedMsg = this._txMessage;
    this._txRenderedFreq = this._txFreq;
    this._txRenderedProfile = this._profile;
    this._txRenderedText = e.text;       // the normalized text that goes on air
    this._txRenderedFrames = e.nframes;
  }

  /** Pure render for tests/preview — does not touch engine TX state. */
  renderMessage(text, freqHz) {
    const e = J.encode(String(text || ''), { profile: this._profile, f0: freqHz != null ? freqHz : this._txFreq });
    return Promise.resolve(e.ok ? e.pcm : null);
  }

  /** validateMessage for the current profile (main.js's jtcat-validate-tx-msg). */
  validate(text) { return validateMessage(text, this._profile); }

  /**
   * Fire TX now — JTTY has no slots, so this is the whole trigger. Emits one
   * 'tx-start' with the FT2-immediate payload shape; main.js keys PTT, plays
   * the buffer, and calls txComplete().
   * @returns {boolean} true if TX started
   */
  requestTx() {
    if (!this._running || !this._txEnabled || !this._txMessage || this._txActive) return false;
    if (!this._txSamples || this._txRenderedMsg !== this._txMessage
        || this._txRenderedFreq !== this._txFreq || this._txRenderedProfile !== this._profile) return false;
    this._txActive = true;
    const safetyMs = Math.round((this._txSamples.length / SAMPLE_RATE) * 1000) + TX_SAFETY_GRACE_MS;
    if (this._txEndTimer) clearTimeout(this._txEndTimer);
    this._txEndTimer = setTimeout(() => {
      if (this._txActive) {
        console.warn('[JTCAT] JTTY TX safety timeout — forcing tx-end');
        this._txActive = false;
        this.emit('tx-end', {});
      }
    }, safetyMs);
    this.emit('tx-start', {
      samples: this._txSamples,
      message: this._txRenderedText || this._txMessage,
      freq: this._txFreq,
      slot: '--',
      offsetMs: 0,
      nframes: this._txRenderedFrames,
    });
    return true;
  }

  /** Signal that TX audio playback has completed (called from main process). */
  txComplete() {
    if (!this._txActive) return;
    this._txActive = false;
    if (this._txEndTimer) {
      clearTimeout(this._txEndTimer);
      this._txEndTimer = null;
    }
    this.emit('tx-end', {});
  }

  // ---- Ft8Engine-contract stubs ----------------------------------------------
  // main.js calls these unconditionally on the active engine; they're
  // FT8-slot/WSPR concepts with no JTTY meaning. tryImmediateTx maps to the
  // real trigger so any generic "fire now" caller still works.

  tryImmediateTx() { return this.requestTx(); }
  setMode() { /* JTTY engine is single-mode; family switches rebuild the slice */ }
  setTxSlot() {}
  setHoldTxFreq(on) { this._holdTxFreq = !!on; }
  setLateStartTx() {}
  setApContext() {}
  setAudioLatencyMs() {}
  setAudioLatencyAuto() {}
  seedAudioLatencyMs() {}
  setWsprDial() {}
  setSquelch() {}
  reBaseline() {}
  encodeMessage() { return Promise.resolve(null); }
}

module.exports = {
  JttyEngine,
  validateMessage,
  PROFILES,
  SAMPLE_RATE,
  TX_MAX_SEC,
  F0_MIN,
  F0_MAX,
};
