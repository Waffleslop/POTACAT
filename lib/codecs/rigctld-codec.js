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

// Sensible default passband (Hz) per rigctld mode token. Used when the user
// hasn't configured an explicit filter width in POTACAT Settings. Prevents
// the "rig defaults PKTUSB to 500 Hz" trap on some hamlib backends (Yaesu
// FT991 in particular). An explicit setFilterWidth call from the rig
// controller's tune pipeline overrides this.
function defaultPassbandFor(token) {
  switch (token) {
    case 'PKTUSB':
    case 'PKTLSB':  return 3000;  // FT8/FT4/JS8/PSK need wide
    case 'USB':
    case 'LSB':     return 2400;  // standard SSB
    case 'CW':
    case 'CWR':     return 500;
    case 'RTTY':
    case 'RTTYR':   return 500;
    case 'FM':
    case 'FMN':     return 15000; // narrow FM
    case 'AM':      return 6000;
    default:        return 0;     // fall back to backend default
  }
}

// ATU sequences for Yaesu raw passthrough
// Different Yaesu generations interpret the AC command differently — there's
// no one-size code. If a model's selected variant doesn't work, the user can
// trial-and-error via Settings > Rig > Custom Command and report back so we
// can add the right preset here.
const ATU_SEQUENCES = {
  'ft891': [{ cmd: 'w AC001;\n', delay: 0 }, { cmd: 'w AC002;\n', delay: 300 }],
  'ac002': [{ cmd: 'w AC002;\n', delay: 0 }],
  'ac103': [{ cmd: 'w AC103;\n', delay: 0 }], // FTX-1 Optima (W9JL) — P1=1, P3=3
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
   *
   * rigctld's `M <mode> <passband>` second argument:
   *   0  = backend default passband
   *   -1 = no change
   *   >0 = explicit Hz
   *
   * We used to send 0 (backend default), but some rigs — notably the Yaesu
   * FT991 via hamlib — default PKTUSB/PKTLSB to 500 Hz, which is useless
   * for FT8/FT4 (needs ~3 kHz). Sending mode-appropriate defaults here
   * gives a sensible RX bandwidth on first mode switch, without forcing
   * users to configure SSB/CW/Digital Filter Width in POTACAT Settings.
   * Users who DO set a POTACAT filter width override this via setFilterWidth
   * after the mode change (the rig-controller tune pipeline calls filter
   * last, so the explicit value wins). (phsdv, FT991, issue #21)
   */
  setMode(modeName, freqHz) {
    const token = this.resolveMode(modeName, freqHz);
    if (token) {
      const pb = defaultPassbandFor(token);
      this._write(`M ${token} ${pb}\n`);
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
    const line = on ? 'T 1\n' : 'T 0\n';
    this.emit('log', `PTT write: ${JSON.stringify(line)}`);
    this._write(line);
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
    // rigctld split command: `S <on/off> <tx-vfo>`. VFO token is ignored when
    // disabling, but hamlib requires a placeholder.
    this._write(on ? 'S 1 VFOB\n' : 'S 0 VFOA\n');
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

  startTune() {
    // For Yaesu, use the variant configured for this model rather than a
    // hardcoded AC011 (which doesn't work for FT-891-style or FTX-1-style
    // radios). For non-Yaesu, fall through to the standard rigctld TUNER fn.
    if (this._yaesuRaw) {
      const seq = ATU_SEQUENCES[this._atuCmd] || ATU_SEQUENCES['standard'];
      this.emit('log', `ATU start (variant=${this._atuCmd}): ${seq.map(s => s.cmd.trim()).join(' then ')}`);
      let delay = 0;
      for (const step of seq) {
        delay += step.delay || 0;
        if (delay === 0) this._write(step.cmd);
        else setTimeout(() => this._write(step.cmd), delay);
      }
    } else {
      this.emit('log', 'ATU start: U TUNER 1');
      this._write('U TUNER 1\n');
    }
  }
  stopTune() {
    const line = this._yaesuRaw ? 'w AC000;\n' : 'U TUNER 0\n';
    this.emit('log', `ATU stop: ${line.trim()}`);
    this._write(line);
  }

  sendCwText(text) {
    const clean = text.toUpperCase().replace(/[^A-Z0-9 /?.=,\-]/g, '');
    const line = `b ${clean}\n`;
    this.emit('log', `CW write: ${JSON.stringify(line)} (${clean.length} chars)`);
    this._write(line);
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
    if (!cmd) return;
    // Detect space-separated hex bytes (e.g. "FE FE 80 E0 16 22 01 FD")
    // and convert to \x escape sequences for rigctld's w command
    const hexParts = cmd.split(/\s+/);
    const isHex = hexParts.length >= 2 && hexParts.every(p => /^[0-9a-fA-F]{2}$/.test(p));
    if (isHex) {
      const escaped = hexParts.map(h => '\\x' + h.toLowerCase()).join('');
      this._write(`w ${escaped}\n`);
    } else {
      this._write(`w ${cmd}\n`);
    }
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

    // RPRT responses — clear all pending expectations (command was answered)
    if (/^RPRT\s+-?\d+/.test(line)) {
      const code = parseInt(line.split(/\s+/)[1], 10);
      if (this._expectNb) {
        this._expectNb = false;
        if (code !== 0) this._nbUnsupported = true;
      }
      this._expectSmeter = false;
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

    // S-meter response: hamlib `l STRENGTH` returns dB relative to S9
    // (S9=0, S0=-54, S9+20=+20, S9+60=+60). Map to 0-255 for UI.
    // Range guard: values -200 to +100; anything > 1000 is a frequency, not S-meter
    if (this._expectSmeter && /^-?\d+$/.test(line)) {
      const val = parseInt(line, 10);
      if (val >= -200 && val <= 100) {
        this._expectSmeter = false;
        // Map: -54 -> 0 (S0), 0 -> 120 (S9), +60 -> 255 (S9+60)
        const scaled = Math.max(0, Math.min(255, Math.round((val + 54) * 255 / 114)));
        this.emit('smeter', scaled);
        return;
      }
      // Value out of S-meter range — not an S-meter response, fall through
      this._expectSmeter = false;
    }

    // Frequency: plain integer (must be > 100 kHz to be a real frequency)
    if (/^\d+$/.test(line)) {
      const hz = parseInt(line, 10);
      if (!isNaN(hz) && hz > 100000) {
        if (hz !== this._lastFreqHz) {
          this.emit('log', `rx: ${hz} -> freq=${(hz / 1000).toFixed(1)}kHz`);
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
      this.emit('log', `rx: ${line} -> mode=${line}`);
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

  /** Return the resolved command table for the Table tab UI */
  getCommandTable() {
    const y = this._yaesuRaw;
    const entries = [
      { key: 'getFreq', label: 'Get Frequency', value: 'f' },
      { key: 'setFreq', label: 'Set Frequency', value: 'F {freq}' },
      { key: 'getMode', label: 'Get Mode', value: 'm' },
      { key: 'setMode', label: 'Set Mode', value: 'M {mode} 0' },
      { key: 'setTransmitOn', label: 'PTT On', value: 'T 1' },
      { key: 'setTransmitOff', label: 'PTT Off', value: 'T 0' },
      { key: 'setNbOn', label: 'NB On', value: y ? 'w NB01;' : 'U NB 1' },
      { key: 'setNbOff', label: 'NB Off', value: y ? 'w NB00;' : 'U NB 0' },
      { key: 'getNb', label: 'Get NB', value: 'u NB' },
      { key: 'getSmeter', label: 'S-Meter', value: 'l STRENGTH' },
      { key: 'setRfGain', label: 'RF Gain', value: y ? 'w RG0{val};' : 'L RFGAIN {val}' },
      { key: 'setPower', label: 'TX Power', value: y ? 'w PC{val};' : 'L RFPOWER {val}' },
      { key: 'setFilter', label: 'Filter Width', value: 'M {mode} {hz}' },
      { key: 'setVfoA', label: 'VFO A', value: 'V VFOA' },
      { key: 'setVfoB', label: 'VFO B', value: 'V VFOB' },
      { key: 'setSplit', label: 'Split On', value: 'S 1 VFOB' },
      { key: 'setPowerOn', label: 'Power On', value: '\\set_powerstat 1' },
      { key: 'setPowerOff', label: 'Power Off', value: '\\set_powerstat 0' },
    ];
    // ATU
    const atuSeq = this.getAtuStartSequence();
    if (atuSeq && atuSeq.length > 0) {
      const atuStr = atuSeq.map(s => s.cmd.replace(/\n$/, '')).join(' -> ');
      entries.push({ key: 'atuTune', label: 'ATU Tune', value: atuStr });
    }
    // Extended Yaesu controls
    if (y) {
      entries.push({ key: 'setNbLevel', label: 'NB Level', value: 'w NL0{val};' });
      entries.push({ key: 'setAfGain', label: 'AF Gain', value: 'w AG0{val};' });
      entries.push({ key: 'setPreampOn', label: 'Preamp On', value: 'w PA01;' });
      entries.push({ key: 'setPreampOff', label: 'Preamp Off', value: 'w PA00;' });
      entries.push({ key: 'setAttenuatorOn', label: 'Atten On', value: 'w RA01;' });
      entries.push({ key: 'setAttenuatorOff', label: 'Atten Off', value: 'w RA00;' });
      entries.push({ key: 'vfoCopyAB', label: 'VFO Copy A->B', value: 'w AB;' });
      entries.push({ key: 'vfoCopyBA', label: 'VFO Copy B->A', value: 'w BA;' });
    } else {
      entries.push({ key: 'setAfGain', label: 'AF Gain', value: 'L AF {val}' });
      entries.push({ key: 'setPreampOn', label: 'Preamp On', value: 'U PREAMP 1' });
      entries.push({ key: 'setPreampOff', label: 'Preamp Off', value: 'U PREAMP 0' });
      entries.push({ key: 'setAttenuatorOn', label: 'Atten On', value: 'U ATT 1' });
      entries.push({ key: 'setAttenuatorOff', label: 'Atten Off', value: 'U ATT 0' });
    }
    return entries;
  }
}

module.exports = { RigctldCodec };
