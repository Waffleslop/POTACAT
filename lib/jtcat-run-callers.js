'use strict';
/**
 * Run's waiting callers (W5XY 2026-11-25: "when running and I have multiple
 * stations calling, after working a station I call CQ again instead of
 * working the next person in line"; N8PFK kept calling while Run kept
 * calling CQ).
 *
 * Run used to look only at the decodes of the one cycle right after its CQ.
 * A station that called while a QSO was in progress was never seen again: the
 * QSO phases only listen to their own partner, and the cycle in hand when the
 * QSO finished was never examined, because rearmCq put the CQ on the air
 * before anything looked at it. This module remembers who called us, for a
 * short window, and picks the one Run answers next. WSJT-X and JTDX operators
 * expect the same: when a QSO ends and someone is waiting, answer them; call
 * CQ only when nobody is.
 *
 * Pure. main.js feeds it every decode cycle while Run is on (note), asks it
 * who to answer (pick) when a QSO ends or while the CQ is listening, and
 * supplies the policy as predicates: worked-before, the TX slot lock, the
 * "Who goes first" ranking. Hunt's signal floor is not applied: Run never
 * applied it to answers to its CQ. Nothing here transmits.
 *
 * A caller is a decode addressed to us, "MYCALL THEIRCALL <x>", where x is a
 * grid (Tx1), a report (Tx2, the compressed reply), an R+report (they think a
 * QSO with us is under way, e.g. one Run gave up on), or nothing (a
 * nonstandard call's two-call Tx1). RR73 / RRR / 73 close a QSO and are not
 * calls. A compound message ("A RR73; B <C> -07") is not a call either.
 */

const JtcatParser = require('../renderer/jtcat-parser');

// How long a caller is remembered: four T/R periods, two full cycles (60 s on
// FT8, 30 s on FT4). Long enough to span a QSO's last exchange and the RR73
// that ends it; short enough that a station who has moved on is not called.
const WINDOW_PERIODS = 4;

// An abandoned QSO (the per-QSO try cap ran out) may be answered once more if
// that station is still calling us: they can hear us, it was our decoder that
// lost them. Once only, so a station we cannot copy does not loop forever.
const ABANDONED_RETRIES = 1;

function windowMs(cycleSec) {
  const s = Number(cycleSec) > 0 ? Number(cycleSec) : 15;
  return WINDOW_PERIODS * s * 1000;
}

function _norm(t) {
  return String(t || '').toUpperCase().replace(/[<>]/g, '').trim();
}

/**
 * Is this decode a station calling us? Returns { call, kind, grid, report }
 * or null. kind: 'grid' | 'report' | 'rreport' | 'bare'.
 */
function parseCaller(text, myCall) {
  const me = _norm(myCall);
  const t = _norm(text);
  if (!me || !t || t.indexOf(';') >= 0) return null;
  const parts = t.split(/\s+/);
  if (parts[0] !== me || parts.length < 2 || parts.length > 3) return null;
  const call = parts[1];
  if (call === me || !JtcatParser.looksLikeCallsign(call)) return null;
  if (parts.length === 2) return { call, kind: 'bare', grid: '', report: '' };
  const x = parts[2];
  if (/^(RR73|RRR|73)$/.test(x)) return null;
  if (/^[A-R]{2}\d{2}$/.test(x)) return { call, kind: 'grid', grid: x, report: '' };
  if (/^[+-]\d{2}$/.test(x)) return { call, kind: 'report', grid: '', report: x };
  if (/^R[+-]\d{2}$/.test(x)) return { call, kind: 'rreport', grid: '', report: x.slice(1) };
  return null;
}

/** The transmitter of a decode: the parser's r.call, else the directed form's second token. */
function _senderOf(d) {
  if (d && typeof d.call === 'string' && d.call) return _norm(d.call);
  const parts = _norm(d && d.text).split(/\s+/);
  if (parts[0] === 'CQ') return '';
  return parts[1] || '';
}

/**
 * The decode the CQ-side state machine is handed to start the QSO. The state
 * machine already turns a grid, a report and a bare two-call reply into the
 * right first message; an R+report caller is given the bare form, so we send
 * them a fresh report and finish with RR73 when their R+report comes back,
 * rather than assume a report they may never have heard.
 */
function answerDecode(entry, myCall) {
  if (!entry) return null;
  if (entry.kind !== 'rreport') return { ...entry.decode };
  return { ...entry.decode, text: _norm(myCall) + ' ' + entry.call };
}

class RunCallerQueue {
  constructor() {
    this._waiting = new Map();   // call -> entry
    this._abandoned = new Map(); // key (call|band|mode) -> times given up
    this._skipNoted = new Set(); // calls already logged as skipped this Run
    this._seq = 0;               // decode cycles noted
  }

  /**
   * Is this caller sure enough to answer after a QSO, when it may not be
   * calling right now? Heard at least twice in the window, or in one of the
   * last two decode cycles (one T/R cycle: their latest transmission period,
   * whichever parity the cycle in hand is). A one-off false decode from a
   * minute ago is not answered.
   */
  confirmed(e) {
    return !!e && (e.heard >= 2 || e.seq >= this._seq - 1);
  }

  /** Run started or stopped: forget everything. */
  clear() {
    this._seq = 0;
    this._waiting.clear();
    this._abandoned.clear();
    this._skipNoted.clear();
  }

  /**
   * Remember every station calling us in this cycle. `scope` is the band and
   * mode the cycle was heard on; pick() only answers callers from its own
   * scope. A waiting station heard calling CQ, working someone else or
   * signing off has moved on and is dropped.
   */
  note(results, myCall, nowMs, scope, winMs) {
    const me = _norm(myCall);
    const win = winMs || windowMs(15);
    this._seq++;
    for (const d of results || []) {
      // A decode recovered only with a priori help (AP) is not evidence
      // enough to call a station a minute later: never remembered.
      if (d && d.ap) continue;
      const c = parseCaller(d && d.text, me);
      if (c) {
        const old = this._waiting.get(c.call);
        const heard = old && nowMs - old.heardAt <= win ? old.heard + 1 : 1;
        // The decode's own fields (event match, new grid / country) feed
        // "Who goes first"; the parsed ones win.
        this._waiting.set(c.call, { ...d, ...c, heardAt: nowMs, heard, seq: this._seq, scope: scope || '', decode: d });
        continue;
      }
      // Anything else from a waiting station (a CQ, a call to someone else,
      // their 73 to us) means they are no longer calling us.
      const sender = _senderOf(d);
      if (sender && sender !== me) this._waiting.delete(sender);
    }
  }

  /** Stop remembering a call (we are answering them, or just worked them). */
  forget(call) {
    if (call) this._waiting.delete(_norm(call));
  }

  /** Callers still inside the window; older ones are dropped. */
  waiting(nowMs, winMs) {
    const out = [];
    for (const [call, e] of this._waiting) {
      if (nowMs - e.heardAt > winMs) { this._waiting.delete(call); continue; }
      out.push(e);
    }
    return out;
  }

  /** Run gave up on a QSO with this station (key = call|band|mode). */
  noteAbandoned(key) {
    if (!key) return;
    this._abandoned.set(key, (this._abandoned.get(key) || 0) + 1);
  }

  /** A QSO with this station finished: no second chance is owed. */
  noteCompleted(key) {
    if (key) this._abandoned.delete(key);
  }

  /** May an abandoned station be answered again when it calls? */
  mayRetry(key) {
    const n = this._abandoned.get(key) || 0;
    return n > 0 && n <= ABANDONED_RETRIES;
  }

  /** Log a worked-caller skip once per call per Run, not every cycle. */
  firstSkipNote(call) {
    const c = _norm(call);
    if (this._skipNoted.has(c)) return false;
    this._skipNoted.add(c);
    return true;
  }

  /**
   * Who Run answers next, or null when nobody is waiting (then Run calls CQ).
   * @param {object} o
   * @param {number}   o.nowMs
   * @param {number}   o.windowMs     how long a caller is remembered
   * @param {string}   [o.scope]      current band|mode; other scopes are not answered
   * @param {string[]} [o.exclude]    calls never answered now (the station just worked or dropped)
   * @param {function} [o.isBlocked]  call -> why it is not answered (worked-before, Never answer), '' when it may be
   * @param {boolean}  [o.confirmedOnly] after a QSO: only callers heard twice, or in the last T/R cycle
   * @param {function} [o.slotOk]     slot -> false when the TX slot lock rules them out
   * @param {function} [o.rank]       list -> sorted list ("Who goes first")
   * @returns {{ best: object|null, ranked: object[], blocked: {call: string, why: string}[] }}
   */
  pick(o) {
    const opts = o || {};
    const exclude = new Set((opts.exclude || []).filter(Boolean).map(_norm));
    const blocked = [];
    const list = this.waiting(opts.nowMs || 0, opts.windowMs || windowMs(15)).filter((e) => {
      if (exclude.has(e.call)) return false;
      if (opts.scope && e.scope && e.scope !== opts.scope) return false;
      const why = opts.isBlocked ? opts.isBlocked(e.call) : '';
      if (why) { blocked.push({ call: e.call, why: typeof why === 'string' ? why : 'already worked' }); return false; }
      if (opts.confirmedOnly && !this.confirmed(e)) return false;
      if (opts.slotOk && !opts.slotOk(e.slot)) return false;
      return true;
    });
    const ranked = opts.rank ? opts.rank(list) : list.slice().sort((a, b) => (Number(b.db) || -99) - (Number(a.db) || -99));
    return { best: ranked[0] || null, ranked, blocked };
  }
}

/** The CAT log line for Run answering a waiting caller instead of calling CQ. */
function answerLogLine(entry, o) {
  const opts = o || {};
  const db = Number.isFinite(entry && entry.db) ? ` (${entry.db > 0 ? '+' : ''}${entry.db} dB)` : '';
  let why;
  if (opts.retry) why = 'who is still calling after the last try was given up';
  else if (opts.afterQso) why = 'who called during the last QSO';
  else why = 'who called us';
  const more = opts.more > 0 ? `; ${opts.more} more waiting` : '';
  return `[JTCAT] Run: answering ${entry.call}${db}, ${why}${more}`;
}

module.exports = {
  WINDOW_PERIODS, ABANDONED_RETRIES, windowMs, parseCaller, answerDecode, answerLogLine, RunCallerQueue,
};
