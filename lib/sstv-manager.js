'use strict';
/**
 * SstvManager — manages multiple SstvEngine instances for multi-slice
 * SSTV monitoring on FlexRadio (up to 4 slices).
 *
 * Each slice gets its own SstvEngine (own worker thread, own decoder state).
 * Events from all engines are re-emitted with sliceId tag.
 *
 * Follows the JtcatManager pattern (lib/jtcat-manager.js).
 */
const { EventEmitter } = require('events');
const { SstvEngine } = require('./sstv-engine');

class SstvManager extends EventEmitter {
  constructor() {
    super();
    this._slices = new Map(); // sliceId -> { engine, config }
  }

  /**
   * Start monitoring on a slice.
   * @param {object} config - { sliceId, freqKhz, audioDeviceId, slicePort }
   */
  startSlice(config) {
    const { sliceId } = config;
    if (this._slices.has(sliceId)) {
      this.stopSlice(sliceId);
    }

    const engine = new SstvEngine();

    // Forward all engine events tagged with sliceId
    engine.on('rx-vis', (data) => {
      this.emit('rx-vis', { ...data, sliceId });
    });
    engine.on('rx-line', (data) => {
      this.emit('rx-line', { ...data, sliceId });
    });
    engine.on('rx-image', (data) => {
      this.emit('rx-image', { ...data, sliceId });
    });
    engine.on('status', (data) => {
      this.emit('status', { ...data, sliceId });
    });
    engine.on('rx-debug', (data) => {
      this.emit('rx-debug', { ...data, sliceId });
    });
    engine.on('error', (data) => {
      this.emit('error', { ...data, sliceId });
    });

    engine.start();
    this._slices.set(sliceId, { engine, config });
    console.log(`[SSTV Manager] Started slice ${sliceId} on ${config.freqKhz} kHz`);
    return engine;
  }

  /** Stop a single slice. */
  stopSlice(sliceId) {
    const entry = this._slices.get(sliceId);
    if (entry) {
      entry.engine.stop();
      this._slices.delete(sliceId);
      console.log(`[SSTV Manager] Stopped slice ${sliceId}`);
    }
  }

  /** Stop all slices. */
  stopAll() {
    for (const [id, entry] of this._slices) {
      entry.engine.stop();
      console.log(`[SSTV Manager] Stopped slice ${id}`);
    }
    this._slices.clear();
  }

  /** Feed audio samples to a specific slice. */
  feedAudio(sliceId, samples) {
    const entry = this._slices.get(sliceId);
    if (entry) entry.engine.feedAudio(samples);
  }

  /** Get a slice entry. */
  getSlice(sliceId) {
    return this._slices.get(sliceId);
  }

  /** List active slice IDs. */
  get sliceIds() {
    return Array.from(this._slices.keys());
  }

  /** Number of active slices. */
  get size() {
    return this._slices.size;
  }
}

module.exports = { SstvManager };
