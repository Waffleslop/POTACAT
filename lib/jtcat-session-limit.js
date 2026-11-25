// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// JTCAT session limit: "Stop Run and Hunt after N minutes" (W5XY 2026-11-25:
// "Set a timer and it stops running. Same for Hunting."). A plain timer the
// operator sets so they can walk away: when it runs out, Run or Hunt stops,
// whatever is happening on the band.
//
// It is not the "Stop calling after N minutes with no answer" watchdog
// (lib/jtcat-calling-time.js), which counts from the last QSO progress or
// operator action, and not the 30-minute attended limit, which counts from
// the same. This one counts from the moment Run or Hunt was started and
// nothing restarts it but starting again.
//
// Settings (per profile, operating policy):
//   jtcatSessionLimitOn   true = on. Anything else (missing, false) is off.
//   jtcatSessionLimitMin  whole minutes, default 60, clamped to 5..240.
//
// Rules (main.js is glue; this module decides):
//   - start() when the operator starts Run, or turns Hunt on from off, on any
//     surface (the JTCAT window, the phone, ECHOCAT Web). The Hunt-to-Run
//     fallback is part of the Hunt session and does not start it again.
//     Starting again starts the count again.
//   - noteStop(kind) when Run or Hunt is stopped any other way: the timer of
//     that kind is cleared. decide() also clears it once nothing is running.
//   - At the deadline a contact in progress (a partner, not yet done) is let
//     finish, through its RR73/73 and logging or until the stall logic gives
//     up on it; then it stops. A Run CQ with nobody answering is not a
//     contact, so it stops at once.
//   - After the deadline nothing new starts: mayStartNew() is false, so Run
//     calls no new CQ and Hunt calls no new station.
//   - It only ever stops. It never keys, never calls, never changes TX.
//
// Dual-mode: main.js requires it; the JTCAT window loads it as
// window.JtcatSessionLimit so its box clamps the same way.
'use strict';

(function () {
const LIMIT_DEFAULT_MIN = 60;
const LIMIT_MIN_MIN = 5;
const LIMIT_MAX_MIN = 240;
const LIMIT_MINUTE_MS = 60 * 1000;

/** Any input -> whole minutes in 5..240; blank, null or not a number -> 60. */
function clampMinutes(v) {
  if (v == null || (typeof v === 'string' && !v.trim())) return LIMIT_DEFAULT_MIN;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return LIMIT_DEFAULT_MIN;
  return Math.max(LIMIT_MIN_MIN, Math.min(LIMIT_MAX_MIN, n));
}

/** Off unless the operator ticked it (a missing key reads off). */
function isOn(settings) {
  return !!(settings && settings.jtcatSessionLimitOn === true);
}

function createState() {
  return { kind: null, owner: null, startedAt: 0, deadline: 0, minutes: 0 };
}

function clear(state) {
  state.kind = null;
  state.owner = null;
  state.startedAt = 0;
  state.deadline = 0;
  state.minutes = 0;
  return state;
}

/**
 * Run or Hunt was started. kind 'run' | 'hunt'; owner 'popout' | 'remote'.
 * Off in settings = no timer (any old one is cleared).
 */
function start(state, opts) {
  const o = opts || {};
  clear(state);
  if (!isOn(o.settings)) return state;
  if (o.kind !== 'run' && o.kind !== 'hunt') return state;
  const minutes = clampMinutes(o.settings.jtcatSessionLimitMin);
  state.kind = o.kind;
  state.owner = o.owner === 'remote' ? 'remote' : 'popout';
  state.startedAt = o.now;
  state.deadline = o.now + minutes * LIMIT_MINUTE_MS;
  state.minutes = minutes;
  return state;
}

/** Run or Hunt was stopped some other way: a timer of that kind ends with it. */
function noteStop(state, kind) {
  if (state.kind && state.kind === kind) clear(state);
  return state;
}

function isArmed(state) {
  return !!(state && state.deadline > 0);
}

function expired(state, now) {
  return isArmed(state) && now >= state.deadline;
}

/** False once the time is up: no new CQ, no new Hunt call. */
function mayStartNew(state, now) {
  return !expired(state, now);
}

/** A contact with a partner that has not finished. A Run CQ shell has no partner. */
function qsoInProgress(qso) {
  return !!(qso && qso.call && qso.phase !== 'done');
}

/**
 * Once per decode cycle.
 * @param {object} a { now, running: Run or Hunt is on, qsoInProgress }
 * @returns {'none'|'clear'|'wait'|'stop'}
 */
function decide(state, a) {
  if (!isArmed(state)) return 'none';
  if (!a.running) return 'clear';
  if (!expired(state, a.now)) return 'none';
  if (a.qsoInProgress) return 'wait';
  return 'stop';
}

function minutesLeft(state, now) {
  if (!isArmed(state)) return 0;
  return Math.max(0, Math.ceil((state.deadline - now) / LIMIT_MINUTE_MS));
}

const kindLabel = (kind) => (kind === 'run' ? 'Run' : 'Hunt');

/** The short line beside Run and Hunt: "Run: 42 min left". '' when no timer. */
function statusText(state, now) {
  if (!isArmed(state)) return '';
  const who = kindLabel(state.kind);
  if (expired(state, now)) return `${who}: time is up, stopping after this contact`;
  return `${who}: ${minutesLeft(state, now)} min left`;
}

/** The stop reason for the log and the phone's Run toast. */
function stopReason(state) {
  return `time limit (${state.minutes} min)`;
}

/** The line the JTCAT window shows after the stop. */
function stopNotice(state) {
  return `${kindLabel(state.kind)} stopped: your ${state.minutes}-minute limit ran out.`;
}

// Function scope (see lib/jtcat-calling-time.js): the JTCAT window's preload
// owns some globals, so nothing here is declared at the top level.
const jtcatSessionLimitApi = {
  DEFAULT_MIN: LIMIT_DEFAULT_MIN, MIN_MIN: LIMIT_MIN_MIN, MAX_MIN: LIMIT_MAX_MIN,
  clampMinutes, isOn, createState, clear, start, noteStop, isArmed, expired,
  mayStartNew, qsoInProgress, decide, minutesLeft, statusText, stopReason, stopNotice,
};
if (typeof module !== 'undefined' && module.exports) module.exports = jtcatSessionLimitApi;
if (typeof window !== 'undefined') window.JtcatSessionLimit = jtcatSessionLimitApi;
})();
