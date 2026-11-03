// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
/**
 * Js8Engine — JS8 as a first-class JTCAT engine.
 *
 * The third Ft8Engine-contract sibling (Ft8Engine, PskEngine, this), hosted
 * by jtcat-manager via startSlice({ mode: 'JS8' }). Being a sibling is the
 * entire architecture: slice hosting, audio routing, the tx-start dispatch
 * choke point in main.js (radio-owner arbiter, SWR guard, wrong-band guard,
 * PTT, every audio route), and the waterfall all come for free. There is no
 * JS8Call application, no TCP API, no virtual audio cable — POTACAT *is*
 * the JS8 station. (See docs/js8-native-plan.md for how we got here.)
 *
 * Same two contract traps as PskEngine, both load-bearing:
 *   - Ft8Engine.setMode() COERCES unknown mode strings to FT8, so a
 *     JS8 <-> FT-family switch must REBUILD the slice; the branch lives in
 *     jtcat-manager.startSlice, never in setMode.
 *   - Never write settings.jtcatLastMode with 'JS8'.
 *
 * RX: feedAudio(12 kHz mono) → js8-worker (real JS8Call modem + varicode)
 *     → 'js8-rx' events with fully interpreted frames. Deliberately NOT
 *     routed into the FT8 decode/QSO machinery — JS8 is a conversation
 *     mode; lib/js8call-threads.js consumes these in main.
 *
 * TX: setTxText() builds the frame queue (multi-frame messages are one
 *     frame per period); enabling TX arms it, and each period boundary
 *     emits one 'tx-start' with the standard payload shape
 *     { samples, message, freq, slot, offsetMs } that main.js's dispatch
 *     already knows how to key, route, and failsafe. PTT drops between
 *     frames (each period is an independent transmission, per JS8Call).
 */

'use strict';

const { EventEmitter } = require('events');
const { Worker } = require('worker_threads');
const path = require('path');

const V = require('./js8-varicode');
const StationClock = require('./station-clock'); // slot timing may run on a corrected clock (time from the phone)

const SAMPLE_RATE = 12000;

// Per-submode timing (mirrors JS8Submode.cpp; the addon is authoritative,
// these only drive the engine's wall-clock scheduler).
const SUBMODES = {
  NORMAL: { id: 0, bit: 1 << 0, period: 15, startDelayMs: 500, txSec: 13.14 },
  FAST: { id: 1, bit: 1 << 1, period: 10, startDelayMs: 200, txSec: 8.4 },
  TURBO: { id: 2, bit: 1 << 2, period: 6, startDelayMs: 100, txSec: 4.36 },
  SLOW: { id: 4, bit: 1 << 3, period: 30, startDelayMs: 500, txSec: 26.28 },
  ULTRA: { id: 8, bit: 1 << 4, period: 4, startDelayMs: 100, txSec: 2.72 },
};
const DEFAULT_SUBMODE = 'NORMAL';

class Js8Engine extends EventEmitter {
  constructor() {
    super();
    // Ft8Engine contract fields (read/written externally)
    this._running = false;
    this._txEnabled = false;
    this._txActive = false;
    this._txFreq = 1500;
    this._rxFreq = 1500;
    this._mode = 'JS8';
    this._txMessage = '';

    this._submodeName = DEFAULT_SUBMODE;
    this._worker = null;
    this._workerReady = false;
    this._encodeSeq = 1;
    this._encodeWaiters = new Map(); // id -> {resolve, reject}

    // TX frame queue: [{ frame, bits, samples|null }]
    this._txQueue = [];
    this._txQueueMessage = '';
    this._txTotal = 0;      // frames in the current message, for "TX 1/3" progress
    this._slotTimer = null;
    this._lastSlot = -1;
    this._rxSlot = -1;   // UTC period the RX ring is currently anchored to
    this._txEndTimer = null;

    // Station identity for buildMessageFrames
    this._myCall = '';
    this._myGrid = '';
    this._selectedCall = '';

    // Spectrum ring for the popout waterfall. JS8 decodes in MAIN (there is no
    // renderer WebAudio graph feeding an AnalyserNode the way FT8 has), so the
    // waterfall is painted from a main-side FFT over this ring — mirroring
    // Ft8Engine._audioBuffer so the same computeSpectrumBins() can read it.
    // Sized well past the 2048-sample FFT window. Written in feedAudio.
    this._specBuffer = new Float32Array(SAMPLE_RATE * 4); // 4 s @ 12 kHz
    this._specOffset = 0;
  }

  get submode() { return SUBMODES[this._submodeName]; }

  setStation({ call, grid } = {}) {
    if (call !== undefined) this._myCall = String(call || '').toUpperCase();
    if (grid !== undefined) this._myGrid = String(grid || '').toUpperCase().slice(0, 4);
  }

  setSelectedCall(call) { this._selectedCall = String(call || '').toUpperCase(); }

  setSubmode(name) {
    const key = String(name || '').toUpperCase();
    if (!SUBMODES[key]) return false;
    this._submodeName = key;
    this._pushDecodeParams();
    return true;
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  start() {
    if (this._running) return;
    this._running = true;
    this._startWorker();
    // The slot clock drives TX; 100 ms is well inside the 500 ms start
    // delay budget and matches the Ft8Engine cadence.
    this._slotTimer = setInterval(() => this._slotTick(), 100);
    this.emit('status', { state: 'running', mode: this._mode });
  }

  stop() {
    this._running = false;
    if (this._slotTimer) { clearInterval(this._slotTimer); this._slotTimer = null; }
    if (this._txEndTimer) { clearTimeout(this._txEndTimer); this._txEndTimer = null; }
    if (this._txActive) {
      this._txActive = false;
      this.emit('tx-end', {});
    }
    this._txQueue = [];
    this._txQueueMessage = '';
    if (this._worker) {
      const w = this._worker;
      this._worker = null;
      this._workerReady = false;
      // Ask first, kill later. terminate() landing while the worker is
      // inside a native decode/encode tears down the isolate under the
      // addon's feet — a deterministic segfault, not a theoretical one. The
      // shutdown message drains the queue (worker messages are processed in
      // order, so any in-flight work finishes first) and the worker closes
      // its own port; terminate() remains only as a 2 s dead-worker fallback.
      try { w.postMessage({ type: 'shutdown' }); } catch { /* already dead */ }
      const killTimer = setTimeout(() => { w.terminate().catch(() => {}); }, 2000);
      if (typeof killTimer.unref === 'function') killTimer.unref();
      w.once('exit', () => clearTimeout(killTimer));
    }
    // Cancel, don't error: these rejections resolve on a LATER microtask —
    // by then the manager has already called removeAllListeners(), and an
    // emit('error') with no listener is fatal to the process (observed as a
    // full crash, then a segfault in native-addon worker teardown). A
    // deliberate stop is not an error; the catch below swallows cancels.
    for (const [, waiter] of this._encodeWaiters) {
      const err = new Error('engine stopped');
      err.cancelled = true;
      waiter.reject(err);
    }
    this._encodeWaiters.clear();
    this.emit('status', { state: 'stopped' });
  }

  _startWorker() {
    const w = new Worker(path.join(__dirname, 'js8-worker.js'));
    this._worker = w;
    w.on('message', (msg) => this._onWorkerMessage(msg));
    w.on('error', (err) => {
      this.emit('error', { message: 'js8 worker: ' + (err.message || err) });
    });
    w.on('exit', (code) => {
      if (this._running && this._worker === w) {
        // A dead decoder is a silent radio — restart it, loudly.
        this.emit('error', { message: `js8 worker exited (${code}) — restarting` });
        this._workerReady = false;
        setTimeout(() => { if (this._running) this._startWorker(); }, 1000);
      }
    });
  }

  _onWorkerMessage(msg) {
    switch (msg.type) {
      case 'ready':
        this._workerReady = true;
        this._pushDecodeParams();
        break;
      case 'frames':
        for (const d of msg.decodes) this.emit('js8-rx', d);
        break;
      case 'decode-ran':
        // Surfaced for the on-air diagnostic (main logs it, throttled).
        this.emit('decode-ran', msg);
        break;
      case 'encode-result': {
        const waiter = this._encodeWaiters.get(msg.id);
        if (waiter) {
          this._encodeWaiters.delete(msg.id);
          waiter.resolve(msg);
        }
        break;
      }
      case 'error': {
        if (msg.id && this._encodeWaiters.has(msg.id)) {
          const waiter = this._encodeWaiters.get(msg.id);
          this._encodeWaiters.delete(msg.id);
          waiter.reject(new Error(msg.message));
        } else {
          this.emit('error', { message: msg.message });
        }
        break;
      }
      default:
        break;
    }
  }

  _pushDecodeParams() {
    if (!this._worker || !this._workerReady) return;
    this._worker.postMessage({
      type: 'decode-params',
      submodes: this.submode.bit,
      nfa: 500,
      nfb: 2700,
      nfqso: Math.round(this._rxFreq),
    });
  }

  // ── RX ─────────────────────────────────────────────────────────────────────

  /**
   * Feed mono 12 kHz audio. Forwarded to the worker; skipped while keyed
   * (the rig's RX is our own sidetone during TX).
   * @param {Float32Array} samples
   */
  feedAudio(samples) {
    if (!this._running || this._txActive) return;
    if (!samples || !samples.length) return;
    // Mirror into the spectrum ring first (the waterfall wants audio even if
    // the decode worker is momentarily not ready). Main reads it at ~10 fps.
    const sb = this._specBuffer;
    for (let i = 0; i < samples.length; i++) {
      sb[this._specOffset] = samples[i];
      if (++this._specOffset >= sb.length) this._specOffset = 0;
    }
    if (!this._worker || !this._workerReady) return;
    // Anchor the decoder's sample clock to the UTC period boundary. JS8
    // transmissions start on :00/:15/:30/:45, and the decode window
    // (the isDecodeReady port) is computed from the count of appended
    // samples `k` — so if k is never re-anchored, the window drifts free of
    // UTC and every decode straddles two transmissions, syncing on nothing.
    // JS8Call's Detector resets its ring at the boundary; we don't vendor
    // Detector (it's a Qt audio device), so the engine must do it. Without
    // this, TX works but RX never decodes a single frame (K3SBP on-air,
    // 2026-08-09 — 4 min on a busy 20m, zero decodes). Reset drops only the
    // sub-frame of audio before the boundary; the transmission starts ~0.5 s
    // in, well after.
    const periodMs = this.submode.period * 1000;
    const slot = Math.floor(StationClock.now() / periodMs);
    if (slot !== this._rxSlot) {
      this._rxSlot = slot;
      this._worker.postMessage({ type: 'reset' });
    }
    // Copy: the caller reuses its buffer, and transfer would detach it.
    const copy = new Float32Array(samples);
    this._worker.postMessage({ type: 'audio', samples: copy }, [copy.buffer]);
  }

  setRxFreq(hz) {
    this._rxFreq = Math.max(200, Math.min(4000, Number(hz) || 1500));
    this._pushDecodeParams();
  }

  /** Set the TX audio offset (Hz in passband). The operator picks it on the
   *  waterfall — JS8 offsets matter more than FT8's. Queued frames were
   *  rendered at the old offset, so drop their cached audio and re-encode. */
  setTxFreq(hz) {
    const f = Math.max(200, Math.min(3000, Number(hz) || 1500));
    if (f === this._txFreq) return;
    this._txFreq = f;
    for (const q of this._txQueue) q.samples = null;
    this._renderNextFrame();
  }

  // ── TX ─────────────────────────────────────────────────────────────────────

  /**
   * Build the frame queue for a message. Returns frame count, or 0 when
   * nothing packs (which the caller must surface — a message that packs to
   * nothing would otherwise arm TX and key silence).
   */
  setTxText(text) {
    this._txMessage = String(text || '');
    this._txQueue = [];
    this._txQueueMessage = '';
    this._txTotal = 0;
    if (!this._txMessage.trim()) return 0;
    if (!this._myCall) return 0;

    const { frames } = V.buildMessageFrames({
      mycall: this._myCall,
      mygrid: this._myGrid,
      selectedCall: this._selectedCall,
      text: this._txMessage,
      // JS8Call's default ("avoid forced identify" off): free text that
      // addresses nobody goes out as "MYCALL: text", so an unaddressed
      // message still identifies the station (K9CYT 2026-10-04).
      forceIdentify: true,
      submode: this.submode.id,
    });
    this._txQueue = frames.map((f) => ({ ...f, samples: null }));
    this._txQueueMessage = this._txMessage;
    this._txTotal = this._txQueue.length;
    // Pre-render the first frame so the next slot boundary can fire on time.
    this._renderNextFrame();
    return this._txQueue.length;
  }

  get txQueueLength() { return this._txQueue.length; }

  _renderNextFrame() {
    const next = this._txQueue[0];
    if (!next || next.samples || !this._worker || !this._workerReady) return;
    const id = this._encodeSeq++;
    const p = new Promise((resolve, reject) => {
      this._encodeWaiters.set(id, { resolve, reject });
    });
    this._worker.postMessage({
      type: 'encode',
      id,
      frame: next.frame,
      itype: next.bits,
      submode: this.submode.id,
      freq: this._txFreq,
    });
    p.then((msg) => {
      // The queue may have been replaced while we rendered.
      if (this._txQueue[0] === next) next.samples = msg.samples;
    }).catch((err) => {
      if (err && err.cancelled) return;   // deliberate stop, not a failure
      // Guarded emit: 'error' with no listener is fatal to the process, and
      // this callback can outlive the manager's listener teardown.
      if (this.listenerCount('error') > 0) {
        this.emit('error', { message: 'JS8 TX encode failed: ' + err.message });
      }
      this.emit('encode-failed', { frame: next.frame });
    });
  }

  _slotTick() {
    if (!this._running) return;
    const sub = this.submode;
    const periodMs = sub.period * 1000;
    const now = StationClock.now();
    const slot = Math.floor(now / periodMs);
    if (slot === this._lastSlot) return;
    const intoSlotMs = now - slot * periodMs;
    // Fire only in the first 300 ms of the slot — the audio routes prepend
    // the ~500 ms PTT-settle lead, which lands the first symbol at the
    // submode's start delay. Late ticks wait for the next period.
    if (intoSlotMs > 300) return;
    this._lastSlot = slot;

    if (!this._txEnabled || this._txActive) return;
    const next = this._txQueue[0];
    if (!next) return;
    if (!next.samples) { this._renderNextFrame(); return; } // try next period

    this._txQueue.shift();
    this._txActive = true;

    const durMs = Math.round((next.samples.length / SAMPLE_RATE) * 1000);
    if (this._txEndTimer) clearTimeout(this._txEndTimer);
    this._txEndTimer = setTimeout(() => {
      if (this._txActive) {
        this.emit('log', '[JS8] TX safety timeout — forcing tx-end');
        this.txComplete();
      }
    }, durMs + 3000);

    this.emit('tx-start', {
      samples: next.samples,
      message: this._txMessage,
      frame: next.frame,
      freq: this._txFreq,
      slot: String(slot % 2 === 0 ? 'even' : 'odd'),
      offsetMs: 0,
      framesLeft: this._txQueue.length,
    });

    // Render the following frame while this one is on the air.
    this._renderNextFrame();
  }

  /** Playback complete (called by main.js's dispatch when audio ends). */
  txComplete() {
    if (!this._txActive) return;
    this._txActive = false;
    if (this._txEndTimer) { clearTimeout(this._txEndTimer); this._txEndTimer = null; }
    this.emit('tx-end', {});
    if (this._txQueue.length === 0) {
      this._txEnabled = false;
      // Only announce a completion when there was a message to finish. A halt
      // (setTxMessage('')) clears _txQueueMessage first, so cutting the frame
      // in flight doesn't fire a bogus "message fully transmitted".
      if (this._txQueueMessage) {
        this.emit('js8-tx-done', { message: this._txQueueMessage });
      }
      this._txMessage = '';
      this._txQueueMessage = '';
      this._txTotal = 0;
    }
  }

  // ── Ft8Engine-contract stubs ───────────────────────────────────────────────
  // main.js calls these unconditionally on the active engine; they're
  // FT8-slot/WSPR concepts with no JS8 meaning.

  tryImmediateTx() {
    // "Fire now" still respects the period clock — arming is the trigger.
    this._txEnabled = true;
    return this._txQueue.length > 0;
  }
  setMode() { /* JS8 engine is single-family; mode switches rebuild the slice */ }
  /**
   * Ft8Engine's pending-TX setter. JS8 arms TX through setTxText(); the one
   * caller that reaches this is the JTCAT halt path (jtcat-halt-tx), which
   * passes '' to drop everything queued. Without it that handler threw
   * mid-loop and skipped the real frame cut (cancelTx + PTT release live
   * AFTER the loop), so halt did almost nothing on a JS8 slice. Clearing the
   * queue here drops pending frames and lets txQueueLength — which the halt UI
   * gates on — fall to zero. A non-empty arg arms normally, matching Ft8Engine.
   */
  setTxMessage(text) {
    if (String(text || '').trim()) return this.setTxText(text);
    this._txQueue = [];
    this._txMessage = '';
    this._txQueueMessage = '';
    this._txTotal = 0;
    return 0;
  }
  setTxSlot() {}
  setHoldTxFreq() {}
  setLateStartTx() {}
  setApContext() {}
  setAudioLatencyMs() {}
  setAudioLatencyAuto() {}
  seedAudioLatencyMs() {}
  setWsprDial() {}
  reBaseline() {}
  encodeMessage() { return Promise.resolve(null); }
}

module.exports = { Js8Engine, SUBMODES, SAMPLE_RATE };
