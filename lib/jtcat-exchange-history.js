'use strict';
// The signal reports each station exchanged with us on the air, per band and
// mode (#1060). A QSO started by clicking a station's RR73 while the JTCAT
// window (or ECHOCAT) was busy with another station or a CQ was built with no
// reports, because the reports lived only in the earlier QSO object, which
// had been replaced. jtcatAutoLog then skipped it ("no signal reports
// exchanged") without a word: three finished contacts lost in one session on
// 20 m FT8, 1.14.8. Main notes every decoded report addressed to us and every
// report we actually transmitted (the tx-start dispatch, after every TX-block
// guard), and fills a 73 QSO's missing reports from here before it logs.
//
// Reports are stored as the state machine stores them: "-05", "+03", never
// with the R. `report` is theirs to us (RST_RCVD), `sentReport` is ours to
// them (RST_SENT). The latest of each wins.

const JtcatParser = require('../renderer/jtcat-parser');

// Matches the default re-log cool-down (lib/jtcat-relog-guard.js), so a QSO
// logged from these reports cannot be logged again from the same ones.
const DEFAULT_TTL_MS = 15 * 60 * 1000;
const REPORT_RE = /^R?([+-]\d{2})$/;

function _call(tok) {
  const c = String(tok || '').trim().toUpperCase().replace(/[<>]/g, '');
  return c && c !== '...' && JtcatParser.looksLikeCallsign(c) ? c : '';
}
function _key(call, band, mode) {
  return `${_call(call)}|${String(band || '').trim().toUpperCase()}|${String(mode || '').trim().toUpperCase()}`;
}
// The three-token halves of a message: "A B C" or "A B C; D E F".
function _segments(text) {
  return String(text || '').toUpperCase().split(';')
    .map((s) => s.trim().split(/\s+/).filter(Boolean))
    .filter((t) => t.length === 3);
}

class JtcatExchangeHistory {
  constructor({ ttlMs = DEFAULT_TTL_MS, max = 2000, now = () => Date.now() } = {}) {
    this._ttl = ttlMs; this._max = max; this._now = now;
    this._map = new Map(); // CALL|BAND|MODE -> { report, reportAt, sentReport, sentAt }
  }

  _set(call, band, mode, field, value) {
    const k = _key(call, band, mode);
    const at = this._now();
    const e = this._map.get(k) || {};
    this._map.delete(k);
    e[field] = value; e[field === 'report' ? 'reportAt' : 'sentAt'] = at;
    this._map.set(k, e);
    if (this._map.size > this._max) this._map.delete(this._map.keys().next().value);
  }

  /**
   * A decoded message. Notes their report when it is addressed to us:
   * "MYCALL THEIRCALL -05" or "MYCALL THEIRCALL R-05" (either half of a
   * compound message). Our own transmission decoded back starts with their
   * call, never ours, so it is never read as theirs (the N3VD echo rule).
   */
  noteHeard(text, myCall, band, mode) {
    const me = JtcatParser.normalizeCall(myCall);
    if (!me) return false;
    let noted = false;
    for (const t of _segments(text)) {
      const m = t[2].match(REPORT_RE);
      const them = _call(t[1]);
      if (!m || !them || JtcatParser.normalizeCall(t[0]) !== me || JtcatParser.normalizeCall(them) === me) continue;
      this._set(them, band, mode, 'report', m[1]);
      noted = true;
    }
    return noted;
  }

  /** A transmission that is starting: "THEIRCALL MYCALL -10" or "... R-10". */
  noteSent(message, myCall, band, mode) {
    const me = JtcatParser.normalizeCall(myCall);
    if (!me) return false;
    let noted = false;
    for (const t of _segments(message)) {
      const m = t[2].match(REPORT_RE);
      const them = _call(t[0]);
      if (!m || !them || JtcatParser.normalizeCall(t[1]) !== me || JtcatParser.normalizeCall(them) === me) continue;
      this._set(them, band, mode, 'sentReport', m[1]);
      noted = true;
    }
    return noted;
  }

  /** { report, sentReport } exchanged with `call` on this band and mode within the TTL; '' when not. */
  get(call, band, mode) {
    const e = this._map.get(_key(call, band, mode));
    const out = { report: '', sentReport: '' };
    if (!e) return out;
    const now = this._now();
    if (e.report && now - e.reportAt <= this._ttl) out.report = e.report;
    if (e.sentReport && now - e.sentAt <= this._ttl) out.sentReport = e.sentReport;
    return out;
  }

  get size() { return this._map.size; }
}

/**
 * Fill a QSO's missing reports from the history. Only an empty field is
 * filled; a report the QSO already holds is never replaced. Returns the
 * names of the fields it filled ([] when none).
 */
function fillMissingReports(q, found) {
  const filled = [];
  if (!q || !found) return filled;
  if (!q.report && found.report) { q.report = found.report; filled.push('report'); }
  if (!q.sentReport && found.sentReport) { q.sentReport = found.sentReport; filled.push('sentReport'); }
  return filled;
}

/** True when the QSO has a report either way, the bar jtcatAutoLog and txLogsQso set. */
function hasReports(q) {
  return !!(q && (q.report || q.sentReport));
}

/** The window's notice when a 73 to a station with no report on record cannot be logged. */
function notLoggedNotice(call, band, mode) {
  const c = String(call || '').toUpperCase();
  const where = [String(band || '').toUpperCase(), String(mode || '').toUpperCase()].filter(Boolean).join(' ');
  return {
    message: `${c} not logged`,
    sub: `No signal reports with ${c}${where ? ' on ' + where : ''} were heard or sent this session. If the QSO was complete, add it in the Logbook.`,
  };
}

module.exports = { JtcatExchangeHistory, fillMissingReports, hasReports, notLoggedNotice, DEFAULT_TTL_MS };
