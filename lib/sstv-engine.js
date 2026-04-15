'use strict';
/**
 * SstvEngine — orchestrates the SSTV worker for image encode/decode.
 *
 * Emits:
 *   'encode-complete'  { samples: Float32Array, mode, durationSec }
 *   'rx-vis'           { mode, modeName }
 *   'rx-line'          { line, totalLines, rgba }
 *   'rx-image'         { imageData: Uint8ClampedArray, width, height, mode }
 *   'status'           { state: 'running'|'stopped'|'encoding'|'decoding' }
 *   'error'            { message }
 */
const { Worker } = require('worker_threads');
const { EventEmitter } = require('events');
const path = require('path');

const SAMPLE_RATE = 48000;

class SstvEngine extends EventEmitter {
  constructor() {
    super();
    this._worker = null;
    this._workerReady = false;
    this._running = false;
    this._encoding = false;
    this._decoding = false;
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._spawnWorker();
  }

  stop() {
    this._running = false;
    this._workerReady = false;
    this._encoding = false;
    this._decoding = false;
    if (this._worker) {
      try { this._worker.postMessage({ type: 'stop' }); } catch {}
      try { this._worker.terminate(); } catch {}
      this._worker = null;
    }
    this.emit('status', { state: 'stopped' });
  }

  /** Encode an RGBA image to SSTV audio. */
  encode(imageData, width, height, mode) {
    if (!this._running || !this._workerReady || !this._worker) return;
    this._encoding = true;
    this.emit('status', { state: 'encoding' });
    // Convert to plain array buffer if needed for transfer
    const data = imageData instanceof Uint8ClampedArray ? imageData : new Uint8ClampedArray(imageData);
    this._worker.postMessage(
      { type: 'encode', imageData: data, width, height, mode },
      [data.buffer]
    );
  }

  /** Set the actual audio sample rate (call before feedAudio if not 48000). */
  setSampleRate(rate) {
    if (this._worker && this._workerReady) {
      this._worker.postMessage({ type: 'set-sample-rate', sampleRate: rate });
    }
    this._sampleRate = rate;
  }

  /** Feed audio samples for continuous RX decode. */
  feedAudio(samples) {
    if (!this._running || !this._workerReady || !this._worker) return;
    const buf = samples instanceof Float32Array ? samples : new Float32Array(samples);
    this._worker.postMessage(
      { type: 'rx-audio', samples: buf },
      [buf.buffer]
    );
  }

  get running() { return this._running; }
  get encoding() { return this._encoding; }
  get decoding() { return this._decoding; }

  // --- Internal ---

  _spawnWorker() {
    const workerPath = path.join(__dirname, 'sstv-worker.js');
    this._worker = new Worker(workerPath);

    this._worker.on('message', (msg) => this._onWorkerMessage(msg));

    this._worker.on('error', (err) => {
      console.error('[SSTV] Worker error:', err.message);
      this.emit('error', { message: err.message });
    });

    this._worker.on('exit', (code) => {
      if (this._running && code !== 0) {
        console.error(`[SSTV] Worker exited with code ${code}, restarting...`);
        setTimeout(() => this._spawnWorker(), 1000);
      }
    });
  }

  _onWorkerMessage(msg) {
    switch (msg.type) {
      case 'ready':
        this._workerReady = true;
        console.log('[SSTV] Engine ready');
        this.emit('status', { state: 'running' });
        break;

      case 'encode-result': {
        this._encoding = false;
        const samples = new Float32Array(msg.samples);
        const durationSec = samples.length / SAMPLE_RATE;
        console.log(`[SSTV] Encode complete: ${samples.length} samples, ${durationSec.toFixed(1)}s`);
        this.emit('encode-complete', { samples, durationSec });
        this.emit('status', { state: 'running' });
        break;
      }

      case 'rx-vis':
        this._decoding = true;
        console.log(`[SSTV] VIS detected: ${msg.modeName} (${msg.mode})`);
        this.emit('rx-vis', { mode: msg.mode, modeName: msg.modeName });
        this.emit('status', { state: 'decoding' });
        break;

      case 'rx-line':
        this.emit('rx-line', {
          line: msg.line,
          totalLines: msg.totalLines,
          rgba: msg.rgba,
        });
        break;

      case 'rx-image': {
        this._decoding = false;
        const imageData = new Uint8ClampedArray(msg.imageData);
        console.log(`[SSTV] Image decoded: ${msg.width}x${msg.height} ${msg.mode}`);
        this.emit('rx-image', {
          imageData,
          width: msg.width,
          height: msg.height,
          mode: msg.mode,
        });
        this.emit('status', { state: 'running' });
        break;
      }

      case 'rx-debug':
        this.emit('rx-debug', { state: msg.state, avgFreq: msg.avgFreq, detail: msg.detail });
        break;

      case 'error':
        this._encoding = false;
        this.emit('error', { message: msg.message });
        this.emit('status', { state: 'running' });
        break;
    }
  }
}

module.exports = { SstvEngine };
