'use strict';
/**
 * RigDispatcher — unified command dispatch for rig control.
 *
 * Single entry point for both IPC (desktop) and ECHOCAT (WebSocket) handlers.
 * Replaces the duplicate switch/case blocks in main.js.
 *
 * Usage:
 *   const dispatcher = new RigDispatcher();
 *   dispatcher.setRig(rigController);     // non-Flex
 *   dispatcher.setSmartSdr(smartSdrClient); // Flex
 *
 *   // From IPC or ECHOCAT:
 *   dispatcher.dispatch('set-nb', { value: true });
 *   dispatcher.dispatch('atu-tune', {});
 *   dispatcher.dispatch('set-rf-gain', { value: 50 });
 */
const { EventEmitter } = require('events');

class RigDispatcher extends EventEmitter {
  constructor() {
    super();
    this._rig = null;          // RigController (non-Flex)
    this._smartSdr = null;     // SmartSdrClient (Flex)
    this._state = {
      connected: false,
      frequency: 0,
      mode: null,
      nb: false,
      rfGain: 0,
      txPower: 0,
      filterWidth: 0,
      atuActive: false,
      power: 0,
      vfo: 'A',
    };

    // Throttle timers for slider commands
    this._rfGainTimer = null;
    this._txPowerTimer = null;
    this._rfGainSuppressBroadcast = 0;
    this._txPowerSuppressBroadcast = 0;
  }

  /** Set the active rig controller (non-Flex) */
  setRig(rig) {
    // Remove old listeners
    if (this._rig) {
      this._rig.removeAllListeners('frequency');
      this._rig.removeAllListeners('mode');
      this._rig.removeAllListeners('power');
      this._rig.removeAllListeners('nb');
      this._rig.removeAllListeners('status');
    }
    this._rig = rig;
    if (!rig) return;

    // Wire rig events to state + broadcast
    rig.on('frequency', (hz) => {
      this._state.frequency = hz;
      this.emit('frequency', hz);
    });
    rig.on('mode', (mode) => {
      this._state.mode = mode;
      this.emit('mode', mode);
    });
    rig.on('power', (w) => {
      this._state.power = w;
      this.emit('power', w);
    });
    rig.on('nb', (on) => {
      this._state.nb = on;
      this.emit('nb', on);
    });
    rig.on('status', (s) => {
      this._state.connected = s.connected;
      this.emit('status', s);
    });
    rig.on('log', (msg) => this.emit('log', msg));
  }

  /** Set the SmartSDR client (Flex) */
  setSmartSdr(sdr) {
    this._smartSdr = sdr;
  }

  /** Is the active rig a Flex via SmartSDR? */
  _flexActive() {
    return this._smartSdr && this._smartSdr.connected;
  }

  /** Get capabilities from the active rig's model */
  getCapabilities() {
    if (this._rig && this._rig.model) return this._rig.model.caps || {};
    return {};
  }

  /** Get current rig state */
  getState() {
    return { ...this._state };
  }

  /**
   * Unified dispatch — handles rig control commands from any source.
   * @param {string} action — command name
   * @param {object} data — command parameters
   */
  dispatch(action, data) {
    switch (action) {
      case 'set-nb': {
        const on = !!data.value;
        if (this._flexActive()) {
          this._smartSdr.setSliceNb(0, on);
        } else if (this._rig && this._rig.connected) {
          this._rig.setNb(on);
        }
        this._state.nb = on;
        this.emit('state-changed');
        break;
      }

      case 'atu-tune': {
        if (this._flexActive()) {
          this._smartSdr.setAtu(true);
        } else if (this._rig && this._rig.connected) {
          this._rig.startTune();
        }
        this._state.atuActive = true;
        this.emit('state-changed');
        break;
      }

      case 'set-atu': {
        const on = !!data.value;
        if (this._flexActive()) {
          this._smartSdr.setAtu(on);
        } else if (this._rig && this._rig.connected) {
          if (on) this._rig.startTune();
          else this._rig.stopTune();
        }
        this._state.atuActive = on;
        this.emit('state-changed');
        break;
      }

      case 'set-rf-gain': {
        const value = Number(data.value) || 0;
        this._state.rfGain = value;
        if (this._flexActive()) {
          const dB = (value * 0.3) - 10;
          this._smartSdr.setRfGain(0, dB);
        } else if (this._rig && this._rig.connected) {
          const rigType = this._rig.protocol;
          if (rigType === 'rigctld') this._rig.setRfGain(value / 100);
          else this._rig.setRfGain(value);
        }
        this.emit('state-changed');
        break;
      }

      case 'set-tx-power': {
        const value = Number(data.value) || 0;
        this._state.txPower = value;
        if (this._flexActive()) {
          this._smartSdr.setTxPower(value);
        } else if (this._rig && this._rig.connected) {
          const rigType = this._rig.protocol;
          if (rigType === 'rigctld') this._rig.setTxPower(value / 100);
          else this._rig.setTxPower(value);
        }
        this.emit('state-changed');
        break;
      }

      case 'set-filter-width': {
        const width = Number(data.value) || 0;
        if (width <= 0) break;
        if (this._flexActive()) {
          const m = (this._state.mode || '').toUpperCase();
          let lo, hi;
          if (m === 'CW') {
            lo = Math.max(0, 600 - Math.round(width / 2));
            hi = 600 + Math.round(width / 2);
          } else {
            lo = 100;
            hi = 100 + width;
          }
          this._smartSdr.setSliceFilter(0, lo, hi);
        } else if (this._rig && this._rig.connected) {
          this._rig.setFilterWidth(width);
        }
        this._state.filterWidth = width;
        this.emit('state-changed');
        break;
      }

      case 'set-vfo': {
        const vfo = data.vfo || 'A';
        if (this._rig && this._rig.connected) {
          this._rig.setVfo(vfo);
        }
        this._state.vfo = vfo;
        this.emit('state-changed');
        break;
      }

      case 'swap-vfo': {
        if (this._rig && this._rig.connected) {
          this._rig.swapVfo();
        }
        this.emit('state-changed');
        break;
      }

      case 'power-on': {
        if (this._rig) this._rig.setPowerState(true);
        break;
      }

      case 'power-off': {
        if (this._rig) this._rig.setPowerState(false);
        break;
      }

      case 'send-raw': {
        if (this._rig && this._rig.connected && data.cmd) {
          this._rig.sendRaw(data.cmd);
        }
        break;
      }

      // --- Extended controls ---

      case 'set-nb-level': {
        const val = Number(data.value) || 0;
        if (this._rig && this._rig.connected) this._rig.setNbLevel(val);
        this.emit('state-changed');
        break;
      }

      case 'set-af-gain': {
        const val = Number(data.value) || 0;
        if (this._rig && this._rig.connected) this._rig.setAfGain(val);
        this.emit('state-changed');
        break;
      }

      case 'set-preamp': {
        const on = !!data.value;
        if (this._rig && this._rig.connected) this._rig.setPreamp(on);
        this.emit('state-changed');
        break;
      }

      case 'set-attenuator': {
        const on = !!data.value;
        if (this._rig && this._rig.connected) this._rig.setAttenuator(on);
        this.emit('state-changed');
        break;
      }

      case 'vfo-copy-ab': {
        if (this._rig && this._rig.connected) this._rig.vfoCopyAB();
        break;
      }

      case 'vfo-copy-ba': {
        if (this._rig && this._rig.connected) this._rig.vfoCopyBA();
        break;
      }

      case 'set-nr': {
        const on = !!data.value;
        if (this._rig && this._rig.connected) this._rig.setNoiseReduction(on);
        this.emit('state-changed');
        break;
      }

      case 'set-anf': {
        const on = !!data.value;
        if (this._rig && this._rig.connected) this._rig.setAutoNotch(on);
        this.emit('state-changed');
        break;
      }

      case 'set-comp': {
        const on = !!data.value;
        if (this._rig && this._rig.connected) this._rig.setCompressor(on);
        this.emit('state-changed');
        break;
      }

      default:
        // Unknown action — ignore
        break;
    }
  }
}

module.exports = { RigDispatcher };
