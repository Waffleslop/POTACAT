'use strict';

// "Is this the same contact?" — the one rule behind the cloud merge
// (cross-device double reports), ADIF/QRZ import (skip what the log already
// holds) and the logbook's Find Duplicates.
//
// Same call + same mode + frequency within 5 kHz (or the same band when
// either side has no frequency) + start times within 3 minutes. The window
// comes from the observed double-report deltas (23-32 s, K3SBP 2026-07-08);
// a deliberate re-work of the same station on the same band is essentially
// never that fast.
//
// Modes are compared by FAMILY, not by the raw MODE field: loggers disagree
// on how to write the same mode (ACLog/most rigs: USB, POTACAT: SSB; ADIF
// 3.1: MODE=MFSK SUBMODE=FT4, older files: MODE=FT4), and comparing the raw
// field let every re-imported SSB and FT4 contact through as a new QSO.

const WINDOW_MS = 3 * 60 * 1000;
const FREQ_TOLERANCE_MHZ = 0.005;

// MODEs that only name a family; the SUBMODE is the real mode.
const FAMILY_MODES = new Set(['MFSK', 'PSK', 'DIGITALVOICE']);

const up = (v) => String(v == null ? '' : v).trim().toUpperCase();

function modeKey(f) {
  const mode = up(f.MODE);
  const sub = up(f.SUBMODE);
  if (sub && FAMILY_MODES.has(mode)) return sub;
  if (mode === 'USB' || mode === 'LSB') return 'SSB';
  return mode;
}

/** UTC millis of a raw QSO record, or null if undated. */
function qsoUtcMillis(f) {
  const d = String(f.QSO_DATE || '');
  if (d.length !== 8) return null;
  const t = (String(f.TIME_ON || '') + '000000').slice(0, 6);
  return Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8),
    +t.slice(0, 2) || 0, +t.slice(2, 4) || 0, +t.slice(4, 6) || 0);
}

function sameContact(a, b) {
  if (!a.CALL || !b.CALL || up(a.CALL) !== up(b.CALL)) return false;
  if (modeKey(a) !== modeKey(b)) return false;
  const fa = parseFloat(a.FREQ), fb = parseFloat(b.FREQ);
  if (Number.isFinite(fa) && Number.isFinite(fb)) {
    if (Math.abs(fa - fb) > FREQ_TOLERANCE_MHZ) return false;
  } else if (up(a.BAND) !== up(b.BAND)) {
    return false;
  }
  const ta = qsoUtcMillis(a), tb = qsoUtcMillis(b);
  if (ta == null || tb == null) return false;
  return Math.abs(ta - tb) <= WINDOW_MS;
}

/**
 * Records bucketed by callsign, so matching a whole imported log against a
 * whole existing log costs O(n * same-call records), not O(n * m).
 */
class ContactIndex {
  constructor(records = []) {
    this._byCall = new Map();
    for (const r of records) this.add(r);
  }

  add(record) {
    const call = up(record.CALL);
    if (!call) return;
    let bucket = this._byCall.get(call);
    if (!bucket) this._byCall.set(call, (bucket = []));
    bucket.push(record);
  }

  /** The first indexed record that is the same contact, or null. */
  findMatch(record) {
    const bucket = this._byCall.get(up(record.CALL));
    if (!bucket) return null;
    for (const r of bucket) if (r !== record && sameContact(r, record)) return r;
    return null;
  }
}

/**
 * Split incoming records into the ones the log doesn't have yet and a count
 * of those it does. Duplicates WITHIN the incoming set are caught too.
 */
function planImport(existing, incoming) {
  const index = new ContactIndex(existing);
  const fresh = [];
  let skipped = 0;
  for (const rec of incoming) {
    if (!rec || !rec.CALL) continue;
    if (index.findMatch(rec)) { skipped++; continue; }
    index.add(rec);
    fresh.push(rec);
  }
  return { fresh, skipped };
}

const filledFieldCount = (r) =>
  Object.values(r).filter((v) => v != null && v !== '').length;

/**
 * Groups of log records that are the same contact. Each group lists record
 * indexes in log order and suggests the one to keep: the record with the
 * most filled fields (ties go to the earliest). Grouping is transitive —
 * A~B and B~C put all three together even if A and C are 4 minutes apart.
 *
 * @returns {Array<{ members: number[], keep: number }>}
 */
function findDuplicateGroups(qsos) {
  const groupOf = new Map(); // record index -> group (array of indexes)
  const byCall = new Map(); // call -> indexes seen so far
  for (let i = 0; i < qsos.length; i++) {
    const call = up(qsos[i].CALL);
    if (!call) continue;
    const seen = byCall.get(call) || [];
    let group = null;
    for (const j of seen) {
      if (!sameContact(qsos[j], qsos[i])) continue;
      const other = groupOf.get(j);
      if (!group) {
        group = other;
      } else if (other !== group) {
        // i bridges two groups: fold the other into this one.
        for (const k of other) { group.push(k); groupOf.set(k, group); }
      }
    }
    if (!group) group = [];
    group.push(i);
    groupOf.set(i, group);
    seen.push(i);
    byCall.set(call, seen);
  }

  const groups = [];
  for (const group of new Set(groupOf.values())) {
    if (group.length < 2) continue;
    const members = group.slice().sort((a, b) => a - b);
    let keep = members[0];
    for (const i of members) {
      if (filledFieldCount(qsos[i]) > filledFieldCount(qsos[keep])) keep = i;
    }
    groups.push({ members, keep });
  }
  return groups.sort((a, b) => a.members[0] - b.members[0]);
}

module.exports = { sameContact, qsoUtcMillis, modeKey, ContactIndex, planImport, findDuplicateGroups };
