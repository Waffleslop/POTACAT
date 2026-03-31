'use strict';
/**
 * RigctldCodec — hamlib rigctld text protocol encoder/decoder.
 * Supports standard rigctld commands and Yaesu raw passthrough.
 *
 * When the rig model is Yaesu brand, commands that hamlib backends handle
 * poorly (NB, RF gain, TX power, ATU) are sent as raw Kenwood commands
 * via the 'w' passthrough. This replaces the old _yaesuRaw flag.
 */
const { EventEmitter } = require('events');

function ssbSideband(freqHz) {
  return freqHz >= 10000000 ? 'USB' : 'LSB';
}

// Map POTACAT mode names to rigctld mode tokens
const RIGCTLD_MODES = {
  'CW': 'CW', 'USB': 'USB', 'LSB': 'LSB', 'FM': 'FM', 'AM': 'AM',
  'DIGU': 'PKTUSB', 'DIGL': 'PKTLSB', 'PKTUSB': 'PKTUSB', 'PKTLSB': 'PKTLSB',
  'FT8': 'PKTUSB', 'FT4': 'PKTUSB', 'FT2': 'PKTUSB',
  'RTTY': 'RTTY',
};

// ATU sequences for Yaesu raw passthrough
const ATU_SEQUENCES = {
  'ft891': [{ cmd: 'w AC001;\n', delay: 0 }, { cmd: 'w AC002;\n', delay: 300 }],
  'ac002': [{ cmd: 'w AC002;\n', delay: 0 }],
  'standard': [{ cmd: 'w AC011;\n', delay: 0 }],
};

class RigctldCodec extends EventEmitter {
  /**
   * @param {object} model — rig model entry
   * @param {function} writeFn — writes string to transport
   */
  constructor(model, writeFn) {
    super();
    this._model = model;
    this._write = writeFn;
    this._yaesuRaw = model.brand === 'Yaesu';
    this._atuCmd = model.atuCmd || 'standard';
    this._minPower = model.minPower || 5;
    this._maxPower = model.maxPower || 100;
    this._modes = Object.assign({}, RIGCTLD_MODES, model.modes || {});

    // Response parser state
    this._buf = '';
    this._expectPassband = false;
    this._expectNb = false;
    this._expectSmeter = false;
    this._nbUnsupported = false;
    this._lastRprtCode = null;
    this._lastMode = null;
    this._lastFreqHz = 0;
  }

  // --- Command generation ---

  setFrequency(hz) {
    this._write(`F ${hz}\n`);
  }

  getFrequency() {
    this._write('f\n');
  }

  /**
   * Set mode. Returns the rigctld mode token used.
   */
  setMode(modeName, freqHz) {
    const token = this.resolveMode(modeName, freqHz);
    if (token) {
      this._write(`M ${token} 0\n`);
      this._lastMode = token;
    }
    return token;
  }

  getMode() {
    this._write('m\n');
  }

  resolveMode(modeName, freqHz) {
    let m = (modeName || '').toUpperCase();
    if (m === 'SSB') m = ssbSideband(freqHz);
    return this._modes[m] || RIGCTLD_MODES[m] || null;
  }

  setTransmit(on) {
    this._write(on ? 'T 1\n' : 'T 0\n');
  }

  setNb(on) {
    if (this._yaesuRaw) {
      this._write(`w NB0${on ? 1 : 0};\n`);
    } else {
      this._write(`U NB ${on ? 1 : 0}\n`);
    }
  }

  getNb() {
    if (this._nbUnsupported) return;
    this._expectNb = true;
    this._write('u NB\n');
  }

  getSmeter() {
    this._expectSmeter = true;
    this._write('l STRENGTH\n');
  }

  setRfGain(pct) {
    if (this._yaesuRaw) {
      const clamped = Math.max(0, Math.min(255, Math.round(pct * 255)));
      this._write(`w RG0${String(clamped).padStart(3, '0')};\n`);
    } else {
      this._write(`L RFGAIN ${pct.toFixed(3)}\n`);
    }
  }

  setTxPower(fraction) {
    if (this._yaesuRaw) {
      const watts = Math.max(this._minPower, Math.min(this._maxPower, Math.round(fraction * this._maxPower)));
      this._write(`w PC${String(watts).padStart(3, '0')};\n`);
    } else {
      this._write(`L RFPOWER ${fraction.toFixed(3)}\n`);
    }
  }

  getPower() {
    // rigctld doesn't have a reliable power query — skip
  }

  setFilterWidth(hz) {
    if (!hz) return;
    const mode = this._lastMode || 'USB';
    this._write(`M ${mode} ${hz}\n`);
  }

  setVfo(vfo) {
    this._write(`V VFO${(vfo || 'A').toUpperCase()}\n`);
  }

  swapVfo() {
    // rigctld doesn't have a direct swap — set opposite VFO
  }

  setSplit(on) {
    if (on) this._write('S 1 VFOB\n');
  }

  setPowerState(on) {
    this._write(`\\set_powerstat ${on ? 1 : 0}\n`);
  }

  /** Returns ATU sequence for the rig */
  getAtuStartSequence() {
    if (this._yaesuRaw) {
      return ATU_SEQUENCES[this._atuCmd] || ATU_SEQUENCES['standard'];
    }
    return [{ cmd: 'U TUNER 1\n', delay: 0 }];
  }

  getAtuStopCmd() {
    return this._yaesuRaw ? 'w AC000;\n' : 'U TUNER 0\n';
  }

  startTune() { this._write(this._yaesuRaw ? 'w AC011;\n' : 'U TUNER 1\n'); }
  stopTune() { this._write(this._yaesuRaw ? 'w AC000;\n' : 'U TUNER 0\n'); }

  sendCwText(text) {
    const clean = text.toUpperCase().replace(/[^A-Z0-9 /?.=,\-]/g, '');
    this._write(`b ${clean}\n`);
  }

  setCwSpeed(wpm) {
    const clamped = Math.max(5, Math.min(50, Math.round(wpm)));
    this._write(`L KEYSPD ${clamped}\n`);
  }

  // --- Extended controls ---

  setNbLevel(val) {
    if (this._yaesuRaw) this._write(`w NL0${String(val).padStart(3, '0')};\n`);
    // No standard rigctld equivalent for NB level
  }

  setAfGain(pct) {
    if (this._yaesuRaw) {
      const scaled = Math.max(0, Math.min(255, Math.round(pct * 255)));
      this._write(`w AG0${String(scaled).padStart(3, '0')};\n`);
    } else {
      this._write(`L AF ${pct.toFixed(3)}\n`);
    }
  }

  setPreamp(on) {
    if (this._yaesuRaw) {
      this._write(`w PA0${on ? 1 : 0};\n`);
    } else {
      this._write(`U PREAMP ${on ? 1 : 0}\n`);
    }
  }

  setAttenuator(on) {
    if (this._yaesuRaw) {
      this._write(`w RA0${on ? 1 : 0};\n`);
    } else {
      this._write(`U ATT ${on ? 1 : 0}\n`);
    }
  }

  vfoCopyAB() {
    if (this._yaesuRaw) this._write('w AB;\n');
  }

  vfoCopyBA() {
    if (this._yaesuRaw) this._write('w BA;\n');
  }

  sendRaw(text) {
    const cmd = text.replace(/[\r\n]/g, '').trim();
    if (cmd) this._write(`w ${cmd}\n`);
  }

  // --- Response parsing ---

  onData(chunk) {
    this._buf += chunk.toString();
    let nl;
    while ((nl = this._buf.indexOf('\n')) !== -1) {
      const line = this._buf.slice(0, nl).trim();
      this._buf = this._buf.slice(nl + 1);
      if (!line) continue;
      this._parseLine(line);
    }
  }

  _parseLine(line) {
    // Passband after mode response — skip, but validate it's actually a passband
    if (this._expectPassband) {
      this._expectPassband = false;
      if (/^\d+$/.test(line) && parseInt(line, 10) <= 100000) {
        return; // genuine passband
      }
      // Fall through — not a passband (e.g. FLRig omits it)
    }

    // RPRT responses
    if (/^RPRT\s+-?\d+/.test(line)) {
      const code = parseInt(line.split(/\s+/)[1], 10);
      if (this._expectNb) {
        this._expectNb = false;
        if (code !== 0) this._nbUnsupported = true;
      }
      if (code !== 0 && code !== this._lastRprtCode) {
        this.emit('log', `rx: ${line} (error: command not supported or failed)`);
      }
      this._lastRprtCode = code;
      return;
    }

    // NB response: "0" or "1" — check BEFORE frequency to avoid "1" being parsed as 1 Hz
    if (this._expectNb && /^[01]$/.test(line)) {
      this._expectNb = false;
      this.emit('nb', line === '1');
      return;
    }

    // S-meter response: integer dBm value (e.g. "-75" or "0")
    if (this._expectSmeter && /^-?\d+$/.test(line)) {
      this._expectSmeter = false;
      const dbm = parseInt(line, 10);
      // Convert dBm to 0-255 scale: -120 dBm = 0, -10 dBm = 255
      const scaled = Math.max(0, Math.min(255, Math.round((dbm + 120) * 255 / 110)));
      this.emit('smeter', scaled);
      return;
    }

    // Frequency: plain integer (must be > 100 kHz to be a real frequency)
    if (/^\d+$/.test(line)) {
      const hz = parseInt(line, 10);
      if (!isNaN(hz) && hz > 100000) {
        if (hz !== this._lastFreqHz) {
          this.emit('log', `rx: ${hz} → freq=${(hz / 1000).toFixed(1)}kHz`);
          this._lastFreqHz = hz;
        }
        this.emit('frequency', hz);
      }
      return;
    }

    // Mode: uppercase letters 2-8 chars
    if (/^[A-Z]{2,8}$/.test(line) && !line.startsWith('RPRT')) {
      this._expectPassband = true;
      this._lastMode = line;
      this.emit('mode', line);
      this.emit('log', `rx: ${line} → mode=${line}`);
      return;
    }

    // NB response already handled above (before frequency check)
    // This catches any remaining single-digit responses
    if (this._expectNb && /^[01]$/.test(line)) {
      this._expectNb = false;
      this.emit('nb', line === '1');
      return;
    }
  }

  get lastMode() { return this._lastMode; }
  set lastMode(m) { this._lastMode = m; }
}

module.exports = { RigctldCodec };
