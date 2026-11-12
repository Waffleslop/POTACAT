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
 * and their external logbook, and the feature is on by default. So the rule
 * is an ALLOW-list: a comment adds parks only when it has one of two shapes
 * we can name. A real park missed costs one record the operator can add by
 * hand; a wrong park is a false claim. A list of words to refuse can never be
 * complete ("Rove today: A, B, C", "A, B at 1800z", "A & B if time permits").
 *
 * WHICH SPOT (nferExtraRefs). One spot decides, alone:
 *   1. it is the activator's own (spotter's base call = the activator's, by
 *      the repo's one definition, JtcatParser.baseCall);
 *   2. it was posted AT the spotted park (an entry that carries a reference
 *      must carry that one; pota.app's history for call + park has none);
 *   3. it is from now: spotTime within 90 minutes before the contact (the
 *      window lib/hunted-park.js uses), 5 minutes of clock skew allowed;
 *   4. it is the NEWEST such spot. If it adds nothing ("QSY 20m FT8"),
 *      nothing is added, whatever an older spot said. Two spots with the
 *      same time that disagree add nothing.
 *
 * WHAT THAT COMMENT MUST LOOK LIKE (commentRefs). Either:
 *   (a) it says n-fer with a number: 2-fer, 2fer, 3 fer, two fer, twofer
 *       (never a bare "N fer"), and the list of parks it stands with has
 *       exactly that many POTA parks of the spotted park's country, the
 *       spotted park included. The parks may be joined by spaces, a comma,
 *       "+", "&", "/", ";" or "and"; "2-fer with US-2222" on a spot at
 *       US-1111 counts US-1111. Refused all the same: a comment with P2P
 *       anywhere, a list introduced by with / to / from / worked / was / QSY /
 *       next / then / yesterday / earlier ..., a list followed by next /
 *       later / tomorrow / tonight / planned / maybe ...;
 *   (b) or it does not say n-fer, it names the spotted park, the parks are
 *       joined by a comma, "+", "&", "/", ";" or "and" (never spaces alone),
 *       and EVERYTHING else in the comment is neutral: a mode, a band, a
 *       frequency, a grid square, QRV, CQ, POTA, 73, TNX / THX / TU, WWFF
 *       references, plain punctuation. Any other word, anywhere, means no
 *       extra parks. At most three extra parks, and every one of them must
 *       be confirmed by the parks catalogue: when that country's list is not
 *       loaded, nothing is added.
 * In both: only references with the spotted park's prefix (its POTA entity;
 * the old US "K-" is read as "US-"), never WWFF (a prefix ending in FF:
 * KFF-, GFF-, DLFF-), and a list holding a park the catalogue says does not
 * exist is not believed at all. Under (a) an unloaded catalogue is no answer
 * and the other checks stand.
 *
 * The history comes from pota.app (/spot/comments/{call}/{ref}), fetched when
 * a QSO with the activator starts, plus the spots POTACAT already collected
 * from its polls. Logging never waits on the network: the next TX message is
 * set after the log write.
 *
 * Every comment is cut to 500 characters and read in one pass (no regular
 * expression here can backtrack over the comment), so a hostile comment costs
 * nothing. Pure apart from the injected fetch and clock.
 */

const JtcatParser = require('../renderer/jtcat-parser'); // dual-mode, pure

const MAX_SPOT_AGE_MS = 90 * 60 * 1000;       // lib/hunted-park.js MAX_SPOT_AGE_MS
const MAX_SPOT_AHEAD_MS = 5 * 60 * 1000;      // clock skew
const MAX_COMMENT = 500;                      // characters of a comment that are read
const MAX_EXTRA = 9;                          // rule (a): a 10-fer
const MAX_EXTRA_PLAIN = 3;                    // rule (b): a bare list longer than this is a plan, not a place

// One pass, two single-class alternatives: a run of call/ref/word characters,
// or one other visible character.
const CHUNK_RE = /[A-Z0-9][A-Z0-9'.\-]*|[^\sA-Z0-9]/g;
const REF_RE = /^([A-Z0-9]{1,5})-(\d{4,5})$/;
const NUMBER_WORDS = { TWO: 2, THREE: 3, FOUR: 4, FIVE: 5, SIX: 6, SEVEN: 7, EIGHT: 8, NINE: 9, TEN: 10 };
const NFER_ONE_RE = /^(\d{1,2}|TWO|THREE|FOUR|FIVE|SIX|SEVEN|EIGHT|NINE|TEN)-?FER$/;
const NUMBER_RE = /^(\d{1,2}|TWO|THREE|FOUR|FIVE|SIX|SEVEN|EIGHT|NINE|TEN)$/;
const JOIN_PUNCT = new Set([',', ';', '+', '&', '/']);
const PLAIN_PUNCT = new Set([',', ';', '+', '&', '/', '(', ')', '.', ':', '-', '!']);
// The word in front of a list that makes it another place or another time.
const STOP_BEFORE = new Set(['WITH', 'TO', 'FROM', 'WORKED', 'WKD', 'WRKD', 'WAS', 'NEXT', 'THEN', 'QSY',
  'QRT', 'YESTERDAY', 'EARLIER', 'LATER', 'TOMORROW', 'AFTER', 'BEFORE', 'LAST', 'PREVIOUS', 'PREVIOUSLY',
  'LEFT', 'LEAVING', 'HEADING', 'MOVING', 'GOING', 'TNX', 'THX', 'THANKS', 'VIA', 'NOT', 'NO', 'OR', 'NEAR',
  'PLAN', 'PLANNED', 'ROVE', 'ROVER', 'DONE', 'FINISHED']);
const STOP_AFTER = new Set(['NEXT', 'LATER', 'TOMORROW', 'YESTERDAY', 'EARLIER', 'AFTERWARDS', 'SOON', 'TONIGHT',
  'PLANNED', 'MAYBE', 'DONE', 'FINISHED']);
const P2P_RE = /^(P2PS?|PARK2PARK|P-2-P)$/;
// Rule (b): the only words a comment may hold beside the list.
const NEUTRAL_WORDS = new Set(['QRV', 'CQ', 'POTA', '73', 'TNX', 'THX', 'TU', 'KHZ', 'MHZ',
  'FT8', 'FT4', 'FT2', 'CW', 'SSB', 'USB', 'LSB', 'AM', 'FM', 'RTTY', 'PSK', 'PSK31', 'JS8', 'SSTV', 'DIGI',
  'DATA', 'PHONE', 'JT65', 'JT9', 'WSPR', 'MFSK', 'OLIVIA', 'FREEDV']);
const BAND_RE = /^\d{1,4}C?M$/;
const FREQ_RE = /^(\d{1,3}\.\d{1,4}|\d{4,6}\.\d{1,3}|\d{5,6})(KHZ|MHZ)?$/;
const GRID_RE = /^[A-R]{2}\d{2}([A-X]{2})?$/;

/** The station's own call out of a compound one: the repo's one definition. */
function baseCall(call) {
  return typeof call === 'string' ? JtcatParser.baseCall(call) : '';
}

/** "K-1234" -> "US-1234" (POTA renamed the US prefix in 2024, numbers kept); else upper-cased. */
function canonRef(ref) {
  const text = typeof ref === 'string' ? ref.trim().toUpperCase().replace(/[‐-―−]/g, '-') : '';
  const m = REF_RE.exec(text);
  if (!m) return text;
  return (m[1] === 'K' ? 'US' : m[1]) + '-' + m[2];
}
const prefixOf = (ref) => ref.slice(0, Math.max(0, ref.lastIndexOf('-')));
const isWwff = (ref) => prefixOf(ref).endsWith('FF');

function spotTimeMs(spot) {
  const v = spot && spot.spotTime;
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  if (typeof v !== 'string' || !v || v.length > 40) return NaN;
  const t = v.trim().replace(' ', 'T');
  return new Date(/Z$|[+-]\d\d:?\d\d$/.test(t) ? t : t + 'Z').getTime();
}

/**
 * The comment as tokens: {k:'ref', ref} | {k:'nfer', n} | {k:'word', w} | {k:'p', c}.
 * Upper-cased, HTML "&amp;" read as "&", typographic dashes as "-".
 */
function tokens(comment) {
  if (typeof comment !== 'string') return [];
  const text = comment.slice(0, MAX_COMMENT).toUpperCase()
    .replace(/&AMP;|&#38;|&#X26;/g, '&')
    .replace(/[‐-―−]/g, '-');
  const raw = [];
  for (const m of text.matchAll(CHUNK_RE)) {
    let chunk = m[0];
    // "US-1111." / "FT8-": the trailing mark is punctuation, not part of the word.
    let end = chunk.length;
    while (end > 1 && (chunk[end - 1] === '.' || chunk[end - 1] === '-' || chunk[end - 1] === "'")) end--;
    const tail = chunk.slice(end);
    chunk = chunk.slice(0, end);
    const r = REF_RE.exec(chunk);
    if (r && /[A-Z]/.test(r[1])) raw.push({ k: 'ref', ref: canonRef(chunk) });
    else if (/[A-Z0-9]/.test(chunk[0])) raw.push({ k: 'word', w: chunk });
    else raw.push({ k: 'p', c: chunk });
    for (const c of tail) raw.push({ k: 'p', c });
  }
  // "2-FER" / "2FER" / "TWOFER" in one word, "3 FER" / "TWO FER" in two.
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i];
    let n = 0;
    if (t.k === 'word') {
      const one = NFER_ONE_RE.exec(t.w);
      if (one) n = NUMBER_WORDS[one[1]] || parseInt(one[1], 10);
      else if (NUMBER_RE.test(t.w) && raw[i + 1] && raw[i + 1].k === 'word' && raw[i + 1].w === 'FER') {
        n = NUMBER_WORDS[t.w] || parseInt(t.w, 10);
        if (n >= 2 && n <= 10) i++;
      }
    }
    if (n >= 2 && n <= 10) out.push({ k: 'nfer', n });
    else out.push(t);
  }
  return out;
}

const isWord = (t, w) => !!t && t.k === 'word' && t.w === w;
const isPunct = (t, set) => !!t && t.k === 'p' && set.has(t.c);

/** What stands between two references: 'space', 'join', 'nfer' or null (not one list). */
function gapKind(T, a, b) {
  if (b === a + 1) return 'space';
  let i = a + 1;
  // "A, B" / "A + B" / "A and B" / "A, and B"
  let joins = 0;
  while (i < b && (isPunct(T[i], JOIN_PUNCT) || isWord(T[i], 'AND'))) { i++; joins++; }
  if (i === b && joins <= 2) return 'join';
  // "A 2-fer with B" / "A (2fer B)"
  i = a + 1;
  while (i < b && isPunct(T[i], new Set([',', ';', ':', '(']))) i++;
  if (i < b && T[i].k === 'nfer') {
    i++;
    while (i < b && isPunct(T[i], new Set([',', ';', ':']))) i++;
    if (isWord(T[i], 'WITH') || isWord(T[i], 'AND')) i++;
    else if (isWord(T[i], 'W') && isPunct(T[i + 1], new Set(['/']))) i += 2;
    if (i === b) return 'nfer';
  }
  return null;
}

/** The run of references around T[at] that `joins` holds together: [lo, hi] token indexes. */
function listAround(T, at, joins) {
  const refIdx = [];
  for (let i = 0; i < T.length; i++) if (T[i].k === 'ref') refIdx.push(i);
  let p = refIdx.indexOf(at);
  let lo = p, hi = p;
  while (lo > 0 && joins(gapKind(T, refIdx[lo - 1], refIdx[lo]))) lo--;
  while (hi < refIdx.length - 1 && joins(gapKind(T, refIdx[hi], refIdx[hi + 1]))) hi++;
  return refIdx.slice(lo, hi + 1);
}

/** Rule (a): the comment says n-fer with a number. */
function nferListRefs(T, spotted, known) {
  for (let i = 0; i < T.length; i++) {
    if (T[i].k === 'word' && P2P_RE.test(T[i].w)) return [];
    if (isWord(T[i], 'PARK') && isWord(T[i + 1], 'TO') && isWord(T[i + 2], 'PARK')) return [];
  }
  const marker = T.findIndex((t) => t.k === 'nfer');
  const n = T[marker].n;
  let at = T.findIndex((t) => t.k === 'ref' && t.ref === spotted);
  const named = at >= 0;
  if (!named) {
    // "2-fer with US-2222" on a spot AT the spotted park: the list right behind the n-fer word.
    let i = marker + 1;
    while (isPunct(T[i], new Set([':', ',', '(']))) i++;
    if (isWord(T[i], 'WITH') || isWord(T[i], 'AND')) i++;
    else if (isWord(T[i], 'W') && isPunct(T[i + 1], new Set(['/']))) i += 2;
    if (!T[i] || T[i].k !== 'ref') return [];
    at = i;
  }
  const list = listAround(T, at, (kind) => kind !== null);

  // Another place or another time: the word in front of the list ...
  let j = list[0] - 1;
  const skipPunct = () => { while (j >= 0 && T[j].k === 'p') j--; };
  skipPunct();
  if (j >= 0 && T[j].k === 'word' && ['WITH', 'OF', 'AT', 'AND', 'W'].includes(T[j].w)) {
    let k = j - 1;
    while (k >= 0 && T[k].k === 'p') k--;
    if (k >= 0 && T[k].k === 'nfer') j = k;
  }
  if (j >= 0 && T[j].k === 'nfer') { j--; skipPunct(); }
  if (j >= 0 && T[j].k === 'word' && STOP_BEFORE.has(T[j].w)) return [];
  // ... and the word behind it. "(yesterday K-9999)" is about K-9999, not the list.
  let k = list[list.length - 1] + 1;
  while (k < T.length && T[k].k === 'p') k++;
  if (k < T.length && T[k].k === 'word' && STOP_AFTER.has(T[k].w)) {
    let q = k + 1;
    while (q < T.length && T[q].k === 'p') q++;
    if (q < T.length && T[q].k === 'word' && ['AT', 'IN', 'WAS', 'IS'].includes(T[q].w)) q++;
    if (!(q < T.length && (T[q].k === 'ref' || T[q].k === 'nfer'))) return [];
  }

  const prefix = prefixOf(spotted);
  const parks = named ? [] : [spotted];
  for (const i of list) {
    const r = T[i].ref;
    if (isWwff(r) || prefixOf(r) !== prefix) continue;
    if (!parks.includes(r)) parks.push(r);
  }
  if (parks.length !== n) return [];   // "2-fer" must list two parks, no more, no fewer
  const extra = parks.filter((r) => r !== spotted);
  if (extra.length > MAX_EXTRA || extra.some((r) => known(r) === false)) return [];
  return extra;
}

function neutralWord(w) {
  return NEUTRAL_WORDS.has(w) || BAND_RE.test(w) || FREQ_RE.test(w) || GRID_RE.test(w);
}

/** Rule (b): no n-fer word; a joined list and nothing else that means anything. */
function plainListRefs(T, spotted, known) {
  const at = T.findIndex((t) => t.k === 'ref' && t.ref === spotted);
  if (at < 0) return [];
  const list = listAround(T, at, (kind) => kind === 'join');
  const lo = list[0], hi = list[list.length - 1];
  const prefix = prefixOf(spotted);
  const parks = [];
  for (let i = 0; i < T.length; i++) {
    const t = T[i];
    const inList = i >= lo && i <= hi;
    if (t.k === 'ref') {
      if (isWwff(t.ref)) continue;                         // a WWFF reference beside it is neutral
      if (!inList || prefixOf(t.ref) !== prefix) return []; // a park outside the list, or another country
      if (!parks.includes(t.ref)) parks.push(t.ref);
    } else if (t.k === 'word') {
      if (inList ? t.w !== 'AND' : !neutralWord(t.w)) return [];
    } else if (!(inList ? JOIN_PUNCT.has(t.c) : PLAIN_PUNCT.has(t.c))) return [];
  }
  const extra = parks.filter((r) => r !== spotted);
  if (!extra.length || extra.length > MAX_EXTRA_PLAIN) return [];
  if (extra.some((r) => known(r) !== true)) return [];   // unknown = refuse: there is no n-fer word to lean on
  return extra;
}

/**
 * The other parks ONE comment, posted at the spotted park, gives for it.
 * @param {string} comment
 * @param {string} spottedRef
 * @param {object} [opts]
 * @param {(ref: string) => (boolean|null)} [opts.parkKnown] the catalogue:
 *        true / false, or null when that country's list is not loaded
 * @returns {string[]} [] when the comment has neither shape
 */
function commentRefs(comment, spottedRef, opts = {}) {
  const spotted = canonRef(spottedRef);
  if (!REF_RE.test(spotted) || isWwff(spotted)) return [];
  const T = tokens(comment);
  if (!T.length) return [];
  const known = typeof (opts && opts.parkKnown) === 'function' ? opts.parkKnown : () => null;
  return T.some((t) => t.k === 'nfer') ? nferListRefs(T, spotted, known) : plainListRefs(T, spotted, known);
}

/** The activator's own spots, trimmed to what the rule reads. */
function selfSpots(spots, activator) {
  const me = baseCall(activator);
  if (!me || !Array.isArray(spots)) return [];
  const out = [];
  for (const s of spots) {
    if (!s || typeof s !== 'object' || typeof s.spotter !== 'string' || baseCall(s.spotter) !== me) continue;
    const one = {
      spotter: s.spotter.slice(0, 20),
      comments: typeof s.comments === 'string' ? s.comments.slice(0, MAX_COMMENT) : '',
      spotTime: (typeof s.spotTime === 'string' || typeof s.spotTime === 'number') ? s.spotTime : '',
    };
    if (typeof s.reference === 'string' && s.reference) one.reference = s.reference.slice(0, 20);
    out.push(one);
  }
  return out;
}

/**
 * The extra POTA parks to log for a hunted contact (the rule at the top).
 * @param {object} a
 * @param {string} a.call        the activator
 * @param {string} a.spottedRef  the POTA park the live spot list matched
 * @param {string[]} [a.known]   POTA refs already matched (not repeated)
 * @param {Array}  [a.spots]     spot history entries {spotter, comments, spotTime, reference?}
 *                               from any source (pota.app history, collected polls)
 * @param {number} [a.now]       time of the contact, ms
 * @param {Function} [a.parkKnown]
 * @returns {string[]}
 */
function nferExtraRefs({ call, spottedRef, known = [], spots = [], now = Date.now(), parkKnown } = {}) {
  const spotted = canonRef(spottedRef);
  if (!REF_RE.test(spotted) || isWwff(spotted)) return [];
  let newestAt = -Infinity;
  let newest = [];
  for (const s of selfSpots(spots, call)) {
    if (s.reference && canonRef(s.reference) !== spotted) continue; // posted at another park
    const t = spotTimeMs(s);
    if (!Number.isFinite(t) || t > now + MAX_SPOT_AHEAD_MS || now - t > MAX_SPOT_AGE_MS) continue;
    if (t > newestAt) { newestAt = t; newest = [s]; } else if (t === newestAt) newest.push(s);
  }
  if (!newest.length) return [];
  // The newest spot decides alone. Same instant, different answers: no answer.
  const answers = newest.map((s) => commentRefs(s.comments, spotted, { parkKnown }));
  const first = answers[0].join(',');
  if (answers.some((a) => a.join(',') !== first)) return [];
  const have = new Set((Array.isArray(known) ? known : []).map(canonRef));
  have.add(spotted);
  return answers[0].filter((r) => !have.has(r));
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
      // pota.app's history for call + park: every entry was posted at that park.
      .then((spots) => { entry.spots = selfSpots(spots, call).slice(0, 100).map(({ reference, ...s }) => s); })
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

/** One line for a toast: "Logged K1ABC at US-1111 and US-2222 (US-2222: from their own spot comment)". */
function loggedLine(d) {
  const o = d || {};
  let line = 'Logged ' + String(o.callsign || '').toUpperCase();
  if (o.parksText) line += ' ' + o.parksText;
  if (o.parksNote) line += ' (' + o.parksNote + ')';
  return line;
}

module.exports = {
  MAX_SPOT_AGE_MS, MAX_SPOT_AHEAD_MS, MAX_EXTRA, MAX_EXTRA_PLAIN, MAX_COMMENT,
  baseCall, canonRef, commentRefs, selfSpots, nferExtraRefs, NferCache, QsoStartGate, parksText, nferNote, loggedLine,
};
