'use strict';

/**
 * The callsign being worked — what CW-macro {call} expands to, on every
 * surface.
 *
 * Several fields can hold one at once: the in-window log dialog, the
 * activator quick log, the banner logger, the Log pop-out, the web log sheet,
 * quick log, Log tab and VFO-panel box. Each reports what it holds — on
 * typing, and when code fills or clears it — and the most recently CHANGED
 * non-empty field wins. That is the operator's latest intent, whichever
 * window it was typed in; a field that was cleared drops out and the next
 * most recent one stands in.
 *
 * Before this (LZ3AW #13, 2026-09-18) only two fields reported, values set in
 * code were never reported, closing a window did not clear its field, and the
 * web and the desktop never heard each other — so a stale field quietly won.
 */
class TypedCallTracker {
  constructor() {
    this._fields = new Map(); // source -> { call, seq }
    this._seq = 0;
  }

  /** Record what `source` holds now; returns the current call after the change. */
  set(source, call) {
    const c = String(call || '').trim().toUpperCase();
    this._fields.set(String(source || 'unknown'), { call: c, seq: ++this._seq });
    return this.current();
  }

  clear(source) {
    return this.set(source, '');
  }

  /** The most recently changed non-empty field's call, or ''. */
  current() {
    let best = null;
    for (const v of this._fields.values()) {
      if (v.call && (!best || v.seq > best.seq)) best = v;
    }
    return best ? best.call : '';
  }
}

module.exports = { TypedCallTracker };
