'use strict';
/**
 * Yaesu legacy 5-byte binary CAT — FT-817, FT-817ND, FT-818, FT-857(D), FT-897(D).
 *
 * These radios do not speak the text protocol (`FA…;`, `MD0;`) of the newer
 * Yaesus. Every command is five bytes, four parameters then the opcode, and
 * the radio answers every one: a single status byte for a set (00 = done), the
 * requested data for a read. Replies carry no framing, so a reply is only
 * meaningful against the command that asked for it: commands go out one at a
 * time and the next waits for the answer (or a timeout).
 *
 * Until this codec the FT-817/818 and FT-857 were on the text codec: the radio
 * ignored everything, mode never arrived (PTT/HALT hidden), tunes did nothing
 * and the link was declared down every few minutes (KL4XQ, FT-818, 2026-10-21).
 *
 * Opcodes (FT-817 / FT-857 operating manuals, CAT section; Hamlib ft817.c):
 *   01 set frequency   P1-P4 = 8 BCD digits of the frequency in 10 Hz units
 *   03 read freq+mode  reply: 4 BCD bytes + mode byte
 *   07 set mode        P1 = mode
 *   08 / 88 PTT on / off
 *   02 / 82 split on / off
 *   81 toggle VFO A/B
 *   E7 read RX status  reply: 1 byte, low nibble = S-meter 0-15
 *   F7 read TX status  reply: 1 byte, bit 7 CLEAR = transmitting
 */
const { EventEmitter } = require('events');
const { rawCatBytes } = require('../raw-cat-command');

function ssbSideband(freqHz) {
  if (freqHz >= 5250000 && freqHz < 5450000) return 'USB';
  return freqHz >= 10000000 ? 'USB' : 'LSB';
}

const OP = {
  SET_FREQ: 0x01, SPLIT_ON: 0x02, READ_FREQ_MODE: 0x03, SET_MODE: 0x07,
  PTT_ON: 0x08, VFO_TOGGLE: 0x81, SPLIT_OFF: 0x82, PTT_OFF: 0x88,
  READ_RX: 0xE7, READ_TX: 0xF7,
};

// Radio mode byte -> POTACAT mode name. Bit 7 marks the narrow filter
// (0x82 CW-N, 0x88 FM-N, 0x8A DIG-N), which is the same mode.
const MODE_PARSE = {
  0x00: 'LSB', 0x01: 'USB', 0x02: 'CW', 0x03: 'CW', 0x04: 'AM',
  0x06: 'WFM', 0x08: 'FM', 0x0A: 'DIGU', 0x0C: 'FM',
};

// POTACAT mode -> radio mode byte. Every digital mode goes to DIG, which
// sends and receives on the DATA jack; its sideband is the radio's own
// DIG MODE menu (USER-U for FT8), as with Hamlib and WSJT-X.
const MODES = {
  LSB: 0x00, USB: 0x01, CW: 0x02, 'CW-R': 0x03, CWR: 0x03, AM: 0x04, FM: 0x08,
  DIGU: 0x0A, DIGL: 0x0A, PKTUSB: 0x0A, PKTLSB: 0x0A, DATA: 0x0A, RTTY: 0x0A,
  PSK: 0x0A, PSK31: 0x0A, FT8: 0x0A, FT4: 0x0A, FT2: 0x0A, JS8: 0x0A,
  JTTY: 0x0A, WSPR: 0x0A, SSTV: 0x0A, PKTFM: 0x0C,
};

// Bytes each opcode's reply carries (a set answers one status byte).
const REPLY_LEN = { [OP.READ_FREQ_MODE]: 5 };

const REPLY_TIMEOUT_MS = 500;
const QUIET_MS = 80; // after a timeout, bytes still arriving are the late reply — drop them
const MAX_QUEUE = 24;

/** 8 BCD digits of hz in 10 Hz units, most significant first. */
function encodeFreq(hz) {
  const s = String(Math.max(0, Math.round(hz / 10))).padStart(8, '0').slice(-8);
  const out = [];
  for (let i = 0; i < 8; i += 2) out.push((Number(s[i]) << 4) | Number(s[i + 1]));
  return out;
}

/** Hz from 4 BCD bytes, or null when a nibble is not a digit (a baud mismatch). */
function decodeFreq(bytes) {
  let tens = 0;
  for (let i = 0; i < 4; i++) {
    const hi = bytes[i] >> 4, lo = bytes[i] & 0x0F;
    if (hi > 9 || lo > 9) return null;
    tens = tens * 100 + hi * 10 + lo;
  }
  return tens * 10;
}

/** The radio's 0-15 S-meter on the wire scale (S9 = 120, S9+60 = 255). */
function smeterToWire(n) {
  const s = n & 0x0F;
  if (s <= 9) return Math.round(s * 120 / 9);     // S0..S9 -> 0..120
  return Math.min(255, Math.round(120 + (s - 9) * 10 * 135 / 60)); // +10..+60 dB -> ..255
}

// Setters the controller calls without checking first. The radio has no CAT
// command for these; each says so once instead of throwing.
const UNSUPPORTED_SETTERS = [
  'setFilterWidth', 'setNb', 'setRfGain', 'setTxPower', 'setPowerState', 'startTune', 'stopTune',
  'setCwSpeed', 'sendCwText', 'setNbLevel', 'setAfGain', 'setNoiseReduction', 'setAutoNotch',
  'setAgc', 'setNrLevel', 'setVoxLevel', 'setMonitor', 'setMonLevel', 'setRit', 'vfoCopyAB',
  'vfoCopyBA', 'setAtuEnabled', 'setSquelch', 'setCompressor', 'setVox', 'setMicGain',
  'setCompLevel', 'setDnrLevel', 'setClarRx', 'setClarTx', 'setClarOffset', 'setBreakIn',
  'setBreakInDelay', 'setPreampTarget', 'setAntennaPort', 'setPreamp', 'setAttenuator',
];

class YaesuLegacyCodec extends EventEmitter {
  constructor(model, writeFn) {
    super();
    this._model = model || {};
    this._write = writeFn;
    this._queue = [];
    this._inflight = null;
    this._timer = null;
    this._buf = Buffer.alloc(0);
    this._quietUntil = 0;
    this._lastMode = null;
    this._said = new Set();
  }

  _sayOnce(key, msg) {
    if (this._said.has(key)) return;
    this._said.add(key);
    this.emit('log', msg);
  }

  // --- Command queue (one in flight; replies have no framing) ---

  _enqueue(op, params, { coalesce, first } = {}) {
    const p = (params || [0, 0, 0, 0]).slice(0, 4);
    while (p.length < 4) p.push(0);
    const cmd = { op, bytes: Buffer.from([...p, op]), expect: REPLY_LEN[op] || 1, coalesce };
    if (coalesce) {
      // A poll already waiting needs no twin; a newer set replaces an older
      // one still waiting (the latest frequency is the one that matters).
      if (this._inflight && this._inflight.coalesce === coalesce && coalesce.startsWith('read')) return;
      const i = this._queue.findIndex((c) => c.coalesce === coalesce);
      if (i >= 0) {
        if (coalesce.startsWith('read')) return;
        this._queue.splice(i, 1);
      }
    }
    if (this._queue.length >= MAX_QUEUE) this._queue.shift(); // a silent radio must not grow this forever
    if (first) this._queue.unshift(cmd); else this._queue.push(cmd);
    this._pump();
  }

  _pump() {
    if (this._inflight || !this._queue.length) return;
    const wait = this._quietUntil - Date.now();
    if (wait > 0) {
      if (!this._pumpTimer) {
        this._pumpTimer = setTimeout(() => { this._pumpTimer = null; this._pump(); }, wait);
        if (this._pumpTimer.unref) this._pumpTimer.unref();
      }
      return;
    }
    const cmd = this._queue.shift();
    this._inflight = cmd;
    this._buf = Buffer.alloc(0);
    this._write(cmd.bytes);
    this._timer = setTimeout(() => this._onTimeout(), REPLY_TIMEOUT_MS);
    if (this._timer.unref) this._timer.unref();
  }

  _onTimeout() {
    const cmd = this._inflight;
    this._inflight = null;
    this._timer = null;
    this._buf = Buffer.alloc(0);
    this._quietUntil = Date.now() + QUIET_MS;
    if (cmd && cmd.op === OP.READ_FREQ_MODE) {
      this._sayOnce('noreply', 'FT-817/818/857: no reply to the frequency read. Check the radio menu CAT RATE matches the baud rate in Settings > My Rigs, and that nothing else has this port open.');
    }
    this._pump();
  }

  onData(chunk) {
    if (Date.now() < this._quietUntil || !this._inflight) return; // a late or unasked reply
    this._buf = Buffer.concat([this._buf, chunk]);
    const cmd = this._inflight;
    if (this._buf.length < cmd.expect) return;
    const reply = this._buf.subarray(0, cmd.expect);
    clearTimeout(this._timer);
    this._timer = null;
    this._inflight = null;
    this._buf = Buffer.alloc(0);
    this._handleReply(cmd, reply);
    this._pump();
  }

  _handleReply(cmd, reply) {
    switch (cmd.op) {
      case OP.READ_FREQ_MODE: {
        const hz = decodeFreq(reply);
        if (hz == null) {
          this._sayOnce('badfreq', `FT-817/818/857 frequency reply did not decode (${Array.from(reply).map((b) => b.toString(16).padStart(2, '0')).join(' ')}) — almost always a CAT RATE mismatch between the radio menu and Settings > My Rigs.`);
          return;
        }
        this.emit('frequency', hz);
        const name = MODE_PARSE[reply[4] & 0x7F];
        if (name) {
          this._lastMode = name;
          this.emit('mode', name);
        } else {
          this._sayOnce('mode' + reply[4], `unrecognized FT-817/818/857 mode byte 0x${reply[4].toString(16).padStart(2, '0')}`);
        }
        return;
      }
      case OP.READ_TX:
        // Bit 7 clear = keyed. The radio answers FF on receive.
        this.emit('ptt', (reply[0] & 0x80) === 0);
        return;
      case OP.READ_RX:
        this.emit('smeter', smeterToWire(reply[0]));
        return;
      default:
        // Status byte for a set: 00 = done. PTT answers F0 when it was already
        // in that state, which is not a failure.
        if (reply[0] !== 0x00 && !(cmd.op === OP.PTT_ON || cmd.op === OP.PTT_OFF)) {
          this._sayOnce('rej' + cmd.op, `FT-817/818/857 refused command 0x${cmd.op.toString(16).padStart(2, '0')} (status 0x${reply[0].toString(16).padStart(2, '0')})`);
        }
    }
  }

  // --- Commands the controller uses ---

  setFrequency(hz) {
    this.emit('log', `setFrequency ${hz} Hz`);
    this._enqueue(OP.SET_FREQ, encodeFreq(hz), { coalesce: 'set-freq' });
  }

  getFrequency() { this._enqueue(OP.READ_FREQ_MODE, null, { coalesce: 'read-fm' }); }

  // The frequency read carries the mode too.
  getMode() { this._enqueue(OP.READ_FREQ_MODE, null, { coalesce: 'read-fm' }); }

  getPtt() { this._enqueue(OP.READ_TX, null, { coalesce: 'read-tx' }); }

  getSmeter() { this._enqueue(OP.READ_RX, null, { coalesce: 'read-rx' }); }

  resolveMode(modeName, freqHz) {
    let m = String(modeName || '').toUpperCase();
    if (m === 'SSB') m = ssbSideband(freqHz);
    const b = MODES[m];
    return b == null ? null : { mode817: b };
  }

  modeNameForMapping(mapping) {
    return mapping ? (MODE_PARSE[mapping.mode817] || null) : null;
  }

  setMode(modeName, freqHz) {
    const r = this.resolveMode(modeName, freqHz);
    if (!r) return null;
    this._enqueue(OP.SET_MODE, [r.mode817, 0, 0, 0], { coalesce: 'set-mode' });
    return r;
  }

  setTransmit(on) {
    // Next on the wire, ahead of queued polls (FT8 keys on a deadline), and
    // never coalesced: a key-up must follow its key-down.
    const lastPtt = [...this._queue].reverse().findIndex((c) => c.op === OP.PTT_ON || c.op === OP.PTT_OFF);
    this._enqueue(on ? OP.PTT_ON : OP.PTT_OFF, null, { first: lastPtt < 0 });
  }

  setSplit(on) { this._enqueue(on ? OP.SPLIT_ON : OP.SPLIT_OFF); }

  swapVfo() { this._enqueue(OP.VFO_TOGGLE); }

  setVfo(vfo) {
    // The radio can only toggle A/B and does not report which is active.
    this._sayOnce('vfo', `VFO ${vfo}: the FT-817/818/857 can only toggle between A and B (use A/B swap)`);
  }

  getAtuStartSequence() { return null; }
  getAtuStopCmd() { return null; }

  /** Custom CAT buttons: hex bytes, e.g. "00 00 00 00 81". */
  sendRaw(text) {
    const bytes = rawCatBytes(text);
    if (!bytes || bytes.length !== 5) {
      this._sayOnce('raw', 'FT-817/818/857 custom commands are 5 hex bytes, opcode last (e.g. "00 00 00 00 81" toggles VFO A/B)');
      return;
    }
    this._enqueue(bytes[4], bytes.slice(0, 4));
  }

  getCommandTable() {
    return [
      { key: 'getFreq', label: 'Get Frequency + Mode', value: '00 00 00 00 03' },
      { key: 'setFreq', label: 'Set Frequency', value: '{bcd 10 Hz} 01' },
      { key: 'setMode', label: 'Set Mode', value: '{mode} 00 00 00 07' },
      { key: 'setTransmitOn', label: 'PTT On', value: '00 00 00 00 08' },
      { key: 'setTransmitOff', label: 'PTT Off', value: '00 00 00 00 88' },
      { key: 'swapVfo', label: 'VFO A/B', value: '00 00 00 00 81' },
      { key: 'setSplit', label: 'Split On', value: '00 00 00 00 02' },
      { key: 'setSplitOff', label: 'Split Off', value: '00 00 00 00 82' },
      { key: 'getSmeter', label: 'RX Status (S-meter)', value: '00 00 00 00 E7' },
      { key: 'getPtt', label: 'TX Status', value: '00 00 00 00 F7' },
    ];
  }
}

for (const name of UNSUPPORTED_SETTERS) {
  YaesuLegacyCodec.prototype[name] = function () {
    this._sayOnce('unsup-' + name, `${name}: the FT-817/818/857 has no CAT command for this`);
  };
}

module.exports = { YaesuLegacyCodec, encodeFreq, decodeFreq, smeterToWire, MODES, MODE_PARSE, OP };
