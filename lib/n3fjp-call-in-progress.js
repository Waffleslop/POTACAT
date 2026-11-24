'use strict';
/**
 * The call in progress, shown in N3FJP's entry window (#712). POTACAT used to
 * send N3FJP only the finished contact (ADDADIFRECORD); N3FJP users expect
 * its lookup panel to fill while they work the station, as WSJT-X does.
 *
 * N3FJP's TCP API (https://www.n3fjp.com/help/api.html), two documented
 * commands, each ended with CR+LF:
 *   <CMD><UPDATE><CONTROL>TXTENTRYCALL</CONTROL><VALUE>W1AW</VALUE></CMD>
 *     writes the Call box,
 *   <CMD><ACTION><VALUE>CALLTAB</VALUE></CMD>
 *     "performs all the functions associated with tabbing from the Call
 *     field": prior contacts, dupe check, callbook lookup. The page
 *     recommends sending it right after a call is written.
 * After POTACAT logs the same call, <CMD><ACTION><VALUE>CLEAR</VALUE></CMD>
 * ("Clears all text boxes") empties the entry window again, as N3FJP's own
 * Enter does, so the call POTACAT put there is not left behind to be logged
 * a second time.
 *
 * Nothing here logs: ENTER and ADDADIFRECORD are never sent from this path.
 *
 * Rules:
 *  - only when the setting is on and the logbook is N3FJP (wanted());
 *  - debounced: typing waits TYPED_DELAY_MS after the last keystroke, a pick
 *    (spot, JTCAT partner) PICK_DELAY_MS; only the latest call is sent;
 *  - the same call is not sent twice in a row;
 *  - N3FJP not answering: nothing is said, and nothing is tried again for
 *    DOWN_MS (a closed N3FJP must not delay a real QSO behind a timeout);
 *  - a call just logged is not put back by the QSO's own late state changes
 *    (JTCAT sends 73 after logging); a spot pick of it still goes.
 * main.js owns the socket (sendN3fjpCommands) and the triggers.
 */

const TYPED_DELAY_MS = 700;
const PICK_DELAY_MS = 250;
const DOWN_MS = 30 * 1000;
const LOGGED_QUIET_MS = 60 * 1000;

/** The call as N3FJP should get it: upper case, first of a comma list, '' when not a whole call yet. */
function cleanCall(raw) {
  const c = String(raw == null ? '' : raw).split(',')[0].trim().toUpperCase();
  if (c.length < 3 || c.length > 15) return '';
  if (!/^[A-Z0-9]+(\/[A-Z0-9]+)*$/.test(c)) return '';
  if (!/[A-Z]/.test(c) || !/[0-9]/.test(c)) return '';
  return c;
}

/** The commands that put `call` in N3FJP's Call box and tab out of it. */
function callCommands(call) {
  const c = cleanCall(call);
  if (!c) return [];
  return [
    `<CMD><UPDATE><CONTROL>TXTENTRYCALL</CONTROL><VALUE>${c}</VALUE></CMD>\r\n`,
    '<CMD><ACTION><VALUE>CALLTAB</VALUE></CMD>\r\n',
  ];
}

/** Empties N3FJP's entry window after POTACAT logged the call it put there. */
function clearCommands() {
  return ['<CMD><ACTION><VALUE>CLEAR</VALUE></CMD>\r\n'];
}

/** The setting is on and the contacts go to N3FJP. */
function wanted(settings) {
  return !!(settings && settings.n3fjpCallInProgress === true && settings.sendToLogbook && settings.logbookType === 'n3fjp');
}

class CallInProgress {
  /**
   * @param {object} o
   * @param {(job:{kind:'call'|'clear',call:string,commands:string[]})=>Promise<any>} o.send
   * @param {()=>boolean} o.isEnabled  wanted(settings) and anything else main requires
   * @param {()=>number} [o.now]
   * @param {Function} [o.setTimer]
   * @param {Function} [o.clearTimer]
   */
  constructor(o) {
    this._send = o.send;
    this._isEnabled = o.isEnabled || (() => false);
    this._now = o.now || Date.now;
    this._setTimer = o.setTimer || setTimeout;
    this._clearTimer = o.clearTimer || clearTimeout;
    this._timer = null;
    this._pending = '';
    this._latest = '';
    this._lastSent = '';
    this._downUntil = 0;
    this._logged = { call: '', at: 0 };
  }

  /** A call the operator is working now. source: 'typed' | 'spot' | 'jtcat'. */
  note(raw, source) {
    const call = cleanCall(raw);
    if (!call) return false;
    if (!this._isEnabled()) return false;
    if (source !== 'spot' && call === this._logged.call && this._now() - this._logged.at < LOGGED_QUIET_MS) return false;
    this._latest = call;
    if (call === this._lastSent && !this._timer) return false;
    if (this._timer) this._clearTimer(this._timer);
    this._pending = call;
    this._timer = this._setTimer(() => this._fire(), source === 'typed' ? TYPED_DELAY_MS : PICK_DELAY_MS);
    return true;
  }

  _fire() {
    this._timer = null;
    const call = this._pending;
    this._pending = '';
    if (!call || call === this._lastSent) return;
    if (!this._isEnabled()) return;
    if (this._now() < this._downUntil) return;
    this._lastSent = call;
    const forget = () => { if (this._lastSent === call) this._lastSent = ''; };
    this._run({ kind: 'call', call, commands: callCommands(call) }, forget, forget);
  }

  // send() resolves { skipped: true } when the queued job was no longer
  // current by the time N3FJP was free: nothing reached N3FJP.
  _run(job, onFail, onSkip) {
    let p;
    try { p = Promise.resolve(this._send(job)); } catch (e) { p = Promise.reject(e); }
    return p.then((r) => {
      if (r && r.skipped) { if (onSkip) onSkip(); return; }
      this._downUntil = 0;
    }, () => {
      this._downUntil = this._now() + DOWN_MS;
      if (onFail) onFail();
    });
  }

  /** Still the call to show (a queued send checks before it connects). */
  isCurrent(call) { return cleanCall(call) === this._latest; }

  /** POTACAT logged `call` to N3FJP: empty the entry window if it holds the call POTACAT put there. */
  logged(raw) {
    const call = cleanCall(raw);
    if (!call) return false;
    this._logged = { call, at: this._now() };
    if (this._pending === call) { if (this._timer) this._clearTimer(this._timer); this._timer = null; this._pending = ''; }
    if (this._latest === call) this._latest = '';
    if (call !== this._lastSent) return false;
    this._lastSent = '';
    if (!this._isEnabled() || this._now() < this._downUntil) return false;
    this._run({ kind: 'clear', call, commands: clearCommands() });
    return true;
  }

  /** A real QSO send or the log pull reached N3FJP (true) or could not (false). */
  reachable(ok) { this._downUntil = ok ? 0 : this._now() + DOWN_MS; }
}

module.exports = {
  cleanCall, callCommands, clearCommands, wanted, CallInProgress,
  TYPED_DELAY_MS, PICK_DELAY_MS, DOWN_MS, LOGGED_QUIET_MS,
};
