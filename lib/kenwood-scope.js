'use strict';
//
// The Kenwood TS-890S's bandscope over its USB or COM port (GitHub #397).
//
// Source: Kenwood, TS-890S PC Control Command Reference Guide (2018-08-30):
// AI p.3; BS3, BS4 p.7; DD0 p.17; DD2 p.18; DD4 p.19; the EX menu list p.27
// (Baud Rate: EX 0 07 00 COM port, 0 07 01 Virtual Standard COM,
// 0 07 02 Virtual Enhanced COM).
//
//   DD0 P1;   bandscope data output: 0 none, 1-3 LAN (##DD2), 4 COM/USB with
//             AI (DD2), 5 COM/USB without AI (DD4). P1 = 5 "can be set only
//             for communication connectors that do not use the AI function".
//   DD4 P1..  P1 = split number 00-32.
//             Piece 00: DD4 00 P2(1) P3(11) P4(11) P5(1);
//               P2 mode 0 Center / 1 Fixed / 2 Auto scroll;
//               Center: P3 = span Hz, P4 = centre Hz;
//               Fixed, Auto scroll: P3 = lower edge Hz, P4 = upper edge Hz;
//               P5 1 = "Outside of the measuring range" on the radio.
//             Pieces 01-32: DD4 nn + 40 hex digits = 20 points each, 640 in
//             all, lower edge first.
//             Not sent in Center or Auto scroll while EXPAND is ON.
//   DD2 P1..  P1 = 00-31, 40 hex digits = 20 points (640), no mode or range.
//   Points:   00h = 0 dB (top of the scope) ... 8Ch = -100 dB (nothing shown).
//   "This command operates only at a baud rate of 115200 bps."
//   AI;       AI0 off, AI2 on (not kept), AI4 on (kept). Set per connector.
//
// So POTACAT uses DD0 5 (DD4: every sweep says where it is), which needs AI
// OFF on the port. It reads AI and DD0 first, sets AI0 only when AI was on,
// and puts both back when the scope closes (startPlan / stopPlan).
//
// TS-990S: NOT this. Its PC Control Command Reference has DD0 0/1/2
// (2 = low-speed output for COM), no DD4, and DD2 output tied to AI, so the
// axis would have to come from other reads. Left for an owner's report.
//
// Pure: no I/O. main.js owns the link and the timing.

const { EventEmitter } = require('events');

const POINTS = 640;
const PIECE_POINTS = 20;
const MAX_VALUE = 0x8c;          // -100 dB
const OUT_BINS = 850;
const MODES = { 0: 'CENTER', 1: 'FIXED', 2: 'AUTO SCROLL' };
const REQUIRED_BAUD = 115200;

function hexPoints(s) {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    const v = parseInt(s.substr(i * 2, 2), 16);
    out[i] = v > MAX_VALUE ? MAX_VALUE : v;
  }
  return out;
}

/**
 * One DD2/DD4 reply (with or without the ';'), or null.
 *  { cmd: 'DD4', piece: 0, header: { mode, modeName, a, b, outOfRange } }
 *  { cmd: 'DD4' | 'DD2', piece: n, points: Uint8Array(20) }
 */
function parseDdLine(line) {
  const s = String(line || '').trim().replace(/;$/, '');
  let m = /^DD400([0-2])(\d{11})(\d{11})([01])$/.exec(s);
  if (m) {
    const mode = Number(m[1]);
    return { cmd: 'DD4', piece: 0, header: { mode, modeName: MODES[mode], a: Number(m[2]), b: Number(m[3]), outOfRange: m[4] === '1' } };
  }
  m = /^DD4(\d\d)([0-9A-Fa-f]{40})$/.exec(s);
  if (m) {
    const piece = Number(m[1]);
    if (piece < 1 || piece > 32) return null;
    return { cmd: 'DD4', piece, points: hexPoints(m[2]) };
  }
  m = /^DD2(\d\d)([0-9A-Fa-f]{40})$/.exec(s);
  if (m) {
    const piece = Number(m[1]);
    if (piece > 31) return null;
    return { cmd: 'DD2', piece, points: hexPoints(m[2]) };
  }
  return null;
}

/** A reply that belongs to the bandscope stream (cheap test for the codec). */
function isDdStream(msg) {
  return /^DD[24]\d\d/.test(String(msg || ''));
}

/**
 * Collects pieces into whole sweeps. Emits 'sweep' { header, points } once
 * every piece of a sweep has arrived in order; a sweep with a gap is dropped
 * (counted in .dropped), never drawn half-old.
 */
class SweepAssembler extends EventEmitter {
  constructor() {
    super();
    this.dropped = 0;
    this.sweeps = 0;
    this._reset();
  }

  _reset() { this._cmd = null; this._header = null; this._points = null; this._next = -1; }

  feed(p) {
    if (!p) return;
    if (p.cmd === 'DD4') {
      if (p.piece === 0) {
        if (this._cmd && this._next !== -1) this.dropped++;
        this._cmd = 'DD4'; this._header = p.header; this._points = new Uint8Array(POINTS); this._next = 1;
        return;
      }
      if (this._cmd !== 'DD4' || p.piece !== this._next) { if (this._cmd) this.dropped++; this._reset(); return; }
      this._points.set(p.points, (p.piece - 1) * PIECE_POINTS);
      this._next++;
      if (p.piece === 32) { this._emit(); }
      return;
    }
    // DD2: pieces 00..31, no header.
    if (p.piece === 0) {
      if (this._cmd && this._next !== -1) this.dropped++;
      this._cmd = 'DD2'; this._header = null; this._points = new Uint8Array(POINTS); this._next = 0;
    }
    if (this._cmd !== 'DD2' || p.piece !== this._next) { if (this._cmd) this.dropped++; this._reset(); return; }
    this._points.set(p.points, p.piece * PIECE_POINTS);
    this._next++;
    if (p.piece === 31) this._emit();
  }

  _emit() {
    const s = { cmd: this._cmd, header: this._header, points: this._points };
    this._reset();
    this.sweeps++;
    this.emit('sweep', s);
  }
}

/**
 * Where a DD4 sweep sits, from its own piece 00. Center: the span and centre
 * the radio states; Fixed and Auto scroll: its two edges. Always 'fixed' for
 * POTACAT's axis, because the numbers are the radio's, not the dial's.
 */
function axisFor(header) {
  if (!header) return null;
  let centerHz, spanHz;
  if (header.mode === 0) { spanHz = header.a; centerHz = header.b; }
  else { spanHz = header.b - header.a; centerHz = Math.round((header.a + header.b) / 2); }
  if (!(spanHz > 0) || !(centerHz > 0)) return null;
  return { anchor: 'fixed', centerHz, spanHz, modeLabel: header.modeName || null };
}

/** 640 points (00h top .. 8Ch bottom) as POTACAT's 850 levels 0..255. */
function toScopeFrame(points, { bins = OUT_BINS, seq = 0 } = {}) {
  const wf1 = new Uint8Array(bins);
  const n = points ? points.length : 0;
  if (n) {
    for (let x = 0; x < bins; x++) {
      const lo = Math.floor((x * n) / bins);
      const hi = Math.max(lo + 1, Math.floor(((x + 1) * n) / bins));
      let top = MAX_VALUE;   // smaller = stronger: keep the strongest point covered
      for (let i = lo; i < hi && i < n; i++) if (points[i] < top) top = points[i];
      wf1[x] = Math.round(((MAX_VALUE - top) / MAX_VALUE) * 255);
    }
  }
  return { seq, kind: 0, wf1, aligned: true };
}

/** The level scale: the radio's own dB, 0 at the top, -100 at the bottom. Not dBm. */
const LEVEL_SCALE = { unit: 'radio', min: -100, max: 0 };

/** "AI4;" -> '4'; anything else -> null. */
function parseAi(reply) {
  const m = /^AI(\d)/.exec(String(reply || '').trim());
  return m ? m[1] : null;
}

/** "DD05;" -> '5'; anything else -> null. */
function parseDd0(reply) {
  const m = /^DD0(\d)/.exec(String(reply || '').trim());
  return m ? m[1] : null;
}

/**
 * What to write to start the scope, and what puts the radio back.
 * ai / dd0: the radio's answers to AI; and DD0; (null = no answer).
 * Without an AI answer nothing is written: DD0 5 on a port that uses AI is
 * an error, and POTACAT does not switch AI blind.
 */
function startPlan({ ai, dd0 }) {
  if (ai == null) {
    return { ok: false, writes: [], restore: [], why: 'no-ai',
      log: '[Scope] TS-890S: the radio did not answer AI; so POTACAT does not know whether Auto Information is on for this port, and sends nothing' };
  }
  const writes = [];
  const restore = [];
  if (ai !== '0') { writes.push('AI0;'); }
  writes.push('DD05;');
  restore.push('DD0' + (dd0 != null && dd0 !== '5' ? dd0 : '0') + ';');
  if (ai !== '0') restore.push('AI' + ai + ';');
  const log = '[Scope] TS-890S bandscope over CAT: ' + (ai !== '0' ? `Auto Information was AI${ai} on this port, set to AI0 for the scope (put back at close); ` : 'Auto Information is off on this port; ')
    + `DD0 was ${dd0 == null ? 'unread' : dd0}, now DD05 (output with mode and range)`;
  return { ok: true, writes, restore, log };
}

/** Whether a link can carry the scope: a serial port at 115200. */
function baudOk(target) {
  const b = Number(target && target.baudRate);
  return b === REQUIRED_BAUD;
}

const BAUD_ACTION = 'On the radio: the menu item Baud Rate for the port POTACAT uses (Virtual Standard COM is EX 0-07-01, Virtual Enhanced COM is 0-07-02, the COM port is 0-07-00), choose 115200. In POTACAT: Settings > My Rigs, edit this radio, Baud rate 115200.';

/** The card for each way the scope cannot start or stay up. Keys are kenwood-*: the
 *  pop-out offers its SCU-LAN10 Enable button on a plain 'silent'. */
function diag(key, extra = {}) {
  const d = {
    baud: { key: 'kenwood-baud', severity: 'blocker',
      headline: 'The bandscope needs 115200 baud',
      detail: `POTACAT talks to the TS-890S at ${extra.baud || '?'} baud. Kenwood: the bandscope output "operates only at a baud rate of 115200 bps".`,
      action: BAUD_ACTION },
    'no-ai': { key: 'kenwood-no-ai', severity: 'error',
      headline: 'The radio did not answer',
      detail: 'POTACAT asks the radio whether Auto Information is on before it turns the bandscope output on, and got no answer.',
      action: 'Check the radio is on and connected, then press Retry.' },
    silent: { key: 'kenwood-silent', severity: 'error',
      headline: 'No bandscope data from the TS-890S',
      detail: 'POTACAT asked for the bandscope output (DD05) and nothing has arrived. Kenwood: the radio does not send it in Center or Auto Scroll mode while EXPAND is on, and only at 115200 baud.',
      action: 'Turn EXPAND off on the radio\'s bandscope, check the baud rate is 115200, then press Retry.' },
    refused: { key: 'kenwood-refused', severity: 'error',
      headline: 'The radio refused the bandscope output',
      detail: 'The TS-890S answered DD05 with an error. Kenwood: that setting is refused on a port that uses Auto Information.',
      action: 'Press Retry. If it happens again, please send a bug report from Help: the log has the radio\'s answers.' },
  }[key];
  return d || { key, severity: 'error', headline: 'The bandscope stopped', detail: '', action: 'Press Retry.' };
}

/** The rig models that have this scope (lib/rig-models.js: bandscope 'kenwood-dd'). */
function modelHasScope(model) {
  return !!(model && model.bandscope === 'kenwood-dd');
}

module.exports = {
  POINTS, PIECE_POINTS, MAX_VALUE, OUT_BINS, MODES, REQUIRED_BAUD, LEVEL_SCALE, BAUD_ACTION,
  parseDdLine, isDdStream, SweepAssembler, axisFor, toScopeFrame, parseAi, parseDd0, startPlan, baudOk, diag, modelHasScope,
};
