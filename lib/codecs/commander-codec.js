// SPDX-License-Identifier: Apache-2.0
'use strict';
/**
 * CommanderCodec: DXLab Commander's TCP command interface.
 *
 * Source: "Commander TCPIP Messages" (dxlabsuite.com/commander), which lists
 * every command Commander accepts over TCP. Commander listens on its Base Port
 * + 2, so 52002 by default. Messages are ADIF fields, a command field and a
 * parameters field whose length covers every parameter field after it:
 *
 *   <command:10>CmdSetFreq<parameters:17><xcvrfreq:5>21230
 *
 * Frequencies are kHz. A reply is a single ADIF field that names itself
 * (`<CmdFreq:10>14,010.500`), and there is no terminator, so the parser reads
 * by the declared length. No reply carries a request id, but each names what it
 * answers, so no pending queue is needed.
 *
 * What Commander's TCP interface does NOT have: NB, NR, ANF, COMP, ATU, power,
 * gain, filter width, preamp/ATT, A/B VFO, meters. Those methods either run a
 * user-defined Commander sequence the operator mapped to the control
 * (lib/commander-sequences.js) or log once and send nothing, so a button never
 * claims to have worked when nothing reached the radio. The capabilities the
 * model advertises already hide the controls Commander cannot do.
 */
const { EventEmitter } = require('events');
const { ssbSideband } = require('../rig-utils');
const { sequenceRef } = require('../commander-sequences');

// POTACAT mode name -> the mode token this codec reports (hamlib style, like
// the rigctld codec, so every mode consumer in main/renderer already knows them).
const MODE_TOKENS = {
  'CW': 'CW', 'CWR': 'CWR', 'USB': 'USB', 'LSB': 'LSB', 'FM': 'FM', 'AM': 'AM',
  'DIGU': 'PKTUSB', 'DIGL': 'PKTLSB', 'PKTUSB': 'PKTUSB', 'PKTLSB': 'PKTLSB',
  'FT8': 'PKTUSB', 'FT4': 'PKTUSB', 'FT2': 'PKTUSB',
  'RTTY': 'RTTY', 'RTTYR': 'RTTYR',
};

// Commander's valid modes (the PDF's list) <-> those tokens.
const TOKEN_TO_COMMANDER = {
  'CW': 'CW', 'CWR': 'CW-R', 'USB': 'USB', 'LSB': 'LSB', 'FM': 'FM', 'AM': 'AM',
  'PKTUSB': 'DATA-U', 'PKTLSB': 'DATA-L', 'RTTY': 'RTTY', 'RTTYR': 'RTTY-R',
};
const COMMANDER_TO_TOKEN = {
  'CW': 'CW', 'CW-R': 'CWR', 'USB': 'USB', 'LSB': 'LSB', 'FM': 'FM', 'AM': 'AM',
  'DATA-U': 'PKTUSB', 'DATA-L': 'PKTLSB', 'RTTY': 'RTTY', 'RTTY-R': 'RTTYR',
  'WBFM': 'WFM',
};

/** One ADIF field: <name:length>value */
function adifField(name, value) {
  const v = String(value);
  return `<${name}:${v.length}>${v}`;
}

/**
 * A complete Commander message. `params` is a list of [name, value] pairs, or a
 * raw string for the one command (cwchars) whose parameter is bare text.
 */
function commanderMessage(command, params) {
  let body = '';
  if (typeof params === 'string') body = params;
  else if (Array.isArray(params)) body = params.map(([n, v]) => adifField(n, v)).join('');
  return adifField('command', command) + adifField('parameters', body);
}

/** Commander wants kHz in the machine's decimal style; whole kHz needs none. */
function khzText(hz, decimal) {
  const h = Math.round(Number(hz));
  if (h % 1000 === 0) return String(h / 1000);
  return (h / 1000).toFixed(3).replace(/0+$/, '').replace('.', decimal === ',' ? ',' : '.');
}

/** "14,010.500" (kHz, comma thousands, period decimal) -> Hz. 0 = not reported. */
function hzFromReply(text) {
  const khz = parseFloat(String(text).replace(/,/g, ''));
  return Number.isFinite(khz) && khz > 0 ? Math.round(khz * 1000) : 0;
}

class CommanderCodec extends EventEmitter {
  /**
   * @param {object} model - rig model entry; `model.commander` carries the
   *   per-rig settings { decimal, sequences }
   * @param {function} writeFn - writes a string to the transport
   */
  constructor(model, writeFn) {
    super();
    this._model = model;
    this._writeFn = writeFn;
    const opts = model.commander || {};
    this._decimal = opts.decimal === ',' ? ',' : '.';
    this._sequences = opts.sequences || {};
    this._buf = '';
    this._lastMode = null;
    this._split = false;
    this._txHint = false;
    this._warned = new Set();
  }

  _write(command, params) {
    return this._writeFn(commanderMessage(command, params));
  }

  /** Say once that a control reached nothing, and return false (the controller's refusal signal). */
  _unsupported(label) {
    if (!this._warned.has(label)) {
      this._warned.add(label);
      this.emit('log', `${label} is not available over DXLab Commander's TCP interface; nothing was sent. ` +
        'Map a Commander command sequence to it in the rig settings to enable it.');
    }
    return false;
  }

  /** Run the Commander sequence mapped to `key`, or report that none is. */
  _sequence(key, label) {
    const ref = sequenceRef(this._sequences[key]);
    if (!ref) return this._unsupported(label);
    this.emit('log', `Commander sequence for ${key}: ${ref.command} ${ref.value}`);
    this._write(ref.command, [['1', ref.value]]);
    return true;
  }

  // --- Frequency / mode ---

  setFrequency(hz) {
    this._write('CmdSetFreq', [['xcvrfreq', khzText(hz, this._decimal)]]);
  }

  getFrequency() {
    this._write('CmdGetFreq', []);
  }

  resolveMode(modeName, freqHz) {
    let m = String(modeName || '').toUpperCase();
    if (m === 'SSB') m = ssbSideband(freqHz);
    return MODE_TOKENS[m] || null;
  }

  /** The token a mode is reported as, so the controller can tell a mode CHANGE from a resend. */
  modeNameForMapping(token) {
    return token;
  }

  setMode(modeName, freqHz) {
    let token = this.resolveMode(modeName, freqHz);
    // Keep the operator's reversed sideband: a CW spot must not yank a rig
    // sitting in CW-R back to CW (the same rule the rigctld codec follows).
    if (token === 'CW' && this._lastMode === 'CWR') token = 'CWR';
    else if (token === 'RTTY' && this._lastMode === 'RTTYR') token = 'RTTYR';
    const mode = TOKEN_TO_COMMANDER[token];
    if (!mode) return null;
    this._write('CmdSetMode', [['1', mode]]);
    this._lastMode = token;
    return token;
  }

  getMode() {
    this._write('CmdSendMode', []);
  }

  // --- PTT / split ---

  setTransmit(on) {
    this._write(on ? 'CmdTX' : 'CmdRX', []);
  }

  /** Not every transceiver answers CmdSendTX; an unanswered poll is harmless. */
  getPtt() {
    this._write('CmdSendTX', []);
  }

  setTxHint(on) {
    this._txHint = !!on;
  }

  setSplit(on) {
    this._write('CmdSplit', [['1', on ? 'on' : 'off']]);
  }

  getVfoSplit() {
    this._write('CmdSendSplit', []);
    if (this._split) this._write('CmdGetTXFreq', []);
  }

  // --- CW ---

  sendCwText(text) {
    const clean = String(text || '').replace(/[\r\n]/g, ' ').trim();
    if (!clean) return;
    this.emit('log', `CW write: ${JSON.stringify(clean)}`);
    // cwchars is the one command whose parameter is bare text, not an ADIF field.
    this._write('cwchars', clean);
  }

  // Commander has no keyer-speed command: the speed is Commander's own setting.
  setCwSpeed() {
    return this._unsupported('CW speed');
  }

  // --- Controls Commander reaches only through a user-defined sequence ---

  setNb(on) { return this._sequence(on ? 'nb-on' : 'nb-off', 'Noise blanker'); }
  setNoiseReduction(on) { return this._sequence(on ? 'nr-on' : 'nr-off', 'Noise reduction'); }
  setAutoNotch(on) { return this._sequence(on ? 'anf-on' : 'anf-off', 'Auto-notch'); }
  setCompressor(on) { return this._sequence(on ? 'comp-on' : 'comp-off', 'Compressor'); }
  setPowerState(on) { return this._sequence(on ? 'power-on' : 'power-off', 'Radio power'); }
  startTune() { return this._sequence('atu-tune', 'ATU tune'); }

  // null = the controller calls startTune()/stopTune() itself instead of writing a canned command.
  getAtuStartSequence() { return null; }
  getAtuStopCmd() { return null; }
  stopTune() { return this._unsupported('ATU stop'); }
  // false = "no enable command", so the controller falls back to startTune/stopTune.
  setAtuEnabled() { return false; }

  // --- Controls with nothing to send. The controller calls these unguarded. ---

  setRfGain() { return this._unsupported('RF gain'); }
  setTxPower() { return this._unsupported('TX power'); }
  setFilterWidth() { return this._unsupported('Filter width'); }
  setVfo() { return this._unsupported('VFO select'); }
  swapVfo() { return this._unsupported('VFO swap'); }
  vfoCopyAB() { return this._unsupported('VFO copy'); }
  vfoCopyBA() { return this._unsupported('VFO copy'); }

  /**
   * Custom CAT button: a Commander message sent as typed, e.g.
   * <command:10>CmdSetFreq<parameters:17><xcvrfreq:5>21230
   */
  sendRaw(text) {
    const cmd = String(text || '').replace(/[\r\n]/g, '').trim();
    if (!cmd) return;
    if (cmd[0] !== '<') {
      this.emit('log', 'DXLab Commander custom commands are ADIF messages that start with "<command:", ' +
        `for example <command:10>CmdSetFreq<parameters:17><xcvrfreq:5>21230. Not sent: ${cmd}`);
      return;
    }
    this._writeFn(cmd);
  }

  // --- Reply parsing ---

  onData(chunk) {
    this._buf += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    for (;;) {
      const lt = this._buf.indexOf('<');
      if (lt === -1) { this._buf = ''; return; }
      if (lt > 0) this._buf = this._buf.slice(lt);
      const head = this._buf.match(/^<([^:<>]+):(\d+)(?::[^<>]*)?>/);
      if (!head) {
        // '<' with no complete header yet: wait, unless it cannot become one.
        if (this._buf.length < 64 && /^<[^<>]*$/.test(this._buf)) return;
        this._buf = this._buf.slice(1);
        continue;
      }
      const len = parseInt(head[2], 10);
      const end = head[0].length + len;
      if (this._buf.length < end) return; // the value is still arriving
      const value = this._buf.slice(head[0].length, end);
      this._buf = this._buf.slice(end);
      this._onField(head[1], value);
    }
  }

  _onField(name, value) {
    switch (name.toLowerCase()) {
      case 'cmdfreq': {
        const hz = hzFromReply(value);
        if (hz) this.emit('frequency', hz);
        break;
      }
      case 'cmdtxfreq': {
        const hz = hzFromReply(value);
        if (hz && this._split) this.emit('frequencyOther', hz);
        break;
      }
      case 'cmdmode': {
        const token = COMMANDER_TO_TOKEN[String(value).trim().toUpperCase()];
        if (token) {
          this._lastMode = token;
          this.emit('mode', token);
        }
        break;
      }
      case 'cmdsplit': {
        this._split = /^on$/i.test(String(value).trim());
        this.emit('split', this._split);
        break;
      }
      case 'cmdtx':
        this.emit('ptt', /^on$/i.test(String(value).trim()));
        break;
      default:
        break;
    }
  }
}

module.exports = { CommanderCodec, commanderMessage, adifField, khzText, hzFromReply, MODE_TOKENS };
