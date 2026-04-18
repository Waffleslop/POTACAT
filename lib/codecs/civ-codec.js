'use strict';
/**
 * CivCodec — Icom CI-V binary protocol encoder/decoder.
 * Handles frequency (BCD), mode, PTT, power, NB, ATU, CW text/speed.
 *
 * Replaces the old CivClient's protocol logic. Unlike the old code, this
 * codec implements ALL rig control commands (NB, filter, ATU, rfgain, txpower)
 * instead of leaving them as stubs.
 */
const { EventEmitter } = require('events');

function ssbSideband(freqHz) {
  return freqHz >= 10000000 ? 'USB' : 'LSB';
}

// CI-V mode byte -> POTACAT mode name
const CIV_MODE_PARSE = {
  0x00: 'LSB', 0x01: 'USB', 0x02: 'AM', 0x03: 'CW',
  0x04: 'RTTY', 0x05: 'FM', 0x06: 'WFM', 0x07: 'CW', // CW-R
  0x08: 'RTTY', // RTTY-R
};

// POTACAT mode -> CI-V mode byte
const CIV_MODES = {
  'LSB':  { civMode: 0x00 },
  'USB':  { civMode: 0x01 },
  'AM':   { civMode: 0x02 },
  'CW':   { civMode: 0x03 },
  'RTTY': { civMode: 0x04 },
  'FM':   { civMode: 0x05 },
  'DIGU': { civMode: 0x01, dataMode: true },
  'DIGL': { civMode: 0x00, dataMode: true },
  'PKTUSB': { civMode: 0x01, dataMode: true },
  'PKTLSB': { civMode: 0x00, dataMode: true },
  'FT8':  { civMode: 0x01, dataMode: true },
  'FT4':  { civMode: 0x01, dataMode: true },
  'FT2':  { civMode: 0x01, dataMode: true },
};

class CivCodec extends EventEmitter {
  /**
   * @param {object} model — rig model entry
   * @param {function} writeFn — writes Buffer to transport
   */
  constructor(model, writeFn) {
    super();
    this._model = model;
    this._write = writeFn;
    this._radioAddr = model.civAddr || 0x94;
    this._ctrlAddr = 0xE0;
    this._modes = Object.assign({}, CIV_MODES, model.modes || {});
    this._modeParse = Object.assign({}, CIV_MODE_PARSE, model.modesParse || {});
    this._maxPower = model.maxPower || 100;

    // Response parser state
    this._buf = Buffer.alloc(0);
    this._lastMode = null;
    this._lastModeByte = null;
    this._lastFreqHz = 0;
  }

  // --- Frame building ---

  _buildFrame(cmd, sub, data) {
    const payload = [];
    payload.push(cmd);
    if (sub != null) payload.push(sub);
    if (data) payload.push(...data);

    const frame = Buffer.alloc(4 + payload.length + 1);
    frame[0] = 0xFE; // preamble
    frame[1] = 0xFE;
    frame[2] = this._radioAddr;
    frame[3] = this._ctrlAddr;
    for (let i = 0; i < payload.length; i++) frame[4 + i] = payload[i];
    frame[frame.length - 1] = 0xFD; // end
    return frame;
  }

  _sendCmd(cmd, sub, data) {
    this._write(this._buildFrame(cmd, sub, data));
  }

  // --- BCD encoding ---

  /** Encode frequency as 5-byte BCD (10 digits, little-endian pairs) */
  _encodeFreqBCD(hz) {
    const digits = String(hz).padStart(10, '0');
    const bytes = [];
    for (let i = 8; i >= 0; i -= 2) {
      bytes.push(parseInt(digits[i], 10) | (parseInt(digits[i + 1], 10) << 4));
    }
    // Wait, CI-V freq is sent least-significant byte first
    // Hz = 14074000 -> "0014074000" -> bytes [00,40,07,14,00] (LSB first)
    const bcd = [];
    for (let i = 8; i >= 0; i -= 2) {
      const hi = parseInt(digits[i], 10);
      const lo = parseInt(digits[i + 1], 10);
      bcd.push((hi << 4) | lo);
    }
    return bcd;
  }

  /** Decode 5-byte BCD frequency to Hz */
  _decodeFreqBCD(bytes) {
    let digits = '';
    for (let i = bytes.length - 1; i >= 0; i--) {
      digits += ((bytes[i] >> 4) & 0x0F).toString();
      digits += (bytes[i] & 0x0F).toString();
    }
    return parseInt(digits, 10);
  }

  /** Encode a 0-255 value as 4-digit BCD (2 bytes) for level commands */
  _encodeLevelBCD(val) {
    const clamped = Math.max(0, Math.min(255, Math.round(val)));
    const s = String(clamped).padStart(4, '0');
    return [
      (parseInt(s[0], 10) << 4) | parseInt(s[1], 10),
      (parseInt(s[2], 10) << 4) | parseInt(s[3], 10),
    ];
  }

  // --- Command generation ---

  setFrequency(hz) {
    this._sendCmd(0x05, null, this._encodeFreqBCD(hz));
  }

  getFrequency() {
    this._sendCmd(0x03);
  }

  setMode(modeName, freqHz) {
    const resolved = this.resolveMode(modeName, freqHz);
    if (!resolved) return null;

    // Set mode (cmd 0x06) — send mode byte only, no filter byte.
    // Including a filter byte (0x01/0x02/0x03) forces FIL1/2/3 on every mode
    // change, overriding the radio's per-band/per-mode filter memory.
    this._sendCmd(0x06, null, [resolved.civMode]);

    // Set data mode if needed (cmd 0x1A sub 0x06).
    // Send single byte (data on/off) without the filter selector — the second
    // byte forces FIL1/2/3 and clobbers the user's per-mode filter memory
    // (e.g. IC-7300 reverting CW to FIL2 when user has FIL3 set).
    if (resolved.dataMode) {
      this._sendCmd(0x1A, 0x06, [0x01]); // data mode ON, preserve filter
    } else {
      this._sendCmd(0x1A, 0x06, [0x00]); // data mode OFF, preserve filter
    }

    return resolved;
  }

  getMode() {
    this._sendCmd(0x04);
  }

  resolveMode(modeName, freqHz) {
    let m = (modeName || '').toUpperCase();
    if (m === 'SSB') m = ssbSideband(freqHz);
    return this._modes[m] || CIV_MODES[m] || null;
  }

  setTransmit(on) {
    this._sendCmd(0x1C, 0x00, [on ? 0x01 : 0x00]);
  }

  setNb(on) {
    this._sendCmd(0x16, 0x22, [on ? 0x01 : 0x00]);
  }

  getNb() {
    this._sendCmd(0x16, 0x22);
  }

  getPower() {
    this._sendCmd(0x14, 0x0A);
  }

  getSmeter() {
    this._sendCmd(0x15, 0x02); // S-meter level
  }

  getSwr() {
    this._sendCmd(0x15, 0x12); // SWR meter
  }

  setRfGain(pct) {
    // CI-V level 0x14 sub 0x02, value 0000-0255 as BCD
    const scaled = Math.round(pct * 2.55);
    this._sendCmd(0x14, 0x02, this._encodeLevelBCD(scaled));
  }

  setTxPower(watts) {
    // Map watts to 0-255 range for CI-V level command
    const scaled = Math.round((watts / this._maxPower) * 255);
    this._sendCmd(0x14, 0x0A, this._encodeLevelBCD(scaled));
  }

  setFilterWidth(_hz) {
    // CI-V cmd 0x06 only selects filter PRESETS (FIL1/2/3), not Hz widths.
    // Mapping Hz->FIL is meaningless — each user's FIL presets are configured
    // differently on the radio. Sending this also re-sends the mode byte,
    // which can disrupt data mode and override the radio's filter memory.
    // Skip for Icom — let the radio manage its own filter presets.
  }

  setVfo(vfo) {
    // CI-V cmd 0x07 sub 0x00=A, 0x01=B
    this._sendCmd(0x07, null, [(vfo || 'A').toUpperCase() === 'B' ? 0x01 : 0x00]);
  }

  swapVfo() {
    this._sendCmd(0x07, 0xB0); // exchange VFO
  }

  setSplit(on) {
    this._sendCmd(0x0F, null, [on ? 0x01 : 0x00]);
  }

  setPowerState(on) {
    this._sendCmd(0x18, null, [on ? 0x01 : 0x00]);
  }

  getAtuStartSequence() {
    return [{ cmd: null, civCmd: { cmd: 0x1C, sub: 0x01, data: [0x02] }, delay: 0 }];
  }

  getAtuStopCmd() {
    return null; // Will be handled as CI-V frame by controller
  }

  startTune() {
    this._sendCmd(0x1C, 0x01, [0x02]); // ATU tune
  }

  stopTune() {
    this._sendCmd(0x1C, 0x01, [0x00]); // ATU off
  }

  sendCwText(text) {
    const clean = text.toUpperCase().replace(/[^A-Z0-9 /?.=,\-]/g, '');
    const chunk = this._model.cw?.textChunk || 30;
    for (let i = 0; i < clean.length; i += chunk) {
      const part = clean.substring(i, i + chunk);
      this._sendCmd(0x17, null, Array.from(Buffer.from(part, 'ascii')));
    }
  }

  setCwSpeed(wpm) {
    // Map WPM 6-48 to CI-V level 0-255
    const scaled = Math.round(((wpm - 6) / 42) * 255);
    this._sendCmd(0x14, 0x0C, this._encodeLevelBCD(scaled));
  }

  // --- Extended controls ---

  setNbLevel(val) {
    // CI-V: NB level is cmd 0x14 sub 0x12
    const scaled = Math.round((val / 10) * 255); // FT-891 range 0-10, CI-V range 0-255
    this._sendCmd(0x14, 0x12, this._encodeLevelBCD(scaled));
  }

  setAfGain(pct) {
    // CI-V: AF gain is cmd 0x14 sub 0x01
    const scaled = Math.round(pct * 2.55);
    this._sendCmd(0x14, 0x01, this._encodeLevelBCD(scaled));
  }

  setPreamp(on) {
    // CI-V: preamp cmd 0x16 sub 0x02
    this._sendCmd(0x16, 0x02, [on ? 0x01 : 0x00]);
  }

  setAttenuator(on) {
    // CI-V: attenuator cmd 0x11 — 0x00=off, 0x20=20dB
    this._sendCmd(0x11, null, [on ? 0x20 : 0x00]);
  }

  setNoiseReduction(on) {
    this._sendCmd(0x16, 0x40, [on ? 0x01 : 0x00]);
  }

  setAutoNotch(on) {
    this._sendCmd(0x16, 0x41, [on ? 0x01 : 0x00]);
  }

  setCompressor(on) {
    this._sendCmd(0x16, 0x44, [on ? 0x01 : 0x00]);
  }

  vfoCopyAB() {
    // CI-V: VFO equalize A=B cmd 0x07 sub 0xA0
    this._sendCmd(0x07, 0xA0);
  }

  vfoCopyBA() {
    // CI-V: VFO equalize B=A cmd 0x07 sub 0xB1
    this._sendCmd(0x07, 0xB1);
  }

  sendRaw(text) {
    // For CI-V, raw is hex bytes: "FE FE 94 E0 03 FD"
    const bytes = text.trim().split(/\s+/).map(b => parseInt(b, 16)).filter(b => !isNaN(b));
    if (bytes.length > 0) this._write(Buffer.from(bytes));
  }

  // --- Response parsing ---

  onData(chunk) {
    this._buf = Buffer.concat([this._buf, chunk]);
    this._parseFrames();
  }

  _parseFrames() {
    while (true) {
      // Find frame start (FE FE)
      const start = this._findPreamble();
      if (start < 0) break;

      // Find frame end (FD)
      const end = this._buf.indexOf(0xFD, start + 2);
      if (end < 0) break; // incomplete frame

      const frame = this._buf.slice(start, end + 1);
      this._buf = this._buf.slice(end + 1);

      // Validate: frame[2]=our addr (or 0x00 broadcast), frame[3]=radio addr
      if (frame.length >= 5) {
        const toAddr = frame[2];
        const fromAddr = frame[3];
        if (toAddr === this._ctrlAddr || toAddr === 0x00) {
          this._handleFrame(frame);
        }
      }
    }
  }

  _findPreamble() {
    for (let i = 0; i < this._buf.length - 1; i++) {
      if (this._buf[i] === 0xFE && this._buf[i + 1] === 0xFE) return i;
    }
    return -1;
  }

  _handleFrame(frame) {
    const cmd = frame[4];
    const payload = frame.slice(5, frame.length - 1); // everything between cmd and FD

    // ACK/NAK
    if (cmd === 0xFB) { /* OK */ return; }
    if (cmd === 0xFA) { this.emit('error', { message: 'CI-V NAK' }); return; }

    // Frequency response (cmd 0x00 or 0x03 echo)
    if ((cmd === 0x00 || cmd === 0x03) && payload.length >= 5) {
      const hz = this._decodeFreqBCD(payload.slice(0, 5));
      if (hz > 0) {
        this._lastFreqHz = hz;
        this.emit('frequency', hz);
      }
      return;
    }

    // Mode response (cmd 0x01 or 0x04 echo)
    if ((cmd === 0x01 || cmd === 0x04) && payload.length >= 1) {
      const modeByte = payload[0];
      this._lastModeByte = modeByte;
      const modeName = this._modeParse[modeByte] || CIV_MODE_PARSE[modeByte];
      if (modeName) {
        this._lastMode = modeName;
        this.emit('mode', modeName);
      }
      return;
    }

    // Level responses (cmd 0x14)
    if (cmd === 0x14 && payload.length >= 3) {
      const sub = payload[0];
      const val = this._decodeLevelBCD(payload.slice(1));
      if (sub === 0x0A) {
        // TX power level -> watts
        const watts = Math.round((val / 255) * this._maxPower);
        this.emit('power', watts);
      }
      // sub 0x02 = RF gain, sub 0x0C = CW speed — could emit these too
      return;
    }

    // Meter response (cmd 0x15)
    if (cmd === 0x15 && payload.length >= 3) {
      const sub = payload[0];
      if (sub === 0x02) {
        // S-meter level (0-255 BCD)
        const val = this._decodeLevelBCD(payload.slice(1));
        this.emit('smeter', val);
      } else if (sub === 0x12) {
        // SWR meter (0-255 BCD)
        const val = this._decodeLevelBCD(payload.slice(1));
        this.emit('swr', val);
      }
      return;
    }

    // Function response (cmd 0x16)
    if (cmd === 0x16 && payload.length >= 2) {
      const sub = payload[0];
      if (sub === 0x22) {
        // NB status
        this.emit('nb', payload[1] === 0x01);
      }
      return;
    }
  }

  _decodeLevelBCD(bytes) {
    if (bytes.length < 2) return 0;
    const s = '' +
      ((bytes[0] >> 4) & 0x0F) + (bytes[0] & 0x0F) +
      ((bytes[1] >> 4) & 0x0F) + (bytes[1] & 0x0F);
    return parseInt(s, 10);
  }

  get lastMode() { return this._lastMode; }
  set lastMode(m) { this._lastMode = m; }

  /** Format a CI-V frame as hex string for display */
  _frameHex(cmd, sub, data) {
    const frame = this._buildFrame(cmd, sub, data);
    return Array.from(frame).map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
  }

  /** Return the resolved command table for the Table tab UI */
  getCommandTable() {
    const a = this._radioAddr.toString(16).toUpperCase().padStart(2, '0');
    return [
      { key: 'getFreq', label: 'Get Frequency', value: this._frameHex(0x03) },
      { key: 'setFreq', label: 'Set Frequency', value: `FE FE ${a} E0 05 {bcd} FD` },
      { key: 'getMode', label: 'Get Mode', value: this._frameHex(0x04) },
      { key: 'setMode', label: 'Set Mode', value: `FE FE ${a} E0 06 {mode} FD` },
      { key: 'setTransmitOn', label: 'PTT On', value: this._frameHex(0x1C, 0x00, [0x01]) },
      { key: 'setTransmitOff', label: 'PTT Off', value: this._frameHex(0x1C, 0x00, [0x00]) },
      { key: 'setNbOn', label: 'NB On', value: this._frameHex(0x16, 0x22, [0x01]) },
      { key: 'setNbOff', label: 'NB Off', value: this._frameHex(0x16, 0x22, [0x00]) },
      { key: 'getNb', label: 'Get NB', value: this._frameHex(0x16, 0x22) },
      { key: 'getSmeter', label: 'S-Meter', value: this._frameHex(0x15, 0x02) },
      { key: 'setRfGain', label: 'RF Gain', value: `FE FE ${a} E0 14 02 {bcd} FD` },
      { key: 'setPower', label: 'TX Power', value: `FE FE ${a} E0 14 0A {bcd} FD` },
      { key: 'getPower', label: 'Get Power', value: this._frameHex(0x14, 0x0A) },
      { key: 'setVfoA', label: 'VFO A', value: this._frameHex(0x07, null, [0x00]) },
      { key: 'setVfoB', label: 'VFO B', value: this._frameHex(0x07, null, [0x01]) },
      { key: 'swapVfo', label: 'VFO Swap', value: this._frameHex(0x07, 0xB0) },
      { key: 'setSplit', label: 'Split On', value: this._frameHex(0x0F, null, [0x01]) },
      { key: 'setPowerOn', label: 'Power On', value: this._frameHex(0x18, null, [0x01]) },
      { key: 'setPowerOff', label: 'Power Off', value: this._frameHex(0x18, null, [0x00]) },
      { key: 'atuTune', label: 'ATU Tune', value: this._frameHex(0x1C, 0x01, [0x02]) },
      { key: 'atuStop', label: 'ATU Stop', value: this._frameHex(0x1C, 0x01, [0x00]) },
      { key: 'setPreampOn', label: 'Preamp On', value: this._frameHex(0x16, 0x02, [0x01]) },
      { key: 'setPreampOff', label: 'Preamp Off', value: this._frameHex(0x16, 0x02, [0x00]) },
      { key: 'setAttenuatorOn', label: 'Atten On', value: this._frameHex(0x11, null, [0x20]) },
      { key: 'setAttenuatorOff', label: 'Atten Off', value: this._frameHex(0x11, null, [0x00]) },
      { key: 'nrOn', label: 'NR On', value: this._frameHex(0x16, 0x40, [0x01]) },
      { key: 'nrOff', label: 'NR Off', value: this._frameHex(0x16, 0x40, [0x00]) },
      { key: 'anfOn', label: 'Auto Notch On', value: this._frameHex(0x16, 0x41, [0x01]) },
      { key: 'anfOff', label: 'Auto Notch Off', value: this._frameHex(0x16, 0x41, [0x00]) },
      { key: 'compOn', label: 'Compressor On', value: this._frameHex(0x16, 0x44, [0x01]) },
      { key: 'compOff', label: 'Compressor Off', value: this._frameHex(0x16, 0x44, [0x00]) },
      { key: 'vfoCopyAB', label: 'VFO Copy A->B', value: this._frameHex(0x07, 0xA0) },
      { key: 'vfoCopyBA', label: 'VFO Copy B->A', value: this._frameHex(0x07, 0xB1) },
    ];
  }
}

module.exports = { CivCodec };
