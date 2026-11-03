'use strict';
// The clock POTACAT's time-slotted modes run on (FT8, FT4, FT2, WSPR, JTTY).
//
// A shack with no internet (a Pi in the field) or nobody at it to approve the
// Windows admin prompt cannot have its clock fixed, and a clock a few hundred
// ms off UTC decodes everything while nobody can decode us. The phone running
// ECHOCAT has carrier/NTP time, so it measures the shack against itself over
// the WebSocket (clock-probe / clock-probe-reply, NTP-style) and sends the
// result (clock-apply). POTACAT then corrects its OWN slot timing by that
// amount. The computer's clock is never touched, so no admin is needed and the
// correction ends when POTACAT quits. (User request via K3SBP 2026-10-25.)
//
// `aheadMs` = how far the computer's clock is AHEAD of true time (positive =
// fast). now() = Date.now() - aheadMs. Note lib/ntp.js reports the opposite
// sign (server minus local).

const MAX_RTT_MS = 400;                    // accuracy is +/- half the round trip
const MAX_ABS_OFFSET_MS = 24 * 3600 * 1000; // beyond a day, the date itself is wrong

let _aheadMs = 0;
let _info = null; // { source: 'device', device, rttMs, samples, at }

function now() { return Date.now() - _aheadMs; }
function aheadMs() { return _aheadMs; }
function info() { return _info ? { ..._info, aheadMs: _aheadMs } : null; }

function setCorrection(ms, meta) {
  _aheadMs = Math.round(ms);
  _info = { ...(meta || {}), at: Date.now() };
}

function clear() {
  const had = _aheadMs !== 0 || !!_info;
  _aheadMs = 0;
  _info = null;
  return had;
}

/**
 * Decide on a device's clock-apply. Pure.
 * @param {object} msg       { offsetMs (shack minus phone), rttMs, samples }
 * @param {object} ctx       { guest: boolean, ntpLevel: 'ok'|'warn'|'bad'|'unknown'|null }
 * @returns {{ok: true, aheadMs: number} | {ok: false, error: string}}
 */
function decideClockApply(msg, ctx) {
  const c = ctx || {};
  if (c.guest) return { ok: false, error: 'guest-pass' };
  const off = Number(msg && msg.offsetMs);
  const rtt = Number(msg && msg.rttMs);
  if (!Number.isFinite(off) || !Number.isFinite(rtt) || rtt < 0 || Math.abs(off) > MAX_ABS_OFFSET_MS) {
    return { ok: false, error: 'bad-value' };
  }
  if (rtt > MAX_RTT_MS) return { ok: false, error: 'rtt-too-high' };
  // The internet time check reaches a real time server: when it says the
  // computer's own clock is in spec, no correction is wanted.
  if (c.ntpLevel === 'ok') return { ok: false, error: 'ntp-ok' };
  // A measured offset is relative to the RAW clock: the phone compares its own
  // time with Date.now() stamps, so an earlier correction does not compound.
  return { ok: true, aheadMs: Math.round(off) };
}

/** Text for the log and the result, one wording everywhere. */
function describeApplyError(error) {
  switch (error) {
    case 'guest-pass': return 'A Guest Pass cannot set the shack\'s time.';
    case 'rtt-too-high': return 'The connection is too slow to measure the time accurately.';
    case 'ntp-ok': return 'The shack\'s clock is already correct (checked against an internet time server).';
    case 'bad-value': return 'The measurement was not usable (more than a day off means the computer\'s date is wrong; set it first).';
    default: return 'Not applied.';
  }
}

module.exports = {
  MAX_RTT_MS, MAX_ABS_OFFSET_MS,
  now, aheadMs, info, setCorrection, clear,
  decideClockApply, describeApplyError,
};
