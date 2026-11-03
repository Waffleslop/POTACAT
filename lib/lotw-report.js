// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// LoTW Phase 3 — confirmation download (docs/tqsl-lotw-plan.md). Different
// auth than upload: the user's LoTW WEBSITE login (not the TQSL cert),
// because lotwreport.adi is a web report, not a tqsl operation. LoTW's
// documented API takes the credentials as HTTPS query parameters — that is
// the mechanism every logger uses; the password must never reach a log
// line. Pure URL building / ADIF parsing / matching here; main owns the
// socket and the file rewrite.
'use strict';

const LOTW_REPORT_HOST = 'lotw.arrl.org';
const LOTW_REPORT_PATH = '/lotwuser/lotwreport.adi';

/**
 * Query for "every QSL record, optionally only ones LoTW issued since
 * `qslSince` (YYYY-MM-DD)". qso_qsldetail=yes adds DXCC/state/grid detail
 * fields; harmless if unused and useful later.
 */
function buildLotwReportQuery({ login, password, qslSince }) {
  const p = new URLSearchParams();
  p.set('login', String(login || ''));
  p.set('password', String(password || ''));
  p.set('qso_query', '1');
  p.set('qso_qsl', 'yes');
  p.set('qso_qsldetail', 'yes');
  if (qslSince) p.set('qso_qslsince', String(qslSince));
  return { host: LOTW_REPORT_HOST, path: LOTW_REPORT_PATH + '?' + p.toString() };
}

/** Minimal ADIF record scanner for LoTW's report body. Returns an array of
 *  field maps (keys uppercased). Tolerates the text preamble LoTW puts
 *  before <eoh> and the <APP_LoTW_*> fields. */
function parseLotwAdif(text) {
  const s = String(text || '');
  const eoh = s.search(/<eoh>/i);
  const body = eoh >= 0 ? s.slice(eoh + 5) : s;
  const records = [];
  let cur = {};
  const re = /<([A-Za-z0-9_]+)(?::(\d+))?(?::[A-Za-z])?>/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const name = m[1].toUpperCase();
    if (name === 'EOR') {
      if (Object.keys(cur).length) records.push(cur);
      cur = {};
      continue;
    }
    const len = parseInt(m[2] || '0', 10);
    cur[name] = body.substr(re.lastIndex, len).trim();
  }
  return records;
}

/** True when LoTW's login rejection page came back instead of ADIF. LoTW
 *  answers HTTP 200 with an HTML "password incorrect" page, so the body is
 *  the only signal. */
function looksLikeLotwAuthFailure(text) {
  const s = String(text || '');
  if (/<eoh>/i.test(s)) return false;
  return /password|username|not valid|invalid|log in/i.test(s) && /<html|<!doctype/i.test(s);
}

/**
 * Match LoTW QSL records against the log (parseAllRawQsos array, mutated)
 * and stamp LOTW_QSL_RCVD=Y + LOTW_QSLRDATE (+ QSLRDATE never touched —
 * that's the paper-card field). Matching key: CALL|QSO_DATE|HHMM — the
 * records came from OUR upload, so times agree; band is cross-checked
 * when both sides have one to guard same-minute dupe-call collisions.
 * Returns { confirmed, alreadyConfirmed, unmatched: [...keys] }.
 */
function stampLotwConfirmations(qsos, lotwRecords, lotwKeyFn) {
  const byKey = new Map();
  for (const q of qsos) {
    if (!q || !q.CALL) continue;
    const key = lotwKeyFn(q.CALL, q.QSO_DATE, q.TIME_ON);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(q);
  }
  let confirmed = 0;
  let alreadyConfirmed = 0;
  let detailed = 0;
  const unmatched = [];
  for (const rec of lotwRecords) {
    if (!rec.CALL || String(rec.QSL_RCVD || '').toUpperCase() !== 'Y') continue;
    const key = lotwKeyFn(rec.CALL, rec.QSO_DATE, rec.TIME_ON);
    const candidates = byKey.get(key) || [];
    const band = String(rec.BAND || '').toLowerCase();
    const hit = candidates.find((q) => {
      const qBand = String(q.BAND || '').toLowerCase();
      return !band || !qBand || band === qBand;
    });
    if (!hit) { unmatched.push(`${rec.CALL} ${rec.QSO_DATE} ${rec.TIME_ON || ''} ${rec.BAND || ''}`.trim()); continue; }
    // The other station's CERTIFIED location rides the confirmation
    // (qso_qsldetail=yes): their TQSL station location, the best source a
    // log can have for STATE, county and grid. Fill what the log lacks —
    // never overwrite what the operator typed. Worked All States counts a
    // state only from the STATE field, so this is where most of an
    // operator's states come from (K3SBP 2026-10-23: 289 confirmations,
    // 25 of them with a state in the log).
    if (fillLotwDetail(hit, rec)) detailed++;
    if (String(hit.LOTW_QSL_RCVD || '').toUpperCase() === 'Y') { alreadyConfirmed++; continue; }
    hit.LOTW_QSL_RCVD = 'Y';
    if (rec.QSLRDATE) hit.LOTW_QSLRDATE = rec.QSLRDATE;
    // A LoTW confirmation implies the upload happened even if the sent
    // flag predates Phase 1.5 — backfill it so the ledger is coherent.
    if (String(hit.LOTW_QSL_SENT || '').toUpperCase() !== 'Y') hit.LOTW_QSL_SENT = 'Y';
    confirmed++;
  }
  return { confirmed, alreadyConfirmed, unmatched, detailed };
}

/** The location fields a LoTW QSL detail record carries for the OTHER station. */
const LOTW_DETAIL_FIELDS = ['STATE', 'CNTY', 'GRIDSQUARE', 'DXCC', 'COUNTRY', 'CQZ', 'ITUZ', 'IOTA'];

/** Copy LoTW's certified location detail into a log record where the record has none. Returns true when anything was filled. */
function fillLotwDetail(hit, rec) {
  let filled = false;
  for (const f of LOTW_DETAIL_FIELDS) {
    const v = String(rec[f] || '').trim();
    if (!v || String(hit[f] || '').trim()) continue;
    hit[f] = f === 'STATE' || f === 'GRIDSQUARE' ? v.toUpperCase() : v;
    filled = true;
  }
  return filled;
}

module.exports = { buildLotwReportQuery, parseLotwAdif, looksLikeLotwAuthFailure, stampLotwConfirmations, fillLotwDetail, LOTW_DETAIL_FIELDS };
