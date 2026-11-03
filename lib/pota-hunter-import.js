'use strict';

// Reconcile the operator's pota.app hunter log with the local QSO log.
//
// pota.app's hunter log (api.pota.app/user/logbook?hunterOnly=1) is built
// from the ACTIVATORS' uploads: every row is a contact some activator logged
// with this operator, with the park the activator was in. So it knows the
// park for contacts the operator's own log may hold without one (logged in a
// general logger, or before POTACAT), and it knows contacts the local log
// never got at all. For each hunted contact:
//   - a matching local QSO with NO park gets pota.app's park reference(s)
//     (SIG/SIG_INFO and POTA_REF, same fields the logger writes —
//     lib/adif-writer.js),
//   - a matching local QSO that already holds every pota.app park is left
//     as it is (UNCHANGED),
//   - a matching local QSO that holds a park pota.app disagrees with is NOT
//     changed: it is listed as a CONFLICT for the operator to settle. Adding
//     pota.app's ref next to the local one would turn a typo'd US-1243 into
//     "US-1243,US-1234", a 2-fer that never happened, and award credit for a
//     park never worked. This includes a local QSO holding one park of a
//     pota.app 2-fer: the import only ever fills an EMPTY park field,
//   - no match, but within MATCH_WINDOW_MS of a local QSO another pota.app
//     row already matched (same call, band and mode class): the activator
//     logged the contact twice. A DUPLICATE, not a new QSO. This holds even
//     when the two rows name different parks: the import never invents a
//     contact from an activator's repeated row,
//   - no match and not a dupe: the contact is a candidate to add. Candidates
//     then go through lib/qso-match.js planImport against the existing log,
//     the same check importQsoRecords (ADIF/QRZ import) uses: one that is
//     already in the log, or that repeats an earlier candidate (two rows of
//     the activator's within planImport's 3 minutes), is a DUPLICATE too.
//     The rest are added as new QSOs.
//
// Two windows, because two kinds of comparison:
//   - pota.app row vs local QSO (matching, and the activator-dupe check):
//     MATCH_WINDOW_MS, 15 minutes, looser than lib/qso-match.js's 3-minute
//     "same contact" rule, because the two sides come from DIFFERENT logs:
//     the time is the activator's, the local one the hunter's, and pota.app
//     keeps no frequency. Same call + same band + same mode class (CW /
//     phone / data — pota.app often reports a digital contact as DATA),
//     closest first, and each local QSO is matched at most once.
//   - added record vs the log / vs each other (planImport): qso-match's own
//     3-minute rule, since both sides are then records in one log.
//
// Pure: no network, no disk. lib/pota-sync.js fetches, main.js applies the
// plan inside mutateQsoLog and writes the review log.

const { freqToBand } = require('./bands');
const { modeKey, qsoUtcMillis, planImport, ContactIndex } = require('./qso-match');

const MATCH_WINDOW_MS = 15 * 60 * 1000;

const PHONE_MODES = new Set(['SSB', 'USB', 'LSB', 'AM', 'FM', 'PHONE', 'DV', 'DIGITALVOICE', 'C4FM', 'DSTAR', 'DMR', 'FREEDV', 'M17']);

const up = (v) => String(v == null ? '' : v).trim().toUpperCase();

/** CW / PHONE / DATA, or '' when unknown. */
function modeClass(mode) {
  const m = up(mode);
  if (!m) return '';
  if (m === 'CW') return 'CW';
  if (PHONE_MODES.has(m)) return 'PHONE';
  return 'DATA';
}

/** The callsign without prefixes/suffixes: VE3/K1ABC/P -> K1ABC. */
function baseCall(call) {
  const parts = up(call).split('/').filter(Boolean);
  if (!parts.length) return '';
  return parts.reduce((a, b) => (b.length > a.length ? b : a));
}

/** "US-1234, US-5678" -> ['US-1234', 'US-5678'] */
function splitRefs(v) {
  return up(v).split(/[,\s]+/).filter(Boolean);
}

/**
 * pota.app's qsoDateTime ("2024-05-01T14:23:00", with or without seconds,
 * fraction or Z; a space instead of T) as UTC parts, or null.
 */
function parseQsoDateTime(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(v || '').trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s = '00'] = m;
  return {
    qsoDate: `${y}${mo}${d}`,
    timeOn: `${h}${mi}${s}`,
    millis: Date.UTC(+y, +mo - 1, +d, +h, +mi, +s),
  };
}

function localBand(q) {
  if (q.BAND) return String(q.BAND).trim().toLowerCase();
  const f = parseFloat(q.FREQ);
  return Number.isFinite(f) ? (freqToBand(f) || '') : '';
}

/** The park refs a local record already carries, in order. */
function localRefs(q) {
  const refs = splitRefs(q.POTA_REF);
  if (up(q.SIG) === 'POTA') for (const r of splitRefs(q.SIG_INFO)) if (!refs.includes(r)) refs.push(r);
  return refs;
}

/**
 * Collapse pota.app entries into contacts. A 2-fer is two entries (one per
 * park) for the same contact; they become one contact with two refs.
 *
 * Which side is the activator: the hunter log rows come from activators'
 * logs, so station_callsign is normally the activator and worked_callsign
 * the operator. Checked per row against the operator's own calls rather than
 * assumed; a row naming none of them falls back to that normal layout.
 *
 * @returns {{ contacts: object[], skipped: Array<{ entry, reason }> }}
 */
function groupHunterEntries(entries, { myCalls = [] } = {}) {
  const mine = new Set(myCalls.map(baseCall).filter(Boolean));
  const byKey = new Map();
  const contacts = [];
  const skipped = [];
  for (const e of entries || []) {
    if (!e) continue;
    const ref = up(e.reference);
    const when = parseQsoDateTime(e.qsoDateTime);
    let call = up(e.station_callsign);
    let myCall = up(e.worked_callsign);
    if (mine.size && mine.has(baseCall(call)) && !mine.has(baseCall(myCall))) {
      [call, myCall] = [myCall, call];
    }
    if (!call) { skipped.push({ entry: e, reason: 'no activator callsign' }); continue; }
    if (!ref) { skipped.push({ entry: e, reason: 'no park reference' }); continue; }
    if (!when) { skipped.push({ entry: e, reason: `unreadable date/time "${e.qsoDateTime}"` }); continue; }
    const band = String(e.band || '').trim().toLowerCase();
    const mode = up(e.mode);
    const key = [call, when.millis, band, mode].join('|');
    let c = byKey.get(key);
    if (!c) {
      c = { call, myCall, operator: up(e.operator_callsign), band, mode, ...when, refs: [], parkNames: [] };
      byKey.set(key, c);
      contacts.push(c);
    }
    if (!c.refs.includes(ref)) {
      c.refs.push(ref);
      c.parkNames.push(String(e.name || '').trim());
    }
  }
  contacts.sort((a, b) => a.millis - b.millis);
  return { contacts, skipped };
}

/**
 * The closest local QSO within MATCH_WINDOW_MS that is the same call, band
 * and mode class as a hunted contact, or null. By default it skips records
 * in `claimed` (the match for a new contact); with `{ claimedOnly: true }` it
 * looks ONLY at claimed records (the QSO an activator's repeated row is a
 * dupe of).
 */
function findLocalMatch(index, contact, claimed, { claimedOnly = false } = {}) {
  const bucket = index.get(baseCall(contact.call));
  if (!bucket) return null;
  const cls = modeClass(contact.mode);
  let best = null;
  let bestDelta = Infinity;
  for (const { q, millis, band, cls: qCls } of bucket) {
    if (claimed.has(q) !== claimedOnly || millis == null) continue;
    if (contact.band && band && band !== contact.band) continue;
    if (cls && qCls && cls !== qCls) continue;
    const delta = Math.abs(millis - contact.millis);
    if (delta <= MATCH_WINDOW_MS && delta < bestDelta) { best = q; bestDelta = delta; }
  }
  return best ? { qso: best, deltaMs: bestDelta } : null;
}

/** The ADIF record for a hunted contact the local log doesn't have. */
function hunterRecord(contact) {
  const refs = contact.refs.join(',');
  const rec = {
    CALL: contact.call,
    QSO_DATE: contact.qsoDate,
    TIME_ON: contact.timeOn,
  };
  if (contact.band) rec.BAND = contact.band;
  if (contact.mode) rec.MODE = contact.mode === 'PHONE' ? 'SSB' : contact.mode;
  rec.SIG = 'POTA';
  rec.SIG_INFO = refs;
  rec.POTA_REF = refs;
  if (contact.myCall) rec.STATION_CALLSIGN = contact.myCall;
  return rec;
}

/**
 * Fill the park refs of a local record that has none, in place. A record
 * that already carries any park is never touched (the planner lists it as a
 * CONFLICT instead); this check repeats the planner's so no caller can
 * append a park next to an existing one. A record whose SIG names another
 * program (a SOTA summit, say) keeps it; the park goes in POTA_REF only.
 *
 * @returns {string[]} the refs written (empty: the record already had a park)
 */
function fillParkRefs(q, refs) {
  if (localRefs(q).length || !refs.length) return [];
  const all = refs.join(',');
  q.POTA_REF = all;
  const sig = up(q.SIG);
  if (!sig || sig === 'POTA') {
    q.SIG = 'POTA';
    q.SIG_INFO = all;
  }
  return refs.slice();
}

/**
 * Work out what each hunted contact does to the local log. Nothing is
 * changed: apply with applyHunterPlan().
 *
 * @param {object[]} qsos - the parsed local log (parseAllRawQsos records)
 * @param {object[]} entries - pota.app logbook entries
 * @returns {{ updates, adds, unchanged, conflicts, duplicates, skipped }} where
 *   updates:   [{ contact, qso, deltaMs, refs }] — the match had no park;
 *              refs are written to it
 *   adds:      [{ contact, record }] — new QSOs, already checked against the
 *              log and each other by planImport
 *   duplicates: [{ contact, kind, qso?, deltaMs?, record? }] — not added:
 *              kind 'activator-dupe' (qso: the matched local QSO it repeats),
 *              'in-log' (planImport found it in the existing log) or
 *              'repeat' (planImport: it repeats an earlier add)
 *   unchanged: [{ contact, qso, deltaMs }] — the match already had the parks
 *   conflicts: [{ contact, qso, deltaMs, localRefs }] — the match holds a
 *              park pota.app disagrees with (or only some of a 2-fer); the
 *              record is left alone and reported
 *   skipped:   [{ entry, reason }]
 */
function planHunterImport(qsos, entries, opts = {}) {
  const { contacts, skipped } = groupHunterEntries(entries, opts);
  const index = new Map();
  for (const q of qsos || []) {
    const call = baseCall(q.CALL);
    if (!call) continue;
    if (!index.has(call)) index.set(call, []);
    index.get(call).push({ q, millis: qsoUtcMillis(q), band: localBand(q), cls: modeClass(modeKey(q)) });
  }
  const claimed = new Set();
  const updates = [];
  const adds = [];
  const unchanged = [];
  const conflicts = [];
  const duplicates = [];
  // Pass 1: match each contact to a local QSO.
  const unmatched = [];
  for (const contact of contacts) {
    const match = findLocalMatch(index, contact, claimed);
    if (!match) { unmatched.push(contact); continue; }
    claimed.add(match.qso);
    const { qso, deltaMs } = match;
    const have = localRefs(qso);
    if (!have.length) updates.push({ contact, qso, deltaMs, refs: contact.refs.slice() });
    else if (contact.refs.every((r) => have.includes(r))) unchanged.push({ contact, qso, deltaMs });
    else conflicts.push({ contact, qso, deltaMs, localRefs: have });
  }
  // Pass 2, once every match is known (so the answer does not depend on which
  // of an activator's two rows comes first): an unmatched contact near a QSO
  // another row matched is the activator logging the contact twice.
  const candidates = [];
  for (const contact of unmatched) {
    const twin = findLocalMatch(index, contact, claimed, { claimedOnly: true });
    if (twin) duplicates.push({ contact, kind: 'activator-dupe', qso: twin.qso, deltaMs: twin.deltaMs });
    else candidates.push({ contact, record: hunterRecord(contact) });
  }
  // Pass 3: the importQsoRecords check. planImport keeps what neither the log
  // nor an earlier candidate already has; anything it drops is a duplicate.
  // Against the log this is a safety net: pass 1's looser match (15 min,
  // mode class) already claims every QSO planImport's 3-minute same-mode rule
  // would find, so today an 'in-log' duplicate needs the matcher to change.
  // Against earlier candidates it is the live check for an activator's two
  // rows when the local log has neither.
  const { fresh } = planImport(qsos || [], candidates.map((c) => c.record));
  const keep = new Set(fresh);
  const inLog = new ContactIndex(qsos || []);
  for (const c of candidates) {
    if (keep.has(c.record)) adds.push(c);
    else duplicates.push({ contact: c.contact, record: c.record, kind: inLog.findMatch(c.record) ? 'in-log' : 'repeat' });
  }
  return { updates, adds, unchanged, conflicts, duplicates, skipped };
}

/** Apply a plan to the array it was made from (inside mutateLog). Conflicts are never applied. */
function applyHunterPlan(qsos, plan) {
  for (const u of plan.updates) fillParkRefs(u.qso, u.refs);
  for (const a of plan.adds) qsos.push(a.record);
  return qsos;
}

const CSV_COLUMNS = ['action', 'call', 'qso_date', 'time_on', 'band', 'mode', 'parks', 'park_names',
  'local_time_on', 'minutes_apart', 'local_parks_after', 'qso_uuid', 'note'];

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * The review log: one CSV row per hunted contact (and per skipped entry).
 * Run after applyHunterPlan so added records carry their new uuid (a dry
 * run's ADDED rows have none). The mode and totals go in SUMMARY rows first
 * (note column holds the value); in a dry run UPDATED/ADDED mean "would be".
 * A DUPLICATE row of kind activator-dupe names the local QSO the other row
 * matched (local_time_on, minutes_apart, its parks and uuid).
 */
function planToCsv(plan, { downloaded, reported, dryRun = false } = {}) {
  const rows = [CSV_COLUMNS];
  const summary = (label, n) => rows.push(['SUMMARY', label, '', '', '', '', '', '', '', '', '', '', String(n)]);
  summary('mode', dryRun ? 'dry run: nothing was changed' : 'import');
  if (downloaded != null) summary('entries downloaded', downloaded);
  if (reported != null) summary('entries pota.app reports', reported);
  summary('updated', plan.updates.length);
  summary('added', plan.adds.length);
  summary('unchanged', plan.unchanged.length);
  summary('conflicts', (plan.conflicts || []).length);
  summary('duplicates', (plan.duplicates || []).length);
  summary('skipped', plan.skipped.length);
  const mins = (ms) => (ms / 60000).toFixed(1);
  const base = (c) => [c.call, c.qsoDate, c.timeOn, c.band, c.mode, c.refs.join(' '), c.parkNames.join(' | ')];
  for (const u of plan.updates) {
    rows.push(['UPDATED', ...base(u.contact), u.qso.TIME_ON || '', mins(u.deltaMs), localRefs(u.qso).join(' '),
      u.qso.APP_POTACAT_UUID || '', `added ${u.refs.join(' ')}`]);
  }
  for (const a of plan.adds) {
    rows.push(['ADDED', ...base(a.contact), '', '', a.record.POTA_REF, a.record.APP_POTACAT_UUID || '', 'not in local log']);
  }
  for (const n of plan.unchanged) {
    rows.push(['UNCHANGED', ...base(n.contact), n.qso.TIME_ON || '', mins(n.deltaMs), localRefs(n.qso).join(' '),
      n.qso.APP_POTACAT_UUID || '', 'already had the park']);
  }
  // local_parks_after is the record's own park(s): a conflict never changes it.
  for (const c of plan.conflicts || []) {
    rows.push(['CONFLICT', ...base(c.contact), c.qso.TIME_ON || '', mins(c.deltaMs), c.localRefs.join(' '),
      c.qso.APP_POTACAT_UUID || '',
      `not changed: your log has ${c.localRefs.join(' ')}, pota.app has ${c.contact.refs.join(' ')}`]);
  }
  const dupeNote = {
    'activator-dupe': 'not added: the activator logged this contact twice; the other row matched your QSO',
    'in-log': 'not added: already in your log',
    repeat: 'not added: repeats an earlier pota.app row',
  };
  for (const d of plan.duplicates || []) {
    rows.push(['DUPLICATE', ...base(d.contact), d.qso ? (d.qso.TIME_ON || '') : '', d.qso ? mins(d.deltaMs) : '',
      d.qso ? localRefs(d.qso).join(' ') : '', d.qso ? (d.qso.APP_POTACAT_UUID || '') : '', dupeNote[d.kind] || 'not added']);
  }
  for (const s of plan.skipped) {
    const e = s.entry || {};
    rows.push(['SKIPPED', up(e.station_callsign), '', String(e.qsoDateTime || ''), e.band || '', e.mode || '',
      up(e.reference), e.name || '', '', '', '', '', s.reason]);
  }
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

module.exports = {
  MATCH_WINDOW_MS,
  modeClass,
  baseCall,
  parseQsoDateTime,
  groupHunterEntries,
  planHunterImport,
  applyHunterPlan,
  fillParkRefs,
  planToCsv,
};
