'use strict';
/**
 * The stuck-TX limit: one timer over every key-down POTACAT starts.
 *
 * jcoreyc 2026-10 (FT-710, DATA-U, 0 W, no ECHOCAT open): the radio sat keyed
 * until POTACAT was closed. The only safeguards were per-feature (the phone's
 * PTT timeout, JTCAT's failsafe, the Yaesu CW-text check), so a key-down from
 * any other route had none. main.js arms this on every PTT it asserts and
 * disarms it on every release; when it trips, main unkeys by every route it
 * has (CAT TX0, RTS/DTR, the audio) and says why.
 *
 * Limits are sized per kind from what that kind legitimately needs, with room:
 *   FT8/FT4/FT2   30 s   (an FT8 over is 12.6 s; JTCAT's own failsafe ~19 s)
 *   JS8           60 s   (the Slow submode transmits ~28 s)
 *   PSK31/JTTY     3 min (a keyboard over: typed text plus macros)
 *   SSTV           6 min (PD290, the longest mode we send, is 289 s + CW ID)
 *   Winlink        2 min (VARA/ARDOP/Mercury key per frame, seconds each)
 *   Tune / test    2 min (JTCAT tune stops itself at 90 s; the test at ~3 s)
 *   Voice         10 min (desktop PTT, voice macros, the phone, FreeDV)
 * Exempt: WSPR (the beacon times its own 110.6 s over and JTCAT's failsafe
 * backs it up), and the external-ATU carrier and CW text, which each run their
 * own envelope timer and never come through here.
 */

const S = 1000;
const TX_LIMITS_MS = Object.freeze({
  ft8: 30 * S,
  ft4: 30 * S,
  ft2: 30 * S,
  js8: 60 * S,
  psk: 180 * S,
  jtty: 180 * S,
  sstv: 360 * S,
  winlink: 120 * S,
  tune: 120 * S,
  voice: 600 * S,
});
const EXEMPT = new Set(['wspr']);

const KIND_LABELS = {
  ft8: 'FT8', ft4: 'FT4', ft2: 'FT2', js8: 'JS8', psk: 'PSK31', jtty: 'JTTY',
  sstv: 'SSTV', winlink: 'Winlink', tune: 'Tune', voice: 'voice', wspr: 'WSPR',
};

/** JTCAT engine mode name -> limit kind. */
function kindForJtcatMode(mode) {
  const m = String(mode || 'FT8').toUpperCase();
  if (m === 'WSPR') return 'wspr';
  if (m === 'FT4') return 'ft4';
  if (m === 'FT2') return 'ft2';
  if (m === 'JS8') return 'js8';
  if (m.startsWith('PSK')) return 'psk';
  if (m === 'JTTY') return 'jtty';
  return 'ft8';
}

/** Limit for a kind in ms, or null when the kind is exempt. Unknown kinds get the voice limit. */
function limitMsFor(kind) {
  if (EXEMPT.has(kind)) return null;
  return TX_LIMITS_MS[kind] || TX_LIMITS_MS.voice;
}

function labelFor(kind) { return KIND_LABELS[kind] || String(kind || 'transmit'); }

function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 120) return `${s} s`;
  return `${Math.round(s / 60)} min`;
}

/** The operator-facing words when the limit trips. */
function tripMessage(kind, ms) {
  return `Transmit stopped: ${labelFor(kind)} had kept the radio keyed for ${fmtDuration(ms)}, longer than a ${labelFor(kind)} transmission ever needs. ` +
    'POTACAT released PTT (CAT, RTS/DTR and the audio). Check the radio is back on receive.';
}

/**
 * One armed limit at a time: a new key-down re-arms with the new kind (a voice
 * macro after a tune), a release disarms. Timers are injectable for tests.
 */
class TxLimit {
  constructor({ onTrip, setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now, isKeyed = null } = {}) {
    this._onTrip = onTrip;
    // isKeyed(): is POTACAT's PTT still asserted at this key-down? Only then is
    // a same-kind arm a re-assert mid-over that keeps its start. Without it a
    // release that ever skipped disarm() would carry the old start into the
    // next over and trip it mid-transmission.
    this._isKeyed = isKeyed;
    this._setTimer = setTimer;
    this._clearTimer = clearTimer;
    this._now = now;
    this._timer = null;
    this.armed = null; // { kind, limitMs, since }
  }

  arm(kind) {
    const k = kind || 'voice';
    const limitMs = limitMsFor(k);
    // Same kind still keyed (a re-assert of PTT mid-over): keep the original start.
    // Not keyed any more: a new over, so the clock restarts.
    const stillKeyed = this._isKeyed ? !!this._isKeyed() : true;
    if (this.armed && this.armed.kind === k && this._timer && stillKeyed) return this.armed;
    this.disarm();
    if (limitMs == null) { this.armed = { kind: k, limitMs: null, since: this._now() }; return this.armed; }
    const armed = { kind: k, limitMs, since: this._now() };
    this.armed = armed;
    this._timer = this._setTimer(() => {
      this._timer = null;
      if (this.armed !== armed) return;
      this.armed = null;
      if (this._onTrip) this._onTrip({ kind: k, limitMs, heldMs: this._now() - armed.since, message: tripMessage(k, limitMs) });
    }, limitMs);
    return armed;
  }

  disarm() {
    if (this._timer) { this._clearTimer(this._timer); this._timer = null; }
    this.armed = null;
  }
}

/**
 * The radio says it is transmitting and POTACAT asserted no PTT. Not unkeyed —
 * the operator may be on the hand mic or a footswitch — but logged with what
 * POTACAT's own keying lines are doing, so a radio keyed by a line POTACAT
 * holds (the jcoreyc case) leaves evidence.
 * @param {object} s { lines: {dtr, rts}|null, handshake: bool, pttRoute: string, mode, freqHz }
 */
function unsolicitedTxReport(s = {}) {
  const lines = s.lines
    ? `CAT port lines as POTACAT set them: DTR ${s.lines.dtr === undefined ? 'unset (driver default)' : (s.lines.dtr ? 'HIGH' : 'low')}, RTS ${s.lines.rts === undefined ? 'unset (driver default)' : (s.lines.rts ? 'HIGH' : 'low')}${s.handshake ? ' (RTS/CTS flow control holds RTS high)' : ''}`
    : 'no serial lines on this link';
  const freq = s.freqHz ? ` on ${(s.freqHz / 1e6).toFixed(4)} MHz` : '';
  return `[TX] WARNING: the radio reports TRANSMIT${freq}${s.mode ? ' in ' + s.mode : ''} and POTACAT did not key it. ` +
    `PTT route: ${s.pttRoute || 'CAT'}; ${lines}. If nobody is on the microphone, a line or another program is keying the radio.`;
}

module.exports = { TX_LIMITS_MS, TxLimit, limitMsFor, kindForJtcatMode, labelFor, tripMessage, unsolicitedTxReport };
