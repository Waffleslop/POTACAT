'use strict';
/**
 * RigController — facade composing transport + codec + model.
 *
 * Owns: polling, tune sequencing, CW keying routing, ATU sequences.
 * Emits: 'frequency', 'mode', 'power', 'nb', 'status', 'log'
 *
 * Replaces CatClient / RigctldClient / CivClient as the unified rig interface.
 */
const { EventEmitter } = require('events');

class RigController extends EventEmitter {
  /**
   * @param {object} model — rig model entry from rig-models.js
   * @param {object} transport — TcpTransport or SerialTransport instance
   * @param {object} codec — KenwoodCodec, RigctldCodec, or CivCodec instance
   */
  constructor(model, transport, codec) {
    super();
    this._model = model;
    this._transport = transport;
    this._codec = codec;

    // State
    this.connected = false;
    this._target = null;
    this._pollTimer = null;
    this._pollCount = 0;
    this._pendingTimers = [];
    this._lastParsedMode = null;
    this._lastFreqHz = 0;
    this._debug = false;

    // Tune state
    this._requestedMd = null; // for post-reconnect mode enforcement

    // CW state
    this._cwTaActive = false;
    this._cwTaSavedMode = null;

    // Throttle state
    this._lastRgTime = 0;
    this._lastPcTime = 0;

    // Wire transport events
    this._transport.on('connect', () => {
      this.connected = true;
      this._target = this._transport._target;
      this.emit('status', { connected: true, target: this._target });
      this._log('Connected');

      // Safety: force PTT off on reconnect — if serial dropped during TX
      // (e.g. Digirig/FT-891), the radio may be stuck transmitting
      if (this._hasConnectedBefore) {
        this._codec.setTransmit(false);
        this._log('post-reconnect safety: PTT off');
      }
      this._hasConnectedBefore = true;

      // Start polling after connect delay
      setTimeout(() => {
        if (this.connected) {
          this._startPolling();
          // Post-reconnect mode enforcement
          this._enforceRequestedMode();
        }
      }, model.connectDelay || 300);
    });

    this._transport.on('close', () => {
      const was = this.connected;
      this.connected = false;
      this._stopPolling();
      if (was) {
        this.emit('status', { connected: false, target: this._target });
        this._log('Disconnected');
      }
    });

    this._transport.on('error', (err) => {
      this._log(`Transport error: ${err.message}`);
    });

    this._transport.on('data', (chunk) => {
      this._codec.onData(chunk);
    });

    // Wire codec events
    this._codec.on('frequency', (hz) => {
      this._lastFreqHz = hz;
      this.emit('frequency', hz);
    });
    this._codec.on('mode', (mode) => {
      this._lastParsedMode = mode;
      this.emit('mode', mode);
    });
    this._codec.on('power', (w) => this.emit('power', w));
    this._codec.on('nb', (on) => this.emit('nb', on));
    this._codec.on('da', (on) => this.emit('da', on));
    this._codec.on('log', (msg) => this._log(msg));
    this._codec.on('error', (e) => this._log(e.message || 'codec error'));
  }

  // --- Lifecycle ---

  connect(target) {
    this._target = target;
    this._transport.connect(target);
  }

  disconnect() {
    this._stopPolling();
    for (const t of this._pendingTimers) clearTimeout(t);
    this._pendingTimers = [];
    this._transport.disconnect();
    this.connected = false;
  }

  // --- Logging ---

  _log(msg) {
    if (this._debug) this.emit('log', msg);
  }

  // --- Polling ---

  _startPolling() {
    this._stopPolling();
    this._pollCount = 0;
    const caps = this._model.caps || {};
    const interval = this._model.protocol === 'rigctld' ? 500 : 1000;

    this._pollTimer = setInterval(() => {
      if (this._codec.getFrequency) this._codec.getFrequency();
      if (this._codec.getMode) this._codec.getMode();

      // Poll power and NB every 5th cycle
      if (this._pollCount++ % 5 === 0) {
        if (caps.txpower && this._codec.getPower) this._codec.getPower();
        if (caps.nb && this._codec.getNb) this._codec.getNb();
      }
    }, interval);
  }

  _stopPolling() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  pausePolling() { this._stopPolling(); }

  resumePolling() {
    if (this.connected && !this._pollTimer) this._startPolling();
  }

  // --- Tune ---

  tune(frequencyHz, mode, { split, filterWidth } = {}) {
    if (!this.connected) return false;

    // Cancel pending tune timers
    for (const t of this._pendingTimers) clearTimeout(t);
    this._pendingTimers = [];
    this._stopPolling();

    const q = this._model.tune || {};
    const resolved = mode ? this._codec.resolveMode(mode, frequencyHz) : null;
    const modeChanged = resolved && this._codec.modeNameForMapping
      ? this._codec.modeNameForMapping(resolved) !== this._lastParsedMode
      : !!resolved;

    let delay = 0;

    // Mode BEFORE frequency
    if (q.modeBeforeFreq !== false && resolved && (modeChanged || q.alwaysResendMode)) {
      this._codec.setMode(mode, frequencyHz);
      delay = Math.max(delay, 100);
    }

    // Frequency
    this._pendingTimers.push(setTimeout(() => {
      if (this.connected) this._codec.setFrequency(frequencyHz);
    }, delay));
    delay += 100;

    // Mode AFTER frequency (band-recall fix)
    if (q.modeAfterFreq && resolved && (modeChanged || q.alwaysResendMode)) {
      this._pendingTimers.push(setTimeout(() => {
        if (this.connected) this._codec.setMode(mode, frequencyHz);
      }, delay));
      delay += 100;

      // Frequency AFTER post-mode (CW pitch offset fix — the "sandwich")
      if (q.freqAfterMode) {
        this._pendingTimers.push(setTimeout(() => {
          if (this.connected) this._codec.setFrequency(frequencyHz);
        }, delay));
        delay += 100;
      }
    }

    // Filter width
    if (filterWidth > 0) {
      this._pendingTimers.push(setTimeout(() => {
        if (this.connected) this._codec.setFilterWidth(filterWidth);
      }, delay));
      delay += 100;
    }

    // Split
    if (split) {
      this._pendingTimers.push(setTimeout(() => {
        if (this.connected) this._codec.setSplit(true);
      }, delay));
      delay += 100;
    }

    // Remember requested mode for post-reconnect enforcement
    if (resolved) this._requestedMd = { mode, freqHz: frequencyHz };

    // Resume polling
    this._pendingTimers.push(setTimeout(() => {
      if (this.connected) this._startPolling();
    }, delay + 500));

    this._log(`tune: freq=${frequencyHz}Hz mode=${mode} split=${!!split} filter=${filterWidth || 0}`);
    return true;
  }

  // --- Post-reconnect mode enforcement ---

  _enforceRequestedMode() {
    if (!this._requestedMd) return;
    const { mode, freqHz } = this._requestedMd;
    // Wait for polling to establish current state, then re-send mode
    setTimeout(() => {
      if (!this.connected || !this._requestedMd) return;
      this._codec.setMode(mode, freqHz);
      this._log(`post-reconnect mode enforcement: ${mode}`);
    }, 1500);
  }

  // --- Rig control commands ---

  setTransmit(on) {
    if (!this.connected) return;
    this._codec.setTransmit(on);
  }

  setFilterWidth(hz) {
    if (!this.connected || !hz) return;
    this._codec.setFilterWidth(hz);
    this._log(`Filter width: ${hz}Hz`);
  }

  setNb(on) {
    if (!this.connected) return;
    this._codec.setNb(on);
    this._log(`NB ${on ? 'on' : 'off'}`);
  }

  setRfGain(pct) {
    if (!this.connected) return;
    const now = Date.now();
    if (this._lastRgTime && now - this._lastRgTime < 150) return;
    this._lastRgTime = now;
    this._codec.setRfGain(pct);
    this._log(`RF gain: ${pct}`);
  }

  setTxPower(watts) {
    if (!this.connected) return;
    const now = Date.now();
    if (this._lastPcTime && now - this._lastPcTime < 150) return;
    this._lastPcTime = now;
    this._codec.setTxPower(watts);
    this._log(`TX power: ${watts}W`);
  }

  setPowerState(on) {
    // Power-on: radio may be off, just need transport open
    if (!this._transport.connected) return;
    this._codec.setPowerState(on);
    this._log(`Power ${on ? 'on' : 'off'}`);
  }

  startTune() {
    if (!this.connected) return;
    const seq = this._codec.getAtuStartSequence();
    if (!seq) {
      // CI-V: codec handles ATU directly
      this._codec.startTune();
      this._log('ATU tune started');
      return;
    }
    // ASCII protocols: execute command sequence with delays
    let delay = 0;
    for (const step of seq) {
      if (step.cmd) {
        this._pendingTimers.push(setTimeout(() => {
          if (this.connected) this._transport.write(step.cmd);
        }, delay));
      }
      delay += step.delay || 0;
    }
    this._log('ATU tune started');
  }

  stopTune() {
    if (!this.connected) return;
    const cmd = this._codec.getAtuStopCmd();
    if (cmd) {
      this._transport.write(cmd);
    } else {
      this._codec.stopTune();
    }
    this._log('ATU tuner off');
  }

  setVfo(vfo) {
    if (!this.connected) return;
    this._codec.setVfo(vfo);
    this._log(`VFO: ${vfo}`);
  }

  swapVfo() {
    if (!this.connected) return;
    this._codec.swapVfo();
    this._log('VFO swap');
  }

  setSplit(on) {
    if (!this.connected) return;
    this._codec.setSplit(on);
    this._log(`Split ${on ? 'on' : 'off'}`);
  }

  sendCwText(text) {
    if (!this.connected || !text) return;
    this._codec.sendCwText(text);
  }

  setCwSpeed(wpm) {
    if (!this.connected) return;
    this._codec.setCwSpeed(wpm);
  }

  sendRaw(text) {
    if (!this.connected) return;
    this._codec.sendRaw(text);
  }

  // --- Extended controls ---

  setNbLevel(val) {
    if (!this.connected) return;
    this._codec.setNbLevel(val);
  }

  setAfGain(pct) {
    if (!this.connected) return;
    const now = Date.now();
    if (this._lastAfTime && now - this._lastAfTime < 150) return;
    this._lastAfTime = now;
    this._codec.setAfGain(pct);
  }

  setPreamp(on) {
    if (!this.connected) return;
    this._codec.setPreamp(on);
  }

  setAttenuator(on) {
    if (!this.connected) return;
    this._codec.setAttenuator(on);
  }

  vfoCopyAB() {
    if (!this.connected) return;
    this._codec.vfoCopyAB();
  }

  vfoCopyBA() {
    if (!this.connected) return;
    this._codec.vfoCopyBA();
  }

  // --- CW keying (DTR + TX/RX routing) ---

  setCwKeyDtr(down, pins) {
    if (!this._transport.setPin) return;
    const p = pins || { dtr: true };
    const state = {};
    if (p.dtr) state.dtr = !!down;
    if (p.rts) state.rts = !!down;
    this._transport.setPin(state, (err) => {
      if (err) this._log(`DTR pin error: ${err.message}`);
    });
  }

  setCwKeyTxRx(down) {
    if (!this.connected) return;
    this._codec.setTransmit(down);
  }

  setCwKeyTa(down) {
    // TA keying: switch to digi mode, TX, send TA tone
    if (!this.connected) return;
    // Codec handles TA command specifics
    if (typeof this._codec.setCwKeyTa === 'function') {
      this._codec.setCwKeyTa(down);
    } else {
      this.setCwKeyTxRx(down);
    }
  }

  endCwKeyTa() {
    if (typeof this._codec.endCwKeyTa === 'function') {
      this._codec.endCwKeyTa();
    }
  }

  // --- Accessors ---

  get model() { return this._model; }
  get protocol() { return this._model.protocol; }
  get lastFreqHz() { return this._lastFreqHz; }
  get lastMode() { return this._lastParsedMode; }
}

module.exports = { RigController };
