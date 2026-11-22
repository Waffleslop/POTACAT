// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// What POTACAT does when Pat (the Winlink mail program it runs) still reports
// a call that POTACAT has already ended (#430).
//
// How Pat gets there. Abort tells Pat to disconnect and ends POTACAT's session
// six seconds later whatever Pat says; ending the session stops the modem. Pat
// is then waiting on a modem that is gone and goes on reporting "connected".
// Seen in the no-RF loopback for more than two minutes, twice; it did not clear
// until POTACAT was restarted. The old rule refused every Connect in that state
// with "Pat is still on the last call — wait a few seconds and try again", and
// waiting never helped.
//
// Why the check exists at all. A VARA dial that was waiting for a clear channel
// ignored the first disconnect and went on dialing when the channel cleared
// (K3SBP 2026-10-23: 45 s of PTT requests after Stop). A new session started on
// top of that collided at Pat ("Session failure"). So a Connect must never go
// ahead while Pat still reports a call.
//
// The rule now: when Pat reports a call and no session of POTACAT's is running,
// that call is nobody's. Pat is restarted (its process is stopped and started
// again, which ends any dial with it), Pat is asked again, and the Connect goes
// ahead only when Pat then reports no call. Otherwise it is refused, in words
// that are true: "Winlink is restarting. Try again in a few seconds."
//
// Pure: no fs, no Electron, no clock. main.js supplies the four actions.

'use strict';

const RESTARTING_TEXT = 'Winlink is restarting. Try again in a few seconds.';

// How long after an Abort POTACAT looks at Pat by itself, so that the next
// Connect finds Pat ready. The session is ended 6 s after the Abort at the
// latest; this is after that.
const AFTER_ABORT_CHECK_MS = 10000;

/**
 * Pat's /api/status in one word: 'on' (it reports a link), 'hanging up' (it
 * reports a dial), '' (no call, or nothing readable). Pat's keys have varied
 * in case between versions.
 */
function patBusyWord(st) {
  if (!st || typeof st !== 'object') return '';
  const v = (k) => (st[k] !== undefined ? st[k] : st[k.charAt(0).toUpperCase() + k.slice(1)]);
  if (v('connected')) return 'on';
  if (v('dialing')) return 'hanging up';
  return '';
}

/**
 * The next step of a Connect, from what is known so far.
 *
 * @param {object} o
 * @param {string} o.busy            patBusyWord() of Pat's status now
 * @param {boolean} o.sessionActive  a session of POTACAT's is running
 * @param {boolean} o.restarted      Pat has been restarted for this Connect already
 * @param {boolean} [o.restartOk]    that restart brought Pat back
 * @returns {'go'|'restart'|'refuse'}
 */
function connectStep({ busy, sessionActive, restarted, restartOk } = {}) {
  // A running session is refused by its own rule before this is asked. If it
  // is asked anyway, Pat is never restarted under a session.
  if (sessionActive) return 'refuse';
  if (restarted) return restartOk && !busy ? 'go' : 'refuse';
  return busy ? 'restart' : 'go';
}

/**
 * What the check that runs by itself after an Abort does.
 * @returns {'restart'|'leave'}
 */
function afterAbortStep({ busy, sessionActive, patRunning } = {}) {
  if (!patRunning) return 'leave';       // nothing to restart; the next use starts Pat
  if (sessionActive) return 'leave';     // the operator has connected again; that Connect asked Pat itself
  return busy ? 'restart' : 'leave';
}

/**
 * Clear the way for a Connect.
 *
 * @param {object} d
 * @param {() => Promise<string>} d.busy       patBusyWord() of Pat's status now
 * @param {() => boolean} d.sessionActive
 * @param {(why: string) => Promise<boolean>} d.restart  stop Pat and start it again; true when it answers
 * @param {(line: string) => void} [d.log]
 * @returns {Promise<{ok: boolean, restarted: boolean, error?: string, reason?: string}>}
 */
async function clearForConnect({ busy, sessionActive, restart, log = () => {} }) {
  let word = await busy();
  let step = connectStep({ busy: word, sessionActive: sessionActive(), restarted: false });
  if (step === 'go') return { ok: true, restarted: false };
  if (step === 'restart') {
    log(`Pat still reports the last call (${word === 'on' ? 'connected' : 'dialing'}) and no session is running: restarting Pat before this Connect`);
    let restartOk = false;
    try { restartOk = !!(await restart(`it still reported the last call (${word === 'on' ? 'connected' : 'dialing'})`)); } catch (e) { log(`Pat could not be restarted: ${(e && e.message) || e}`); }
    word = restartOk ? await busy() : word;
    step = connectStep({ busy: word, sessionActive: sessionActive(), restarted: true, restartOk });
    if (step === 'go') { log('Pat is back and reports no call: the Connect goes ahead'); return { ok: true, restarted: true }; }
    log(restartOk ? `Pat is back but still reports a call (${word}): the Connect is refused` : 'Pat did not come back: the Connect is refused');
    return { ok: false, restarted: true, error: RESTARTING_TEXT, reason: 'pat-restarting' };
  }
  return { ok: false, restarted: false, error: RESTARTING_TEXT, reason: 'pat-restarting' };
}

/**
 * The check that runs by itself after an Abort: restart Pat when it is still
 * on a call nobody owns, so the next Connect does not have to.
 * @returns {Promise<'restarted'|'restart-failed'|'left'>}
 */
async function afterAbort({ busy, sessionActive, patRunning, restart, log = () => {} }) {
  if (!patRunning() || sessionActive()) return 'left';
  const word = await busy();
  if (afterAbortStep({ busy: word, sessionActive: sessionActive(), patRunning: patRunning() }) !== 'restart') return 'left';
  log(`after the Abort, Pat still reports the last call (${word === 'on' ? 'connected' : 'dialing'}): restarting Pat so the next Connect is ready`);
  let ok = false;
  try { ok = !!(await restart(`it still reported the last call after an Abort (${word === 'on' ? 'connected' : 'dialing'})`)); } catch (e) { log(`Pat could not be restarted: ${(e && e.message) || e}`); }
  return ok ? 'restarted' : 'restart-failed';
}

module.exports = {
  RESTARTING_TEXT,
  AFTER_ABORT_CHECK_MS,
  patBusyWord,
  connectStep,
  afterAbortStep,
  clearForConnect,
  afterAbort,
};
