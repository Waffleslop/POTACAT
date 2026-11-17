'use strict';
// ECHOCAT's "logged" reply goes out once the record is on disk (activation
// review 2026-11-17, fix 5, #732).
//
// saveQsoRecord writes the record, then forwards it to the external loggers
// and QRZ Logbook, looks the call up for the respot comment, re-spots it and
// uploads a SOTA chase. The phone's log-ok used to wait for all of that, so on
// a weak link it waited tens of seconds for a QSO saved long before, and a
// phone that slept meanwhile never heard it.
//
// untilWritten() lets a caller go on as soon as the save says "written"
// (opts.onWritten), while the slow steps finish in the background. Their
// outcome is still reported: the steps keep their own log lines and toasts,
// and the respot result comes back through `after` for a follow-up log-ok.
//
// Pure: no Electron, no network.

const RESPOT_ERROR_KEYS = ['respotError', 'wwffRespotError', 'llotaRespotError', 'wwbotaRespotError', 'gmaRespotError', 'dxcRespotError'];

/**
 * Start a save and resolve when its record is written, or when the save ends
 * without writing (refused, suppressed). `start(onWritten)` begins the save
 * and returns its promise; the save calls onWritten(info) right after the
 * disk write.
 *
 * @returns {Promise<{ result: object, after: Promise<object> }>} result: the
 *   save's own result when it ended first, else { success: true, ...info };
 *   after: the save's final result. It never rejects: a throw after the
 *   write becomes { success: true, afterError } (the record is saved), one
 *   before it { success: false, error } (the result already reported it).
 */
function untilWritten(start) {
  let wrote = null;
  let signal;
  const written = new Promise((resolve) => { signal = resolve; });
  const done = Promise.resolve().then(() => start((info) => { wrote = info || {}; signal(); }));
  const after = done.catch((err) => {
    const message = (err && err.message) || String(err);
    return wrote ? { success: true, afterError: message } : { success: false, error: message };
  });
  return Promise.race([
    written.then(() => ({ result: { success: true, ...wrote }, after })),
    done.then((result) => (wrote ? { result: { success: true, ...wrote }, after } : { result, after })),
  ]);
}

/** The respot outcome of several saves (one contact can be several records). */
function mergeAfterResults(results) {
  let resposted = false;
  let respotError = '';
  for (const r of results || []) {
    if (!r) continue;
    if (r.resposted) resposted = true;
    if (!respotError) {
      for (const k of RESPOT_ERROR_KEYS) if (r[k]) { respotError = String(r[k]); break; }
    }
  }
  return { resposted, respotError };
}

/**
 * The follow-up log-ok for a reply sent before the respot ran: the same reply
 * (so a device that missed the first one still gets every record), marked
 * followUp, with the respot outcome. Null when there is no outcome to tell.
 */
function respotFollowUp(reply, outcome) {
  const o = outcome || {};
  if (!reply || (!o.resposted && !o.respotError)) return null;
  return { ...reply, followUp: true, resposted: !!o.resposted, respotError: o.respotError || '' };
}

module.exports = { untilWritten, mergeAfterResults, respotFollowUp, RESPOT_ERROR_KEYS };
