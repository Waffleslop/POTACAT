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
    // Counts samples appended via feedAudio() since the last cycle-boundary
    // grab. Used to detect a stalled audio capture: a healthy cycle should
    // see roughly bufLen new samples (180000 for FT8). The previous heuristic
    // checked the absolute circular-buffer position, which always lands near
    // zero after the first wrap and triggered spurious "silent" warnings on
    // every healthy cycle (K3SBP 2026-05-04 — false positives during a
    // successful W4MAA QSO with 14/8/11/12 decodes).
    this._samplesSinceCycle = 0;
    this._feedDiag = 0;
    this._zeroDecodeCycles = 0;
    this._hasEverDecoded = false;
    this._lastCycleMax = 0;

    // TX state
    this._txEnabled = false;
    // Auto Seq: when true (default), the QSO state machine auto-advances
    // on each matching decode (RR73 -> 73 -> done, etc.). When false, the
    // engine still records what was heard but does not compose the next
    // TX — the user drives phases manually via the Skip button. ECHOCAT
    // mobile exposes this as a pill on the FT8 screen. (Gap 12,
    // 2026-05-04.)
    this._autoSeq = true;
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
    this._lockedTxSlot = null; // locked opposite slot for TX (set when TX enabled)
    this._consecutiveTxCount = 0; // consecutive TX cycles without monitoring
    this._lastTxCycleNum = -1; // cycle number of last TX
    this._maxConsecutiveTx = 5; // safety: max TX cycles before forced monitor

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
    this._samplesSinceCycle += samples.length;
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
      // Reset slot state — stale slot from previous mode can cause TX on wrong slot
      this._lastRxSlot = null;
      this._lockedTxSlot = null;
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
    if (!text) {
      this._consecutiveTxCount = 0;
      this._lockedTxSlot = null;
      if (this._txEndTimer) { clearTimeout(this._txEndTimer); this._txEndTimer = null; }
    } else if (this._lastRxSlot && !this._lockedTxSlot) {
      // Lock TX to opposite of last RX slot — prevents decode cycles from flipping it
      this._lockedTxSlot = this._lastRxSlot === 'even' ? 'odd' : 'even';
    }
    return this._preEncode();
  }

  /**
   * Set TX slot preference: 'auto', 'even', or 'odd'.
   * In auto mode, TX uses the opposite of the last received decode slot.
   */
  setTxSlot(slot) {
    this._txSlot = (slot === 'even' || slot === 'odd') ? slot : 'auto';
    // Lock the slot so decode cycles can't flip it
    if (slot === 'even' || slot === 'odd') {
      this._lockedTxSlot = slot;
    } else if (!this._txMessage) {
      // Only clear auto-lock when no TX message is set — prevents
      // setTxSlot('auto') from undoing the lock that setTxMessage() created
      this._lockedTxSlot = null;
    }
  }

  /**
   * Signal that TX audio playback has completed (called from main process).
   */
  txComplete() {
    if (!this._txActive) return;
    this._txActive = false;
    this._lastTxEndedTs = Date.now();
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

    // FT2 is async — no even/odd slot logic, but enforce monitoring gap
    if (this._mode === 'FT2') {
      if (this._consecutiveTxCount >= this._maxConsecutiveTx) return false;
      if (this._lastTxCycleNum >= 0 && this._cycleNumber - this._lastTxCycleNum < 2) return false;
      this._txActive = true;
      this._consecutiveTxCount++;
      this._lastTxCycleNum = this._cycleNumber;
      const safetyMs = FT2_TX_DURATION_MS + 1500;
      if (this._txEndTimer) clearTimeout(this._txEndTimer);
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

    // Must be in the correct slot — use locked slot if available
    if (this._txSlot === 'auto') {
      const targetSlot = this._lockedTxSlot;
      if (targetSlot && slot !== targetSlot) return false;
      if (!targetSlot && this._lastRxSlot && slot === this._lastRxSlot) return false;
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
    if (this._txEndTimer) clearTimeout(this._txEndTimer);
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
      const decoderName = this._workerNative ? 'native C (ft8_lib)' : 'WASM (ft8js)';
      console.log('[JTCAT] FT8 worker ready' + (this._workerNative ? ' (native)' : ' (WASM)'));
      // Surface in Verbose CAT log so users can verify which decoder is in use
      // without opening DevTools / Node console. Native is ~10-50x faster on
      // realistic CPU loads — if you see the WASM line in the log, the native
      // .node file is missing (run `npm run build-ft8` to rebuild).
      this.emit('log', `FT8 decoder: ${decoderName}`);
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

      // Reset consecutive TX counter only when real decodes received (monitoring worked)
      // Don't reset on empty RX cycles — prevents bypass of the safety cap
      if (!this._txActive && count > 0) this._consecutiveTxCount = 0;

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

    // Fire decode 1.5s BEFORE the next slot boundary, not 0.5s after.
    // FT8 frames end at 12.64s into the 15s cycle; the remaining 2.36s is
    // dead air. Decoding at 13.5s gives ~0.86s of slack past frame end and
    // ~1.5s of prep budget before the next TX boundary at 15s, so the QSO
    // state machine has time to advance and pre-encode the next message
    // without missing the TX slot. The previous "+500ms" timing fired
    // decode AFTER the next TX boundary had already passed, which meant
    // every reply went out one cycle stale (the W4MAA QSO at 03:58:15
    // sent FN20 again instead of R-12 because R-12 wasn't pre-encoded
    // until 583ms after TX had already started). FT4 has the same shape:
    // 5.04s frame, 7.5s cycle, fire at 6.0s. (K3SBP 2026-05-04, mobile
    // dev analysis.)
    //
    // FT2 uses a different (continuous) timing model — keep the original
    // +500ms behavior there until that path is re-evaluated.
    const decodeAtMs = this._mode === 'FT2'
      ? -500 // means "500ms past slot boundary" via the math below
      : cycleMs - 1500;
    const msIntoCurrentCycle = now % cycleMs;
    let delay;
    if (this._mode === 'FT2') {
      delay = cycleMs - msIntoCurrentCycle + 500;
    } else if (msIntoCurrentCycle < decodeAtMs) {
      // Still in this cycle, before the decode point
      delay = decodeAtMs - msIntoCurrentCycle;
    } else {
      // Past this cycle's decode point — wait until the next cycle's
      delay = (cycleMs - msIntoCurrentCycle) + decodeAtMs;
    }

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
      // The new pre-boundary timing fires 1.5s before the next slot
      // boundary, so `now` is still inside the slot we just RX'd. The
      // legacy timing fired 500ms past the boundary (in the new slot),
      // which is why the original code flipped here. Keep the legacy
      // behavior gated for safety in case anything still drives FT8/FT4
      // at the old timing path.
      this._lastRxSlot = slot;
    }

    this.emit('cycle', { number: this._cycleNumber + 1, mode: this._mode, slot });

    // Grab current audio buffer and rotate so it's in chronological order.
    // The circular buffer may have wrapped: [0..offset-1] = newest, [offset..end] = oldest.
    // The decoder needs samples in chronological order: [oldest ... newest].
    const raw = this._audioBuffer;
    const off = this._audioOffset;
    const samples = new Float32Array(raw.length);
    if (off > 0 && off < raw.length) {
      samples.set(raw.subarray(off), 0);          // oldest part -> start
      samples.set(raw.subarray(0, off), raw.length - off); // newest part -> end
    } else {
      samples.set(raw);
    }
    // Check multiple spots in the buffer for a better max reading
    let maxSample = 0;
    for (let k = 0; k < samples.length; k += Math.floor(samples.length / 500)) {
      maxSample = Math.max(maxSample, Math.abs(samples[k]));
    }
    this._lastCycleMax = maxSample;
    // Snapshot how many samples we appended since the previous cycle and
    // reset the counter. A healthy FT8 cycle delivers ~180000 samples
    // (15s @ 12kHz); anything below ~25% means the OS/driver stopped
    // feeding us. Don't conflate this with the absolute buffer offset,
    // which is a circular write pointer and routinely lands near zero
    // after wrap. (K3SBP 2026-05-04.)
    const writtenThisCycle = this._samplesSinceCycle;
    this._samplesSinceCycle = 0;
    console.log(`[JTCAT] Cycle boundary: sending ${samples.length} samples to worker, max=${maxSample.toFixed(4)}, written=${writtenThisCycle}`);

    // Silence watchdog. Two genuine failure modes:
    // * audioStarved — capture stalled (driver dropped us, device unplugged)
    // * maxSample === 0 — capture is alive but device delivers all zeros
    //   (Flex DAX RX not active on slice, suspended AudioContext, etc.)
    //
    // BUT: don't count a cycle in which we transmitted (or just finished
    // transmitting) — the rig mutes RX during TX, so that cycle's audio
    // legitimately reads near-zero. Counting it as "silent" was generating
    // spurious restart requests after every successful TX. (K3SBP
    // 2026-05-04 — saw 3 watchdog firings during a clean W4MAA QSO that
    // each came right after one of our own TX cycles.)
    const cycleMs = this._cycleSec() * 1000;
    const recentlyTxd = this._lastTxEndedTs && (Date.now() - this._lastTxEndedTs) < cycleMs;
    const skipWatchdog = this._txActive || recentlyTxd;
    const audioStarved = writtenThisCycle < this._audioBuffer.length / 4;
    if (skipWatchdog) {
      // Don't increment the counter and don't reset it either — let the
      // next non-TX cycle make the decision so a sustained dead capture
      // around a TX still surfaces.
    } else if (maxSample === 0 || audioStarved) {
      this._silentCycles = (this._silentCycles || 0) + 1;
      if (this._silentCycles >= 3) {
        const detail = audioStarved
          ? `audio capture stalled (only ${writtenThisCycle} samples this cycle, expected ~${this._audioBuffer.length})`
          : `audio capture is delivering zero samples (max=${maxSample.toFixed(4)})`;
        const reason = `${this._silentCycles} consecutive silent cycles — ${detail}`;
        console.warn('[JTCAT] ' + reason);
        // Surface in Verbose CAT log so the user sees it without DevTools.
        this.emit('log', `${reason} — restarting audio capture`);
        this.emit('silent');
        this._silentRestarts = (this._silentRestarts || 0) + 1;
        if (this._silentRestarts >= 3) {
          this.emit('log', `audio capture still silent after ${this._silentRestarts} restart attempts — check rig audio device, DAX RX activation on slice, or click the POTACAT window once to grant audio permission`);
        }
        this._silentCycles = 0;
      }
    } else {
      this._silentCycles = 0;
      this._silentRestarts = 0;
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

    // Safety: max consecutive TX cycles without monitoring (applies to all modes)
    if (this._consecutiveTxCount >= this._maxConsecutiveTx) {
      console.warn(`[JTCAT] Max consecutive TX (${this._maxConsecutiveTx}) — forcing monitor cycle`);
      this._consecutiveTxCount = 0;
      return; // skip this TX, allow a decode cycle
    }

    // FT2 is async — no even/odd slot logic, but require 1 monitor cycle between TXes
    if (this._mode === 'FT2') {
      // Require at least 1 RX cycle gap between TX cycles
      if (this._lastTxCycleNum >= 0 && this._cycleNumber - this._lastTxCycleNum < 2) {
        return; // skip — need a monitoring gap
      }
      this._txActive = true;
      this._consecutiveTxCount++;
      this._lastTxCycleNum = this._cycleNumber;
      const safetyMs = FT2_TX_DURATION_MS + 1500; // extra margin for FT2
      if (this._txEndTimer) clearTimeout(this._txEndTimer);
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

    // Check slot parity — use locked slot if available (prevents decode from flipping)
    if (this._txSlot === 'auto') {
      const targetSlot = this._lockedTxSlot;
      if (targetSlot && slot !== targetSlot) return;
      if (!targetSlot && this._lastRxSlot && slot === this._lastRxSlot) return;
    } else if (this._txSlot !== slot) {
      return;
    }

    this._txActive = true;
    this._consecutiveTxCount++;
    this._lastTxCycleNum = this._cycleNumber;

    // Safety timer must fire BEFORE the next TX boundary so _txActive is cleared
    // in time for the next cycle's TX (e.g. courtesy 73). FT8 audio is ~12.64s,
    // FT4 is ~4.48s — cycleSec-1.5 gives ample margin after audio ends while
    // ensuring the timer fires well before the next boundary at cycleSec.
    const safetyMs = (cycleSec - 1.5) * 1000;
    if (this._txEndTimer) clearTimeout(this._txEndTimer);
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
