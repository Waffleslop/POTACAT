'use strict';

// JTCAT Spot Target: when a finished QSO ends the target, and when the
// watcher must not call (#518).
//
// Clicking an FT8/FT4 spot arms a target ('armed'); the watcher in main.js
// calls the station on their next CQ or tail-end RR73 and marks it 'engaged'.
// If the operator answered that station himself (double-click or Hunt) before
// the watcher fired, the target stayed 'armed'. The QSO finished and was
// logged, but the done-blocks only cleared an 'engaged' target, so the
// watcher then called the station again with the grid on their next CQ, as
// if the QSO had never happened, until the 10-minute expiry.
//
// Two rules close it:
//   1. Any finished QSO (done, Skip, Cancel) with the target's call clears the
//      target, whatever its status.
//   2. The watcher refuses to call a station that is already worked (the
//      session, the Log QSO review hold, or the log per worked-before policy).
//
// Pure: main owns the target, the worked check and the log line.

const JtcatParser = require('../renderer/jtcat-parser');

/** Does a QSO with `qsoCall` that just finished (done, Skip or Cancel) end
 *  this spot target? True when the calls are the same station, whatever the
 *  target's status ('armed' or 'engaged'). */
function qsoEndClearsTarget(target, qsoCall) {
  if (!target || !target.call || !qsoCall) return false;
  const a = JtcatParser.normalizeCall(target.call);
  return !!a && a === JtcatParser.normalizeCall(qsoCall);
}

/** Must the watcher refuse to call this target? `isWorked(call)` is main's
 *  jtcatIsWorkedCall on the current band and mode. */
function watcherRefusesWorked(target, isWorked) {
  if (!target || !target.call || typeof isWorked !== 'function') return false;
  return !!isWorked(target.call);
}

/** The one CAT log line for a refusal. */
function refusalLogLine(call, band, mode) {
  const where = [band, mode].filter(Boolean).join(' ');
  return `[JTCAT] Spot target ${call} already worked${where ? ' on ' + where : ''}: not calling again`;
}

module.exports = { qsoEndClearsTarget, watcherRefusesWorked, refusalLogLine };
