'use strict';
/**
 * KenwoodCodec — ASCII semicolon-terminated protocol encoder/decoder.
 * Handles Kenwood, Yaesu, Elecraft, QRP Labs, Xiegu radios.
 *
 * Unlike the old CatClient, this codec has NO if(_isYaesu) branches.
 * All Yaesu vs Kenwood differences are encoded in the model's `commands`
 * and `modes` tables. The codec just expands templates.
 */
const { EventEmitter } = require('events');

// Default command tables — used when model doesn't define explicit commands.
// Built from brand+protocol to provide backward compatibility.
const KENWOOD_DEFAULTS = {
  faDigits: 11,
  getFreq: 'FA;',
  setFreq: 'FA{freq:pad11};',
  getMode: 'MD;',
  setMode: 'MD{mode};',
  setTransmitOn: 'TX;',
  setTransmitOff: 'RX;',
  setNbOn: 'NB1;',
  setNbOff: 'NB0;',
  getNb: 'NB;',
  getSmeter: 'SM;',
  setRfGain: 'RG{val:pad3};',
  getPower: 'PC;',
  setPower: 'PC{val:pad3};',
  getFilter: null,
  setFilter: 'FW{val:pad4};',
  setVfoA: 'FR0;',
  setVfoB: 'FR1;',
  swapVfo: null,
  setSplit: 'FT1;',
  setDa: 'DA{val};',
  setPowerOn: 'PS1;',
  setPowerOff: 'PS0;',
  // Extended controls
  setNbLevel: 'NL{val:pad3};',
  setAfGain: 'AG{val:pad3};',
  setPreampOn: 'PA1;',
  setPreampOff: 'PA0;',
  setAttenuatorOn: 'RA1;',
  setAttenuatorOff: 'RA0;',
  vfoCopyAB: null,           // not standard Kenwood
  vfoCopyBA: null,
};

const YAESU_DEFAULTS = {
  faDigits: 9,
  getFreq: 'FA;',
  setFreq: 'FA{freq:pad9};',
  getMode: 'MD0;',
  setMode: 'MD0{mode:hexU};',
  setTransmitOn: 'TX1;',
  setTransmitOff: 'TX0;',
  setNbOn: 'NB01;',
  setNbOff: 'NB00;',
  getNb: 'NB0;',
  getSmeter: 'SM0;',
  setRfGain: 'RG0{val:pad3};',
  getPower: 'PC;',
  setPower: 'PC{val:pad3};',
  getFilter: null,
  setFilter: 'SH01{val:pad2};',
  setVfoA: 'VS0;',
  setVfoB: 'VS1;',
  swapVfo: 'SV;',
  setSplit: 'ST1;',
  setDa: null, // Yaesu uses dedicated MD codes, no DA command
  setPowerOn: 'PS1;',
  setPowerOff: 'PS0;',
  // Extended controls
  setNbLevel: 'NL0{val:pad3};',
  setAfGain: 'AG0{val:pad3};',
  setPreampOn: 'PA01;',
  setPreampOff: 'PA00;',
  setAttenuatorOn: 'RA01;',
  setAttenuatorOff: 'RA00;',
  vfoCopyAB: 'AB;',
  vfoCopyBA: 'BA;',
};

// Default mode tables
const KENWOOD_MODES = {
  'LSB':  { md: 1, da: 0 },
  'USB':  { md: 2, da: 0 },
  'CW':   { md: 3 },
  'FM':   { md: 4, da: 0 },
  'AM':   { md: 5, da: 0 },
  'RTTY': { md: 6 },
  'DIGU': { md: 2, da: 1 },
  'DIGL': { md: 1, da: 1 },
  'PKTUSB': { md: 2, da: 1 },
  'PKTLSB': { md: 1, da: 1 },
  'FT8':  { md: 2, da: 1 },
  'FT4':  { md: 2, da: 1 },
  'FT2':  { md: 2, da: 1 },
  'SSB':  null, // resolved at runtime via ssbSideband
};

const YAESU_MODES = {
  'LSB':  { md: 1 },
  'USB':  { md: 2 },
  'CW':   { md: 3 },
  'FM':   { md: 4 },
  'AM':   { md: 5 },
  'RTTY': { md: 6 },
  'DIGU': { md: 0xC },
  'DIGL': { md: 8 },
  'PKTUSB': { md: 0xC },
  'PKTLSB': { md: 8 },
  'FT8':  { md: 0xC },
  'FT4':  { md: 0xC },
  'FT2':  { md: 0xC },
  'SSB':  null,
};

// Mode parse tables (wire value → POTACAT mode name)
const KENWOOD_MODE_PARSE = {
  1: 'LSB', 2: 'USB', 3: 'CW', 4: 'FM', 5: 'AM', 6: 'RTTY', 7: 'CW', 9: 'DIGU',
};

const YAESU_MODE_PARSE = {
  1: 'LSB', 2: 'USB', 3: 'CW', 4: 'FM', 5: 'AM', 6: 'RTTY', 7: 'CW',
  8: 'DIGL', 9: 'DIGU',
  0xA: 'FM', 0xB: 'FM', 0xC: 'DIGU', 0xD: 'AM', 0xE: 'FM',
};

// Yaesu SH0 bandwidth tables
const YAESU_SSB_BW = [200,400,600,850,1100,1350,1500,1650,1800,1950,2100,2250,2400,2500,2600,2700,2800,2900,3000,3200,3600];
const YAESU_CW_BW  = [50,100,150,200,250,300,350,400,450,500,600,800,1000,1200,1500,2400];

function ssbSideband(freqHz) {
  return freqHz >= 10000000 ? 'USB' : 'LSB';
}

function yaesuBwToIndex(hz, mode) {
  // Yaesu DATA modes (DIGU, DIGL, RTTY) use the same SH0 index table as CW
  const m = (mode || '').toUpperCase();
  const useCwTable = m === 'CW' || m === 'CW-R' || m === 'DIGU' || m === 'DIGL' ||
    m === 'RTTY' || m === 'RTTY-R' || m === 'PKTUSB' || m === 'PKTLSB' || m === 'DATA';
  const table = useCwTable ? YAESU_CW_BW : YAESU_SSB_BW;
  let best = 0, bestDist = Infinity;
  for (let i = 0; i < table.length; i++) {
    const d = Math.abs(table[i] - hz);
    if (d < bestDist) { bestDist = d; best = i + 1; } // 1-based
  }
  return best;
}

/**
 * Expand a command template with variables.
 * {freq:pad9} → zero-pad to 9 digits
 * {val:pad3}  → zero-pad to 3 digits
 * {mode:hexU} → uppercase hex digit
 * {mode}      → plain toString
 * {val}       → plain toString
 */
function expand(template, vars) {
  if (!template) return null;
  return template.replace(/\{(\w+)(?::(\w+))?\}/g, (_, name, fmt) => {
    const v = vars[name];
    if (v == null) return '';
    if (fmt && fmt.startsWith('pad')) {
      const width = parseInt(fmt.slice(3), 10);
      return String(Math.round(v)).padStart(width, '0');
    }
    if (fmt === 'hexU') return v.toString(16).toUpperCase();
    return String(v);
  });
}

// ATU command sequences
const ATU_SEQUENCES = {
  'ft891':    [{ cmd: 'AC001;', delay: 0 }, { cmd: 'AC002;', delay: 300 }],
  'ac002':    [{ cmd: 'AC002;', delay: 0 }],
  'standard': [{ cmd: 'AC011;', delay: 0 }],
  'ft450':    [{ cmd: 'AC011;', delay: 0 }],
};

class KenwoodCodec extends EventEmitter {
  /**
   * @param {object} model — rig model entry from rig-models.js
   * @param {function} writeFn — function to write data to transport
   */
  constructor(model, writeFn) {
    super();
    this._model = model;
    this._write = writeFn;

    // Resolve command table: model.commands > brand defaults
    const isYaesu = model.brand === 'Yaesu';
    const defaults = isYaesu ? YAESU_DEFAULTS : KENWOOD_DEFAULTS;
    this._cmds = Object.assign({}, defaults, model.commands || {});

    // Resolve mode table
    const defaultModes = isYaesu ? YAESU_MODES : KENWOOD_MODES;
    this._modes = Object.assign({}, defaultModes, model.modes || {});

    // Resolve mode parse table
    const defaultParse = isYaesu ? YAESU_MODE_PARSE : KENWOOD_MODE_PARSE;
    this._modeParse = Object.assign({}, defaultParse, model.modesParse || {});

    // Rig-model overrides for digital modes (e.g. QMX uses MD6)
    this._digiMd = model.digiMd || null;

    // Power limits
    this._minPower = model.minPower || 0;
    this._maxPower = model.maxPower || 100;

    // ATU sequence
    this._atuCmd = model.atuCmd || 'standard';

    // Response parser state
    this._buf = '';
    this._lastParsedMode = null;
    this._lastFreqHz = 0;
    this._faDigits = this._cmds.faDigits || (isYaesu ? 9 : 11);
  }

  // --- Command generation ---

  setFrequency(hz) {
    const cmd = expand(this._cmds.setFreq, { freq: hz });
    if (cmd) this._write(cmd);
  }

  getFrequency() {
    if (this._cmds.getFreq) this._write(this._cmds.getFreq);
  }

  /**
   * Set mode. Resolves SSB → USB/LSB, handles digiMd override and DA command.
   * @returns {object|null} the resolved mode mapping (for tune sequencing)
   */
  setMode(modeName, freqHz) {
    const resolved = this.resolveMode(modeName, freqHz);
    if (!resolved) return null;

    const mdCmd = expand(this._cmds.setMode, { mode: resolved.md });
    if (mdCmd) this._write(mdCmd);

    // DA command for Kenwood data mode toggle
    if (resolved.da != null && this._cmds.setDa) {
      this._write(expand(this._cmds.setDa, { val: resolved.da }));
    }
    return resolved;
  }

  getMode() {
    if (this._cmds.getMode) this._write(this._cmds.getMode);
  }

  /**
   * Resolve a POTACAT mode name to wire values.
   * Handles SSB → USB/LSB, digiMd override.
   */
  resolveMode(modeName, freqHz) {
    let m = (modeName || '').toUpperCase();
    if (m === 'SSB') m = ssbSideband(freqHz);

    let mapping = this._modes[m];
    if (!mapping) return null;

    // Rig-model override: QMX uses MD6 for all digital modes.
    // Only trigger when da=1 (data mode ON), not da=0 (data mode OFF = voice/CW).
    if (this._digiMd != null && mapping.da === 1) {
      return { md: this._digiMd };
    }

    return mapping;
  }

  /** Get the parsed mode name for a mode mapping (for change detection) */
  modeNameForMapping(mapping) {
    if (!mapping) return null;
    return this._modeParse[mapping.md] || null;
  }

  setTransmit(on) {
    const cmd = on ? this._cmds.setTransmitOn : this._cmds.setTransmitOff;
    if (cmd) this._write(cmd);
  }

  setNb(on) {
    const cmd = on ? this._cmds.setNbOn : this._cmds.setNbOff;
    if (cmd) this._write(cmd);
  }

  getNb() {
    if (this._cmds.getNb) this._write(this._cmds.getNb);
  }

  getSmeter() {
    if (this._cmds.getSmeter) this._write(this._cmds.getSmeter);
  }

  getSwr() {
    this._write('RM1;');
  }

  setRfGain(pct) {
    const scaled = Math.max(0, Math.min(255, Math.round(pct * 2.55)));
    const cmd = expand(this._cmds.setRfGain, { val: scaled });
    if (cmd) this._write(cmd);
  }

  setTxPower(watts) {
    const clamped = Math.max(this._minPower, Math.min(this._maxPower, Math.round(watts)));
    const cmd = expand(this._cmds.setPower, { val: clamped });
    if (cmd) this._write(cmd);
  }

  getPower() {
    if (this._cmds.getPower) this._write(this._cmds.getPower);
  }

  setFilterWidth(hz) {
    const filterType = this._model.caps?.filterType || this._cmds.filterType;
    if (filterType === 'indexed') {
      const mode = this._lastParsedMode || '';
      const idx = yaesuBwToIndex(hz, mode);
      const cmd = expand(this._cmds.setFilter, { val: idx });
      if (cmd) this._write(cmd);
    } else if (filterType === 'direct') {
      const cmd = expand(this._cmds.setFilter, { val: hz });
      if (cmd) this._write(cmd);
    }
  }

  setVfo(vfo) {
    const cmd = (vfo || 'A').toUpperCase() === 'B' ? this._cmds.setVfoB : this._cmds.setVfoA;
    if (cmd) this._write(cmd);
  }

  swapVfo() {
    if (this._cmds.swapVfo) this._write(this._cmds.swapVfo);
  }

  setSplit(on) {
    if (on && this._cmds.setSplit) this._write(this._cmds.setSplit);
  }

  /** Set TX CLAR (XIT) using native Yaesu XT/RU/RD commands.
   *  hz > 0: enable + offset up.  hz < 0: enable + offset down.  hz === 0: disable. */
  setXit(hz) {
    if (!hz) {
      this._write('XT0;'); // TX CLAR off
      return;
    }
    this._write('XT1;'); // TX CLAR on
    this._write('RC;');  // reset to zero
    const abs = String(Math.min(9999, Math.abs(Math.round(hz)))).padStart(4, '0');
    this._write((hz > 0 ? 'RU' : 'RD') + abs + ';');
  }

  setPowerState(on) {
    const cmd = on ? this._cmds.setPowerOn : this._cmds.setPowerOff;
    if (cmd) this._write(cmd);
  }

  /** Returns array of { cmd, delay } for ATU tune sequence */
  getAtuStartSequence() {
    return ATU_SEQUENCES[this._atuCmd] || ATU_SEQUENCES['standard'];
  }

  getAtuStopCmd() {
    return 'AC000;';
  }

  // Direct ATU methods (used by RigController as fallback if getAtuStartSequence returns null)
  startTune() { this._write('AC011;'); }
  stopTune() { this._write('AC000;'); }

  sendCwText(text) {
    // Handled by rig-controller based on model.cw config
    // This is just the protocol-level send
    const clean = text.toUpperCase().replace(/[^A-Z0-9 /?.=,\-[\]_<>#%\\]/g, '');
    const cw = this._model.cw || {};
    const chunk = cw.textChunk || 24;

    if (cw.kyMode === 'km') {
      // FTDX101D: write to memory 5 via KM, play back via KYA
      for (let i = 0; i < clean.length; i += chunk) {
        const part = clean.substring(i, i + chunk);
        this._write(`KM5${part};`);
        this._write('KYA;');
      }
    } else if (cw.text === 'ky1') {
      // Yaesu KY format: KY<P1> <text padded to 48 chars>;
      const p1 = cw.kyParam != null ? cw.kyParam : 0;
      for (let i = 0; i < clean.length; i += 48) {
        const part = clean.substring(i, i + 48).padEnd(48, ' ');
        this._write(`KY${p1} ${part};`);
      }
    } else {
      // Kenwood KY format: KY <text>;
      for (let i = 0; i < clean.length; i += chunk) {
        const part = clean.substring(i, i + chunk).padEnd(chunk, ' ');
        this._write(`KY ${part};`);
      }
    }
  }

  setCwSpeed(wpm) {
    const clamped = Math.max(4, Math.min(60, Math.round(wpm)));
    this._write(`KS${String(clamped).padStart(3, '0')};`);
  }

  // --- Extended controls ---

  setNbLevel(val) {
    const cmd = expand(this._cmds.setNbLevel, { val });
    if (cmd) this._write(cmd);
  }

  setAfGain(pct) {
    const scaled = Math.max(0, Math.min(255, Math.round(pct * 2.55)));
    const cmd = expand(this._cmds.setAfGain, { val: scaled });
    if (cmd) this._write(cmd);
  }

  setPreamp(on) {
    const cmd = on ? this._cmds.setPreampOn : this._cmds.setPreampOff;
    if (cmd) this._write(cmd);
  }

  setAttenuator(on) {
    const cmd = on ? this._cmds.setAttenuatorOn : this._cmds.setAttenuatorOff;
    if (cmd) this._write(cmd);
  }

  vfoCopyAB() {
    if (this._cmds.vfoCopyAB) this._write(this._cmds.vfoCopyAB);
  }

  vfoCopyBA() {
    if (this._cmds.vfoCopyBA) this._write(this._cmds.vfoCopyBA);
  }

  sendRaw(text) {
    const cmd = text.replace(/[\r\n]/g, '').trim();
    if (cmd) this._write(cmd.endsWith(';') ? cmd : cmd + ';');
  }

  // --- Response parsing ---

  /**
   * Feed incoming data from transport. Parses semicolon-terminated messages.
   * Emits: 'frequency', 'mode', 'power', 'nb', 'error'
   */
  onData(chunk) {
    this._buf += chunk.toString();
    let idx;
    while ((idx = this._buf.indexOf(';')) !== -1) {
      const msg = this._buf.slice(0, idx).trim();
      this._buf = this._buf.slice(idx + 1);
      if (msg) this._parseMessage(msg);
    }
    // Check for '?' error responses (no semicolon)
    while (this._buf.includes('?')) {
      const qIdx = this._buf.indexOf('?');
      const before = this._buf.slice(0, qIdx).trim();
      this._buf = this._buf.slice(qIdx + 1);
      this.emit('error', { message: '? (command error)', raw: before });
    }
  }

  _parseMessage(msg) {
    // Frequency: FA followed by digits
    if (msg.startsWith('FA') && msg.length > 2) {
      const digits = msg.slice(2);
      const hz = parseInt(digits, 10);
      if (!isNaN(hz) && hz > 0) {
        // Detect FA digit count (Yaesu=9, Kenwood=11)
        if (digits.length === 9 || digits.length === 11) {
          this._faDigits = digits.length;
        }
        this._lastFreqHz = hz;
        this.emit('frequency', hz);
      }
      return;
    }

    // Mode: MD followed by digits or MD0 followed by hex digit (Yaesu)
    if (msg.startsWith('MD')) {
      const payload = msg.slice(2);
      // Yaesu: MD0C (VFO selector + hex mode). Kenwood: MD2 (decimal mode)
      const mdVal = payload.length > 1
        ? parseInt(payload.slice(-1), 16)  // last char as hex
        : parseInt(payload, 10);
      const modeName = this._modeParse[mdVal];
      if (modeName) {
        this._lastParsedMode = modeName;
        this.emit('mode', modeName);
      }
      return;
    }

    // Power: PC followed by digits
    if (msg.startsWith('PC') && msg.length > 2) {
      const watts = parseInt(msg.slice(2), 10);
      if (!isNaN(watts)) this.emit('power', watts);
      return;
    }

    // Noise blanker: NB followed by 0/1 (Kenwood) or NB0 followed by 0/1 (Yaesu)
    if (msg.startsWith('NB')) {
      const last = msg.slice(-1);
      this.emit('nb', last === '1');
      return;
    }

    // S-meter: SM followed by digits (Kenwood: SM0005, Yaesu: SM0128)
    if (msg.startsWith('SM')) {
      const digits = msg.replace(/^SM0?/, '');
      const val = parseInt(digits, 10) || 0;
      this.emit('smeter', val);
      return;
    }

    // SWR/ALC meter: RM1xxxx (SWR)
    if (msg.startsWith('RM')) {
      const rmType = msg.charAt(2);
      const rmVal = parseInt(msg.slice(3), 10) || 0;
      if (rmType === '1') this.emit('swr', rmVal);
      return;
    }

    // Data mode: DA followed by 0/1
    if (msg.startsWith('DA')) {
      this.emit('da', msg.slice(-1) === '1');
      return;
    }
  }

  /** Get the detected/configured FA digit count */
  get faDigits() { return this._faDigits; }

  /** Get the last parsed mode name */
  get lastMode() { return this._lastParsedMode; }

  /** Set last parsed mode (for external sync) */
  set lastMode(m) { this._lastParsedMode = m; }
}

module.exports = { KenwoodCodec, expand, ssbSideband, yaesuBwToIndex, YAESU_SSB_BW, YAESU_CW_BW };
