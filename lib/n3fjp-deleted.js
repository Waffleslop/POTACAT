'use strict';
/**
 * Contacts the operator deleted from POTACAT's log after the N3FJP pull
 * brought them in. The daily whole-log re-read would otherwise import them
 * again (review of the 1.13.11 chain). Kept in the profile as a short list of
 * keys, call + date + time (to the minute) + band, the shape N3FJP gives back.
 * Pure: main.js records deletes from the log sink and filters the pull.
 */
const MAX_KEYS = 2000;

function keyOf(r) {
  if (!r) return '';
  const call = String(r.CALL || '').trim().toUpperCase();
  const date = String(r.QSO_DATE || '').replace(/\D/g, '').slice(0, 8);
  const time = String(r.TIME_ON || '').replace(/\D/g, '').slice(0, 4);
  const band = String(r.BAND || '').trim().toLowerCase();
  if (!call || date.length !== 8 || time.length !== 4) return '';
  return `${call}|${date}|${time}|${band}`;
}

/** The list after these log changes: deleted N3FJP imports added, newest kept. */
function noteDeleted(list, changes) {
  const out = Array.isArray(list) ? list.slice() : [];
  let added = 0;
  for (const c of changes || []) {
    if (!c || c.action !== 'delete' || !c.fields || c.fields.APP_POTACAT_IMPORTED_FROM !== 'N3FJP') continue;
    const k = keyOf(c.fields);
    if (k && !out.includes(k)) { out.push(k); added++; }
  }
  if (!added) return null;
  return out.length > MAX_KEYS ? out.slice(out.length - MAX_KEYS) : out;
}

/** The pulled records minus the ones the operator deleted. */
function withoutDeleted(records, list) {
  if (!Array.isArray(list) || !list.length) return { records: records || [], left: 0 };
  const set = new Set(list);
  const kept = (records || []).filter((r) => !set.has(keyOf(r)));
  return { records: kept, left: (records || []).length - kept.length };
}

module.exports = { keyOf, noteDeleted, withoutDeleted, MAX_KEYS };
