// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// JTCAT calling time (#161): how long FT8, FT4 and FT2 keep transmitting with
// no answer that moves a QSO on and nothing from the operator, before the
// transmit watchdog stops TX. WSJT-X calls this its Tx watchdog and lets the
// operator set it; POTACAT had it fixed at 6 minutes (lloyd KO4L 2026-10-25)
// until operators asked for it to be adjustable (2026-11-05, 2026-11-13).
//
// Setting (per profile, operating policy): jtcatCallingTimeMin, whole minutes,
// default 6, clamped to 1..30. The ceiling is the attended-operator limit that
// already bounds Run and Hunt (JTCAT_FULL_AUTO_CQ_WATCHDOG_MS in main.js,
// 30 minutes): no value of this setting lets JTCAT call longer with nobody at
// the radio than that rule allows. Anything unreadable reads as the default.
//
// Dual-mode: main.js requires it; the JTCAT window loads it as
// window.JtcatCallingTime so its box clamps the same way.
'use strict';

(function () {
const DEFAULT_MIN = 6;
const MIN_MIN = 1;
const MAX_MIN = 30;

/** Any input -> whole minutes in 1..30; blank, null or not a number -> 6. */
function clampMinutes(v) {
  if (v == null || (typeof v === 'string' && !v.trim())) return DEFAULT_MIN;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return DEFAULT_MIN;
  return Math.max(MIN_MIN, Math.min(MAX_MIN, n));
}

/** The watchdog span in ms for a settings object (settings.jtcatCallingTimeMin). */
function callingTimeMs(settings) {
  return clampMinutes(settings && settings.jtcatCallingTimeMin) * 60 * 1000;
}

// Function scope (see lib/jtcat-snr-floor.js): the JTCAT window's preload owns
// some globals, so nothing here is declared at the top level.
const jtcatCallingTimeApi = { DEFAULT_MIN, MIN_MIN, MAX_MIN, clampMinutes, callingTimeMs };
if (typeof module !== 'undefined' && module.exports) module.exports = jtcatCallingTimeApi;
if (typeof window !== 'undefined') window.JtcatCallingTime = jtcatCallingTimeApi;
})();
