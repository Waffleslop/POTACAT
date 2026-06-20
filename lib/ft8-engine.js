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
// WSPR is a slow propagation-beacon mode on a 120 s (2-minute) T/R window. It
// has NO QSO state machine — capture a full window, hand it to the (separate,
// GPLv3) wsprd process for decode, emit spots. Aligns to even minutes, which
// `now % cycleMs === 0` already gives since the epoch is on a 2-min boundary.
const WSPR_CYCLE_SEC = 120;
// Per-mode RX buffer = exactly one T/R period of audio. Derive all three from
// the cycle length so they can't drift apart: FT2 was hardcoded 45000 (3.75 s)
// while its cycle is 3.8 s, so the ring wrapped ~50 ms early every period and
// shaved the window. K3SBP 2026-06-10.
const FT8_SAMPLES = Math.round(SAMPLE_RATE * FT8_CYCLE_SEC); // 180,000
const FT4_SAMPLES = Math.round(SAMPLE_RATE * FT4_CYCLE_SEC); //  90,000
const FT2_SAMPLES = Math.round(SAMPLE_RATE * FT2_CYCLE_SEC); //  45,600
const WSPR_SAMPLES = Math.round(SAMPLE_RATE * WSPR_CYCLE_SEC); // 1,440,000
const FT2_TX_DURATION_MS = 2520; // 105 * 288 / 12000 * 1000

// How far before the slot boundary the decode snapshot fires. This is a
// TX-prep head start (advance the QSO state machine + pre-encode the next
// message before the TX boundary), but it also sets the END of the decoded
// window: the window ends at (slotEnd - DECODE_LEAD_MS - pipelineDelay) in
// air time, and an FT8 transmission runs to ~13.14 s of the 15 s slot. At
// the old 1500 ms lead that left only ~360 ms of slack for capture latency,
// so any real dax_rx/soundcard delay clipped the tail of every signal and
// dropped the weakest decodes (K3SBP 2026-06-14, Flex dax_rx ~0.6 s lag).
// 800 ms keeps ample time for a native pre-encode (single FT8 message =
// milliseconds) while recovering ~700 ms of capture margin. FT4's 7.5 s
// slot has plenty of slack either way.
const DECODE_LEAD_MS = 800;

// TX envelope durations — number of samples the actual modulated message
// occupies. ft8js's encode() returns a buffer padded with silence to fill
// the full cycle (180,000 samples for FT8). Playing the padded buffer keeps
// PTT keyed through ~2.4 s of silence after the last symbol, eating into
// the next slot's RX window. Truncating to the envelope length cuts the
// dead carrier. Numbers are samples-per-symbol × symbol-count at 12 kHz:
//   FT8: 79 symbols × 1920 samples/symbol = 151,680  (12.64 s)
//   FT4: 105 symbols × 576 samples/symbol = 60,480   (5.04 s)
const FT8_TX_SAMPLES = 151680;
const FT4_TX_SAMPLES = 60480;
const FT2_TX_SAMPLES = Math.round(SAMPLE_RATE * FT2_TX_DURATION_MS / 1000); // 30,240

// Late-start TX (WSJT-X waveform-truncation parity) ------------------------
// When a user-tap reply lands later than the 500 ms pad window, WSJT-X does
// NOT defer to the next cycle — it skips the leading channel symbols and
// transmits the remainder, staying locked to the symbol clock so the tail
// still lands on the normal interval boundary. Because the pre-rendered
// buffer's TAIL is unchanged, PTT-off stays on time (slot+13.14 s) and does
// NOT bleed into the responder's next slot — this is the crucial distinction
// from the reverted 2026-05-08 "pad-and-play-full-buffer late" path, which
// pushed the whole envelope late and truncated the responder's reply Costas.
// The leading Costas array is sacrificed; the receiver re-syncs on the middle
// and end Costas arrays. Per Franke/Somerville/Taylor (QEX Jul/Aug 2020) a
// reply to a CQ (the caller decodes with AP "mycall") survives to ~8 s late,
// with a graceful step down near the middle-Costas boundary ~6.5 s rather
// than a cliff. We cap conservatively below that so the middle Costas and a
// useful run of data symbols always survive.
const LATE_START_TX_MAX_MS = 7000;   // never fire later than this into the slot
const LATE_START_PTT_SETTLE_MS = 80; // let PTT key before audio; skipped from
                                     // the buffer too, so symbol alignment holds
const LATE_START_RAMP_MS = 20;       // raised-cosine head ramp = T/8 GFSK ramp

class Ft8Engine extends EventEmitter {
  constructor() {
    super();
    this._worker = null;
    this._workerReady = false;
    this._mode = 'FT8'; // 'FT8' | 'FT4' | 'FT2' | 'WSPR'
    this._wsprDialMHz = 14.0956; // USB dial for WSPR decode (20 m default)
    this._running = false;
    // Polling tick — replaces the previous setTimeout-based _scheduleCycle
    // / _scheduleTx pair. A single 100 ms interval re-evaluates "is it
    // time to decode?" and "is it time to TX?" on every fire. Eliminates
    // the entire class of "JS timer fired ~1 ms early and slot parity
    // misclassified" bugs that bit FT8 QSOs (K3SBP HK3YL 2026-05-14:
    // TX every 15 s instead of every 30 s because the slot-boundary
    // setTimeout fired at wall :44.999 instead of :45.000, evaluated
    // slot as still-even, and bled audio into the responder's odd
    // slot). Matches WSJT-X's guiUpdate architecture. _lastCycleFire-
    // Slot / _lastTxFireSlot dedupe so each event fires at most once
    // per slot regardless of how many ticks land inside it.
    this._tickTimer = null;
    this._tickIntervalMs = 100;
    this._lastCycleFireSlot = -1;
    this._lastTxFireSlot = -1;
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

    // Soundcard / pipeline latency calibration. WSJT-X has the same setting
    // under "Audio: Soundcard time delay". Positive ms means our captured
    // audio arrives N ms after wall clock — we subtract it from "now" when
    // computing slot positions, scheduling TX, and reporting decoded DT, so
    // reported DTs align with WSJT-X. K0OTC 2026-05-04: JTCAT showed DT=
    // +2.5..2.7 on signals WSJT-X reported DT=+0.2..0.3 on the same audio,
    // a constant ~2.3 s pipeline lag that pushed his TX off the slot
    // boundary and broke QSO completion.
    //
    // Auto-calibration: per-cycle median of raw decoded DTs, smoothed across
    // a rolling window of recent cycles. Most stations have NTP-tight clocks,
    // so the median over a few hundred decodes converges to the local
    // pipeline lag. Manual setAudioLatencyMs() or settings.jtcatAudioLatency
    // ManualMs disables auto and pins the value.
    this._audioLatencyMs = 0;
    this._audioLatencyAuto = true;
    this._audioLatencyMedians = []; // rolling window of per-cycle DT medians (raw, pre-correction)

    // Hold TX frequency: when true, setTxFreq() calls from the QSO state
    // machine / phone-driven replies are ignored — the user's stored TX
    // freq stays put. Useful for fixed-frequency operation while RX freq
    // tracks the responder. Phone toggles via jtcat-set-hold-tx-freq.
    this._holdTxFreq = false;

    // Late-start TX cap (ms-into-cycle). 0 = strict slot-boundary parity:
    // a user-tap reply past the 500 ms pad window defers to the next cycle.
    // When > 0, tryImmediateTx() will still fire up to this many ms late and
    // truncate the waveform (see LATE_START_* above). Set from settings via
    // setLateStartTx(); default off until main applies the persisted value.
    this._lateStartTxMs = 0;

    // AP (a priori) decode context — the RX mirror of late-start TX. When
    // enabled and myCall is set, the native decoder runs extra "AP mycall" /
    // "AP both" passes to recover marginal or late-started replies addressed to
    // us (e.g. someone answering our CQ 5 s late, leading Costas gone). myCall
    // is authoritative from settings (set via setApContext); dxCall (the
    // stronger both-calls hypothesis) is auto-derived from our directed TX
    // message in setTxMessage(), so it tracks the QSO with no extra wiring.
    this._apDecode = true;
    this._apMyCall = '';
    this._apDxCall = '';

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
    this._reEncodePending = false; // set by _preEncode when called during in-flight encode
    this._txEncoding = false;
    this._txEncodedMsg = ''; // message that _txSamples corresponds to
    this._txEncodedFreq = 0; // freq that _txSamples corresponds to
    this._txActive = false; // true while TX audio is playing
    this._txEndTimer = null;
    this._lastRxSlot = null; // slot of last received decode cycle
    this._lockedTxSlot = null; // locked opposite slot for TX (set when TX enabled)
    this._consecutiveTxCount = 0; // consecutive TX cycles without monitoring
    this._lastTxCycleNum = -1; // cycle number of last TX
    this._maxConsecutiveTx = 5; // safety: max TX cycles before forced monitor

    // Pending decode callbacks
    this._pending = new Map();

    // Worker watchdog. Luk OneLD reported FT8 silently stopping decoding
    // with audio + WF still flowing (2026-05-12) — the worker thread or
    // its native addon hung without crashing, so the existing exit/error
    // handlers in _spawnWorker never fired and the existing zero-decode
    // detector (line ~564) never tripped because that one needs the
    // worker to be responsive enough to *send back* zero-decode results.
    // The watchdog covers the harder failure: worker stops responding
    // entirely. Every received message refreshes _lastWorkerResponseMs;
    // every cycle boundary checks whether we've gone too long without one
    // and respawns if so.
    this._lastWorkerResponseMs = 0;
    this._workerWatchdogFires = 0;
  }

  /**
   * Start the engine — spawns worker, begins cycle timing.
   */
  start() {
    if (this._running) return;
    this._running = true;
    this._spawnWorker();
    this._startTick();
    this.emit('status', { state: 'running', mode: this._mode });
  }

  /**
   * Stop the engine — kills worker, clears timers.
   */
  stop() {
    this._running = false;
    this._stopTick();
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
    // Clear the watchdog timestamp so a subsequent start() gets a clean
    // grace window (worker spawn re-seeds it, but zeroing here means an
    // interleaved cycle-boundary fire while stopped is a no-op).
    this._lastWorkerResponseMs = 0;
    this.emit('status', { state: 'stopped' });
  }

  /**
   * Re-baseline timing after the OS clock was corrected mid-session (e.g. a
   * w32tm resync stepped it by ~10 s). The slot math is all live Date.now(),
   * so RX *would* self-heal — but a clock step poisons a cluster of secondary
   * state that nothing else re-derives, which is why decoding previously
   * needed a full app restart to recover. This resets exactly that state (the
   * same set start()/the constructor reset, minus the worker kill), so the
   * next clean boundary aligns to true UTC. K3SBP 2026-06-10.
   */
  reBaseline() {
    if (!this._running) return;
    // 1. Flush audio captured under the old timeline.
    this._audioBuffer = new Float32Array(this._audioBuffer.length);
    this._audioOffset = 0;
    this._samplesSinceCycle = 0;
    // 2. Re-arm the slot-fire dedupe so the next correct boundary fires (a
    //    backward step left these holding a now-future slot index).
    this._lastCycleFireSlot = -1;
    this._lastTxFireSlot = -1;
    // 3. Drop the poisoned auto-latency calibration (respect a manual pin).
    this._audioLatencyMedians = [];
    if (this._audioLatencyAuto && this._audioLatencyMs !== 0) {
      this._audioLatencyMs = 0;
      this.emit('audio-latency-changed', { ms: 0, auto: true });
    }
    // 4. Drop slot/TX parity + silence counters derived under the bad clock.
    this._lastRxSlot = null;
    this._lockedTxSlot = null;
    this._silentCycles = 0;
    this._silentRestarts = 0;
    // 5. Stop the clock jump from tripping a spurious worker respawn.
    this._lastWorkerResponseMs = Date.now();
    this.emit('log', 'Clock corrected — re-baselined FT8 timing (no restart needed)');
    this.emit('status', { state: 'running', mode: this._mode, rebaselined: true });
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
    // Diagnostic: check for zero-filled IPC data (macOS audio capture issue).
    // Skipped during TX — the rig's RX is intentionally muted while we're
    // keying, so zeros are expected and don't indicate a dead capture.
    // (K3SBP 2026-06-02: log was spamming during every JTCAT TX cycle.)
    if (!this._txActive && this._feedDiag++ % 200 === 0) {
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
    this._mode = (mode === 'FT4') ? 'FT4' : (mode === 'FT2') ? 'FT2' : (mode === 'WSPR') ? 'WSPR' : 'FT8';
    // Resize audio buffer for each mode's cycle length
    if (this._mode !== prev) {
      const newSize = this._mode === 'WSPR' ? WSPR_SAMPLES : this._mode === 'FT2' ? FT2_SAMPLES : this._mode === 'FT4' ? FT4_SAMPLES : FT8_SAMPLES;
      this._audioBuffer = new Float32Array(newSize);
      this._audioOffset = 0;
      // Invalidate pre-encoded TX (encode type changes)
      this._txSamples = null;
      this._txEncodedMsg = '';
      // Reset slot state — stale slot from previous mode can cause TX on wrong slot
      this._lastRxSlot = null;
      this._lockedTxSlot = null;
      // Slot-fire dedupe counters reset on mode change. Slot numbering is
      // tied to the cycle length, so a slot index from the previous mode
      // doesn't carry over meaning to the new mode and could falsely
      // suppress an early-tick fire in the new cadence.
      this._lastCycleFireSlot = -1;
      this._lastTxFireSlot = -1;
    }
  }

  /**
   * Set the WSPR USB dial frequency (MHz). Passed to wsprd so it can report
   * absolute spot frequencies and select the band. No effect outside WSPR.
   */
  setWsprDial(mhz) {
    const m = Number(mhz);
    if (Number.isFinite(m) && m > 0) this._wsprDialMHz = m;
  }

  /**
   * Set TX audio frequency offset (Hz within passband).
   * Skipped when _holdTxFreq is on — the user has pinned a freq and doesn't
   * want auto-replies / state-machine advances to drag it around.
   */
  setTxFreq(hz) {
    if (this._holdTxFreq) {
      // Log so users can see why TX freq isn't tracking the decode they
      // clicked. Don't mutate _txFreq.
      this.emit('log', `setTxFreq(${hz}) ignored — Hold TX Freq is on (TX stays at ${this._txFreq} Hz)`);
      return;
    }
    this._txFreq = Math.max(100, Math.min(3000, hz));
    // Invalidate cached samples if freq changed
    if (this._txEncodedFreq !== this._txFreq) this._preEncode();
  }

  /**
   * Calibration: subtract this many ms from "now" for slot alignment, TX
   * scheduling, and decoded-DT reporting. Negative values shift the other
   * direction (capture is ahead of wall clock).
   *
   * Calling this from a UI / settings handler pins the value and turns auto-
   * calibration off. Use setAudioLatencyAuto(true) to re-enable adaptive
   * tuning.
   */
  setAudioLatencyMs(ms) {
    const v = parseInt(ms, 10);
    this._audioLatencyMs = isNaN(v) ? 0 : Math.max(-3000, Math.min(3000, v));
    this._audioLatencyAuto = false;
    this._audioLatencyMedians = [];
  }

  /** Toggle adaptive latency calibration. */
  setAudioLatencyAuto(on) {
    this._audioLatencyAuto = !!on;
    if (this._audioLatencyAuto) this._audioLatencyMedians = [];
  }

  /**
   * Seed the auto-calibration's STARTING point without pinning it (unlike
   * setAudioLatencyMs, which turns auto off). A fresh engine starts at 0 and
   * spends the first ~3 cycles with the wrong slot-parity / DT-report / TX-
   * scheduling baseline while the auto loop re-derives the pipeline lag from
   * decoded DTs — wasted on every band/mode change and QSY (each one builds a
   * brand-new engine). Seeding from the last persisted value makes a restart
   * start warm; auto stays ON and keeps refining. No-op under a manual pin or
   * on a bad value. K3SBP 2026-06-14.
   */
  seedAudioLatencyMs(ms) {
    if (!this._audioLatencyAuto) return; // a manual pin wins
    const v = parseInt(ms, 10);
    if (isNaN(v)) return;
    this._audioLatencyMs = Math.max(-3000, Math.min(3000, v));
  }

  /** Pin TX frequency — block setTxFreq() calls from auto-progression. */
  setHoldTxFreq(on) {
    this._holdTxFreq = !!on;
    this.emit('log', `Hold TX Freq: ${this._holdTxFreq ? 'ON' : 'off'}`);
  }

  /**
   * Enable/disable late-start TX (WSJT-X waveform-truncation parity).
   * @param {boolean|number} v — true = use the default cap (LATE_START_TX_MAX_MS),
   *   false/0 = strict boundary parity, or a numeric ms cap (clamped).
   */
  setLateStartTx(v) {
    let cap;
    if (v === true) cap = LATE_START_TX_MAX_MS;
    else if (v === false || v == null) cap = 0;
    else { cap = parseInt(v, 10); if (isNaN(cap) || cap <= 0) cap = 0; }
    this._lateStartTxMs = Math.min(cap, LATE_START_TX_MAX_MS);
    this.emit('log', `Late-start TX: ${this._lateStartTxMs ? this._lateStartTxMs + ' ms cap' : 'off'}`);
  }

  /**
   * Pure: schedule the pre-rendered TX buffer for a late start. Called only
   * when offsetMs is past the slot+500 ms pad window — we can't pad the
   * envelope back to slot+500 ms (that moment is gone), so we slice the
   * leading symbols off and start mid-waveform after a short PTT settle.
   * The settle delay is ALSO skipped from the buffer so the surviving
   * symbols stay locked to the standard grid and the tail still lands at
   * slot+13.14 s. Returned values are the renderer's marching orders.
   *
   * @param {number} offsetMs   ms into the T/R slot at emit time
   * @param {number} bufDurSec  full pre-rendered buffer length (~12.64 s)
   * @returns {{leadingDelaySec:number, playOffsetSec:number, playDurSec:number, rampMs:number}}
   */
  static computeLateStartPlan(offsetMs, bufDurSec, opts = {}) {
    const slot = opts.slotAudioStartMs != null ? opts.slotAudioStartMs : 500;
    const settle = opts.pttSettleMs != null ? opts.pttSettleMs : LATE_START_PTT_SETTLE_MS;
    const rampMs = opts.rampMs != null ? opts.rampMs : LATE_START_RAMP_MS;
    const raw = (offsetMs - slot + settle) / 1000;
    const playOffsetSec = Math.max(0, Math.min(raw, bufDurSec));
    return {
      leadingDelaySec: settle / 1000,
      playOffsetSec,
      playDurSec: Math.max(0, bufDurSec - playOffsetSec),
      rampMs,
    };
  }

  /**
   * Pure: produce the truncated, de-clicked TX buffer for a late start.
   * Slices `plan.playOffsetSec` of leading waveform off `samples` and applies
   * a raised-cosine head ramp over `plan.rampMs` so the mid-waveform start
   * doesn't radiate a key-click/splatter. Returns a NEW Float32Array — never
   * mutates the input, because the engine reuses _txSamples across QSO retries.
   * main.js calls this once at the TX dispatch choke point so every audio
   * route (SmartSDR direct, Icom network, renderer DAX, failsafe) gets the
   * already-truncated buffer and only has to prepend the PTT-settle lead.
   */
  static sliceLateStartBuffer(samples, plan, sampleRate = SAMPLE_RATE) {
    const n = samples ? samples.length : 0;
    if (!n || !plan) return samples;
    const skip = Math.min(n, Math.max(0, Math.round(plan.playOffsetSec * sampleRate)));
    const out = Float32Array.prototype.slice.call(samples, skip);
    const ramp = Math.min(out.length, Math.round((plan.rampMs || 0) / 1000 * sampleRate));
    for (let i = 0; i < ramp; i++) {
      out[i] *= 0.5 * (1 - Math.cos(Math.PI * (i / ramp)));
    }
    return out;
  }

  /**
   * Wall-clock "now" minus the soundcard latency calibration. Used everywhere
   * cycle / TX scheduling reasons about "where are we in the FT8 slot."
   */
  _adjustedNow() {
    return Date.now() - this._audioLatencyMs;
  }

  /**
   * Set the message to transmit.
   * Pre-encodes immediately so samples are ready at the cycle boundary.
   * Returns a promise that resolves when encoding is complete.
   */
  /**
   * Set AP decode context. enabled + myCall come from settings (main.js);
   * dxCall is normally auto-derived from the TX message, but can be overridden.
   */
  setApContext({ enabled, myCall, dxCall } = {}) {
    if (enabled !== undefined) this._apDecode = !!enabled;
    if (myCall !== undefined) this._apMyCall = (myCall || '').toUpperCase().trim();
    if (dxCall !== undefined) this._apDxCall = (dxCall || '').toUpperCase().trim();
  }

  setTxMessage(text) {
    this._txMessage = text || '';
    // Auto-derive the AP "both calls" partner from a directed TX message: in
    // our reply "WB0SFT K3SBP ...", WB0SFT is the station we're working, so
    // their reply "K3SBP WB0SFT ..." has call2 = WB0SFT. CQ/QRZ/etc. have no
    // partner — fall back to AP mycall only.
    const first = (text || '').trim().split(/\s+/)[0] || '';
    this._apDxCall = /^(CQ|QRZ|DE|TEST)$/i.test(first) ? '' : first.toUpperCase();
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
    return this._mode === 'WSPR' ? WSPR_CYCLE_SEC : this._mode === 'FT2' ? FT2_CYCLE_SEC : this._mode === 'FT4' ? FT4_CYCLE_SEC : FT8_CYCLE_SEC;
  }

  tryImmediateTx() {
    if (!this._running || !this._txEnabled || !this._txMessage || this._txActive) return false;
    if (!this._txSamples || this._txEncodedMsg !== this._txMessage || this._txEncodedFreq !== this._txFreq) return false;

    // TX scheduling uses WALL CLOCK, not the latency-adjusted clock — the
    // _audioLatencyMs calibration is the *input* pipeline delay (audio
    // captured at T was emitted on air at T-L). For TX we want PTT-on at
    // the wall-clock slot boundary so audio reaches the air at slot+500ms
    // (WSJT-X convention). Using adjustedNow here pushed every TX L ms
    // late — K3SBP 2026-05-05 saw V31DL QSO firing at slot+2.642s with
    // latency=2640ms because input lag was being subtracted from TX too.
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

    // 500ms look-ahead so slot reflects where the audio actually lands
    // (renderer pads to slot+500ms). See _onTxBoundary for the rationale.
    const audioLandsAt = now + 500;
    const slot = Math.floor(audioLandsAt / 1000 / cycleSec) % 2 === 0 ? 'even' : 'odd';

    // Must be in the correct slot — use locked slot if available
    if (this._txSlot === 'auto') {
      const targetSlot = this._lockedTxSlot;
      if (targetSlot && slot !== targetSlot) return false;
      if (!targetSlot && this._lastRxSlot && slot === this._lastRxSlot) return false;
    } else if (this._txSlot !== slot) {
      return false;
    }

    // Late-start cutoff — WSJT-X parity. WSJT-X always lands the audio
    // envelope at exactly slot+500ms via its slot-boundary timer plus
    // built-in modulator silence; the renderer's leading-silence pad at
    // renderer/app.js does the equivalent here. The pad only writes a
    // positive delay when offsetMs ≤ 500 — past that, audio starts late,
    // on-air DT becomes (offsetMs − 500), and PTT-off bleeds into the
    // responder's next-slot RX (the responder loses the start of their
    // own Costas array when their replying-station's PTT trails).
    //
    // Set the cap at 500 so every TX that fires has audio aligned to
    // slot+500ms exactly. Envelope ends at slot+13.14s, PTT-off at
    // slot+13.29s with the 150ms grace, leaving 1.71s of clear air
    // before the next slot. DT=0 at well-tuned receivers; no bleed.
    //
    // Earlier values (1500ms 2026-05-05, 2500ms 2026-05-08) were chosen
    // to reduce click-to-TX latency for the spot-tap UX, trading
    // receive-side margin for ergonomics. Reverted to WSJT-X-strict
    // parity 2026-05-13: the tradeoff cost responder QSO completion
    // when their reply Costas got truncated by our PTT trail.
    // Up to 500 ms late the renderer PADS leading silence (keeps the leading
    // Costas — the right call there, see renderer/app.js). Past that, padding
    // can't realign the envelope, so we either truncate the waveform
    // (late-start parity, when _lateStartTxMs is set) or defer to next cycle.
    // Late-start is FT8-only: the QEX tolerances and the 7 s cap are derived
    // from FT8's 15 s slot / 79-symbol envelope. For FT4 (7.5 s slot, 5 s
    // envelope) a multi-second slice would key PTT with near-silence, so FT4
    // keeps strict 500 ms boundary parity. (FT2 returns above.)
    const MAX_LATE_MS = 500;
    const lateStartActive = this._lateStartTxMs > 0 && this._mode === 'FT8';
    const lateCap = lateStartActive
      ? Math.min(this._lateStartTxMs, LATE_START_TX_MAX_MS)
      : MAX_LATE_MS;
    if (msIntoCycle > lateCap) {
      console.log('[JTCAT] Too late in cycle (' + msIntoCycle + 'ms, cap ' + lateCap + 'ms), deferring TX to next boundary');
      return false;
    }
    // Mark the slot as fired so the polling tick won't re-evaluate this
    // slot once _txActive clears — defense against a slot getting TX'd
    // twice if the safety timer fires early or external code flips
    // _txActive false during playback.
    this._lastTxFireSlot = Math.floor(now / cycleMs);
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
    const payload = {
      samples: this._txSamples,
      message: this._txMessage,
      freq: this._txFreq,
      slot,
      offsetMs: msIntoCycle,
    };
    if (lateStartActive && msIntoCycle > MAX_LATE_MS) {
      const bufDurSec = this._txSamples.length / SAMPLE_RATE;
      payload.lateStart = Ft8Engine.computeLateStartPlan(msIntoCycle, bufDurSec);
      console.log('[JTCAT] Late-start TX: skipping ' + payload.lateStart.playOffsetSec.toFixed(2) +
        's of leading waveform (offset ' + msIntoCycle + 'ms); tail stays aligned to slot+13.14s');
    }
    this.emit('tx-start', payload);
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
    // Seed the watchdog: the worker has from now until 2.5 cycle lengths
    // from now to send its first 'ready' or 'decode-result' message. After
    // a respawn this prevents the watchdog from immediately re-firing on
    // the stale timestamp the previous (hung) worker left behind.
    this._lastWorkerResponseMs = Date.now();
  }

  _onWorkerMessage(msg) {
    // Any message — ready, decode-result, encode-result, error — proves the
    // worker is still responsive. Refresh before the type switch so even
    // unrecognized messages keep the watchdog quiet.
    this._lastWorkerResponseMs = Date.now();

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

      // Auto-calibration: take the median of THIS cycle's raw DTs (the
      // decoder hasn't seen any latency correction yet) and add it to a
      // small rolling window. Once we have several cycles' medians, set
      // _audioLatencyMs to the median-of-medians. The assumption: most
      // stations on FT8 have NTP-tight clocks, so the population median
      // of true on-air DTs is ~0; whatever we see in the median is our
      // local pipeline lag. A handful of badly-clocked stations get
      // outvoted by the median. Disabled when the user pins a value via
      // setAudioLatencyMs(). Cycle needs ≥4 decodes for a stable median.
      const rawDts = (msg.results || [])
        .map((r) => (typeof r.dt === 'number' ? r.dt : null))
        .filter((v) => v !== null);
      if (this._audioLatencyAuto && rawDts.length >= 4) {
        const sortedRaw = [...rawDts].sort((a, b) => a - b);
        const cycleMedian = sortedRaw[Math.floor(sortedRaw.length / 2)];
        this._audioLatencyMedians.push(cycleMedian);
        if (this._audioLatencyMedians.length > 8) this._audioLatencyMedians.shift();
        // Median-of-medians once we have at least 3 cycles' worth.
        if (this._audioLatencyMedians.length >= 3) {
          const mom = [...this._audioLatencyMedians].sort((a, b) => a - b);
          const stable = mom[Math.floor(mom.length / 2)];
          const newLatencyMs = Math.max(-3000, Math.min(3000, Math.round(stable * 1000)));
          if (newLatencyMs !== this._audioLatencyMs) {
            this._audioLatencyMs = newLatencyMs;
            this.emit('audio-latency-changed', { ms: newLatencyMs, auto: true });
          }
        }
      }

      // Apply soundcard latency calibration to each result's DT so the
      // values reported on the wire match WSJT-X for the same audio. With
      // latency=0 (default) this is a no-op pass-through.
      const latencySec = this._audioLatencyMs / 1000;
      const results = (msg.results || []).map((r) => (
        latencySec ? { ...r, dt: (typeof r.dt === 'number' ? r.dt - latencySec : r.dt) } : r
      ));
      this.emit('decode', {
        cycle: this._cycleNumber,
        mode: this._mode,
        slot: this._lastRxSlot,
        results,
      });
      return;
    }
    if (msg.type === 'wspr-result') {
      // WSPR is a beacon/propagation mode — no QSO state machine, no DT
      // latency calibration, no WASM-stall heuristic. Just surface the spots
      // (or the "decoder not installed" error) for the UI / wsprnet upload.
      this._cycleNumber++;
      const spots = msg.spots || [];
      if (msg.error) {
        console.warn(`[JTCAT] WSPR decode: ${msg.error}`);
        this.emit('log', `WSPR decode: ${msg.error}`);
      } else {
        console.log(`[JTCAT] WSPR decode: ${spots.length} spots`);
        if (spots.length) this._hasEverDecoded = true;
      }
      this.emit('wspr-spots', { cycle: this._cycleNumber, spots, error: msg.error || null });
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

  // ── Polling tick ────────────────────────────────────────────────────
  // Single 100 ms interval replaces the previous setTimeout-based
  // _scheduleCycle / _scheduleTx pair. Each tick re-reads wall clock,
  // computes current slot, and decides whether decode or TX needs to
  // fire — exactly once per slot, deduplicated via _lastCycleFireSlot
  // and _lastTxFireSlot. Matches WSJT-X's guiUpdate polling architecture
  // and eliminates the entire "timer fired ~1 ms early at the slot
  // boundary and slot-parity misclassified" failure mode.

  _startTick() {
    if (this._tickTimer) return;
    this._tickTimer = setInterval(() => this._tick(), this._tickIntervalMs);
  }

  _stopTick() {
    if (this._tickTimer) {
      clearInterval(this._tickTimer);
      this._tickTimer = null;
    }
  }

  _tick() {
    if (!this._running) return;
    const now = Date.now();
    const cycleSec = this._cycleSec();
    const cycleMs = cycleSec * 1000;
    const msIntoCycle = now % cycleMs;
    // Slot index is monotonic since the UNIX epoch, so distinct slots
    // always have distinct numbers (no modulo). Each slot's events
    // (decode + TX engage) fire at most once because we stamp this
    // number into _lastCycleFireSlot / _lastTxFireSlot.
    const slotNumber = Math.floor(now / cycleMs);

    // --- Cycle-boundary decode trigger -------------------------------
    // FT8/FT4: fire 1.5 s before slot end (gives the QSO state machine
    // time to advance and pre-encode the next message before the next
    // TX boundary — K3SBP 2026-05-04 W4MAA QSO debugging).
    // FT2: fire 500 ms past slot start (continuous mode).
    const decodeFireAtMs = this._mode === 'FT2' ? 500 : (cycleMs - DECODE_LEAD_MS);
    if (msIntoCycle >= decodeFireAtMs && this._lastCycleFireSlot !== slotNumber) {
      this._lastCycleFireSlot = slotNumber;
      if (this._workerReady) this._onCycleBoundary();
    }

    // --- TX-boundary engagement trigger ------------------------------
    // Re-evaluate every tick while inside the first MAX_LATE_MS of the
    // slot. _onTxBoundary() guards on _txEnabled / _txMessage / slot
    // parity / _txActive / max-consecutive-TX itself; calling it on a
    // tick where conditions aren't met is a cheap no-op. Mark
    // _lastTxFireSlot only when TX actually engages (post-call
    // _txActive flipped true) so a tap arriving mid-window still gets
    // a fire chance on the next tick within the same slot.
    const MAX_LATE_MS_TICK = 500;
    if (
      msIntoCycle <= MAX_LATE_MS_TICK &&
      this._lastTxFireSlot !== slotNumber &&
      !this._txActive  // tryImmediateTx may have already fired this slot
                       // via the user-tap path; skip re-evaluation while
                       // that TX is still in progress.
    ) {
      const wasActive = this._txActive;
      this._onTxBoundary();
      if (this._txActive && !wasActive) {
        this._lastTxFireSlot = slotNumber;
      }
    }
  }

  _onCycleBoundary() {
    if (!this._running || !this._workerReady) return;

    const wallNow = Date.now();
    const now = this._adjustedNow();
    const cycleSec = this._cycleSec();
    const cycleMs = cycleSec * 1000;

    // Worker watchdog — catch the case where the worker thread or its
    // native decoder hung without crashing. Tolerate 2.5 cycle lengths
    // (≈38 s for FT8, ≈19 s for FT4) of silence: one round-trip for the
    // decode plus enough slack to absorb GC pauses and slow disks before
    // declaring the worker dead. Respawn skips this cycle's decode; the
    // fresh worker re-seeds the timestamp on spawn so the next boundary
    // doesn't immediately re-fire. Logged to the verbose CAT pane so users
    // see the auto-recovery (and can report repeated fires).
    if (this._lastWorkerResponseMs) {
      const sinceLast = wallNow - this._lastWorkerResponseMs;
      if (sinceLast > 2.5 * cycleMs) {
        const secs = (sinceLast / 1000).toFixed(1);
        this._workerWatchdogFires = (this._workerWatchdogFires || 0) + 1;
        const msg = `FT8 worker unresponsive for ${secs}s — respawning (watchdog fire #${this._workerWatchdogFires})`;
        console.warn(`[JTCAT] ${msg}`);
        this.emit('log', msg);
        this._respawnWorker();
        return;
      }
    }

    // Timing diagnostic — helps users compare JTCAT's slot alignment to
    // WSJT-X. fireOffset = how many ms into the slot we fired (target is
    // cycleSec - 1.5s for FT8/FT4); large fireOffset means the timer
    // drifted. msIntoCycle is the post-latency-adjusted position. K0OTC
    // 2026-05-04 used this to diagnose a ~2.3 s pipeline delay.
    const slotStartAdj = now - (now % cycleMs);
    const msIntoCycle = now - slotStartAdj;
    const expectedFireMs = cycleMs - DECODE_LEAD_MS;
    const fireOffsetMs = msIntoCycle - expectedFireMs;
    const fmtUtc = (t) => new Date(t).toISOString().slice(11, 23);
    console.log(`[JTCAT] timing: now=${fmtUtc(wallNow)} adjNow=${fmtUtc(now)} slotStart=${fmtUtc(slotStartAdj)} msIntoCycle=${msIntoCycle}ms fireOffset=${fireOffsetMs}ms latency=${this._audioLatencyMs}ms`);

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
    const decodeType = this._mode === 'WSPR' ? 'wspr-decode' : this._mode === 'FT4' ? 'ft4-decode' : this._mode === 'FT2' ? 'ft2-decode' : 'decode';
    // Skip the worker post if we captured less than half a slot of audio.
    // Engine just spun up mid-slot: the buffer is mostly leading zeros
    // with a tail of real audio, so the decoder predictably returns 0
    // decodes and burns ~10ms of native CPU for nothing. K3SBP 2026-05-14
    // log: cycle at 03:08:58 had written=32768/180000 = 18% → wasted run.
    if (writtenThisCycle >= samples.length * 0.5) {
      this._worker.postMessage(
        {
          type: decodeType,
          id: ++this._msgId,
          samples: samples.buffer,
          myCall: this._apDecode ? this._apMyCall : '',
          dxCall: this._apDecode ? this._apDxCall : '',
          // WSPR: wsprd needs the USB dial (MHz) to report absolute spot
          // frequencies and pick the band. Ignored by the FT8/FT4/FT2 paths.
          dialFreqMHz: this._wsprDialMHz,
        },
        [samples.buffer]
      );
    } else {
      console.log(`[JTCAT] Skip decode — startup partial cycle (${writtenThisCycle}/${samples.length} samples captured)`);
    }

    // Allocate new buffer (old one was transferred)
    const bufSize = this._mode === 'WSPR' ? WSPR_SAMPLES : this._mode === 'FT2' ? FT2_SAMPLES : this._mode === 'FT4' ? FT4_SAMPLES : FT8_SAMPLES;
    this._audioBuffer = new Float32Array(bufSize);
    this._audioOffset = 0;
  }

  /**
   * Pre-encode the current TX message so samples are ready at cycle boundary.
   *
   * Race-condition note: setTxFreq() also calls into here when the freq
   * changes (to invalidate the cached samples). The popout-reply handler
   * orders setTxFreq BEFORE setTxMessage, so the first _preEncode
   * captures the OLD message at the NEW freq. Without the guard below
   * the second _preEncode (from setTxMessage) would return the
   * in-flight OLD-message promise and the radio would transmit stale
   * audio at a new offset. We now snapshot msg+freq at dispatch and
   * re-encode if either changed during the in-flight call. K3SBP
   * 2026-05-30, observed as "TX'd KG4OJT after clicking 7Z1CE."
   */
  _preEncode() {
    if (!this._txMessage || !this._workerReady) return Promise.resolve();
    if (this._txEncoding) {
      // An encode is already in flight. Mark that we want a re-encode
      // when it finishes — the .then below will re-call _preEncode() if
      // msg or freq drifted away from what's being encoded.
      this._reEncodePending = true;
      return this._preEncodePromise || Promise.resolve();
    }
    this._txEncoding = true;
    this._reEncodePending = false;
    // Snapshot at dispatch so we can detect msg/freq drift during the
    // in-flight encode (caller updates _txMessage / _txFreq directly).
    const msgAtDispatch = this._txMessage;
    const freqAtDispatch = this._txFreq;
    this._preEncodePromise = this.encodeMessage(msgAtDispatch, freqAtDispatch)
      .then((samples) => {
        // Truncate to the actual modulated-envelope length so the renderer's
        // BufferSource doesn't keep PTT keyed through trailing silence.
        // ft8js pads to a full cycle (180,000 samples for FT8) — playing
        // the pad means ~2.4 s of dead carrier after the last symbol, which
        // shrinks the next slot's RX window enough to strand the decoder's
        // Costas sync on the responder's reply. K3SBP 2026-05-04: K0LLT
        // QSO sat in phase=r+report through three full cycles because of
        // exactly this overhang.
        if (samples && samples.length > 0) {
          const envSamples = this._mode === 'FT2' ? FT2_TX_SAMPLES
            : this._mode === 'FT4' ? FT4_TX_SAMPLES
            : FT8_TX_SAMPLES;
          if (samples.length > envSamples) {
            samples = samples.subarray(0, envSamples);
          }
        }
        this._txSamples = samples;
        this._txEncodedMsg = msgAtDispatch;
        this._txEncodedFreq = freqAtDispatch;
        this._txEncoding = false;
        this._preEncodePromise = null;
        // Did msg or freq drift while we were encoding? Or was a
        // re-encode explicitly requested? Run another pass — the
        // latest values will be picked up because the next call uses
        // the live _txMessage / _txFreq.
        const drifted = this._txMessage !== msgAtDispatch || this._txFreq !== freqAtDispatch;
        if (this._reEncodePending || drifted) {
          this._reEncodePending = false;
          console.log('[JTCAT] Pre-encoded TX:', this._txEncodedMsg, '@', this._txEncodedFreq, 'Hz,', samples ? samples.length + ' samples' : 'NULL', '(stale — re-encoding for', this._txMessage, '@', this._txFreq, 'Hz)');
          return this._preEncode();
        }
        console.log('[JTCAT] Pre-encoded TX:', this._txEncodedMsg, '@', this._txEncodedFreq, 'Hz,', samples ? samples.length + ' samples' : 'NULL');
      })
      .catch((err) => {
        this._txEncoding = false;
        this._preEncodePromise = null;
        console.error('[JTCAT] Pre-encode failed:', err.message);
      });
    return this._preEncodePromise;
  }

  // _scheduleTx removed — the polling tick (_tick) handles TX scheduling.
  // _onTxBoundary remains as the body of that work, callable from the
  // tick when msIntoCycle is within MAX_LATE_MS of slot start.

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

    // Wall clock for slot parity, plus a 500 ms look-ahead matching the
    // renderer's leading-silence pad (SLOT_AUDIO_START_MS). Node's
    // setTimeout can fire up to ~1ms before its scheduled time, so a
    // timer scheduled for wall :45.000 can land at :44.999. Without
    // the look-ahead, slot evaluates to the previous slot (:44.999 ∈
    // even slot :30–:45), the locked-slot check passes against the
    // user's even-locked QSO, and the engine emits tx-start — but
    // the actual on-air audio plays at wall :45.499 which is in the
    // *odd* slot, colliding with the QSO partner who transmits there.
    // K3SBP 2026-05-14: HK3YL QSO transmitted "HK3YL K3SBP FN20" back-
    // to-back every 15s (both even and odd slots) instead of every 30s,
    // never decoding a reply because we were drowning HK3YL out in our
    // own odd-slot TX. The look-ahead snaps slot evaluation to where
    // the audio will actually land.
    const now = Date.now();
    const cycleSec = this._cycleSec();
    const audioLandsAt = now + 500;
    const slot = Math.floor(audioLandsAt / 1000 / cycleSec) % 2 === 0 ? 'even' : 'odd';

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
    // in time for the next cycle's TX (e.g. courtesy 73). The previous margin
    // (cycleSec-1.5) was TOO TIGHT: FT8 audio is 12.64s buffer + 0.5s lead =
    // 13.14s; main.js adds a 200ms setTimeout before sending the audio IPC;
    // renderer adds ~150–400ms scheduling latency before source.start. Total
    // tx-start → audio-end is ~13.7s, which already exceeded the old 13.5s
    // safety budget — PTT was being released ~150–500ms before the FT8
    // envelope finished, every cycle. Receivers got truncated audio that
    // wouldn't decode, so K3SBP saw zero replies / zero PSK Reporter spots.
    // (cycleSec - 1) gives ~860ms headroom past audio end for FT8 and ~1500ms
    // for FT4, with a full 1s back-end window before the next slot for rig
    // PTT release and TX→RX changeover. K3SBP 2026-05-15.
    const safetyMs = (cycleSec - 1) * 1000;
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
