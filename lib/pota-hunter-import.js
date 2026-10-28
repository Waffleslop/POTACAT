'use strict';

// Reconcile the operator's pota.app hunter log with the local QSO log.
//
// pota.app's hunter log (api.pota.app/user/logbook?hunterOnly=1) is built
// from the ACTIVATORS' uploads: every row is a contact some activator logged
// with this operator, with the park the activator was in. So it knows the
// park for contacts the operator's own log may hold without one (logged in a
// general logger, or before POTACAT), and it knows contacts the local log
// never got at all. For each hunted contact:
//   - a matching local QSO gets the park reference(s) it is missing
//     (SIG/SIG_INFO and POTA_REF, same fields the logger writes —
//     lib/adif-writer.js),
//   - no match: the contact is added as a new QSO.
//
// Matching is looser than lib/qso-match.js's 3-minute "same contact" rule,
// because the two sides here come from DIFFERENT logs: the time is the
// activator's, the local one the hunter's, and pota.app keeps no frequency.
// Same call + same band + same mode class (CW / phone / data — pota.app
// often reports a digital contact as DATA) + times within MATCH_WINDOW_MS,
// closest first, and each local QSO is matched at most once.
//
// Pure: no network, no disk. lib/pota-sync.js fetches, main.js applies the
// plan inside mutateQsoLog and writes the review log.

const { freqToBand } = require('./bands');
const { modeKey, qsoUtcMillis } = require('./qso-match');

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

/** The local QSO a hunted contact is, or null. Skips records in `claimed`. */
function findLocalMatch(index, contact, claimed) {
  const bucket = index.get(baseCall(contact.call));
  if (!bucket) return null;
  const cls = modeClass(contact.mode);
  let best = null;
  let bestDelta = Infinity;
  for (const { q, millis, band, cls: qCls } of bucket) {
    if (claimed.has(q) || millis == null) continue;
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
 * Add park refs to a local record in place. A record whose SIG names another
 * program (a SOTA summit, say) keeps it; the park goes in POTA_REF only.
 *
 * @returns {string[]} the refs that were added (empty: it had them all)
 */
function addParkRefs(q, refs) {
  const have = localRefs(q);
  const missing = refs.filter((r) => !have.includes(r));
  if (!missing.length) return [];
  const all = [...have, ...missing].join(',');
  q.POTA_REF = all;
  const sig = up(q.SIG);
  if (!sig || sig === 'POTA') {
    q.SIG = 'POTA';
    q.SIG_INFO = all;
  }
  return missing;
}

/**
 * Work out what each hunted contact does to the local log. Nothing is
 * changed: apply with applyHunterPlan().
 *
 * @param {object[]} qsos - the parsed local log (parseAllRawQsos records)
 * @param {object[]} entries - pota.app logbook entries
 * @returns {{ updates, adds, unchanged, skipped }} where
 *   updates:   [{ contact, qso, deltaMs, refs }] — refs to add to qso
 *   adds:      [{ contact, record }]
 *   unchanged: [{ contact, qso, deltaMs }] — the match already had the parks
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
  for (const contact of contacts) {
    const match = findLocalMatch(index, contact, claimed);
    if (!match) { adds.push({ contact, record: hunterRecord(contact) }); continue; }
    claimed.add(match.qso);
    const have = localRefs(match.qso);
    const refs = contact.refs.filter((r) => !have.includes(r));
    if (refs.length) updates.push({ contact, qso: match.qso, deltaMs: match.deltaMs, refs });
    else unchanged.push({ contact, qso: match.qso, deltaMs: match.deltaMs });
  }
  return { updates, adds, unchanged, skipped };
}

/** Apply a plan to the array it was made from (inside mutateLog). */
function applyHunterPlan(qsos, plan) {
  for (const u of plan.updates) addParkRefs(u.qso, u.refs);
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
  addParkRefs,
  planToCsv,
};
