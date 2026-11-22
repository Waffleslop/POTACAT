// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// APRS: the timed radio beacon, 2 m ONLY (Casey 2026-11-21, "approve all").
// Off by default; never more often than every 10 minutes. It sends the same
// one beacon "Beacon on the radio" sends: the same radio run
// (lib/aprs-rf-beacon.js createRfBeacon), the same gate (lib/aprs-rf-gate.js),
// the same cap. Pure; main.js owns the one setTimeout.
//
//  - 2 m only (TIMER_BANDS). 30 m stays one click per beacon: unattended HF
//    beaconing needs an FCC 97.221 check first. On 30 m the timer waits and
//    says so; it never sends there.
//  - Intervals: Off, 10, 20 or 30 minutes, the internet timer's own choices
//    and floor (lib/aprs-beacon.js intervalMinutes: nothing under 10 min,
//    whatever is asked). The window's pick is saved through
//    lib/aprs-beacon.js settingsPatch (rfIntervalMin), like every beacon key.
//  - Never on a pick or an open, the internet timer's rule (Casey
//    2026-11-19): the first timed beacon is one interval after the later of
//    the last radio beacon and the moment the timer started (picked, the
//    window opened, or the radio came back to 2 m). main starts it (armedAt)
//    whenever no timed beacon is pending, so no restart can send at once.
//  - A timed beacon never comes sooner than the interval after the last radio
//    beacon, manual or timed. The last one's time is kept in settings
//    (aprsRfBeaconLastAt), so a restart never beacons early.
//  - When it is due it sends only while the radio listens on 2 m and the
//    gate allows it; anything else skips that round (one log line) and the
//    next try is a full interval later. It never retries sooner.
//
// Dual-mode: require() in main and tests, window.AprsRfTimer in the window.
(function (root, factory) {
  const api = factory(typeof require === 'function' ? require : null);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AprsRfTimer = api;
})(typeof self !== 'undefined' ? self : this, function (req) {
  'use strict';

  const TIMER_BANDS = Object.freeze(['2m']);
  const INTERVALS = Object.freeze([0, 10, 20, 30]);
  const MIN_INTERVAL_MIN = 10;
  const MAX_INTERVAL_MIN = 30;

  const SENTENCES = Object.freeze({
    band: 'The radio timer runs on 2 m only. On 30 m every beacon is a click.',
    window: 'The radio timer runs only while the APRS window is open.',
    listen: 'The radio timer waits for Listen on my radio on 2 m.',
    busy: 'The radio was sending another packet.',
  });

  /** 0 (off), else 10 to 30 minutes (the internet timer's rule). */
  function intervalMinutes(v) {
    const n = Number(v);
    if (!isFinite(n) || n <= 0) return 0;
    return Math.min(MAX_INTERVAL_MIN, Math.max(MIN_INTERVAL_MIN, Math.round(n)));
  }

  /** The last radio beacon's time from settings: 0 when none, never later than now. */
  function lastAtFrom(st, now) {
    const t = st && Number(st.aprsRfBeaconLastAt);
    if (!t || !isFinite(t) || t < 0) return 0;
    return Math.min(t, now);
  }

  /**
   * Should a timed beacon be pending, and when?
   *   { on: false, reason, sentence? }   off: no timer (reason 'off', 'window', 'band')
   *   { on: true, dueMs }                one setTimeout for dueMs
   * band '' (not listening yet) keeps the timer: the due check decides then.
   */
  function plan({ intervalMin, band, windowOpen, lastAt, armedAt, now }) {
    const min = intervalMinutes(intervalMin);
    if (!min) return { on: false, reason: 'off' };
    if (!windowOpen) return { on: false, reason: 'window', sentence: SENTENCES.window };
    if (band && TIMER_BANDS.indexOf(band) < 0) return { on: false, reason: 'band', sentence: SENTENCES.band };
    const from = Math.max(Number(lastAt) || 0, Number(armedAt) || 0) || now;
    return { on: true, dueMs: Math.max(0, from + min * 60000 - now) };
  }

  /**
   * At the due time: send, or skip this round. null = send (the gate still
   * judges); else { reason, sentence }.
   */
  function dueCheck({ band, listenOn, listenState, busy }) {
    if (TIMER_BANDS.indexOf(band) < 0) return { reason: 'band', sentence: band ? SENTENCES.band : SENTENCES.listen };
    if (!listenOn || listenState !== 'listening') return { reason: 'listen', sentence: SENTENCES.listen };
    if (busy) return { reason: 'busy', sentence: SENTENCES.busy };
    return null;
  }

  return { TIMER_BANDS, INTERVALS, MIN_INTERVAL_MIN, SENTENCES, intervalMinutes, lastAtFrom, plan, dueCheck };
});
