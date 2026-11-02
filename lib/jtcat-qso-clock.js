'use strict';

// When a JTCAT QSO began. TIME_ON is the start of the contact and TIME_OFF its
// end, as WSJT-X writes them; JTCAT logs at the RR73, so stamping TIME_ON at
// log time put every FT8 contact one to three minutes after the other side's.
//
// Keyed by call, not by QSO object: several paths replace the object with a
// new one for the same station part way through an exchange. A station not
// seen for IDLE_MS is an abandoned attempt, and the next one starts afresh.
//
// Pure: main owns the instance and the clock.

const IDLE_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 50;

const keyOf = (call) => String(call || '').toUpperCase().replace(/[<>]/g, '').trim();

class JtcatQsoClock {
  constructor() { this._starts = new Map(); }

  /** A QSO with this call is under way. */
  note(call, nowMs) {
    const c = keyOf(call);
    if (!c) return;
    const e = this._starts.get(c);
    if (e && nowMs - e.seen < IDLE_MS) { e.seen = nowMs; return; }
    this._starts.set(c, { at: nowMs, seen: nowMs });
    if (this._starts.size > MAX_ENTRIES) {
      for (const [k, v] of this._starts) if (nowMs - v.seen >= IDLE_MS) this._starts.delete(k);
    }
  }

  /** The QSO is being logged: when it began, or nowMs if it was never noted. */
  take(call, nowMs) {
    const c = keyOf(call);
    const e = this._starts.get(c);
    this._starts.delete(c);
    return e && nowMs - e.seen < IDLE_MS ? e.at : nowMs;
  }
}

module.exports = { JtcatQsoClock, IDLE_MS };
