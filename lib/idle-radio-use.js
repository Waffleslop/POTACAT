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

module.exports = { aprsListenHoldsRadio, radioInUse, idleStartBlocker, deferLine, idleMayRetune };
