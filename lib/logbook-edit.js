'use strict';

// One Logbook edit or delete of a single QSO, for every surface that names a
// record by its position (desktop Logbook pop-out, ECHOCAT Web, the phone).
// main.js only wires these to IPC / ECHOCAT messages (#988).
//
//  - The record is the one the caller chose: lib/qso-identity.js locates it
//    by idx + identity and refuses when no single record matches, so a stale
//    idx never edits or deletes another QSO.
//  - The write goes through `mutate` (main's mutateQsoLog = QsoLog.mutateLog
//    on the operator's log, journaled to the cloud).
//  - A delete succeeds only when the record left the file (`removed`, which
//    counts records with no uuid too; `changes` does not).

const QsoIdentity = require('./qso-identity');

/**
 * @param {(fn: Function) => { removed: number }} mutate - mutateQsoLog
 * @returns {{ success: true, index: number } | { success: false, error: string, reason?: string }}
 */
function deleteOne(mutate, idx, identity) {
  let at = null;
  const { removed } = mutate((qsos) => {
    at = QsoIdentity.locate(qsos, idx, identity);
    if (at.error) return false;
    qsos.splice(at.index, 1);
  });
  if (at && at.error) return { success: false, error: at.error, reason: at.reason };
  if (!removed) return { success: false, error: 'The QSO could not be removed from the log.' };
  return { success: true, index: at.index };
}

/**
 * @param {(fn: Function) => object} mutate - mutateQsoLog
 * @param {(rec: object, edit: object) => { fields?: object, error?: string }} applyEdit - lib/qso-edit applyQsoEdit
 * @returns {{ success: true, index: number, fields: object } | { success: false, error: string, reason?: string }}
 */
function updateOne(mutate, idx, identity, edit, applyEdit) {
  let at = null;
  let applied = null;
  mutate((qsos) => {
    at = QsoIdentity.locate(qsos, idx, identity);
    if (at.error) return false;
    applied = applyEdit(qsos[at.index], edit);
    if (applied.error) return false;
  });
  if (at && at.error) return { success: false, error: at.error, reason: at.reason };
  if (applied.error) return { success: false, error: applied.error };
  return { success: true, index: at.index, fields: applied.fields };
}

module.exports = { deleteOne, updateOne };
