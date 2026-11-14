'use strict';
// A Logbook cell edit -> the fields it really changes on the record.
//
// Most cells are one ADIF field. "My Park" is not: the activation a QSO
// belongs to is MY_SIG (the program) + MY_SIG_INFO (the reference), and the
// writer also mirrors the ref into MY_<PROGRAM>_REF. The cell used to write
// MY_SIG_INFO alone, so a QSO logged as a hunter before Start Activation and
// then given its park in the Logbook had no MY_SIG, and Past Activations
// (which groups by MY_SIG + MY_SIG_INFO + date) never offered it for Resume,
// Export ADIF or Upload to POTA.app (#509).
//
// The program comes from lib/activation-program.js (inferParkProgram), the one
// shape rule the app has. A record already filed under a program whose refs
// share the new ref's shape keeps it: inference cannot tell LLOTA or PARC from
// POTA, and an operator correcting a digit has not changed program.
//
// One reference per record: a multi-park activation is one record per park
// (lib/qso-expand.js), so a list in this cell is refused rather than stored
// as a ref no program would credit.
//
// Their park (the Park cell, SIG_INFO) has the same shape: SIG + SIG_INFO,
// mirrored into <PROGRAM>_REF. Since 12 Nov 2026 POTA.app's uploader reads
// POTA_REF / MY_POTA_REF and, when present, ignores SIG_INFO / MY_SIG_INFO, so
// a corrected Park cell that left the old POTA_REF behind credited the wrong
// park-to-park. Unlike My Park, this cell may hold a list: the AG5B split
// prompt's "save as a single row" keeps "US-1,US-2" on one record, and
// POTA_REF is a comma-delimited list in ADIF. A list is POTA only; the other
// programs' REF fields take one reference.
//
// Used by both edit paths in main.js (the Logbook window and ECHOCAT), inside
// mutateQsoLog, so the cloud journal carries every field changed here.

const { inferParkProgram } = require('./activation-program');
const { PROGRAM_REF_FIELD } = require('./qso-expand');

/** MY_SIG values that name a park / summit program. */
const PARK_PROGRAMS = new Set(Object.keys(PROGRAM_REF_FIELD));
/** Program -> the MY_<PROGRAM>_REF field the ADIF writer mirrors the ref into. */
const MY_REF_FIELD = Object.freeze({
  POTA: 'MY_POTA_REF', SOTA: 'MY_SOTA_REF', WWFF: 'MY_WWFF_REF', LLOTA: 'MY_LLOTA_REF',
});

/** Program -> the <PROGRAM>_REF field the ADIF writer mirrors their ref into. */
const REF_FIELD = Object.freeze({
  POTA: 'POTA_REF', SOTA: 'SOTA_REF', WWFF: 'WWFF_REF', LLOTA: 'LLOTA_REF',
});

const up = (v) => String(v == null ? '' : v).trim().toUpperCase();
/** "us-1, US-2 " -> "US-1,US-2": the one spelling of a ref list. */
const refList = (v) => up(v).split(',').map((r) => r.trim()).filter(Boolean).join(',');

/**
 * Fields for setting (or clearing) My Park on `rec`. Keys whose value is
 * null are to be removed from the record.
 * @returns {{ fields: object } | { error: string }}
 */
function myParkEditFields(rec, value) {
  const ref = up(value);
  const oldSig = up(rec && rec.MY_SIG);
  const oldRef = up(rec && (rec.MY_SIG_INFO || rec.MY_POTA_REF));
  if (/[\s,;]/.test(ref)) {
    return { error: 'My Park takes one reference. A QSO at two parks is one record per park.' };
  }
  const fields = { MY_SIG_INFO: ref || null };
  let sig = '';
  if (ref) {
    sig = inferParkProgram(ref);
    if (PARK_PROGRAMS.has(oldSig) && oldRef && inferParkProgram(oldRef) === sig) sig = oldSig;
    fields.MY_SIG = sig;
  } else if (PARK_PROGRAMS.has(oldSig)) {
    fields.MY_SIG = null;
  }
  // The old ref's mirrors go with it; the new program's mirror follows the ref.
  for (const f of Object.values(MY_REF_FIELD)) {
    if (oldRef && rec && up(rec[f]) === oldRef) fields[f] = null;
  }
  if (ref && MY_REF_FIELD[sig]) fields[MY_REF_FIELD[sig]] = ref;
  return { fields };
}

/**
 * Fields for setting (or clearing) their park (SIG_INFO) on `rec`. Keys whose
 * value is null are to be removed from the record.
 * @returns {{ fields: object } | { error: string }}
 */
function parkEditFields(rec, value) {
  if (/[\s;]/.test(up(value).replace(/\s*,\s*/g, ','))) {
    return { error: 'Park takes references separated by commas, like US-1234,US-5678.' };
  }
  const ref = refList(value);
  const refs = ref ? ref.split(',') : [];
  const oldSig = up(rec && rec.SIG);
  const oldRef = refList(rec && rec.SIG_INFO);
  const oldShape = oldRef ? inferParkProgram(oldRef.split(',')[0]) : '';
  const fields = { SIG_INFO: ref || null };
  let sig = '';
  if (ref) {
    const programs = new Set(refs.map((r) => inferParkProgram(r)));
    sig = programs.size === 1 ? [...programs][0] : '';
    if (sig && PARK_PROGRAMS.has(oldSig) && oldRef && oldShape === sig) sig = oldSig;
    if (refs.length > 1 && sig !== 'POTA') {
      return { error: 'Only POTA parks can share one record. Give each reference its own QSO.' };
    }
    fields.SIG = sig;
  } else if (PARK_PROGRAMS.has(oldSig)) {
    fields.SIG = null;
  }
  // Every copy of the old park goes: the one SIG_INFO named, and a POTA_REF
  // left stale by an edit made before this rule (the cell shows POTA_REF when
  // SIG_INFO is empty, so that copy is what the operator was correcting).
  const stale = new Set([oldRef, refList(rec && rec.POTA_REF)].filter(Boolean));
  for (const f of Object.values(REF_FIELD)) {
    if (rec && stale.has(refList(rec[f]))) fields[f] = null;
  }
  if (ref && REF_FIELD[sig]) fields[REF_FIELD[sig]] = ref;
  return { fields };
}

/**
 * Apply a Logbook edit to one record in place.
 * @returns {{ fields: object } | { error: string }} the fields as written
 *   ('' for a removed field), for the windows that mirror the record.
 */
function applyQsoEdit(rec, fields) {
  let out = { ...(fields || {}) };
  if (Object.prototype.hasOwnProperty.call(out, 'MY_SIG_INFO')) {
    const r = myParkEditFields(rec, out.MY_SIG_INFO);
    if (r.error) return r;
    out = { ...out, ...r.fields };
  }
  if (Object.prototype.hasOwnProperty.call(out, 'SIG_INFO')) {
    const r = parkEditFields(rec, out.SIG_INFO);
    if (r.error) return r;
    out = { ...out, ...r.fields };
  }
  const shown = {};
  for (const [k, v] of Object.entries(out)) {
    if (v == null) { delete rec[k]; shown[k] = ''; } else { rec[k] = v; shown[k] = v; }
  }
  return { fields: shown };
}

// A reference by shape: POTA / WWFF / LLOTA (US-1234, KFF-1234), SOTA
// (W4C/CM-001), WWBOTA (B/US-1234).
const REF_SHAPE = /^(?:B\/)?[A-Z0-9]{1,5}-\d{4,5}$|^[A-Z0-9]{1,4}\/[A-Z0-9]{2}-\d{3}$/;

/**
 * The program Past Activations files a record under: its MY_SIG, or, for a
 * record with a reference-shaped MY_SIG_INFO and no MY_SIG (an edit made
 * before #509, another logger's export), the program the ref belongs to.
 * '' = not an activation record.
 */
function activationSigOf(q) {
  if (!q || !q.MY_SIG_INFO) return '';
  const sig = up(q.MY_SIG);
  if (sig) return sig;
  const ref = up(q.MY_SIG_INFO);
  return REF_SHAPE.test(ref) ? inferParkProgram(ref) : '';
}

module.exports = { myParkEditFields, parkEditFields, applyQsoEdit, activationSigOf, MY_REF_FIELD, REF_FIELD };
