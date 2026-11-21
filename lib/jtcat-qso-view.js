'use strict';
// Which JTCAT QSO phase an ECHOCAT client is shown (#807 follow-up).
//
// Since #807 a QSO enters '73' (reply side) or 'cq-rr73' (CQ side) when our
// RR73 is QUEUED, and is logged when that RR73 starts going out (or when
// their RR73 arrives). ECHOCAT phone builds up to 1.5.x show a "QSO Logged"
// toast on the change into either phase, so a QSO halted before the RR73 went
// out (Halt, cancel, a newer QSO, a TX block) was reported as logged when it
// was not. Those phones are in the field until they update.
//
// The rule: a client whose hello does not declare 'jtcat-qso-logged' keeps
// seeing the phase it was last shown for that station while the QSO sits in
// a logging phase unlogged; the real phase reaches it once the write is done
// (main.js re-broadcasts after it), so its toast lands at the real log. A QSO
// that never logs goes on to done / idle / error without that client ever
// seeing the logging phase. A client that declares the capability (ECHOCAT
// Web) gets the real state: it learns about the log from jtcat-qso-logged.
// Only the wire copy changes; the engine's QSO object is never touched.

const CAP = 'jtcat-qso-logged';
const LOGGING_PHASES = ['73', 'cq-rr73'];

function isLoggingPhase(phase) {
  return LOGGING_PHASES.indexOf(phase) >= 0;
}

// Written to the log: jtcatAutoLog sets _logged before the write and
// _logFailed when the write did not go in.
function isLogged(q) {
  return !!(q && q._logged && !q._logFailed);
}

function holdsForOldClient(q) {
  return !!(q && q.call && isLoggingPhase(q.phase) && !isLogged(q));
}

// The last phase worth holding on, per station: a non-logging phase of a QSO
// with a call. `shown` is { call, phase } or null.
function rememberShown(shown, q) {
  if (!q || !q.call) return null;
  if (!isLoggingPhase(q.phase)) return { call: q.call, phase: q.phase };
  return shown && shown.call === q.call ? shown : null;
}

// Nothing remembered for this station (it went straight to the RR73, or the
// server only just started): the step before the RR73 on its ladder.
function stepBefore(q) {
  if (q.fd) return q.mode === 'cq' ? 'cq' : 'reply';
  return q.mode === 'cq' ? 'cq-report' : 'r+report';
}

// The jtcat-qso-state body for one client. Returns `q` itself when nothing
// changes, else a copy with only the phase replaced.
function qsoStateFor(q, opts) {
  const o = opts || {};
  if (o.knowsLogged || !holdsForOldClient(q)) return q;
  const shown = o.shown && o.shown.call === q.call ? o.shown.phase : null;
  return Object.assign({}, q, { phase: shown || stepBefore(q) });
}

module.exports = { CAP, LOGGING_PHASES, isLoggingPhase, isLogged, holdsForOldClient, rememberShown, qsoStateFor };
