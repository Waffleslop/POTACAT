// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// Import Log: a record the log already holds is not skipped whole any more.
// Its QSL, LoTW and eQSL received fields are merged into the QSO the log has,
// so importing LoTW's detailed ADIF (or another logger's export) after the
// log is in POTACAT adds the confirmations (#461).
//
// The rules:
//  - "Same contact" is lib/qso-match.js, the rule the import already used.
//  - Only a confirmation (Y, or ADIF's deprecated V) is ever merged. Nothing
//    is downgraded: an existing Y stays, whatever the file says.
//  - Only the received fields change: the status, its date and (paper) the
//    route. A date or route is filled only when the log has none, unless the
//    log's status was not yet a confirmation.
//  - A LoTW confirmation also backfills LOTW_QSL_SENT and fills the other
//    station's certified STATE / county / grid where the log has none,
//    exactly as the LoTW "Download confirmations" path does (lib/lotw-report.js).
//
// LoTW's report (lotwreport.adi, the file lotw.arrl.org hands out) writes its
// confirmation as QSL_RCVD / QSLRDATE, ADIF's PAPER card fields. Its records
// carry APP_LoTW_* fields, so they are recognised and the confirmation is
// moved to LOTW_QSL_RCVD / LOTW_QSLRDATE before anything else sees it: a LoTW
// confirmation never shows as a paper card.
'use strict';

const { ContactIndex } = require('./qso-match');
const { LOTW_DETAIL_FIELDS } = require('./lotw-report');

/** Each received status and the fields that belong to it. */
const RECEIVED = [
  { status: 'QSL_RCVD', extra: ['QSLRDATE', 'QSL_RCVD_VIA'] },
  { status: 'LOTW_QSL_RCVD', extra: ['LOTW_QSLRDATE'] },
  { status: 'EQSL_QSL_RCVD', extra: ['EQSL_QSLRDATE'] },
];

const str = (v) => (v == null ? '' : String(v).trim());
const isConfirmed = (v) => { const s = str(v).toUpperCase(); return s === 'Y' || s === 'V'; };

/** True for a record from LoTW's own report file (it carries APP_LoTW_* fields). */
function isLotwReportRecord(rec) {
  if (!rec) return false;
  for (const k of Object.keys(rec)) if (/^APP_LOTW_/i.test(k)) return true;
  return false;
}

/**
 * A LoTW report record with its confirmation in the LoTW fields instead of
 * the paper ones. Any other record is returned unchanged (same object).
 */
function fromLotwReport(rec) {
  if (!isLotwReportRecord(rec)) return rec;
  const out = { ...rec };
  if (str(out.QSL_RCVD)) {
    if (!str(out.LOTW_QSL_RCVD)) out.LOTW_QSL_RCVD = str(out.QSL_RCVD).toUpperCase();
    delete out.QSL_RCVD;
  }
  if (str(out.QSLRDATE)) {
    if (!str(out.LOTW_QSLRDATE)) out.LOTW_QSLRDATE = str(out.QSLRDATE);
    delete out.QSLRDATE;
  }
  // Every record in LoTW's report was uploaded to LoTW.
  if (!str(out.LOTW_QSL_SENT)) out.LOTW_QSL_SENT = 'Y';
  return out;
}

/**
 * The fields to change on `existing` so it carries the confirmations
 * `incoming` has. Returns null when nothing changes. Never removes a field
 * and never changes a field outside the received set (plus, for a LoTW
 * confirmation, LOTW_QSL_SENT and the empty location fields LoTW certifies).
 */
function confirmationPatch(existing, incoming) {
  if (!existing || !incoming) return null;
  const patch = {};
  let lotwConfirmed = false;
  for (const { status, extra } of RECEIVED) {
    if (!isConfirmed(incoming[status])) continue;
    if (status === 'LOTW_QSL_RCVD') lotwConfirmed = true;
    const had = isConfirmed(existing[status]);
    if (!had) patch[status] = str(incoming[status]).toUpperCase();
    for (const f of extra) {
      const v = str(incoming[f]);
      if (!v) continue;
      if (!had ? v !== str(existing[f]) : !str(existing[f])) patch[f] = f === 'QSL_RCVD_VIA' ? v.toUpperCase() : v;
    }
  }
  if (lotwConfirmed) {
    if (str(existing.LOTW_QSL_SENT).toUpperCase() !== 'Y') patch.LOTW_QSL_SENT = 'Y';
    if (isLotwReportRecord(incoming)) {
      for (const f of LOTW_DETAIL_FIELDS) {
        const v = str(incoming[f]);
        if (!v || str(existing[f])) continue;
        patch[f] = f === 'STATE' || f === 'GRIDSQUARE' ? v.toUpperCase() : v;
      }
    }
  }
  return Object.keys(patch).length ? patch : null;
}

/**
 * planImport (lib/qso-match.js) plus the merge: split incoming records into
 * the ones the log does not have yet (`fresh`), the changes to QSOs it does
 * have (`updates`, one per existing record), and a count of the rest
 * (`skipped`: already there, nothing new to add). Pure: neither the log nor
 * the incoming records are changed; apply the patches with applyUpdates.
 *
 * @returns {{ fresh: object[], updates: Array<{ target: object, patch: object }>, skipped: number }}
 */
function planImportWithConfirmations(existing, incoming) {
  const index = new ContactIndex(existing);
  const inLog = new Set(existing);
  const patches = new Map(); // existing record -> merged patch
  const fresh = [];
  let skipped = 0;
  for (const rec of incoming) {
    if (!rec || !rec.CALL) continue;
    const match = index.findMatch(rec);
    if (!match) { index.add(rec); fresh.push(rec); continue; }
    if (inLog.has(match)) {
      const prior = patches.get(match);
      const patch = confirmationPatch(prior ? { ...match, ...prior } : match, rec);
      if (patch) { patches.set(match, { ...(prior || {}), ...patch }); continue; }
    }
    skipped++;
  }
  const updates = [...patches].map(([target, patch]) => ({ target, patch }));
  return { fresh, updates, skipped };
}

/** Write the planned patches into their records (in place). Returns how many records changed. */
function applyUpdates(updates) {
  for (const { target, patch } of updates) Object.assign(target, patch);
  return updates.length;
}

module.exports = { isLotwReportRecord, fromLotwReport, confirmationPatch, planImportWithConfirmations, applyUpdates, RECEIVED };
