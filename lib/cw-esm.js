'use strict';

// Enter Sends Message for CW (#741), POTACAT's take on the contest-logger
// habit: in CW, Enter in the call field sends the next message of the
// contact, and the last Enter logs it.
//
// Run (Activator): call empty -> CQ (F1). Call typed -> their call and the
// exchange (F5 + F2; F7 in place of F2 for a park-to-park contact). Enter
// again -> log, and only when the log is saved, TU (F3). A call corrected
// after the exchange went -> log, then the corrected call + TU. A call with a
// "?" in it, or not shaped like a call -> what is typed + AGN (F8), no log.
//
// S&P (Hunter): call empty -> nothing, focus the call. Call typed -> my call
// (F4). Enter again -> log, and only when saved, my exchange (F2, or F7 P2P).
//
// Casey's rules (2026-11-19): off by default; Enter keys only in CW, with ESM
// on, from the call field; everywhere else Enter logs as it always did; log
// first, then TU, so a failed log sends nothing and never logs twice. Esc
// aborts through the one cancel path. Pure: the page passes in how to log,
// send and cancel, and this module decides what happens and in what order.
//
// Dual-mode: require() in node, window.CwEsm in a page (needs CwBanks).

(function (root, factory) {
  const banks = (typeof module === 'object' && module.exports) ? require('./cw-banks') : root.CwBanks;
  const api = factory(banks);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CwEsm = api;
}(typeof self !== 'undefined' ? self : this, function (CwBanks) {
  function initialState() { return { stage: 'idle', sentCall: '' }; }

  function isCwMode(mode) { return /^CW(-?R)?$/i.test(String(mode || '').trim()); }

  /** ESM acts only when switched on, in CW, from the call field. */
  function active({ enabled, mode, field } = {}) {
    return enabled === true && isCwMode(mode) && field === 'call';
  }

  const CALL_SHAPE = /^([A-Z0-9]{1,4}\/)?[A-Z0-9]{0,3}[0-9][A-Z0-9]*[A-Z](\/[A-Z0-9]{1,4})?$/;
  function normCall(call) { return String(call || '').trim().toUpperCase().replace(/\s*,\s*/g, ','); }
  /** A call ESM may log: every comma-separated part shaped like a callsign, no "?". */
  function isCompleteCall(call) {
    const c = normCall(call);
    if (!c || c.includes('?')) return false;
    return c.split(',').every((p) => p.length >= 3 && CALL_SHAPE.test(p));
  }

  /**
   * What Enter does now. Never sends or logs by itself.
   * @param {{side:'run'|'sp', state?:object, call?:string, p2p?:boolean}} input
   * @returns {{ send: string[], log: boolean, focus: string|null, nextState: object, cue: string }}
   */
  function next({ side, state, call, p2p } = {}) {
    const st = state && state.stage ? state : initialState();
    const c = normCall(call);
    const exch = p2p ? 'P2P' : 'EXCH';
    if (side === 'sp') {
      if (!c) return { send: [], log: false, focus: 'call', nextState: initialState(), cue: 'MYCALL' };
      if (st.stage !== 'mycall-sent') {
        return { send: ['MYCALL'], log: false, focus: null, nextState: { stage: 'mycall-sent', sentCall: c }, cue: 'MYCALL' };
      }
      if (!isCompleteCall(c)) return { send: ['AGN'], log: false, focus: 'call', nextState: st, cue: 'AGN' };
      return { send: [exch], log: true, focus: null, nextState: st, cue: 'EXCH+LOG' };
    }
    // Run
    if (!c) return { send: ['CQ'], log: false, focus: null, nextState: initialState(), cue: 'CQ' };
    if (c === '?') return { send: ['AGN'], log: false, focus: 'call', nextState: st, cue: 'AGN' };
    if (!isCompleteCall(c)) return { send: ['CALL', 'AGN'], log: false, focus: 'call', nextState: st, cue: 'AGN' };
    if (st.stage !== 'exch-sent') {
      return { send: ['CALL', exch], log: false, focus: null, nextState: { stage: 'exch-sent', sentCall: c }, cue: 'EXCH' };
    }
    if (c !== st.sentCall) return { send: ['CALL', 'TU'], log: true, focus: null, nextState: st, cue: 'TU+LOG' };
    return { send: ['TU'], log: true, focus: null, nextState: st, cue: 'TU+LOG' };
  }

  /** The badge: what the next Enter will do, without doing it. */
  function cue(input) { return next(input).cue; }

  /**
   * The text for some roles from a bank, joined. missing lists roles whose
   * key is empty: ESM then sends nothing rather than half a message.
   */
  function compose(roles, bank) {
    const parts = [];
    const missing = [];
    for (const r of roles || []) {
      const t = CwBanks.slotText(bank, r).trim();
      if (!t) missing.push(r);
      else parts.push(t);
    }
    return { text: parts.join(' '), missing };
  }

  /**
   * One ESM session (one logger). enter() runs a step; abort() stops the send.
   * io: {
   *   bank: () => Array            the bank for this side
   *   expand: (text, {call}) => {text, unknown}   fills the variables for this contact
   *   log: async () => boolean     true only when the contact is saved
   *   send: (text) => void         the existing CW text path
   *   cancel: () => void           the existing CW cancel path
   *   onMissing?: (roles) => void, onUnknown?: (vars) => void
   * }
   */
  function createSession(side) {
    const s = { side, state: initialState(), busy: false };
    s.reset = () => { s.state = initialState(); };
    s.cue = (call, p2p) => cue({ side, state: s.state, call, p2p });
    s.abort = (io) => { try { io.cancel(); } catch {} };
    s.enter = async (input, io) => {
      if (s.busy) return { ignored: true, sent: '', logged: false };
      const step = next({ side, state: s.state, call: input.call, p2p: !!input.p2p });
      if (!step.send.length && !step.log) {
        s.state = step.nextState;
        return { sent: '', logged: false, focus: step.focus };
      }
      const msg = compose(step.send, io.bank());
      if (msg.missing.length) {
        if (io.onMissing) io.onMissing(msg.missing);
        return { sent: '', logged: false, missing: msg.missing, focus: step.focus };
      }
      const ex = io.expand(msg.text, { call: normCall(input.call) });
      if (ex.unknown && ex.unknown.length && io.onUnknown) io.onUnknown(ex.unknown);
      if (step.log) {
        s.busy = true;
        let ok = false;
        try { ok = (await io.log()) === true; } catch { ok = false; } finally { s.busy = false; }
        if (!ok) return { sent: '', logged: false, focus: step.focus }; // state stays: Enter again retries the log
        s.state = initialState();
        if (ex.text) io.send(ex.text);
        return { sent: ex.text, logged: true, focus: 'call' };
      }
      s.state = step.nextState;
      if (ex.text) io.send(ex.text);
      return { sent: ex.text, logged: false, focus: step.focus };
    };
    return s;
  }

  return { initialState, isCwMode, active, isCompleteCall, next, cue, compose, createSession };
}));
