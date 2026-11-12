// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// Winlink diagnostics (#295; docs/ardop-macos-plan.md layer L5). A failed
// Winlink session used to leave nothing readable in the log: the modem's own
// story (what it sent, what it heard, whether it read the channel as busy)
// sat in ardopcf's debug file, and the audio's health was invisible. Pure:
// main.js tails the files and feeds the lines; nothing here touches disk.

'use strict';

// ── ardopcf's debug log → one plain line per event that matters ─────────────
// The shapes (ardopcf 1.0.4.1.3, POTACAT's build; real lines from K3SBP's
// 2026-11-11 KY4RY session):
//   "12:27:09.285 I Sending Frame Type ConReq2000M"
//   "22:20:55.202 I [DecodeFrame] Frame: ConAck2000 Decode PASS,  Quality= 94,  RS fixed 0 (of 0 max)."
//   "22:21:02.509 D poor frame type decode"
//   "22:20:59.857 D  Command Trace TO Host CONNECTED KY4RY 2000"
//   "... BUSY TRUE" / "... BUSY FALSE"
//   "22:20:26.273 I [SendARQConnectRequest] MYCALL=K3SBP  TARGET=KY4RY bytPendingSessionID=ad"
const ARDOP_RULES = [
  { re: /\[SendARQConnectRequest\][^\n]*TARGET=(\S+)/, ev: (m) => ({ kind: 'call', text: `calling ${m[1]}` }) },
  { re: /Sending Frame Type (\S+)/, ev: (m) => ({ kind: 'tx', frame: m[1], text: `sent ${m[1]}` }) },
  { re: /\[DecodeFrame\] Frame: (\S+) Decode (PASS|FAIL)[^\n]*?Quality=\s*(\d+)/, ev: (m) => ({ kind: m[2] === 'PASS' ? 'rx' : 'rx-fail', frame: m[1], quality: Number(m[3]), text: m[2] === 'PASS' ? `heard ${m[1]} (quality ${m[3]})` : `heard ${m[1]} but could not decode it (quality ${m[3]})` }) },
  { re: /Frame Type Decode Fail|poor frame type decode/i, ev: () => ({ kind: 'rx-fail', text: 'heard a frame but could not tell what it was' }) },
  { re: /TO Host CONNECTED (\S+)\s+(\d+)/, ev: (m) => ({ kind: 'state', text: `CONNECTED to ${m[1]} at ${m[2]} Hz` }) },
  { re: /TO Host DISCONNECTED/, ev: () => ({ kind: 'state', text: 'DISCONNECTED' }) },
  { re: /\bBUSY (TRUE|FALSE)\b/, ev: (m) => ({ kind: 'busy', busy: m[1] === 'TRUE', text: m[1] === 'TRUE' ? 'the channel reads busy' : 'the channel reads clear' }) },
  { re: /TO Host REJECTED(?:BUSY|BW)?\s*(\S*)/, ev: (m) => ({ kind: 'state', text: `the call was refused${m[1] ? ' (' + m[1] + ')' : ''}` }) },
];

/** One ardopcf debug line → { kind, text, frame?, quality? } or null (not worth a session-log line). */
function classifyArdopDebugLine(line) {
  const s = String(line || '');
  for (const r of ARDOP_RULES) {
    const m = r.re.exec(s);
    if (m) return r.ev(m);
  }
  return null;
}

// Dire Wolf's own stdout (POTACAT's packet modem). A received frame starts
// "[0.4] CALL>CALL..." (channel.level), a sent one "[0L] CALL>CALL..."; the
// AX.25 link layer says "Connected to" / "Disconnected from".
function classifyDirewolfLine(line) {
  const s = String(line || '').trim();
  let m;
  if ((m = /^\[\d+L\]\s+(\S+?)>(\S+?)[:,\s]/.exec(s))) return { kind: 'tx', text: `sent a frame ${m[1]} > ${m[2]}` };
  if ((m = /^\[\d+\.\d+\]\s+(\S+?)>(\S+?)[:,\s]/.exec(s))) return { kind: 'rx', text: `heard a frame ${m[1]} > ${m[2]}` };
  if ((m = /^\[\d+\.\d+\]\s+.*audio level\s*=\s*(\d+)/i.exec(s))) return null;
  if ((m = /(Connected to|Disconnected from)\s+(\S+)/i.exec(s))) return { kind: 'state', text: `${m[1]} ${m[2]}` };
  if (/Stuck in transmit|bad FCS|FCS bad|frame dropped/i.test(s)) return { kind: 'rx-fail', text: s.slice(0, 120) };
  return null;
}

/**
 * Turns a stream of events into session-log lines: a run of the same event
 * collapses into one line with a count ("sent ConReq2000M (x9)"), and at most
 * `perSec` lines go out in any second; the rest are counted and said once.
 * feed(ev, now) / flush(now) → string[] (lines to log, without the prefix).
 */
class ModemEventLog {
  constructor({ perSec = 4, holdMs = 15000 } = {}) {
    this.perSec = perSec;
    this.holdMs = holdMs;
    this._run = null;      // { text, n, at }
    this._sec = 0;
    this._inSec = 0;
    this._dropped = 0;
  }

  _emit(text, now, out) {
    const sec = Math.floor(now / 1000);
    if (sec !== this._sec) {
      if (this._dropped) { out.push(`(${this._dropped} more modem line${this._dropped === 1 ? '' : 's'} not shown)`); this._dropped = 0; }
      this._sec = sec; this._inSec = 0;
    }
    if (this._inSec >= this.perSec) { this._dropped++; return; }
    this._inSec++;
    out.push(text);
  }

  _closeRun(now, out) {
    const r = this._run;
    if (r && r.n > 1) this._emit(`${r.text} (x${r.n})`, now, out);
    this._run = null;
  }

  feed(ev, now = Date.now()) {
    const out = [];
    if (!ev || !ev.text) return out;
    const r = this._run;
    if (r && r.text === ev.text && now - r.at < this.holdMs) { r.n++; r.at = now; return out; }
    this._closeRun(now, out);
    this._emit(ev.text, now, out);
    this._run = { text: ev.text, n: 1, at: now };
    return out;
  }

  flush(now = Date.now()) {
    const out = [];
    this._closeRun(now, out);
    if (this._dropped) { out.push(`(${this._dropped} more modem line${this._dropped === 1 ? '' : 's'} not shown)`); this._dropped = 0; }
    return out;
  }
}

// ── the modem's log files, for Report a Bug ──────────────────────────────────

/**
 * The last run of ardopcf in one of its log files: from the last startup line
 * ("ardopcf Version ...") to the end. Debug lines (" D ") are dropped unless
 * `keepDebug`, then the tail is capped by lines and characters.
 * @returns {{lines:string[], omitted:number}}
 */
function lastArdopRun(text, { maxLines = 150, maxChars = 12000, keepDebug = false } = {}) {
  const all = String(text || '').split(/\r?\n/).filter((l) => l.trim());
  let start = 0;
  for (let i = all.length - 1; i >= 0; i--) { if (/ardopcf Version/i.test(all[i])) { start = i; break; } }
  let run = all.slice(start);
  if (!keepDebug) run = run.filter((l) => !/^\S+\s+D\s/.test(l) || classifyArdopDebugLine(l));
  return capTail(run, { maxLines, maxChars });
}

/**
 * A log line fit for a report, or null. ardopcf's log files carry runs of raw
 * memory (K3SBP's 2026-11-11 logs: 440 binary lines in each file, NULs and
 * stack bytes around "Invalid parameter passed to C runtime function"). Raw
 * memory can hold anything the process held, so a line with control or
 * non-text bytes in it never goes into a report: it is dropped whole, not
 * cleaned, and counted.
 */
function reportableLine(line) {
  const s = String(line == null ? '' : line);
  // Tab is fine; every other C0/C1 control, DEL, and U+FFFD (a byte that was not text) is not.
  if (/[\u0000-\u0008\u000a-\u001f\u007f-\u009f�]/.test(s)) return null;
  return s;
}

/** The last `maxLines` lines that fit in `maxChars`, and how many were left out. */
function capTail(lines, { maxLines = 150, maxChars = 12000 } = {}) {
  const all = Array.isArray(lines) ? lines : [];
  const src = all.map(reportableLine).filter((l) => l != null);
  const out = [];
  let chars = 0;
  for (let i = src.length - 1; i >= 0 && out.length < maxLines; i--) {
    const l = String(src[i]).slice(0, 300);
    if (chars + l.length + 1 > maxChars) break;
    out.unshift(l);
    chars += l.length + 1;
  }
  return { lines: out, omitted: all.length - out.length, binary: all.length - src.length };
}

// ── the audio's health (L5) ──────────────────────────────────────────────────

/**
 * Measures when the audio on one direction of the modem link RAN OUT. Each
 * block carries `samples / rate` seconds of sound, so the stream is covered
 * until the last block's sound ends; a block that arrives after that leaves
 * a hole of (arrival - covered-until). Bursty writes (ardopcf sends 100 ms at
 * a time) are not holes. A hole longer than `idleMs` is the link at rest (the
 * modem not transmitting), not a dropout; under it, the longest hole and the
 * count over `warnMs` are what an ARDOP frame cannot survive (20 ms ruins one).
 */
class AudioFlowMeter {
  constructor({ rate = 12000, warnMs = 50, idleMs = 1000 } = {}) {
    this.rate = rate;
    this.warnMs = warnMs;
    this.idleMs = idleMs;
    this.reset();
  }

  reset() {
    this.blocks = 0; this.samples = 0; this.maxGapMs = 0; this.gapsOverWarn = 0; this._until = 0;
  }

  note(samples, now = Date.now()) {
    const n = Math.max(0, Number(samples) || 0);
    if (this._until) {
      const hole = now - this._until;
      if (hole > 0 && hole <= this.idleMs) {
        if (hole > this.maxGapMs) this.maxGapMs = hole;
        if (hole > this.warnMs) this.gapsOverWarn++;
      }
    }
    this._until = Math.max(this._until, now) + (n / this.rate) * 1000;
    this.blocks++;
    this.samples += n;
  }

  snapshot(rate) {
    return { blocks: this.blocks, seconds: rate ? Math.round(this.samples / rate) : 0, maxGapMs: Math.round(this.maxGapMs), gapsOverWarn: this.gapsOverWarn };
  }
}

/** One sentence about a session's audio, for the session log. */
function audioSummaryText({ rx, tx, rxDropped = 0, rate = 12000, warnMs = 50 } = {}) {
  const side = (name, s) => {
    if (!s || !s.blocks) return `${name}: no audio`;
    return `${name} ${s.seconds} s, largest gap ${s.maxGapMs} ms` + (s.gapsOverWarn ? ` (${s.gapsOverWarn} gap${s.gapsOverWarn === 1 ? '' : 's'} over ${warnMs} ms)` : '');
  };
  return `audio this session: ${side('radio to modem', rx)}${rxDropped ? `, ${rxDropped} block${rxDropped === 1 ? '' : 's'} dropped (the modem stopped reading)` : ''}; ${side('modem to radio', tx)} (modem side ${rate} samples/s)`;
}

// ── "Record what the modem hears" ────────────────────────────────────────────

/** Collects up to `seconds` of mono 16-bit audio. push(Int16Array|Buffer) → true when full. */
class PcmRecorder {
  constructor({ rate = 12000, seconds = 30 } = {}) {
    this.rate = rate;
    this.max = Math.round(rate * seconds);
    this.chunks = [];
    this.count = 0;
  }

  get full() { return this.count >= this.max; }

  push(pcm) {
    if (this.full || !pcm) return this.full;
    let a = pcm;
    if (Buffer.isBuffer(a)) {
      // A socket chunk can start at an odd byte offset: read it, never view it.
      const n = Math.floor(a.length / 2);
      const c = new Int16Array(n);
      for (let i = 0; i < n; i++) c[i] = a.readInt16LE(i * 2);
      a = c;
    }
    const take = Math.min(a.length, this.max - this.count);
    if (take > 0) { this.chunks.push(Int16Array.from(a.subarray(0, take))); this.count += take; }
    return this.full;
  }

  /** The samples as a WAV file (PCM, mono, 16-bit). */
  toWav() {
    return wavBuffer(this.chunks, this.rate);
  }
}

function wavBuffer(chunks, rate) {
  const n = chunks.reduce((s, c) => s + c.length, 0);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  let o = 44;
  for (const c of chunks) for (let i = 0; i < c.length; i++, o += 2) buf.writeInt16LE(c[i], o);
  return buf;
}

module.exports = {
  classifyArdopDebugLine, classifyDirewolfLine, ModemEventLog,
  lastArdopRun, capTail, reportableLine, AudioFlowMeter, audioSummaryText, PcmRecorder, wavBuffer,
};
