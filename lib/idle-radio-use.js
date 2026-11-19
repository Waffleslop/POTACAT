'use strict';
/**
 * Who is using the radio, as far as Idle Mode is concerned (SSTV, WSPR, PSK31,
 * JTTY, JS8 on idle). Someone using the radio restarts the idle countdown,
 * keeps an idle session from starting, and keeps a running one from retuning.
 *
 * APRS "Listen on my radio" is use of the radio: on air 2026-11-18 (FLEX-8600M,
 * 30 m APRS) nothing held Idle Mode off while it listened, so 90 minutes after
 * the switch went on Idle Mode would have retuned the radio away from the APRS
 * frequency.
 */

/** "Listen on my radio" has the radio: starting, listening, or paused while Winlink borrows it. */
function aprsListenHoldsRadio(listen) {
  if (!listen || !listen.on) return false;
  return listen.state === 'starting' || listen.state === 'listening' || listen.state === 'paused';
}

/**
 * '' when nobody uses the radio, else who: 'jtcat' | 'aprs' | 'remote'.
 * A connected ECHOCAT device only holds off a session that has not started
 * (W0TLP 2026-11-02); a running session is left alone by a device that watches it.
 */
function radioInUse({ jtcatDecoding = false, aprsListening = false, remoteWatching = false, idleActive = false } = {}) {
  if (jtcatDecoding) return 'jtcat';
  if (aprsListening) return 'aprs';
  if (remoteWatching && !idleActive) return 'remote';
  return '';
}

/** '' when Idle Mode may start now, else why not: 'jtcat' | 'aprs'. */
function idleStartBlocker({ jtcatDecoding = false, aprsListening = false } = {}) {
  if (jtcatDecoding) return 'jtcat';
  if (aprsListening) return 'aprs';
  return '';
}

/** The one log line per deferral. */
function deferLine(reason) {
  if (reason === 'aprs') return '[Auto-RX] Deferred — APRS is listening on the radio (silenced until it stops)';
  return '[Auto-RX] Deferred — JTCAT is already decoding (silenced until it stops)';
}

/** A running idle session may move the radio (sunrise/sunset band change) only when APRS is not listening. */
function idleMayRetune({ aprsListening = false } = {}) {
  return !aprsListening;
}

/** How long after an idle session ends its place still counts (the switch that ended it is the same click). */
const IDLE_HANDOVER_MS = 5000;
const NEAR_HZ = 1000;
const near = (a, b) => Number(a) > 0 && Number(b) > 0 && Math.abs(Number(a) - Number(b)) <= NEAR_HZ;

/**
 * Where APRS listening sends the radio back (Casey 2026-11-19: "return point
 * is the frequency before idle mode"). An idle session (Auto-SSTV, WSPR,
 * PSK31, JTTY, JS8) moved the radio to its own frequency; the place to go back
 * to is where that session found the radio, not the idle frequency.
 *  - here: {freqHz, mode} read from the radio now (lib/radio-tune-route.js placeBefore)
 *  - active/home: an idle session running now, and where it found the radio
 *  - last: the session that just ended {freqHz, mode, endedAt, endedHz}: the
 *    click on the switch ends it first (markUserActive), so its place still
 *    counts for IDLE_HANDOVER_MS while the radio has not been moved since.
 * Returns {freqHz, mode, from: 'idle' | 'here'}.
 */
function listenReturnPoint(here, { active = false, home = null, last = null, nowHz = 0, now = Date.now() } = {}) {
  const h = here || {};
  const usable = (p) => !!(p && Number(p.freqHz) > 0);
  // The radio is still where the idle session found it (APRS-on-idle tunes nothing first): the
  // reading now wins, as it carries the route's mode form (an Icom's DIGU, the Flex slice's).
  const pick = (p) => (near(p.freqHz, h.freqHz)
    ? { freqHz: Number(h.freqHz), mode: String(h.mode || p.mode || ''), from: 'here' }
    : { freqHz: Number(p.freqHz), mode: String(p.mode || h.mode || ''), from: 'idle' });
  if (active && usable(home)) return pick(home);
  if (!active && usable(last) && Number(now) - Number(last.endedAt || 0) <= IDLE_HANDOVER_MS &&
      (!Number(nowHz) || near(nowHz, last.endedHz) || near(nowHz, last.freqHz))) return pick(last);
  return { freqHz: Number(h.freqHz) || 0, mode: String(h.mode || ''), from: 'here' };
}

module.exports = { aprsListenHoldsRadio, radioInUse, idleStartBlocker, deferLine, idleMayRetune, listenReturnPoint, IDLE_HANDOVER_MS };
