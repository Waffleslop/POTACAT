'use strict';

/**
 * JtcatManager — Multi-slice orchestrator for JTCAT.
 *
 * Wraps one or more Ft8Engine instances, each associated with a slice/audio source.
 * Phase 0: single engine (drop-in replacement for the raw ft8Engine global).
 * Phase 1+: multiple engines with merged decode output and TX arbitration.
 *
 * Events (forwarded from engines, tagged with sliceId):
 *  - 'decode'    — { sliceId, cycle, mode, slot, results }
 *  - 'cycle'     — { sliceId, number, mode, slot }
 *  - 'tx-start'  — { sliceId, samples, message, freq, slot, offsetMs }
 *  - 'tx-end'    — { sliceId }
 *  - 'status'    — { sliceId, state }
 *  - 'silent'    — { sliceId }
 *  - 'error'     — { sliceId, message }
 */

const { EventEmitter } = require('events');
const Ft8Engine = require('./ft8-engine');

class JtcatManager extends EventEmitter {
  constructor() {
    super();
    this._engines = new Map(); // sliceId → { engine, config }
    this._txSlice = null;      // sliceId that owns TX
    this._qsoState = new Map(); // sliceId → { popout: QsoObj|null, remote: QsoObj|null }
    this._dialFreqs = new Map(); // sliceId → { freqHz, band }
  }

  /** Start an engine for a slice. Config: { sliceId, mode, dialFreqKhz, sliceIndex } */
  startSlice(config) {
    const id = config.sliceId || 'default';
    this.stopSlice(id);

    const engine = new Ft8Engine();
    engine.setMode(config.mode || 'FT8');

    // Forward all events tagged with sliceId
    for (const evt of ['decode', 'cycle', 'tx-start', 'tx-end', 'status', 'silent', 'error']) {
      engine.on(evt, (data) => {
        this.emit(evt, { sliceId: id, ...(data || {}) });
      });
    }

    this._engines.set(id, {
      engine,
      config: { ...config },
    });

    return engine;
  }

  /** Stop all engines */
  stopAll() {
    for (const [id] of this._engines) {
      this.stopSlice(id);
    }
  }

  /** Get engine for a slice (or the default/only engine) */
  getEngine(id) {
    if (id) {
      const entry = this._engines.get(id);
      return entry ? entry.engine : null;
    }
    // Return the first (only) engine for Phase 0 compatibility
    const first = this._engines.values().next();
    return first.done ? null : first.value.engine;
  }

  /** Get the default/active engine (Phase 0 compatibility) */
  get engine() {
    return this.getEngine();
  }

  /** Check if any engine is running */
  get running() {
    for (const [, entry] of this._engines) {
      if (entry.engine._running) return true;
    }
    return false;
  }

  /** Feed audio to a specific slice's engine */
  feedAudio(sliceId, samples) {
    const entry = this._engines.get(sliceId);
    if (entry) entry.engine.feedAudio(samples);
  }

  /** Get all slice IDs */
  get sliceIds() {
    return [...this._engines.keys()];
  }

  /** Get slice count */
  get sliceCount() {
    return this._engines.size;
  }

  /** Set which slice owns TX */
  setTxSlice(id) {
    this._txSlice = id;
    // Disable TX on all other engines
    for (const [sliceId, entry] of this._engines) {
      if (sliceId !== id) {
        entry.engine._txEnabled = false;
      }
    }
  }

  /** Get the TX slice's engine */
  get txEngine() {
    return this._txSlice ? this.getEngine(this._txSlice) : this.getEngine();
  }

  /** Get the TX slice ID */
  get txSliceId() {
    return this._txSlice || 'default';
  }

  // --- Per-slice dial frequency tracking ---

  /** Set dial frequency for a slice */
  setDialFreq(sliceId, freqHz, band) {
    this._dialFreqs.set(sliceId, { freqHz, band: band || '' });
  }

  /** Get dial frequency for a slice */
  getDialFreq(sliceId) {
    return this._dialFreqs.get(sliceId) || { freqHz: 0, band: '' };
  }

  // --- Per-slice QSO state ---

  /** Get QSO state for a slice and owner (popout or remote) */
  getQso(sliceId, owner) {
    const state = this._qsoState.get(sliceId);
    return state ? state[owner] || null : null;
  }

  /** Set QSO state for a slice and owner */
  setQso(sliceId, owner, qso) {
    if (!this._qsoState.has(sliceId)) {
      this._qsoState.set(sliceId, { popout: null, remote: null });
    }
    this._qsoState.get(sliceId)[owner] = qso;
  }

  /** Clear QSO state for a slice and owner */
  clearQso(sliceId, owner) {
    const state = this._qsoState.get(sliceId);
    if (state) state[owner] = null;
  }

  /** Find the slice that has an active QSO for a given owner */
  findActiveQsoSlice(owner) {
    for (const [sliceId, state] of this._qsoState) {
      if (state[owner] && state[owner].phase !== 'done' && state[owner].phase !== 'error') {
        return sliceId;
      }
    }
    return null;
  }

  /** Get all slice configs */
  getSliceConfigs() {
    const configs = [];
    for (const [id, entry] of this._engines) {
      configs.push({ sliceId: id, ...entry.config, ...this.getDialFreq(id) });
    }
    return configs;
  }

  /** Clean up on stopSlice — also clear QSO state and dial freq */
  stopSlice(id) {
    const entry = this._engines.get(id);
    if (!entry) return;
    entry.engine.stop();
    entry.engine.removeAllListeners();
    this._engines.delete(id);
    this._qsoState.delete(id);
    this._dialFreqs.delete(id);
    if (this._txSlice === id) this._txSlice = null;
  }
}

module.exports = { JtcatManager };
