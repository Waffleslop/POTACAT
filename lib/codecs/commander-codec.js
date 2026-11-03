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
 * ADIF lengths count BYTES. Replies are decoded as latin1 (one byte, one
 * character), so a multi-byte character, whole or split across two TCP reads,
 * can never shift the framing. Outgoing text is held to printable ASCII for the
 * same reason: a sequence name or CW text that is not is refused with a log
 * line instead of being sent with a length Commander would read differently.
 *
 * What Commander's TCP interface does NOT have: NB, NR, ANF, COMP, ATU, power,
 * gain, filter width, preamp/ATT, A/B VFO, meters. Those methods either run a
 * user-defined Commander sequence the operator mapped to the control
 * (lib/commander-sequences.js) or log once and send nothing, so a button never
 * claims to have worked when nothing reached the radio. The capabilities the
 * model advertises already hide the controls Commander cannot do.
 */
const net = require('net');
const { EventEmitter } = require('events');
const { ssbSideband } = require('../rig-utils');
const { sequenceRef, isAscii, capsFromSequences, cleanSequences } = require('../commander-sequences');
const { GENERIC_CAPS } = require('../rig-models');

// A Commander reply is a frequency, a mode, ON/OFF: a field can never be long.
// A larger declared length is garbage (or a different server on the port), and
// waiting for it would stall every reply after it.
const MAX_FIELD_LEN = 1024;
// The most unparsed input kept between reads. Past this the input cannot be
// Commander's, and the buffer must not grow without limit.
const MAX_BUFFER = 16 * 1024;

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

/**
 * Read every complete ADIF field at the front of `buf`, calling onField(name,
 * value) for each. Text before a '<' is skipped. A field that declares more
 * than MAX_FIELD_LEN is not a field: its '<' is dropped and reading resumes at
 * the next one. Returns what is left (an incomplete field still arriving) and
 * whether anything had to be thrown away.
 *
 * Shared by the reply parser and by sendRaw's check of a hand-typed message.
 * `rest` is bounded: an incomplete field is at most MAX_FIELD_LEN plus its
 * header, so the caller's buffer cannot grow on garbage.
 * @returns {{ rest: string, skipped: boolean, oversized: boolean }}
 */
function readFields(buf, onField) {
  let skipped = false, oversized = false;
  for (;;) {
    const lt = buf.indexOf('<');
    if (lt === -1) return { rest: '', skipped: skipped || buf.length > 0, oversized };
    if (lt > 0) { buf = buf.slice(lt); skipped = true; }
    const head = buf.match(/^<([^:<>]+):(\d+)(?::[^<>]*)?>/);
    if (!head) {
      // '<' and no complete header yet: wait, unless it cannot become one.
      if (buf.length < 64 && /^<[^<>]*$/.test(buf)) return { rest: buf, skipped, oversized };
      buf = buf.slice(1);
      skipped = true;
      continue;
    }
    const len = parseInt(head[2], 10);
    if (!(len <= MAX_FIELD_LEN)) { buf = buf.slice(1); skipped = true; oversized = true; continue; }
    const end = head[0].length + len;
    if (buf.length < end) return { rest: buf, skipped, oversized }; // the value is still arriving
    const value = buf.slice(head[0].length, end);
    buf = buf.slice(end);
    onField(head[1], value);
  }
}

/**
 * Check a hand-typed Commander message: exactly a command field and a
 * parameters field, every length right, nothing left over. Returns null when it
 * is good, or what is wrong plus the message correctly framed when that can be
 * worked out (a miscounted length is the usual mistake).
 * @returns {null | { problem: string, corrected?: string }}
 */
function checkMessage(text) {
  if (!isAscii(text)) return { problem: 'it contains characters that are not plain ASCII' };
  const fields = [];
  const r = readFields(text, (name, value) => fields.push([name.toLowerCase(), value]));
  let problem = null;
  if (r.rest) problem = 'a length runs past the end of the message';
  else if (r.skipped || fields.length !== 2 || fields[0][0] !== 'command' || fields[1][0] !== 'parameters') {
    problem = 'a length does not match its text';
  } else if (!/^cwchars$/i.test(fields[0][1]) && fields[1][1]) {
    // The parameters are fields themselves, except cwchars's bare text.
    const inner = readFields(fields[1][1], () => {});
    if (inner.rest || inner.skipped) problem = 'a parameter length does not match its text';
  }
  if (!problem) return null;
  const m = text.match(/^<command:\d+>([^<]*)<parameters:\d+>([\s\S]*)$/i);
  const corrected = m ? commanderMessage(m[1], m[2]) : null;
  return corrected && corrected !== text ? { problem, corrected } : { problem };
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

// What a picked Radio Model may lend a Commander rig: fields that describe the
// RADIO (its bands, for per-rig bands and rig presets; its power range, for the
// sliders and presets). Nothing about how POTACAT would talk to that radio
// directly (poll interval, connect delay, CAT commands, setup notes), and not
// its brand: main.js takes Icom-only paths on brand === 'Icom', and none of
// them apply through Commander.
const RADIO_FIELDS = ['bands', 'maxPower', 'minPower', 'powerStep', 'powerDecimals', 'powerChoices'];

/**
 * The model a Commander rig runs with. A real radio sits behind Commander, so
 * a picked Radio Model lends RADIO_FIELDS; what POTACAT can do through
 * Commander is Commander's, whatever the radio: the base caps plus the controls
 * the operator mapped to sequences. The same split as flrigModel()
 * (lib/codecs/flrig-codec.js), with the borrowed fields listed explicitly.
 *
 * @param {object|null} picked - the rig's Radio Model entry, if any
 * @param {{ sequences?: object, decimal?: string }} [opts] - from catTarget
 */
function commanderModel(picked, opts) {
  const base = GENERIC_CAPS.commander;
  const sequences = cleanSequences(opts && opts.sequences);
  const model = {
    ...base,
    caps: { ...base.caps, ...capsFromSequences(sequences) },
    cw: { ...base.cw },
    tune: { ...base.tune },
    commander: { decimal: opts && opts.decimal === ',' ? ',' : '.', sequences },
  };
  for (const k of RADIO_FIELDS) {
    const v = picked && picked[k];
    if (v != null) model[k] = Array.isArray(v) ? v.slice() : v;
  }
  return model;
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
    this._warned = new Set();
  }

  _write(command, params) {
    return this._writeFn(commanderMessage(command, params));
  }

  /** Log a line once per key (the same mistake repeated says nothing new). */
  _once(key, msg) {
    if (this._warned.has(key)) return;
    this._warned.add(key);
    this.emit('log', msg);
  }

  /** Say once that a control reached nothing, and return false (the controller's refusal signal). */
  _unsupported(label) {
    this._once(label, `${label} is not available over DXLab Commander's TCP interface; nothing was sent. ` +
      'Map a Commander command sequence to it in the rig settings to enable it.');
    return false;
  }

  /** Run the Commander sequence mapped to `key`, or report that none is. */
  _sequence(key, label) {
    const typed = this._sequences[key];
    const ref = sequenceRef(typed);
    if (!ref) {
      if (typed && !isAscii(typed)) {
        this._once('ascii:' + key, `Commander sequence name for ${label} is not plain ASCII and was not sent: ${JSON.stringify(typed)}`);
        return false;
      }
      return this._unsupported(label);
    }
    this.emit('log', `Commander sequence for ${key}: ${ref.command} ${ref.value}`);
    this._write(ref.command, [['1', ref.value]]);
    return true;
  }

  /**
   * At connect (RigController calls it on every transport connect, before the
   * safety PTT-off). A field half-received when the last socket dropped must not
   * swallow the first reply of this one, and split state is re-read.
   */
  probeCaps() {
    this._buf = '';
    this._split = false;
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

  setSplit(on) {
    this._write('CmdSplit', [['1', on ? 'on' : 'off']]);
  }

  getVfoSplit() {
    this._write('CmdSendSplit', []);
    if (this._split) this._write('CmdGetTXFreq', []);
  }

  /**
   * The split TX frequency, without moving the dial (RigController
   * setFrequencyOther). CmdSetTXFreq sets the OTHER VFO only while split is on;
   * with split off, Commander's reference says it sets the current VFO, which
   * is the receive frequency. So it is sent only once Commander has reported
   * split on.
   */
  setFrequencyOther(hz) {
    if (!this._split) {
      this._once('txfreq-nosplit', 'DXLab Commander: split is off, and CmdSetTXFreq would then move the receive frequency, so the TX frequency was not sent. Turn split on first.');
      return false;
    }
    this._write('CmdSetTXFreq', [['xcvrfreq', khzText(hz, this._decimal)]]);
    return true;
  }

  // --- CW ---

  sendCwText(text) {
    const clean = String(text || '').replace(/[\r\n]/g, ' ').trim();
    if (!clean) return;
    if (!isAscii(clean)) {
      this._once('ascii:cw', 'CW text for DXLab Commander must be plain ASCII; this text was not sent: ' + JSON.stringify(clean));
      return;
    }
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
   * It is read with the same field parser as the replies first, so a
   * miscounted length is caught here (with the right framing in the log)
   * instead of leaving Commander waiting for bytes that never come.
   */
  sendRaw(text) {
    const cmd = String(text || '').replace(/[\r\n]/g, '').trim();
    if (!cmd) return;
    if (cmd[0] !== '<') {
      this.emit('log', 'DXLab Commander custom commands are ADIF messages that start with "<command:", ' +
        `for example <command:10>CmdSetFreq<parameters:17><xcvrfreq:5>21230. Not sent: ${cmd}`);
      return;
    }
    const bad = checkMessage(cmd);
    if (bad) {
      this.emit('log', `DXLab Commander custom command not sent, ${bad.problem}: ${cmd}` +
        (bad.corrected ? `. Correctly framed it would be: ${bad.corrected}` : ''));
      return;
    }
    this._writeFn(cmd);
  }

  // --- Reply parsing ---

  onData(chunk) {
    this._buf += Buffer.isBuffer(chunk) ? chunk.toString('latin1') : String(chunk);
    if (this._buf.length > MAX_BUFFER) {
      // One read bigger than any run of Commander replies: something other than
      // Commander is on the port. Keep only the tail, from its first '<'.
      const tail = this._buf.slice(-MAX_BUFFER);
      const lt = tail.indexOf('<');
      this._buf = lt === -1 ? '' : tail.slice(lt);
      this._once('overflow', `DXLab Commander: discarded input that was not Commander replies. Is this port Commander's Base Port + 2?`);
    }
    const { rest, oversized } = readFields(this._buf, (name, value) => this._onField(name, value));
    this._buf = rest;
    if (oversized) this._once('oversize', `DXLab Commander: a reply declared a length over ${MAX_FIELD_LEN} bytes, which no Commander field has; skipped it.`);
  }

  _onField(name, value) {
    this.emit('field', name, value);
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

/**
 * Rig editor "Test Connection": open a socket to Commander, ask for the
 * frequency and mode, and say which of the three cases it is. The live link is
 * not touched (Commander, like flrig, takes more than one TCP client).
 *
 * @returns {Promise<{ok:boolean, freqHz?:number, mode?:string, noRadio?:boolean, error?:string}>}
 */
function probeCommander({ host = '127.0.0.1', port = 52002, timeoutMs = 2500 } = {}) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    const out = { ok: false };
    let freqSeen = false, modeSeen = false, done = false;
    const codec = new CommanderCodec({ commander: {} }, (d) => sock.write(d, 'latin1'));
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(r);
    };
    codec.on('field', (name, value) => {
      const n = name.toLowerCase();
      if (n === 'cmdfreq') { freqSeen = true; out.freqHz = hzFromReply(value); }
      if (n === 'cmdmode') { modeSeen = true; out.mode = COMMANDER_TO_TOKEN[String(value).trim().toUpperCase()] || String(value).trim(); }
      if (freqSeen && modeSeen) finish({ ...out, ok: true, noRadio: !out.freqHz });
    });
    const timer = setTimeout(() => finish(freqSeen
      ? { ...out, ok: true, noRadio: !out.freqHz }
      : { ok: false, error: `something is listening on ${host}:${port} but did not answer like DXLab Commander. Is that Commander's Base Port + 2, rather than the Base Port itself?` }),
    timeoutMs);
    if (timer.unref) timer.unref();
    sock.on('data', (d) => codec.onData(d));
    sock.on('error', (e) => finish({ ok: false, error: describeCommanderError(e, host, port) }));
    sock.on('close', () => finish(freqSeen ? { ...out, ok: true, noRadio: !out.freqHz }
      : { ok: false, error: `${host}:${port} closed the connection without answering. Is that DXLab Commander's port (its Base Port + 2)?` }));
    sock.connect(port, host, () => { codec.getFrequency(); codec.getMode(); });
  });
}

function describeCommanderError(e, host, port) {
  const code = e && e.code;
  if (code === 'ECONNREFUSED') return `nothing is listening on ${host}:${port}. Check that DXLab Commander is running and that the port is Commander's Base Port + 2 (Net Serv window; 52000 + 2 = 52002 by default).`;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `host ${host} was not found`;
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return `${host} is unreachable from this computer`;
  if (code === 'ETIMEDOUT') return `no answer from ${host}:${port} (a firewall, or Commander is not on that computer)`;
  return (e && e.message) || String(e);
}

module.exports = {
  CommanderCodec, commanderModel, probeCommander, describeCommanderError,
  commanderMessage, adifField, readFields, checkMessage, khzText, hzFromReply,
  MODE_TOKENS, MAX_FIELD_LEN, MAX_BUFFER,
};
