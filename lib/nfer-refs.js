'use strict';
/**
 * The other parks of an n-fer, from the activator's own spot comment.
 *
 * A POTA spot carries one reference. An activator at several parks at once
 * usually self-spots one of them and lists the rest in the comment ("3-fer
 * DE-1197,DE-0941,DE-0034 FT8"), so a hunted contact matched on the spot list
 * was logged at one park only (DA2PK and DK5UR, 2026-11-11, #353).
 *
 * A park read from free text goes into the operator's log, the Cloud journal
 * and their external logbook, so the rule is strict: a real park missed costs
 * one record the operator can add by hand, a wrong park is a false claim.
 *
 * THE RULE (nferExtraRefs). Extra parks are taken from ONE spot comment:
 *   1. the spot is the activator's own (spotter's base call = the activator's);
 *      hunters name their own park (P2P) and RBN names none;
 *   2. it is from this activation: spotTime within 3 hours before the contact
 *      (5 minutes of clock skew allowed), and it can be read;
 *   3. its own text names the spotted park;
 *   4. of the spots that pass 1-3 only the NEWEST counts. Comments are never
 *      added together: K-1111 + K-2222 in the morning and K-1111 + K-3333 in
 *      the afternoon is K-3333 in the afternoon, never both.
 * Inside that comment (commentRefs):
 *   5. only the LIST the spotted park stands in is read: references joined to
 *      it by a comma, "+", "&", "/", ";" or "and", or by spaces alone when the
 *      comment says "2-fer", "3fer", "n-fer" and so on. Any other word ends
 *      the list, so "(yesterday K-9999)" and "QSY to K-5678 next" add nothing;
 *   6. a list introduced by P2P / with / to / from / worked / was / QSY /
 *      next / then / yesterday / earlier ..., or followed by next / later /
 *      tomorrow / yesterday / earlier ("K-1111, K-2222 next"), is not read
 *      at all;
 *   7. a comment that says "2-fer" and lists three parks is not read at all;
 *   8. each reference must have the spotted park's prefix (its POTA entity;
 *      the old US "K-" is read as "US-"), must not be WWFF (a prefix ending
 *      in FF: KFF-, GFF-, DLFF-), and must be in the parks catalogue when that
 *      country's list is loaded (`parkKnown` answers null when it is not).
 *
 * The history comes from pota.app (/spot/comments/{call}/{ref}), fetched when
 * a QSO with the activator starts, plus the spots POTACAT already collected
 * from its polls. Logging never waits on the network: the next TX message is
 * set after the log write.
 *
 * Pure apart from the injected fetch and clock.
 */

const MAX_SPOT_AGE_MS = 3 * 60 * 60 * 1000;   // one activation
const MAX_SPOT_AHEAD_MS = 5 * 60 * 1000;      // clock skew
const MAX_EXTRA = 9;                          // a 10-fer; a longer list is not believed

// Anything shaped like a reference: POTA (DE-1197, US-12345, K-1234, 9A-0001),
// WWFF (KFF-1234, DLFF-0123) and look-alikes ("FT8-1234"), told apart later.
const REF_RE = /(?<![A-Z0-9-])([A-Z0-9]{1,5})-(\d{4,5})(?![A-Z0-9])/g;
// "2-fer", "3fer", "2 fer", "twofer", "n-fer".
const NFER_SRC = '(\\d{1,2}|TWO|THREE|FOUR|FIVE|SIX|N|X)[\\s-]?FER';
const NFER_RE = new RegExp('(?<![A-Z0-9])' + NFER_SRC + '(?![A-Z0-9])');
const NFER_WORDS = { TWO: 2, THREE: 3, FOUR: 4, FIVE: 5, SIX: 6 };
// Between two references of one list.
const JOIN_RE = /^\s*(?:[,;+&\/]|&AMP;|AND|,\s*AND)\s*$/;
// "US-1111 2-fer with US-2222": the n-fer word itself joins.
const JOIN_NFER_RE = new RegExp('^[\\s,;:]*' + NFER_SRC + '[\\s,;:]*(?:(?:WITH|AND|W\\/)\\s*)?$');
// "... 2-fer with" / "3-fer:" in front of a list is part of the list.
const LEAD_NFER_RE = new RegExp('(?<![A-Z0-9])' + NFER_SRC + '[\\s,;:(]*(?:(?:WITH|OF|AT|W\\/)[\\s:]*)?$');
// The word in front of a list that makes it another place or another time.
const STOP_BEFORE = new Set(['P2P', 'WITH', 'TO', 'FROM', 'WORKED', 'WKD', 'WRKD', 'WAS', 'NEXT', 'THEN', 'QSY',
  'QRT', 'YESTERDAY', 'EARLIER', 'LATER', 'TOMORROW', 'AFTER', 'BEFORE', 'LAST', 'PREVIOUS', 'PREVIOUSLY',
  'LEFT', 'LEAVING', 'HEADING', 'MOVING', 'GOING', 'TNX', 'THX', 'THANKS', 'VIA', 'NOT', 'NO']);
const STOP_AFTER = new Set(['NEXT', 'LATER', 'TOMORROW', 'YESTERDAY', 'EARLIER', 'AFTERWARDS', 'SOON']);

function baseCall(call) {
  const parts = String(call || '').toUpperCase().split('/').filter(Boolean);
  if (parts.length <= 1) return parts[0] || '';
  // The longest part is the call (EA8/DF4UE -> DF4UE, G8XDD/P -> G8XDD).
  return parts.reduce((a, b) => (b.length > a.length ? b : a));
}

/** "K-1234" -> "US-1234" (POTA renamed the US prefix in 2024, numbers kept); else upper-cased. */
function canonRef(ref) {
  const m = /^\s*([A-Z0-9]{1,5})-(\d{4,5})\s*$/i.exec(String(ref || ''));
  if (!m) return String(ref || '').trim().toUpperCase();
  const prefix = m[1].toUpperCase();
  return (prefix === 'K' ? 'US' : prefix) + '-' + m[2];
}
const prefixOf = (ref) => ref.slice(0, Math.max(0, ref.lastIndexOf('-')));
const isWwff = (ref) => /FF$/.test(prefixOf(ref));

function spotTimeMs(spot) {
  if (!spot || !spot.spotTime) return NaN;
  const t = String(spot.spotTime);
  return new Date(/Z$|[+-]\d\d:?\d\d$/.test(t) ? t : t + 'Z').getTime();
}

function lastWord(text) {
  const m = /([A-Z0-9']+)[^A-Z0-9']*$/.exec(text);
  return m ? m[1] : '';
}
/** "... next" / "... later" after a list. "(yesterday K-9999)" is about K-9999, not the list. */
function stopsAfter(text) {
  const m = /^[^A-Z0-9']*([A-Z0-9']+)([^]*)$/.exec(text);
  if (!m || !STOP_AFTER.has(m[1])) return false;
  return !/^\s*(?:(?:AT|IN|WAS|IS)\s+)?[A-Z0-9]{1,5}-\d{4,5}/.test(m[2]);
}

/**
 * The other parks ONE comment names beside the spotted park (rules 5-8).
 * @param {string} comment
 * @param {string} spottedRef
 * @param {object} [opts]
 * @param {(ref: string) => (boolean|null)} [opts.parkKnown] the catalogue:
 *        true / false, or null when that country's list is not loaded
 * @returns {string[]|null} null when the comment does not name the spotted
 *        park (it says nothing about this contact); else the extra parks
 */
function commentRefs(comment, spottedRef, opts = {}) {
  const spotted = canonRef(spottedRef);
  const text = String(comment || '').toUpperCase();
  if (!spotted || !text) return null;
  const tokens = [];
  for (const m of text.matchAll(REF_RE)) {
    tokens.push({ ref: canonRef(m[0]), start: m.index, end: m.index + m[0].length });
  }
  const at = tokens.findIndex((t) => t.ref === spotted);
  if (at < 0) return null;

  const nfer = NFER_RE.exec(text);
  const joins = (a, b) => {
    const gap = text.slice(a.end, b.start);
    if (JOIN_RE.test(gap) || JOIN_NFER_RE.test(gap)) return true;
    return !!nfer && /^\s+$/.test(gap); // spaces alone: only in a comment that says n-fer
  };
  let lo = at, hi = at;
  while (lo > 0 && joins(tokens[lo - 1], tokens[lo])) lo--;
  while (hi < tokens.length - 1 && joins(tokens[hi], tokens[hi + 1])) hi++;
  const list = tokens.slice(lo, hi + 1);

  // Another place or another time (rule 6).
  const before = text.slice(0, list[0].start).replace(LEAD_NFER_RE, '');
  if (STOP_BEFORE.has(lastWord(before))) return [];
  if (stopsAfter(text.slice(list[list.length - 1].end))) return [];

  const prefix = prefixOf(spotted);
  const parks = [];
  for (const t of list) {
    if (isWwff(t.ref) || prefixOf(t.ref) !== prefix) continue;
    if (!parks.includes(t.ref)) parks.push(t.ref);
  }
  // "2-fer" with three parks listed: the comment contradicts itself (rule 7).
  if (nfer) {
    const n = NFER_WORDS[nfer[1]] || parseInt(nfer[1], 10);
    if (Number.isFinite(n) && n >= 2 && parks.length > n) return [];
  }
  const known = typeof opts.parkKnown === 'function' ? opts.parkKnown : () => null;
  const extra = parks.filter((r) => r !== spotted && known(r) !== false);
  return extra.length > MAX_EXTRA ? [] : extra;
}

/** The activator's own spots, trimmed to what the rule reads. */
function selfSpots(spots, activator) {
  const me = baseCall(activator);
  if (!me || !Array.isArray(spots)) return [];
  const out = [];
  for (const s of spots) {
    if (!s || baseCall(s.spotter) !== me) continue;
    out.push({ spotter: String(s.spotter), comments: String(s.comments || ''), spotTime: s.spotTime || '' });
  }
  return out;
}

/**
 * The extra POTA parks to log for a hunted contact (the rule at the top).
 * @param {object} a
 * @param {string} a.call        the activator
 * @param {string} a.spottedRef  the POTA park the live spot list matched
 * @param {string[]} [a.known]   POTA refs already matched (not repeated)
 * @param {Array}  [a.spots]     spot history entries {spotter, comments, spotTime}
 *                               from any source (pota.app history, collected polls)
 * @param {number} [a.now]       time of the contact, ms
 * @param {Function} [a.parkKnown]
 * @returns {string[]}
 */
function nferExtraRefs({ call, spottedRef, known = [], spots = [], now = Date.now(), parkKnown } = {}) {
  const spotted = canonRef(spottedRef);
  if (!spotted || isWwff(spotted)) return [];
  let newest = null;
  for (const s of selfSpots(spots, call)) {
    const t = spotTimeMs(s);
    if (!Number.isFinite(t) || t > now + MAX_SPOT_AHEAD_MS || now - t > MAX_SPOT_AGE_MS) continue;
    if (newest && t <= newest.t) continue;
    const refs = commentRefs(s.comments, spotted, { parkKnown });
    if (refs === null) continue; // does not name the spotted park
    newest = { t, refs };
  }
  if (!newest) return [];
  const have = new Set(known.map(canonRef));
  have.add(spotted);
  return newest.refs.filter((r) => !have.has(r));
}

/**
 * Prefetched POTA spot histories, keyed by activator + spotted park. Holds
 * the activator's own spots, not parks: which of them count is decided at log
 * time, against the time of the contact.
 */
class NferCache {
  constructor({ fetchHistory, now = Date.now, ttlMs = 30 * 60 * 1000, failTtlMs = 5 * 60 * 1000, pendingMs = 15 * 1000, max = 500 } = {}) {
    this._fetch = fetchHistory;
    this._now = now;
    this._ttl = ttlMs;
    this._failTtl = failTtlMs;
    this._pendingMs = pendingMs;
    this._max = max;
    this._map = new Map(); // key -> { spots, at, ttl, pending }
  }

  _key(call, ref) { return `${baseCall(call)}|${canonRef(ref)}`; }

  /** One request per key per ttl. Never throws, returns nothing to wait on. */
  prefetch(call, ref) {
    if (!call || !ref || !this._fetch) return;
    const key = this._key(call, ref);
    const e = this._map.get(key);
    const age = e ? this._now() - e.at : 0;
    // A request that never settles must not hold the key for the session.
    if (e && (e.pending ? age < this._pendingMs : age < e.ttl)) return;
    const entry = { spots: e ? e.spots : [], at: this._now(), ttl: this._ttl, pending: true };
    this._map.delete(key);
    this._map.set(key, entry);
    Promise.resolve()
      .then(() => this._fetch(call, ref))
      .then((spots) => { entry.spots = selfSpots(spots, call); })
      .catch(() => { entry.ttl = this._failTtl; })
      .finally(() => { entry.pending = false; entry.at = this._now(); });
    while (this._map.size > this._max) this._map.delete(this._map.keys().next().value);
  }

  /** The activator's own spots known now ([] when none or not fetched yet). Never waits. */
  get(call, ref) {
    const e = this._map.get(this._key(call, ref));
    return e ? e.spots.slice() : [];
  }
}

/**
 * "A QSO with this station has just started", once per QSO: the QSO state is
 * broadcast on every step, the prefetch belongs to the first one only.
 */
class QsoStartGate {
  constructor() { this._call = new Map(); }
  /** true the first time `owner`'s QSO is seen with this call. */
  started(owner, call) {
    const c = String(call || '').toUpperCase();
    if ((this._call.get(owner) || '') === c) return false;
    this._call.set(owner, c);
    return !!c;
  }
}

/** "at US-1111", "at US-1111 and US-2222", "at A, B and C" ('' for none). */
function parksText(refs) {
  const list = (Array.isArray(refs) ? refs : []).filter(Boolean);
  if (!list.length) return '';
  if (list.length === 1) return 'at ' + list[0];
  return 'at ' + list.slice(0, -1).join(', ') + ' and ' + list[list.length - 1];
}

/** The second line of the logged card: which parks came from the comment. */
function nferNote(extra) {
  const list = (Array.isArray(extra) ? extra : []).filter(Boolean);
  if (!list.length) return '';
  return parksText(list).slice(3) + ': from their own spot comment';
}

module.exports = {
  MAX_SPOT_AGE_MS, MAX_SPOT_AHEAD_MS, MAX_EXTRA,
  baseCall, canonRef, commentRefs, selfSpots, nferExtraRefs, NferCache, QsoStartGate, parksText, nferNote,
};
