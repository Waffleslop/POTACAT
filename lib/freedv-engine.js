'use strict';
/**
 * FreedvEngine — orchestrates the FreeDV worker for continuous
 * streaming digital voice encode/decode.
 *
 * Emits:
 *   'rx-speech'  { samples: Int16Array }
 *   'tx-modem'   { samples: Int16Array }
 *   'sync'       { sync: bool, snr: float }
 *   'status'     { state: 'running'|'stopped', mode: string, info: object }
 *   'error'      { message: string }
 */
const { Worker } = require('worker_threads');
const { EventEmitter } = require('events');
const path = require('path');

class FreedvEngine extends EventEmitter {
  constructor() {
    super();
    this._worker = null;
    this._workerReady = false;
    this._running = false;
    this._mode = '700E';
    this._info = null;
    this._txEnabled = false;
    this._squelchEnabled = true;
    this._squelchThreshold = 2.0; // dB
    this._lastSync = false;
    this._lastSnr = 0;
  }

  start(mode) {
    if (this._running) return;
    this._mode = mode || '700E';
    this._running = true;
    this._spawnWorker();
  }

  stop() {
    this._running = false;
    this._workerReady = false;
    if (this._worker) {
      try { this._worker.postMessage({ type: 'stop' }); } catch {}
      try { this._worker.terminate(); } catch {}
      this._worker = null;
    }
    this._info = null;
    this.emit('status', { state: 'stopped', mode: this._mode, info: null });
  }

  setMode(mode) {
    this._mode = mode || '700E';
    if (this._worker && this._workerReady) {
      this._worker.postMessage({ type: 'set-mode', mode: this._mode });
    }
  }

  /** Feed demodulated audio from the radio (8kHz Int16) */
  feedRxAudio(samples) {
    if (!this._running || !this._workerReady || !this._worker) return;
    this._worker.postMessage(
      { type: 'rx-audio', samples },
      [samples.buffer]
    );
  }

  /** Feed speech audio from the mic (8kHz Int16) */
  feedTxAudio(samples) {
    if (!this._running || !this._workerReady || !this._worker || !this._txEnabled) return;
    this._worker.postMessage(
      { type: 'tx-audio', samples },
      [samples.buffer]
    );
  }

  setTxEnabled(enabled) {
    this._txEnabled = !!enabled;
  }

  setSquelch(enabled, threshold) {
    this._squelchEnabled = !!enabled;
    if (threshold != null) this._squelchThreshold = threshold;
  }

  get info() { return this._info; }
  get mode() { return this._mode; }
  get running() { return this._running; }
  get synced() { return this._lastSync; }

  // --- Internal ---

  _spawnWorker() {
    const workerPath = path.join(__dirname, 'freedv-worker.js');
    this._worker = new Worker(workerPath);

    this._worker.on('message', (msg) => this._onWorkerMessage(msg));

    this._worker.on('error', (err) => {
      console.error('[FreeDV] Worker error:', err.message);
      this.emit('error', { message: err.message });
    });

    this._worker.on('exit', (code) => {
      if (this._running && code !== 0) {
        console.error(`[FreeDV] Worker exited with code ${code}, restarting...`);
        setTimeout(() => this._spawnWorker(), 1000);
      }
    });

    // Init the codec
    this._worker.postMessage({ type: 'init', mode: this._mode });
  }

  _onWorkerMessage(msg) {
    switch (msg.type) {
      case 'ready':
        this._workerReady = true;
        this._info = msg.info;
        console.log('[FreeDV] Engine ready:', JSON.stringify(msg.info));
        this.emit('status', { state: 'running', mode: this._mode, info: this._info });
        break;

      case 'rx-speech': {
        // Squelch: suppress output when not synced or SNR below threshold
        const muted = this._squelchEnabled && (!this._lastSync || this._lastSnr < this._squelchThreshold);
        if (!muted) {
          this.emit('rx-speech', { samples: new Int16Array(msg.samples) });
        }
        break;
      }

      case 'tx-modem':
        this.emit('tx-modem', { samples: new Int16Array(msg.samples) });
        break;

      case 'rx-stats': {
        const synced = msg.sync > 0;
        this._lastSync = synced;
        this._lastSnr = msg.snr;
        this.emit('sync', { sync: synced, snr: msg.snr });
        break;
      }

      case 'error':
        this.emit('error', { message: msg.message });
        break;
    }
  }
}

module.exports = { FreedvEngine };
