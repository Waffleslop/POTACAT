'use strict';

// Every write to the QSO log goes through here, so cloud sync can never miss
// one.
//
// Before 2026-09-17 each call site that rewrote the log was responsible for
// remembering to journal the change, and most didn't: ECHOCAT edits and
// deletes, activation deletes, activator edits, event retro-stamps, LoTW
// flags and every import changed the local log without telling the cloud.
// And the call sites that did remember bumped APP_POTACAT_VERSION AFTER the
// file was written, so a second edit before the next sync went out at the
// version the server already held and was discarded as a conflict.
//
// mutateLog() instead lets a call site change the parsed records however it
// likes, then works out what changed by comparing against a snapshot:
//   - a record object that wasn't in the parse is a CREATE (it gets a fresh
//     APP_POTACAT_UUID if it has none, or one another record already uses —
//     a clone made with {...record} carries its source's uuid),
//   - a parsed record whose fields changed is an UPDATE (version bumped
//     BEFORE the write, so the file and the journal always agree),
//   - a parsed record missing from the result is a DELETE.
// Only then is the file written, once, and the changes handed to the sink.
//
// The sink is the cloud journal (cloud-ipc recordLogChanges). It decides
// whether anything is recorded (signed in or not); versions and uuids are
// maintained regardless, because they describe the local file.

const fs = require('fs');
const crypto = require('crypto');
const { parseAllRawQsos } = require('./adif');
const { appendRawQsos, rewriteAdifFile } = require('./adif-writer');
const { textHasPseudoFields } = require('./adif-normalize');

const versionOf = (fields) => parseInt(fields.APP_POTACAT_VERSION || '1', 10) || 1;

// The cloud stores uuids in a Postgres UUID column, so a record whose
// APP_POTACAT_UUID is anything else (a hand-edited ADIF, another logger's
// idea of the field) fails the cast, fails the WHOLE push batch, and is
// retried forever. Here such a value counts as "no uuid": the record gets a
// real one and goes out as a create.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isValidUuid = (v) => typeof v === 'string' && UUID_RE.test(v);
/** The record's uuid if it is a real one, else undefined. */
const uuidOf = (fields) => (isValidUuid(fields.APP_POTACAT_UUID) ? fields.APP_POTACAT_UUID : undefined);

function readLog(logPath) {
  return fs.existsSync(logPath) ? parseAllRawQsos(logPath) : [];
}

/** A stable content fingerprint of one record (field order included). */
function fingerprint(fields) {
  return crypto.createHash('sha1').update(JSON.stringify(fields)).digest('hex');
}

/**
 * Parse the log, let `mutate` change it, write the result, journal the diff.
 *
 * @param {string} logPath
 * @param {(qsos: object[]) => (object[]|void|false)} mutate - change the
 *   array/records in place, or return a new array. Return `false` to abort
 *   without writing.
 * @param {{ sink?: (changes: object[]) => void }} [opts]
 * @returns {{ qsos: object[], changes: Array<{action, fields}> }}
 */
function mutateLog(logPath, mutate, { sink } = {}) {
  const before = readLog(logPath);
  const snapshot = new Map(before.map((r) => [r, { json: JSON.stringify(r), version: versionOf(r), fields: { ...r } }]));

  const result = mutate(before);
  if (result === false) return { qsos: before, changes: [] };
  const after = Array.isArray(result) ? result : before;

  const kept = new Set(after.filter((r) => snapshot.has(r)));
  // uuid -> the record that holds it in the result. Surviving records claim
  // theirs first, in log order, so a clone can never take its source's.
  const owner = new Map();
  for (const rec of after) {
    const uuid = uuidOf(rec);
    if (kept.has(rec) && uuid && !owner.has(uuid)) owner.set(uuid, rec);
  }
  // Parsed records that are gone, by uuid: a new object carrying one of
  // these uuids REPLACES that record (an update), it doesn't create one.
  const gone = new Map();
  for (const [rec, prev] of snapshot) {
    if (!kept.has(rec) && uuidOf(prev.fields)) gone.set(prev.fields.APP_POTACAT_UUID, prev);
  }

  const changes = [];
  const mint = (rec) => {
    rec.APP_POTACAT_UUID = crypto.randomUUID();
    rec.APP_POTACAT_VERSION = '1';
    owner.set(rec.APP_POTACAT_UUID, rec);
    changes.push({ action: 'create', fields: rec });
  };
  const bump = (rec, prevVersion) => {
    rec.APP_POTACAT_VERSION = String(Math.max(prevVersion, versionOf(rec)) + 1);
    changes.push({ action: 'update', fields: rec });
  };

  for (const rec of after) {
    const uuid = uuidOf(rec);
    const prev = snapshot.get(rec);
    if (prev) {
      if (JSON.stringify(rec) === prev.json) continue;
      // A legacy record that was never synced, or a second holder of a
      // duplicated uuid: this edit gives it an identity of its own.
      if (uuid && owner.get(uuid) === rec) bump(rec, prev.version);
      else mint(rec);
    } else if (uuid && !owner.has(uuid) && gone.has(uuid)) {
      owner.set(uuid, rec);
      bump(rec, gone.get(uuid).version);
      gone.delete(uuid);
    } else if (!uuid || owner.has(uuid)) {
      mint(rec);
    } else {
      owner.set(uuid, rec);
      if (!rec.APP_POTACAT_VERSION) rec.APP_POTACAT_VERSION = '1';
      changes.push({ action: 'create', fields: rec });
    }
  }

  for (const [rec, prev] of snapshot) {
    if (kept.has(rec)) continue;
    const uuid = uuidOf(prev.fields);
    if (uuid && !gone.has(uuid)) continue; // replaced above
    if (!uuid) continue; // never had an identity the cloud could know
    changes.push({ action: 'delete', fields: prev.fields });
  }

  if (!changes.length) return { qsos: after, changes };
  rewriteAdifFile(logPath, after);
  if (sink) sink(changes);
  return { qsos: after, changes };
}

/**
 * Append new records (each a raw ADIF field map) in one write. Records get a
 * uuid + version 1 unless they carry a uuid the log doesn't already use.
 *
 * @param {{ existing?: object[], sink?: Function }} [opts] - `existing` saves
 *   a re-parse when the caller already holds the log.
 */
function appendRecords(logPath, records, { existing, sink } = {}) {
  if (!records.length) return [];
  const inUse = new Set((existing || readLog(logPath)).map(uuidOf).filter(Boolean));
  for (const rec of records) {
    if (!uuidOf(rec) || inUse.has(rec.APP_POTACAT_UUID)) {
      rec.APP_POTACAT_UUID = crypto.randomUUID();
      rec.APP_POTACAT_VERSION = '1';
    } else if (!rec.APP_POTACAT_VERSION) {
      rec.APP_POTACAT_VERSION = '1';
    }
    inUse.add(rec.APP_POTACAT_UUID);
  }
  appendRawQsos(logPath, records);
  const changes = records.map((fields) => ({ action: 'create', fields }));
  if (sink) sink(changes);
  return changes;
}

/**
 * Give every record a usable identity: a real uuid and a version. Records
 * with no uuid, a malformed one, or one another record already holds get a
 * fresh uuid at version 1 and are journaled as creates. The sign-in catch-up
 * runs this first, so the "which of these do you have" question can be asked
 * about every local QSO.
 *
 * @returns {object[]} the records that were given a new identity
 */
function ensureIdentities(logPath, { sink } = {}) {
  const qsos = readLog(logPath);
  const seen = new Set();
  const changed = [];
  for (const q of qsos) {
    const u = uuidOf(q);
    if (u && !seen.has(u)) { seen.add(u); continue; }
    q.APP_POTACAT_UUID = crypto.randomUUID();
    q.APP_POTACAT_VERSION = '1';
    seen.add(q.APP_POTACAT_UUID);
    changed.push(q);
  }
  if (!changed.length) return changed;
  rewriteAdifFile(logPath, qsos);
  if (sink) sink(changed.map((fields) => ({ action: 'create', fields })));
  return changed;
}

/**
 * One-time repair of pseudo field names (see adif-normalize.js). Parsing
 * normalizes, so a rewrite from the parse IS the repair. The original file
 * is kept alongside as `<log>.pre-field-repair-<stamp>.bak`. Nothing is
 * journaled: the server backfilled its own copies without bumping versions.
 *
 * The same pass drops exact re-appends: a pulled pseudo-named record had no
 * CALL, so the merge's uuid index never saw it and every later pull appended
 * it again (K3SBP's log held one QSO 108 times). A record with the same uuid
 * AND identical fields as an earlier one is that same record written twice —
 * removing it loses nothing. Anything less identical is left for the
 * logbook's Find Duplicates, where the operator decides.
 *
 * @returns {{ repaired: number, collapsed: number }}
 */
function repairFieldNames(logPath) {
  const none = { repaired: 0, collapsed: 0 };
  if (!fs.existsSync(logPath)) return none;
  const text = fs.readFileSync(logPath, 'utf-8');
  if (!textHasPseudoFields(text)) return none;
  const seen = new Set();
  let collapsed = 0;
  const qsos = parseAllRawQsos(logPath).filter((q) => {
    if (!q.APP_POTACAT_UUID) return true;
    const key = JSON.stringify(q);
    if (seen.has(key)) { collapsed++; return false; }
    seen.add(key);
    return true;
  });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
  fs.copyFileSync(logPath, `${logPath}.pre-field-repair-${stamp}.bak`);
  rewriteAdifFile(logPath, qsos);
  return {
    repaired: (text.match(/<CALLSIGN:\d/gi) || []).length,
    collapsed,
  };
}

module.exports = { mutateLog, appendRecords, ensureIdentities, repairFieldNames, readLog, fingerprint, versionOf, isValidUuid, uuidOf, UUID_RE };
