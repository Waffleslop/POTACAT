// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// An Icom's OWN spectrum scope, read over the CI-V link POTACAT already drives
// the radio with (USB serial, CI-V over TCP, or Icom Network). Plan:
// docs/icom-band-scope-plan.md. Pure: the codec hands this module the bytes,
// main.js owns the state.
//
// From Icom's CI-V references (IC-705 CI-V Reference Guide 2020-07; IC-7300
// Information v1.40) and Hamlib's field-tested parser (rigs/icom/icom.c
// icom_parse_spectrum_frame); NOT yet checked against a capture from a real
// radio. That is what recordCapture/captureLine are for.
//
// Command 27 (scope):
//   27 00  waveform data, SENT BY THE RADIO while 27 10 and 27 11 are both ON
//   27 10  scope on/off              [00|01]          (no scope id)
//   27 11  wave data output on/off   [00|01]          (no scope id)
//   27 14  mode                      [id, 00 Center | 01 Fixed | 02 Scroll-C | 03 Scroll-F]
//   27 15  span (Center mode)        [id, 5-byte BCD of HALF the span: 2500 = ±2.5 kHz]
//   27 1A  sweep speed               [id, 00 fast | 01 mid | 02 slow]
//
// A 27 00 payload (after the sub byte):
//   [0] scope id (00 Main, 01 Sub)   [1] division, BCD   [2] divisions per sweep, BCD
//   division 1 only:
//     [3] mode   [4..8] Center: centre Hz | other modes: LOWER edge Hz
//                [9..13] Center: HALF span Hz | other modes: HIGHER edge Hz
//     [14] 01 = out of range (no data follows)   [15..] data
//   division 2+: [3..] data
// Over USB a sweep is 11 frames (a header, then 50 points per frame); over the
// network the whole sweep is ONE frame (divisions = 1, data after byte 15).
'use strict';

const { EventEmitter } = require('events');

const OUT_BINS = 850; // = ScopeAxis.BINS, the frame every scope source produces

// Per model, from Hamlib's spectrum_scope_caps. `dbmMin` is level 0, `dbmMax`
// is levelMax. Spans are the FULL width (Hz) the radio offers in Center mode.
const SPANS_STD = [5000, 10000, 20000, 50000, 100000, 200000, 500000, 1000000];
const MODELS = {
  'IC-7300':       { points: 475, levelMax: 160, dbmMin: -80,  dbmMax: 0, scopes: 1, spans: SPANS_STD },
  'IC-7300 MK II': { points: 475, levelMax: 160, dbmMin: -80,  dbmMax: 0, scopes: 1, spans: SPANS_STD },
  'IC-705':        { points: 475, levelMax: 160, dbmMin: -80,  dbmMax: 0, scopes: 1, spans: SPANS_STD },
  'IC-9700':       { points: 475, levelMax: 160, dbmMin: -80,  dbmMax: 0, scopes: 1, spans: SPANS_STD },
  'IC-905':        { points: 475, levelMax: 160, dbmMin: -80,  dbmMax: 0, scopes: 1, spans: SPANS_STD },
  'IC-7610':       { points: 689, levelMax: 200, dbmMin: -100, dbmMax: 0, scopes: 2, spans: SPANS_STD },
  'IC-7851':       { points: 689, levelMax: 200, dbmMin: -100, dbmMax: 0, scopes: 2, spans: SPANS_STD },
  // Not in Hamlib's scope tables. Assumed to be the 7610's shape until an
  // owner's capture says otherwise.
  'IC-7760':       { points: 689, levelMax: 200, dbmMin: -100, dbmMax: 0, scopes: 2, spans: SPANS_STD, unverified: true },
};

const SUB = { DATA: 0x00, ON: 0x10, OUTPUT: 0x11, MODE: 0x14, SPAN: 0x15, SPEED: 0x1A };
const MODE_NAMES = { 0: 'center', 1: 'fixed', 2: 'scroll-c', 3: 'scroll-f' };

function scopeModelFor(modelName) {
  return MODELS[String(modelName || '')] || null;
}

// ─── BCD ─────────────────────────────────────────────────────────────────────

/** One BCD byte (0x11 → 11). */
function bcdByte(b) { return ((b >> 4) & 0x0F) * 10 + (b & 0x0F); }

/**
 * Icom's 5-byte frequency, least significant byte first (the 03 frequency
 * format). The IC-7300 marks a negative lower edge with an F in the top
 * nibble.
 */
function bcdFreq(bytes, off = 0) {
  let hz = 0, mul = 1, negative = false;
  for (let i = 0; i < 5; i++) {
    const b = bytes[off + i];
    let hi = (b >> 4) & 0x0F;
    const lo = b & 0x0F;
    if (i === 4 && hi === 0x0F) { negative = true; hi = 0; }
    hz += lo * mul + hi * mul * 10;
    mul *= 100;
  }
  return negative ? -hz : hz;
}

/** Hz → Icom's 5-byte frequency BCD. */
function freqBcd(hz) {
  let v = Math.max(0, Math.round(Number(hz) || 0));
  const out = [];
  for (let i = 0; i < 5; i++) {
    const two = v % 100;
    out.push(((Math.floor(two / 10)) << 4) | (two % 10));
    v = Math.floor(v / 100);
  }
  return out;
}

// ─── The 27 00 frame ─────────────────────────────────────────────────────────

/**
 * Parse one 27 00 payload (the bytes after the 00 sub-command).
 * @returns {null | {id, division, divisions, header: null | {mode, modeName, centerHz, spanHz, lowHz, highHz, outOfRange}, data: Uint8Array}}
 */
function parseScopeFrame(payload) {
  if (!payload || payload.length < 3) return null;
  const id = payload[0];
  const division = bcdByte(payload[1]);
  const divisions = bcdByte(payload[2]);
  if (!division || !divisions || division > divisions) return null;
  if (division !== 1) {
    return { id, division, divisions, header: null, data: Uint8Array.from(payload.subarray(3)) };
  }
  if (payload.length < 15) return null;
  const mode = payload[3];
  const a = bcdFreq(payload, 4);
  const b = bcdFreq(payload, 9);
  let centerHz, spanHz, lowHz, highHz;
  if (mode === 0) {
    centerHz = a;
    spanHz = b * 2;          // the radio sends ± (Hamlib: span = value × 2)
    lowHz = centerHz - spanHz / 2;
    highHz = centerHz + spanHz / 2;
  } else {
    lowHz = a;
    highHz = b;
    spanHz = highHz - lowHz;
    centerHz = lowHz + spanHz / 2;
  }
  return {
    id, division, divisions,
    header: { mode, modeName: MODE_NAMES[mode] || 'unknown', centerHz, spanHz, lowHz, highHz, outOfRange: payload[14] === 0x01 },
    data: Uint8Array.from(payload.subarray(15)),
  };
}

/**
 * Puts the pieces of a sweep back together, per scope id. Emits 'sweep'
 * { id, header, levels: Uint8Array, empty } when the last division lands; a
 * new header abandons a sweep still being built (counted in `dropped`).
 */
class SweepAssembler extends EventEmitter {
  constructor() {
    super();
    this._byId = new Map();
    this.sweeps = 0;
    this.dropped = 0;
  }

  feed(frame) {
    if (!frame) return;
    let st = this._byId.get(frame.id);
    if (frame.header) {
      if (st && st.parts.length) this.dropped++;
      st = { header: frame.header, divisions: frame.divisions, parts: [], next: 2 };
      this._byId.set(frame.id, st);
      if (frame.data.length) st.parts.push(frame.data);
    } else {
      // A piece with no header before it, or out of order: wait for the next sweep.
      if (!st || frame.divisions !== st.divisions || frame.division !== st.next) {
        if (st) { this.dropped++; this._byId.delete(frame.id); }
        return;
      }
      st.parts.push(frame.data);
      st.next++;
    }
    if (frame.division !== frame.divisions) return;
    this._byId.delete(frame.id);
    const total = st.parts.reduce((n, p) => n + p.length, 0);
    const levels = new Uint8Array(total);
    let o = 0;
    for (const p of st.parts) { levels.set(p, o); o += p.length; }
    this.sweeps++;
    this.emit('sweep', { id: frame.id, header: st.header, levels, empty: st.header.outOfRange || total === 0 });
  }
}

/**
 * A sweep → the 850-level frame every scope source produces (0..255, higher =
 * stronger): each of the 850 bins takes the nearest of the radio's 475 or
 * 689 points, so a one-point carrier keeps its full height (interpolating
 * shaved a lone peak from 255 to 193), and the radio's 0..levelMax is
 * scaled to 0..255.
 */
function toScopeFrame(levels, { levelMax = 160, bins = OUT_BINS, seq = 0 } = {}) {
  const wf1 = new Uint8Array(bins);
  const n = levels ? levels.length : 0;
  if (n) {
    const k = 255 / Math.max(1, levelMax);
    for (let x = 0; x < bins; x++) {
      const i = bins > 1 ? Math.round((x * (n - 1)) / (bins - 1)) : 0;
      wf1[x] = Math.max(0, Math.min(255, Math.round(levels[i] * k)));
    }
  }
  return { seq, kind: 0, wf1, aligned: true };
}

/** Where the sweep sits: known in every mode, because the radio says so. */
function axisFor(header) {
  if (!header) return null;
  return {
    anchor: header.mode === 0 ? 'center' : 'fixed',
    centerHz: Math.round(header.centerHz),
    spanHz: Math.round(header.spanHz),
  };
}

// ─── Settings replies and writes ─────────────────────────────────────────────

/** A 27 1x reply (payload after cmd 27, sub included) → { sub, ... } or null. */
function parseScopeStatus(payload) {
  if (!payload || payload.length < 2) return null;
  const sub = payload[0];
  if (sub === SUB.ON || sub === SUB.OUTPUT) return { sub, on: payload[1] === 0x01 };
  if (sub === SUB.MODE && payload.length >= 3) return { sub, id: payload[1], mode: payload[2], modeName: MODE_NAMES[payload[2]] || 'unknown' };
  if (sub === SUB.SPAN && payload.length >= 7) return { sub, id: payload[1], spanHz: bcdFreq(payload, 2) * 2 };
  if (sub === SUB.SPEED && payload.length >= 3) return { sub, id: payload[1], speed: payload[2] };
  return { sub, raw: Array.from(payload.subarray(1)) };
}

/** Writes, as [sub, ...data] for CivCodec.sendScope. A read is [sub] (+ id). */
const write = {
  scopeOn: (on) => [SUB.ON, on ? 0x01 : 0x00],
  output: (on) => [SUB.OUTPUT, on ? 0x01 : 0x00],
  mode: (mode, id = 0) => [SUB.MODE, id, mode & 0xFF],
  span: (fullHz, id = 0) => [SUB.SPAN, id, ...freqBcd(Math.round(fullHz / 2))],
};
const read = {
  scopeOn: () => [SUB.ON],
  output: () => [SUB.OUTPUT],
  mode: (id = 0) => [SUB.MODE, id],
  span: (id = 0) => [SUB.SPAN, id],
};

// ─── Capture (the recording an owner sends us) ───────────────────────────────

/** One line of a capture file: time, direction, hex of the whole CI-V frame. */
function captureLine(dir, frame, at = new Date()) {
  const hex = Array.from(frame).map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${at.toISOString()} ${dir} ${hex}\n`;
}

/** A capture file → the CI-V frames it holds ({ at, dir, frame: Buffer }). */
function parseCapture(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^(\S+) (rx|tx) ([0-9a-f]+)$/i.exec(line.trim());
    if (m) out.push({ at: m[1], dir: m[2].toLowerCase(), frame: Buffer.from(m[3], 'hex') });
  }
  return out;
}

/** What a capture shows, for the log line and the operator's message. */
function summarizeSweeps(sweeps) {
  if (!sweeps.length) return { sweeps: 0 };
  const first = sweeps[0].header;
  const pts = new Set(sweeps.map((s) => s.levels.length));
  let max = 0;
  for (const s of sweeps) for (const v of s.levels) if (v > max) max = v;
  return {
    sweeps: sweeps.length,
    points: [...pts].sort((a, b) => a - b),
    maxLevel: max,
    mode: first.modeName,
    centerHz: first.centerHz,
    spanHz: first.spanHz,
  };
}

module.exports = {
  OUT_BINS, MODELS, SUB, MODE_NAMES, SPANS_STD,
  scopeModelFor, bcdByte, bcdFreq, freqBcd,
  parseScopeFrame, SweepAssembler, toScopeFrame, axisFor,
  parseScopeStatus, write, read,
  captureLine, parseCapture, summarizeSweeps,
};
