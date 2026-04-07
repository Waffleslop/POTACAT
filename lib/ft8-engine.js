/**
 * FT8 Engine — Core orchestrator for JTCAT.
 *
 * Manages:
 *  - 15-second decode cycles (FT8) / 7.5-second (FT4)
 *  - Audio buffer accumulation from any source
 *  - Decode via worker thread (ft8js WASM)
 *  - TX tone generation and scheduling
 *  - QSO state machine (Phase 3)
 *
 * Events emitted:
 *  - 'decode'    — { cycle, results: [{db, dt, df, text}] }
 *  - 'cycle'     — { number, mode, slot } — new decode cycle started
 *  - 'tx-start'  — { samples: Float32Array, message, freq, slot } — TX audio ready
 *  - 'tx-end'    — {} — TX period elapsed (safety PTT release)
 *  - 'status'    — { state, sync, nextCycle }
 *  - 'error'     — { message }
 */

const { EventEmitter } = require('events');
const { Worker } = require('worker_threads');
const path = require('path');

// FT8 digital mode frequencies (kHz) per band
const DIGITAL_FREQS = {
  '160m': 1840,
  '80m':  3573,
  '60m':  5357,
  '40m':  7074,
  '30m': 10136,
  '20m': 14074,
  '17m': 18100,
  '15m': 21074,
  '12m': 24915,
  '10m': 28074,
  '6m':  50313,
  '2m': 144174,
};

// FT4 digital mode frequencies (kHz) per band
const FT4_FREQS = {
  '160m': 1840,
  '80m':  3568,
  '60m':  5357,
  '40m':  7047.5,
  '30m': 10140,
  '20m': 14080,
  '17m': 18104,
  '15m': 21140,
  '12m': 24919,
  '10m': 28180,
  '6m':  50318,
};

// FT2 digital mode frequencies (kHz) per band
const FT2_FREQS = {
  '160m': 1843,
  '80m':  3578,
  '60m':  5360,
  '40m':  7052,
  '30m': 10144,
  '20m': 14084,
  '17m': 18108,
  '15m': 21144,
  '12m': 24923,
  '10m': 28184,
};

/** Return the correct frequency table for a given mode. */
function freqsForMode(mode) {
  if (mode === 'FT4') return FT4_FREQS;
  if (mode === 'FT2') return FT2_FREQS;
  return DIGITAL_FREQS;
}

const SAMPLE_RATE = 12000;
const FT8_CYCLE_SEC = 15;
const FT4_CYCLE_SEC = 7.5;
const FT2_CYCLE_SEC = 3.8;
const FT8_SAMPLES = SAMPLE_RATE * FT8_CYCLE_SEC; // 180,000
const FT4_SAMPLES = 90000; // 7.5s input buffer for FT4
const FT2_SAMPLES = 45000; // 3.75s input buffer for FT2
const FT2_TX_DURATION_MS = 2520; // 105 * 288 / 12000 * 1000

class Ft8Engine extends EventEmitter {
  constructor() {
    super();
    this._worker = null;
    this._workerReady = false;
    this._mode = 'FT8'; // 'FT8' | 'FT4' | 'FT2'
    this._running = false;
    this._cycleTimer = null;
    this._cycleNumber = 0;
    this._msgId = 0;

    // Audio buffer accumulation
    this._audioBuffer = new Float32Array(FT8_SAMPLES);
    this._audioOffset = 0;
    this._feedDiag = 0;
    this._zeroDecodeCycles = 0;
    this._hasEverDecoded = false;
    this._lastCycleMax = 0;

    // TX state
    this._txEnabled = false;
    this._txFreq = 1500; // Hz audio offset
    this._rxFreq = 1500;
    this._txMessage = '';
    this._txSlot = 'auto'; // 'auto' | 'even' | 'odd'
    this._txSamples = null; // pre-encoded audio cache
    this._txEncoding = false;
    this._txEncodedMsg = ''; // message that _txSamples corresponds to
    this._txEncodedFreq = 0; // freq that _txSamples corresponds to
    this._txTimer = null;
    this._txActive = false; // true while TX audio is playing
    this._txEndTimer = null;
    this._lastRxSlot = null; // slot of last received decode cycle

    // Pending decode callbacks
    this._pending = new Map();
  }

  /**
   * Start the engine — spawns worker, begins cycle timing.
   */
  start() {
    if (this._running) return;
    this._running = true;
    this._spawnWorker();
    this._scheduleCycle();
    this._scheduleTx();
    this.emit('status', { state: 'running', mode: this._mode });
  }

  /**
   * Stop the engine — kills worker, clears timers.
   */
  stop() {
    this._running = false;
    if (this._cycleTimer) {
      clearTimeout(this._cycleTimer);
      this._cycleTimer = null;
    }
    if (this._txTimer) {
      clearTimeout(this._txTimer);
      this._txTimer = null;
    }
    if (this._txEndTimer) {
      clearTimeout(this._txEndTimer);
      this._txEndTimer = null;
    }
    if (this._txActive) {
      this._txActive = false;
      this.emit('tx-end', {});
    }
    if (this._worker) {
      this._worker.terminate();
      this._worker = null;
      this._workerReady = false;
    }
    this._audioOffset = 0;
    this._txSamples = null;
    this._txEncoding = false;
    this._pending.clear();
    this.emit('status', { state: 'stopped' });
  }

  /**
   * Feed audio samples into the engine.
   * Call this continuously as audio arrives from DAX or soundcard.
   * @param {Float32Array} samples — mono audio at 12000 Hz
   */
  feedAudio(samples) {
    if (!this._running) return;
    if (!samples || !samples.length) return;
    const bufLen = this._audioBuffer.length;
    // Diagnostic: check for zero-filled IPC data (macOS audio capture issue)
    if (this._feedDiag++ % 200 === 0) {
      let maxAbs = 0;
      for (let j = 0; j < Math.min(100, samples.length); j++) maxAbs = Math.max(maxAbs, Math.abs(samples[j]));
      if (maxAbs === 0 && this._feedDiag > 1) {
        console.log(`[JTCAT] feedAudio #${this._feedDiag}: all zeros (len=${samples.length}) — audio capture may be dead`);
      }
    }
    for (let i = 0; i < samples.length; i++) {
      this._audioBuffer[this._audioOffset] = samples[i];
      this._audioOffset++;
      if (this._audioOffset >= bufLen) {
        this._audioOffset = 0;
      }
    }
  }

  /**
   * Set mode: 'FT8' or 'FT4'
   */
  setMode(mode) {
    const prev = this._mode;
    this._mode = (mode === 'FT4') ? 'FT4' : (mode === 'FT2') ? 'FT2' : 'FT8';
    // Resize audio buffer for each mode's cycle length
    if (this._mode !== prev) {
      const newSize = this._mode === 'FT2' ? FT2_SAMPLES : this._mode === 'FT4' ? FT4_SAMPLES : FT8_SAMPLES;
      this._audioBuffer = new Float32Array(newSize);
      this._audioOffset = 0;
      // Invalidate pre-encoded TX (encode type changes)
      this._txSamples = null;
      this._txEncodedMsg = '';
      // Reschedule cycle + TX timers for new cycle length
      if (this._running) {
        if (this._cycleTimer) { clearTimeout(this._cycleTimer); this._cycleTimer = null; }
        if (this._txTimer) { clearTimeout(this._txTimer); this._txTimer = null; }
        this._scheduleCycle();
        this._scheduleTx();
      }
    }
  }

  /**
   * Set TX audio frequency offset (Hz within passband).
   */
  setTxFreq(hz) {
    this._txFreq = Math.max(100, Math.min(3000, hz));
    // Invalidate cached samples if freq changed
    if (this._txEncodedFreq !== this._txFreq) this._preEncode();
  }

  /**
   * Set the message to transmit.
   * Pre-encodes immediately so samples are ready at the cycle boundary.
   * Returns a promise that resolves when encoding is complete.
   */
  setTxMessage(text) {
    this._txMessage = text || '';
    return this._preEncode();
  }

  /**
   * Set TX slot preference: 'auto', 'even', or 'odd'.
   * In auto mode, TX uses the opposite of the last received decode slot.
   */
  setTxSlot(slot) {
    this._txSlot = (slot === 'even' || slot === 'odd') ? slot : 'auto';
  }

  /**
   * Signal that TX audio playback has completed (called from main process).
   */
  txComplete() {
    if (!this._txActive) return;
    this._txActive = false;
    if (this._txEndTimer) {
      clearTimeout(this._txEndTimer);
      this._txEndTimer = null;
    }
    this.emit('tx-end', {});
  }

  /**
   * Attempt to start TX immediately if we're in the correct slot and early enough.
   * Called after setting up a reply so we don't miss the current slot.
   * Returns true if TX was fired.
   */
  _cycleSec() {
    return this._mode === 'FT2' ? FT2_CYCLE_SEC : this._mode === 'FT4' ? FT4_CYCLE_SEC : FT8_CYCLE_SEC;
  }

  tryImmediateTx() {
    if (!this._running || !this._txEnabled || !this._txMessage || this._txActive) return false;
    if (!this._txSamples || this._txEncodedMsg !== this._txMessage || this._txEncodedFreq !== this._txFreq) return false;

    const now = Date.now();
    const cycleSec = this._cycleSec();
    const cycleMs = cycleSec * 1000;
    const msIntoCycle = now % cycleMs;

    // FT2 is async — no even/odd slot logic. TX fires immediately when ready.
    if (this._mode === 'FT2') {
      this._txActive = true;
      const safetyMs = FT2_TX_DURATION_MS + 1000;
      this._txEndTimer = setTimeout(() => {
        if (this._txActive) {
          console.warn('[JTCAT] TX safety timeout — forcing tx-end');
          this._txActive = false;
          this.emit('tx-end', {});
        }
      }, safetyMs);
      console.log('[JTCAT] Immediate FT2 TX:', this._txMessage, 'freq', this._txFreq);
      this.emit('tx-start', {
        samples: this._txSamples,
        message: this._txMessage,
        freq: this._txFreq,
        slot: '--',
        offsetMs: 0,
      });
      return true;
    }

    const slot = Math.floor(now / 1000 / cycleSec) % 2 === 0 ? 'even' : 'odd';

    // Must be in the correct slot — if wrong slot, wait for normal scheduler
    if (this._txSlot === 'auto') {
      if (this._lastRxSlot && slot === this._lastRxSlot) return false;
    } else if (this._txSlot !== slot) {
      return false;
    }

    // Allow late-start TX up to 12s into the cycle (leaves ~3s minimum TX).
    const MAX_LATE_MS = 12000;
    if (msIntoCycle > MAX_LATE_MS) {
      console.log('[JTCAT] Too late in cycle (' + msIntoCycle + 'ms), deferring TX to next boundary');
      return false;
    }
    this._txActive = true;
    const remainingMs = cycleMs - msIntoCycle;
    const safetyMs = remainingMs + 1000;
    this._txEndTimer = setTimeout(() => {
      if (this._txActive) {
        console.warn('[JTCAT] TX safety timeout — forcing tx-end');
        this._txActive = false;
        this.emit('tx-end', {});
      }
    }, safetyMs);

    console.log('[JTCAT] Immediate TX:', this._txMessage, '@ slot', slot, 'freq', this._txFreq, msIntoCycle + 'ms into cycle');
    this.emit('tx-start', {
      samples: this._txSamples,
      message: this._txMessage,
      freq: this._txFreq,
      slot,
      offsetMs: msIntoCycle,
    });
    return true;
  }

  /**
   * Set RX audio frequency offset (Hz within passband).
   */
  setRxFreq(hz) {
    this._rxFreq = Math.max(100, Math.min(3000, hz));
  }

  /**
   * Encode a message for TX.
   * @param {string} text — FT8 message (e.g. "CQ K3SBP FN20")
   * @param {number} freq — audio frequency in Hz
   * @returns {Promise<Float32Array|null>}
   */
  async encodeMessage(text, freq) {
    if (!this._workerReady) throw new Error('FT8 worker not ready');
    const id = ++this._msgId;
    const type = this._mode === 'FT4' ? 'ft4-encode' : this._mode === 'FT2' ? 'ft2-encode' : 'encode';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        console.error(`[JTCAT] Encode timeout (10s) for: ${text} @ ${freq}Hz type=${type}`);
        reject(new Error('Encode timeout — ft8js may not support this message'));
      }, 10000);
      this._pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this._worker.postMessage({ type, id, text, frequency: freq || this._txFreq });
    });
  }

  // --- Internal ---

  _respawnWorker() {
    this._respawning = true; // prevent exit handler from double-spawning
    if (this._worker) {
      try { this._worker.terminate(); } catch {}
      this._worker = null;
    }
    this._workerReady = false;
    this._respawning = false;
    this._spawnWorker();
  }

  _spawnWorker() {
    const workerPath = path.join(__dirname, 'ft8-worker.js');
    this._worker = new Worker(workerPath);
    this._worker.on('message', (msg) => this._onWorkerMessage(msg));
    this._worker.on('error', (err) => {
      console.error('[JTCAT] Worker error:', err.message);
      this.emit('error', { message: err.message });
    });
    this._worker.on('exit', (code) => {
      if (this._running && code !== 0 && !this._respawning) {
        console.error(`[JTCAT] Worker exited with code ${code}, restarting...`);
        setTimeout(() => this._spawnWorker(), 1000);
      }
    });
  }

  _onWorkerMessage(msg) {
    if (msg.type === 'ready') {
      this._workerReady = true;
      this._workerNative = !!msg.native;
      console.log('[JTCAT] FT8 worker ready' + (this._workerNative ? ' (native)' : ' (WASM)'));
      return;
    }
    if (msg.type === 'decode-result') {
      this._cycleNumber++;
      const count = (msg.results || []).length;
      console.log(`[JTCAT] Decode result: ${count} decodes`);

      // WASM stall detector: if audio is present (max > 0.1) but decoder
      // returns 0 for 4+ consecutive cycles, the WASM module's internal
      // state is likely corrupted. Respawn the worker for a fresh instance.
      // Skip for native decoder (doesn't stall) and during TX (no RX audio).
      if (count > 0) {
        this._zeroDecodeCycles = 0;
        this._hasEverDecoded = true;
      } else if (!this._workerNative && this._hasEverDecoded && this._lastCycleMax > 0.1 && !this._txActive) {
        this._zeroDecodeCycles = (this._zeroDecodeCycles || 0) + 1;
        if (this._zeroDecodeCycles >= 4) {
          console.warn(`[JTCAT] WASM stall detected (${this._zeroDecodeCycles} empty cycles with audio) — respawning worker`);
          this._zeroDecodeCycles = 0;
          this._respawnWorker();
        }
      }

      this.emit('decode', {
        cycle: this._cycleNumber,
        mode: this._mode,
        slot: this._lastRxSlot,
        results: msg.results || [],
      });
      return;
    }
    if (msg.type === 'encode-result') {
      const cb = this._pending.get(msg.id);
      if (cb) {
        this._pending.delete(msg.id);
        cb.resolve(msg.samples ? new Float32Array(msg.samples) : null);
      }
      return;
    }
    if (msg.type === 'error') {
      const cb = this._pending.get(msg.id);
      if (cb) {
        this._pending.delete(msg.id);
        cb.reject(new Error(msg.message));
      } else {
        this.emit('error', { message: msg.message });
      }
    }
  }

  /**
   * Schedule decode cycles aligned to 15-second (FT8) or 7.5-second (FT4) boundaries.
   */
  _scheduleCycle() {
    if (!this._running) return;

    const now = Date.now();
    const cycleSec = this._cycleSec();
    const cycleMs = cycleSec * 1000;

    // Time until next cycle boundary
    const msIntoCurrentCycle = now % cycleMs;
    // Trigger decode ~0.5s after cycle boundary to allow for propagation delay
    const delay = cycleMs - msIntoCurrentCycle + 500;

    this._cycleTimer = setTimeout(() => {
      this._onCycleBoundary();
      this._scheduleCycle(); // schedule next
    }, delay);
  }

  _onCycleBoundary() {
    if (!this._running || !this._workerReady) return;

    const now = Date.now();
    const cycleSec = this._cycleSec();

    // FT2 is async — no even/odd slot concept
    let slot;
    if (this._mode === 'FT2') {
      slot = '--';
      this._lastRxSlot = null;
    } else {
      slot = Math.floor(now / 1000 / cycleSec) % 2 === 0 ? 'even' : 'odd';
      this._lastRxSlot = slot === 'even' ? 'odd' : 'even';
    }

    this.emit('cycle', { number: this._cycleNumber + 1, mode: this._mode, slot });

    // Grab current audio buffer and rotate so it's in chronological order.
    // The circular buffer may have wrapped: [0..offset-1] = newest, [offset..end] = oldest.
    // The decoder needs samples in chronological order: [oldest ... newest].
    const raw = this._audioBuffer;
    const off = this._audioOffset;
    const samples = new Float32Array(raw.length);
    if (off > 0 && off < raw.length) {
      samples.set(raw.subarray(off), 0);          // oldest part → start
      samples.set(raw.subarray(0, off), raw.length - off); // newest part → end
    } else {
      samples.set(raw);
    }
    // Check multiple spots in the buffer for a better max reading
    let maxSample = 0;
    for (let k = 0; k < samples.length; k += Math.floor(samples.length / 500)) {
      maxSample = Math.max(maxSample, Math.abs(samples[k]));
    }
    this._lastCycleMax = maxSample;
    console.log(`[JTCAT] Cycle boundary: sending ${samples.length} samples to worker, max=${maxSample.toFixed(4)}, offset=${off}`);

    // Silence watchdog: detect dead audio capture
    // Case 1: audio arriving but all zeros (maxSample === 0, buffer partially filled)
    // Case 2: audio capture died completely (offset === 0 or barely advanced)
    const audioStarved = off < 1000; // less than ~80ms of audio received this cycle
    if (maxSample === 0 || audioStarved) {
      this._silentCycles = (this._silentCycles || 0) + 1;
      if (this._silentCycles >= 3) {
        console.warn(`[JTCAT] ${this._silentCycles} consecutive silent cycles (max=${maxSample.toFixed(4)} off=${off}) — requesting audio restart`);
        this.emit('silent');
        this._silentCycles = 0;
      }
    } else {
      this._silentCycles = 0;
    }
    const decodeType = this._mode === 'FT4' ? 'ft4-decode' : this._mode === 'FT2' ? 'ft2-decode' : 'decode';
    this._worker.postMessage(
      { type: decodeType, id: ++this._msgId, samples: samples.buffer },
      [samples.buffer]
    );

    // Allocate new buffer (old one was transferred)
    const bufSize = this._mode === 'FT2' ? FT2_SAMPLES : this._mode === 'FT4' ? FT4_SAMPLES : FT8_SAMPLES;
    this._audioBuffer = new Float32Array(bufSize);
    this._audioOffset = 0;
  }

  /**
   * Pre-encode the current TX message so samples are ready at cycle boundary.
   */
  _preEncode() {
    if (!this._txMessage || !this._workerReady) return Promise.resolve();
    if (this._txEncoding) return this._preEncodePromise || Promise.resolve();
    this._txEncoding = true;
    this._preEncodePromise = this.encodeMessage(this._txMessage, this._txFreq)
      .then((samples) => {
        this._txSamples = samples;
        this._txEncodedMsg = this._txMessage;
        this._txEncodedFreq = this._txFreq;
        this._txEncoding = false;
        this._preEncodePromise = null;
        console.log('[JTCAT] Pre-encoded TX:', this._txEncodedMsg, '@', this._txEncodedFreq, 'Hz,', samples ? samples.length + ' samples' : 'NULL');
      })
      .catch((err) => {
        this._txEncoding = false;
        this._preEncodePromise = null;
        console.error('[JTCAT] Pre-encode failed:', err.message);
      });
    return this._preEncodePromise;
  }

  /**
   * Schedule TX events aligned to cycle boundaries.
   * Fires at the boundary (not +500ms like decode) so audio starts on time.
   */
  _scheduleTx() {
    if (!this._running) return;

    const now = Date.now();
    const cycleSec = this._cycleSec();
    const cycleMs = cycleSec * 1000;
    const msIntoCycle = now % cycleMs;

    // Fire right at the next cycle boundary
    let delay = cycleMs - msIntoCycle;
    if (delay < 50) delay += cycleMs; // avoid firing immediately if we're at the boundary

    this._txTimer = setTimeout(() => {
      this._onTxBoundary();
      this._scheduleTx();
    }, delay);
  }

  _onTxBoundary() {
    if (!this._running || !this._txEnabled || !this._txMessage || this._txActive) {
      if (this._txEnabled && this._txMessage) {
        console.log(`[JTCAT] TX boundary skip — running=${this._running} txActive=${this._txActive}`);
      }
      return;
    }

    // Re-encode if message or freq changed since last encode
    if (!this._txSamples || this._txEncodedMsg !== this._txMessage || this._txEncodedFreq !== this._txFreq) {
      this._preEncode();
      console.log('[JTCAT] TX samples not ready, encoding for next cycle');
      return;
    }

    // FT2 is async — TX fires immediately at any boundary, no slot logic
    if (this._mode === 'FT2') {
      this._txActive = true;
      const safetyMs = FT2_TX_DURATION_MS + 1000;
      this._txEndTimer = setTimeout(() => {
        if (this._txActive) {
          console.warn('[JTCAT] TX safety timeout — forcing tx-end');
          this._txActive = false;
          this.emit('tx-end', {});
        }
      }, safetyMs);
      console.log('[JTCAT] FT2 TX start:', this._txMessage, 'freq', this._txFreq);
      this.emit('tx-start', {
        samples: this._txSamples,
        message: this._txMessage,
        freq: this._txFreq,
        slot: '--',
        offsetMs: 0,
      });
      return;
    }

    const now = Date.now();
    const cycleSec = this._cycleSec();
    const slot = Math.floor(now / 1000 / cycleSec) % 2 === 0 ? 'even' : 'odd';

    // Check slot parity
    if (this._txSlot === 'auto') {
      if (this._lastRxSlot && slot === this._lastRxSlot) return;
    } else if (this._txSlot !== slot) {
      return;
    }

    this._txActive = true;

    // Safety timer must fire BEFORE the next TX boundary so _txActive is cleared
    // in time for the next cycle's TX (e.g. courtesy 73). FT8 audio is ~12.64s,
    // FT4 is ~4.48s — cycleSec-1.5 gives ample margin after audio ends while
    // ensuring the timer fires well before the next boundary at cycleSec.
    const safetyMs = (cycleSec - 1.5) * 1000;
    this._txEndTimer = setTimeout(() => {
      if (this._txActive) {
        console.warn('[JTCAT] TX safety timeout — forcing tx-end');
        this._txActive = false;
        this.emit('tx-end', {});
      }
    }, safetyMs);

    console.log('[JTCAT] TX start:', this._txMessage, '@ slot', slot, 'freq', this._txFreq);
    this.emit('tx-start', {
      samples: this._txSamples,
      message: this._txMessage,
      freq: this._txFreq,
      slot,
      offsetMs: 0,
    });
  }

  /**
   * Get standard digital frequencies for band buttons.
   */
  static get DIGITAL_FREQS() {
    return DIGITAL_FREQS;
  }
}

module.exports = { Ft8Engine, DIGITAL_FREQS, FT2_FREQS, freqsForMode, SAMPLE_RATE, FT2_CYCLE_SEC };
