'use strict';
/**
 * The other parks of an n-fer, from the activator's own spot comment.
 *
 * A POTA spot carries one reference. An activator at several parks at once
 * usually self-spots one of them and lists the rest in the comment ("3-fer:
 * US-4579 US-4576 US-4566", "2Fer (DE-0157, DE-0288)"), so a hunted contact
 * matched on the spot list was logged at one park only (DA2PK and DK5UR,
 * 2026-11-11, #353).
 *
 * A park read from free text goes into the operator's log, the Cloud journal
 * and their external logbook, and the feature is on by default. So every part
 * of the rule is an ALLOW-list: a comment adds parks only when all of it is
 * something we can name. A real park missed costs one record the operator
 * can add by hand; a wrong park is a false claim. A list of words to refuse
 * can never be complete ("Rove today: A, B", "almost a 2fer with B", "2fer B
 * is next", "not a 2fer A B").
 *
 * WHEN (nferExtraRefs). Parks are added only from pota.app's own history for
 * this activator and park, fetched successfully in the last 3 minutes
 * (NferCache.fresh). No fresh history, a failed or pending request: nothing
 * is added. POTACAT's collected spots can only take parks away (a newer own
 * spot seen there still decides); they never add any.
 *
 * WHICH SPOT. One spot decides, alone: the NEWEST of the activator's own
 * spots (spotter's base call = the activator's, JtcatParser.baseCall) from
 * the last 90 minutes (the window lib/hunted-park.js uses), by the station
 * clock.
 *   - If that newest own spot was posted at ANOTHER park, nothing is added:
 *     they have moved.
 *   - If it adds nothing ("QSY 20m FT8"), nothing is added, whatever an older
 *     spot said. Two newest spots of the same instant that disagree: nothing.
 *   - If ANY of their own spots, fetched or collected, at any park, has a
 *     time that cannot be read, is before 2020, or is more than 5 minutes
 *     ahead of our clock, nothing is added: it might be the newest, or our
 *     clock is slow and "newest" cannot be trusted.
 *
 * WHAT ITS COMMENT MUST LOOK LIKE (commentRefs). An n-fer word carrying a
 * number, its list of parks, and nothing else that means anything:
 *   - the word: 2-fer, 2fer, 3 fer, two fer, twofer; exactly one, never a
 *     bare "N fer". A list of parks with no such word adds nothing ("US-1111,
 *     US-2222" may be a plan: in 384 real own-spot comments the bare form
 *     never once meant an n-fer);
 *   - the list has exactly that many parks, the spotted park included;
 *     "2-fer with US-2222" on a spot at US-1111 counts US-1111. The parks may
 *     be joined by spaces, a comma, "+", "&", "/", ";", "and", "with", "w/"
 *     or "w";
 *   - EVERY other token is neutral: a mode (FT8, CW, SSB ...), one band label
 *     (20m, 70cm), a frequency inside a ham band (14.074, 14074; never
 *     "18.30" or "1800"), a six-character grid, QRV, CQ, POTA, kHz, MHz; 73,
 *     TNX, THX, TU behind the list only (in front they thank someone);
 *   - punctuation only where real comments have it: a colon right after the
 *     n-fer word, parentheses or brackets that enclose the list, the joiners
 *     inside the list, " - " in front of an app's tail, one final full stop;
 *   - a logging app's signature, by NAME (APP_NAMES, from real spots): a
 *     trailing "Self-spotted via World Radio League" / "Self-spot via HAMRS
 *     Pro" / "Sent via Smart Logger", or one "[Ham2K PoLo]"-style bracket.
 *     Any other bracket or tail is free text.
 * Any other word, number, mark or reference, anywhere, means no extra parks:
 * "not a 2fer ...", "2fer ... cancelled", "QRT 2fer ...", "2fer ... [wrong]",
 * "2fer ... :(". Every park in the list must have the spotted park's prefix
 * (its POTA entity; the old US "K-" is read as "US-"); a WWFF reference (a
 * prefix ending in FF) or another country's in the list refuses the list. A
 * reference is 4 digits, or 5 not starting with 0. A list holding a park the
 * catalogue says does not exist is not believed; when that country's list is
 * not loaded the other checks stand.
 *
 * A comment longer than 500 characters is not read at all (real ones are
 * under 100), and the comment is read in one pass, so a hostile comment
 * costs nothing. Pure apart from the injected fetch and clock.
 */

const JtcatParser = require('../renderer/jtcat-parser'); // dual-mode, pure
const { freqToBand } = require('./bands');

const MAX_SPOT_AGE_MS = 90 * 60 * 1000;       // lib/hunted-park.js MAX_SPOT_AGE_MS
const MAX_SPOT_AHEAD_MS = 5 * 60 * 1000;      // clock skew
const FRESH_MS = 3 * 60 * 1000;               // how old a fetched history may be when the contact is logged
const MAX_COMMENT = 500;                      // a longer comment is not read
const MAX_EXTRA = 9;                          // a 10-fer
const MIN_SPOT_TIME_MS = Date.UTC(2020, 0, 1); // an own spot "before 2020" is a time we cannot read

// One pass, two single-class alternatives: a run of call/ref/word characters,
// or one other visible character.
const CHUNK_RE = /[A-Z0-9][A-Z0-9'.\-]*|[^\sA-Z0-9]/g;
const REF_RE = /^([A-Z0-9]{1,5})-(\d{4,5})$/;
const NUMBER_WORDS = { TWO: 2, THREE: 3, FOUR: 4, FIVE: 5, SIX: 6, SEVEN: 7, EIGHT: 8, NINE: 9, TEN: 10 };
const NFER_ONE_RE = /^([2-9]|10|TWO|THREE|FOUR|FIVE|SIX|SEVEN|EIGHT|NINE|TEN)-?FER$/;
const NUMBER_RE = /^([2-9]|10|TWO|THREE|FOUR|FIVE|SIX|SEVEN|EIGHT|NINE|TEN)$/;
const JOIN_PUNCT = new Set([',', ';', '+', '&', '/']);
// Neutral anywhere.
const NEUTRAL_WORDS = new Set(['QRV', 'CQ', 'POTA', 'KHZ', 'MHZ',
  'FT8', 'FT4', 'FT2', 'CW', 'SSB', 'USB', 'LSB', 'AM', 'FM', 'RTTY', 'PSK', 'PSK31', 'JS8', 'SSTV', 'DIGI',
  'DATA', 'PHONE', 'JT65', 'JT9', 'WSPR', 'MFSK', 'OLIVIA', 'FREEDV']);
// Neutral behind the list only: in front of it they thank or greet someone.
const NEUTRAL_AFTER = new Set(['73', 'TNX', 'THX', 'TU']);
const BANDS = new Set(['160M', '80M', '75M', '60M', '40M', '30M', '20M', '17M', '15M', '12M', '10M', '6M', '4M', '2M',
  '1.25M', '70CM', '33CM', '23CM', '13CM']);
const FREQ_RE = /^(\d{1,3}\.\d{3,6}|\d{4,6}(?:\.\d{1,3})?)(KHZ|MHZ)?$/;
const GRID6_RE = /^[A-R]{2}\d{2}[A-X]{2}$/;
// Logging apps that sign the comment, by name. Seen in pota.app spots of
// 2026-11-12: "Self-spotted via World Radio League", "Self-spot via HAMRS Pro",
// "Sent via Smart Logger", "QRT - via Tiles on the Air", "... via POTACAT",
// "[PW] ..." (parkwatch); Ham2K PoLo (source "Ham2K Portable Logger") writes
// "3-fer: US-4579 US-4576 US-4566" with no signature. A tag is one of these
// names and nothing else: "[wrong]" and "via phone wrong park sorry" are text.
const APP_NAMES = new Set(['WORLD RADIO LEAGUE', 'WRL', 'HAMRS', 'HAMRS PRO', 'HAM2K POLO', 'POLO',
  'HAM2K PORTABLE LOGGER', 'SMART LOGGER', 'TILES ON THE AIR', 'POTACAT', 'PW']);
const TAIL_LEADS = ['SELF-SPOTTED VIA ', 'SELF SPOTTED VIA ', 'SELF-SPOT VIA ', 'SELF SPOT VIA ', 'SENT VIA ', 'VIA '];
const TIME_RE = /^\d{4}-\d\d-\d\d[T ]\d\d:\d\d(:\d\d(\.\d{1,6})?)?(Z|[+-]\d\d:?\d\d)?$/;

/** The station's own call out of a compound one: the repo's one definition. */
function baseCall(call) {
  return typeof call === 'string' && call.length <= 40 ? JtcatParser.baseCall(call) : '';
}

/** "K-1234" -> "US-1234" (POTA renamed the US prefix in 2024, numbers kept); else upper-cased. */
function canonRef(ref) {
  if (typeof ref !== 'string' || ref.length > 40) return '';
  const text = ref.trim().toUpperCase().replace(/[\u2010-\u2015\u2212]/g, '-');
  const m = REF_RE.exec(text);
  if (!m) return text;
  return (m[1] === 'K' ? 'US' : m[1]) + '-' + m[2];
}
const prefixOf = (ref) => ref.slice(0, Math.max(0, ref.lastIndexOf('-')));
const isWwff = (ref) => prefixOf(ref).endsWith('FF');

/** ms, or NaN for anything that is not plainly a time (pota.app: "2026-11-12T14:03:22", UTC). */
function spotTimeMs(spot) {
  const v = spot && spot.spotTime;
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v <= 0) return NaN;
    return v < 1e11 ? v * 1000 : v; // epoch seconds or milliseconds
  }
  if (typeof v !== 'string' || v.length > 40) return NaN;
  const t = v.trim();
  if (!TIME_RE.test(t)) return NaN;
  const iso = t.replace(' ', 'T');
  return new Date(/Z$|[+-]\d\d:?\d\d$/.test(iso) ? iso : iso + 'Z').getTime();
}

/**
 * The comment as tokens: {k:'ref', ref} | {k:'nfer', n} | {k:'word', w} | {k:'p', c}.
 * Upper-cased, HTML "&amp;" read as "&", typographic dashes as "-".
 */
function tokens(text) {
  const up = text.toUpperCase()
    .replace(/&AMP;|&#38;|&#X26;/g, '&')
    .replace(/[\u2010-\u2015\u2212]/g, '-');
  const raw = [];
  for (const m of up.matchAll(CHUNK_RE)) {
    let chunk = m[0];
    // "US-1111." / "FT8-": the trailing mark is punctuation, not part of the word.
    let end = chunk.length;
    while (end > 1 && (chunk[end - 1] === '.' || chunk[end - 1] === '-' || chunk[end - 1] === "'")) end--;
    const tail = chunk.slice(end);
    chunk = chunk.slice(0, end);
    const r = REF_RE.exec(chunk);
    // A park number is 4 digits, or 5 not starting with 0 ("US-02222" is a typo, not a park).
    if (r && /[A-Z]/.test(r[1]) && !(r[2].length === 5 && r[2][0] === '0')) raw.push({ k: 'ref', ref: canonRef(chunk) });
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
const isSlash = (t) => !!t && t.k === 'p' && t.c === '/';

/** "with" / "w/" / "w" starting at T[i]: how many tokens it takes (0 = none). */
function withAt(T, i) {
  if (isWord(T[i], 'WITH')) return 1;
  if (isWord(T[i], 'W')) return isSlash(T[i + 1]) ? 2 : 1;
  return 0;
}

/** What stands between two references: 'space', 'join', 'with', 'nfer' or null (not one list). */
function gapKind(T, a, b) {
  if (b === a + 1) return 'space';
  // "A, B" / "A + B" / "A and B" / "A, and B": one joiner, no more
  if (b === a + 2 && (isPunct(T[a + 1], JOIN_PUNCT) || isWord(T[a + 1], 'AND'))) return 'join';
  if (b === a + 3 && isPunct(T[a + 1], JOIN_PUNCT) && T[a + 1].c === ',' && isWord(T[a + 2], 'AND')) return 'join';
  // "A with B" / "A w/ B"
  if (a + 1 + withAt(T, a + 1) === b) return 'with';
  // "A 2-fer with B" / "A, 2fer: B" / "A (2fer B)"
  let i = a + 1;
  if (isPunct(T[i], JOIN_PUNCT) && (T[i].c === ',' || T[i].c === ';')) i++;
  if (T[i] && T[i].k === 'p' && T[i].c === '(') i++;
  if (i < b && T[i].k === 'nfer') {
    i = afterNfer(T, i);
    if (i === b) return 'nfer';
  }
  return null;
}

/** Past the n-fer word at T[m] and what may follow it: "2-fer", "2-fer:", "2-fer with", "2-fer: w/". */
function afterNfer(T, m) {
  let i = m + 1;
  if (T[i] && T[i].k === 'p' && T[i].c === ':') i++;
  if (isWord(T[i], 'AND')) i++; else i += withAt(T, i);
  return i;
}

/** The run of references around T[at] that `joins` holds together, as token indexes. */
function listAround(T, at, joins) {
  const refIdx = [];
  for (let i = 0; i < T.length; i++) if (T[i].k === 'ref') refIdx.push(i);
  const p = refIdx.indexOf(at);
  let lo = p, hi = p;
  while (lo > 0 && joins(gapKind(T, refIdx[lo - 1], refIdx[lo]))) lo--;
  while (hi < refIdx.length - 1 && joins(gapKind(T, refIdx[hi], refIdx[hi + 1]))) hi++;
  return refIdx.slice(lo, hi + 1);
}

/** A frequency inside a ham band: "14.074", "7.200" (MHz), "14074", "14074.5" (kHz). Never a clock time. */
function hamFreq(w) {
  const m = FREQ_RE.exec(w);
  if (!m) return false;
  const digits = m[1];
  const mhzForm = /^\d{1,3}\./.test(digits);
  if (!m[2] && /^\d{4}$/.test(digits) && Number(digits.slice(0, 2)) <= 23 && Number(digits.slice(2)) <= 59) return false; // "1800" may be 18:00
  const v = parseFloat(digits);
  const mhz = m[2] === 'MHZ' ? v : m[2] === 'KHZ' ? v / 1000 : mhzForm ? v : v / 1000;
  return !!freqToBand(mhz);
}

/**
 * A logging app's signature, by name: one "[Ham2K PoLo]" bracket, and a
 * trailing "Self-spotted via World Radio League" (with an optional " - " in
 * front and a full stop behind). Returns the token indexes it covers.
 */
function appTags(T) {
  const tag = new Set();
  const open = T.findIndex((t) => t.k === 'p' && t.c === '[');
  if (open >= 0) {
    let close = open + 1;
    const words = [];
    while (close < T.length && T[close].k === 'word' && words.length < 4) words.push(T[close++].w);
    if (words.length && T[close] && T[close].k === 'p' && T[close].c === ']' && APP_NAMES.has(words.join(' '))) {
      for (let i = open; i <= close; i++) tag.add(i);
    }
  }
  // The tail: the last run of words, up to 7 of them.
  let end = T.length;
  if (end && T[end - 1].k === 'p' && T[end - 1].c === '.') end--;
  let start = end;
  while (start > 0 && T[start - 1].k === 'word' && end - start < 8) start--;
  for (let i = start; i < end - 1; i++) {
    const text = T.slice(i, end).map((t) => t.w).join(' ');
    const lead = TAIL_LEADS.find((l) => text.startsWith(l));
    if (!lead || !APP_NAMES.has(text.slice(lead.length))) continue;
    let from = i;
    if (from > 0 && T[from - 1].k === 'p' && T[from - 1].c === '-') from--; // " - Self-spotted via ..."
    for (let k = from; k < T.length; k++) tag.add(k);
    break;
  }
  return tag;
}

/**
 * The other parks ONE comment, posted at the spotted park, gives for it.
 * @param {string} comment
 * @param {string} spottedRef
 * @param {object} [opts]
 * @param {(ref: string) => (boolean|null)} [opts.parkKnown] the catalogue:
 *        true / false, or null when that country's list is not loaded
 * @returns {string[]} [] unless the whole comment is a list of parks and neutral tokens
 */
function commentRefs(comment, spottedRef, opts = {}) {
  const spotted = canonRef(spottedRef);
  if (!REF_RE.test(spotted) || isWwff(spotted) || typeof comment !== 'string') return [];
  // A long comment is not read: what a cut would hide is not neutral, and a
  // cut can turn US-22223 into US-2222.
  if (comment.length > MAX_COMMENT * 4) return [];
  const text = comment.trim();
  if (!text || text.length > MAX_COMMENT) return [];
  const T = tokens(text);
  const ask = typeof (opts && opts.parkKnown) === 'function' ? opts.parkKnown : null;
  const known = (r) => { if (!ask) return null; try { const a = ask(r); return a === true ? true : a === false ? false : null; } catch { return null; } };

  let marker = -1;
  for (let i = 0; i < T.length; i++) {
    if (T[i].k !== 'nfer') continue;
    if (marker >= 0) return [];           // two n-fer words: two stories
    marker = i;
  }
  if (marker < 0) return [];              // no n-fer word: a list of parks may be a plan
  let at = T.findIndex((t) => t.k === 'ref' && t.ref === spotted);
  const named = at >= 0;
  if (!named) {
    // "2-fer with US-2222" on a spot AT the spotted park: the list right behind the n-fer word.
    let i = afterNfer(T, marker);
    if (T[i] && T[i].k === 'p' && (T[i].c === '(' || T[i].c === '[')) i++;  // "2FER (US-2222)"
    if (!T[i] || T[i].k !== 'ref') return [];
    at = i;
  }
  const list = listAround(T, at, (kind) => kind !== null);
  const lo = list[0], hi = list[list.length - 1];

  // Every token outside the list must be neutral, punctuation included.
  const tag = appTags(T);
  const pc = (i) => (T[i] && T[i].k === 'p' ? T[i].c : '');
  let opensInside = 0;
  for (let i = lo; i <= hi; i++) { if (pc(i) === '(') opensInside++; else if (pc(i) === ')') opensInside--; }
  if (opensInside !== 0 && !(opensInside === 1 && pc(hi + 1) === ')')) return []; // "A (2fer B" never closed
  let bands = 0;
  for (let i = 0; i < T.length; i++) {
    if ((i >= lo && i <= hi) || i === marker || tag.has(i)) continue;
    const t = T[i];
    if (t.k === 'ref') return [];                                  // a reference outside the list
    if (t.k === 'p') {
      const c = t.c;
      if (c === ':' && i === marker + 1) continue;                 // "2-fer: ..."
      if (c === '(' && i === lo - 1 && pc(hi + 1) === ')') continue; // "(list)"
      if (c === ')' && i === hi + 1 && (pc(lo - 1) === '(' || opensInside === 1)) continue; // "(list)", "A (2fer B)"
      if (c === '[' && i === lo - 1 && pc(hi + 1) === ']') continue; // "[list]"
      if (c === ']' && i === hi + 1 && pc(lo - 1) === '[') continue;
      if (c === '/' && i > marker && i < lo && isWord(T[i - 1], 'W')) continue; // "2fer w/ ..."
      if (c === '.' && i === T.length - 1) continue;               // one final full stop
      return [];                                                   // "!", ":(", a stray "-" or comma: not neutral
    }
    // "2-fer with / w/ / and <list>": the glue between the n-fer word and its list.
    if (i > marker && i < lo && (t.w === 'WITH' || t.w === 'W' || t.w === 'AND')) continue;
    if (BANDS.has(t.w)) { bands++; continue; }
    if (NEUTRAL_WORDS.has(t.w) || hamFreq(t.w) || GRID6_RE.test(t.w)) continue;
    if (i > hi && NEUTRAL_AFTER.has(t.w)) continue;
    return [];
  }
  if (bands > 1) return [];                                        // "15M" twice, or "5 m" of something

  const prefix = prefixOf(spotted);
  const parks = named ? [] : [spotted];
  for (const i of list) {
    const r = T[i].ref;
    if (isWwff(r) || prefixOf(r) !== prefix) return [];           // not a POTA park of this country: not this list
    if (!parks.includes(r)) parks.push(r);
  }
  const extra = parks.filter((r) => r !== spotted);
  if (!extra.length) return [];
  if (parks.length !== T[marker].n) return [];                     // "2-fer" lists two parks, no more, no fewer
  if (extra.length > MAX_EXTRA || extra.some((r) => known(r) === false)) return [];
  return extra;
}

/** The activator's own spots, trimmed to what the rule reads. */
function selfSpots(spots, activator) {
  const me = baseCall(activator);
  if (!me || !Array.isArray(spots)) return [];
  const out = [];
  for (const s of spots) {
    if (!s || typeof s !== 'object' || typeof s.spotter !== 'string' || baseCall(s.spotter) !== me) continue;
    // A comment over the limit is kept as "too long" (never cut: a cut could
    // hide a trailing word or shorten a reference), and is then not read.
    let text = '';
    if (typeof s.comments === 'string') {
      text = s.comments.length <= 65536 ? s.comments.trim() : '';
      if (s.comments.length > 65536 || text.length > MAX_COMMENT) text = '#'.repeat(MAX_COMMENT + 1);
    }
    const one = {
      spotter: s.spotter.slice(0, 20),
      comments: text,
      spotTime: (typeof s.spotTime === 'number' || (typeof s.spotTime === 'string' && s.spotTime.length <= 40)) ? s.spotTime : '',
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
 * @param {Array|null} a.spots   pota.app's history for call + park from a FRESH fetch
 *                               (NferCache.fresh): {spotter, comments, spotTime}. Not an
 *                               array (no fresh history) = nothing is added.
 * @param {Array}  [a.buffer]    spots POTACAT collected, the activator's at any park
 *                               ({spotter, comments, spotTime, reference}). They can only
 *                               take parks away: a newer own spot there still decides.
 * @param {number} [a.now]       time of the contact, ms
 * @param {Function} [a.parkKnown]
 * @returns {string[]}
 */
function nferExtraRefs({ call, spottedRef, known = [], spots, buffer = [], now = Date.now(), parkKnown } = {}) {
  const spotted = canonRef(spottedRef);
  if (!REF_RE.test(spotted) || isWwff(spotted) || !Array.isArray(spots)) return [];
  const own = selfSpots(spots, call).map((s) => ({ ...s, fetched: true }))
    .concat(selfSpots(buffer, call));
  let newestAt = -Infinity;
  let newest = [];
  for (const s of own) {
    s.here = !s.reference || canonRef(s.reference) === spotted;
    const t = spotTimeMs(s);
    // A time that cannot be read or cannot be true, on ANY of their spots:
    // it might be the newest. A spot from "the future" means OUR clock is
    // slow, and then "the newest" and "90 minutes" mean nothing either.
    if (!Number.isFinite(t) || t < MIN_SPOT_TIME_MS || t > now + MAX_SPOT_AHEAD_MS) return [];
    if (now - t > MAX_SPOT_AGE_MS) continue;
    if (t > newestAt) { newestAt = t; newest = [s]; } else if (t === newestAt) newest.push(s);
  }
  if (!newest.length) return [];
  if (newest.some((s) => !s.here)) return [];        // their newest spot is at another park: they have moved
  // The newest spot decides alone. Same instant, different answers: no answer.
  const answers = newest.map((s) => commentRefs(s.comments, spotted, { parkKnown }));
  const first = answers[0].join(',');
  if (!first || answers.some((a) => a.join(',') !== first)) return [];
  if (!newest.some((s) => s.fetched)) return [];     // the collected spots never add a park by themselves
  const have = new Set((Array.isArray(known) ? known : []).map(canonRef));
  have.add(spotted);
  return answers[0].filter((r) => !have.has(r));
}

/**
 * Fetched POTA spot histories, keyed by activator + spotted park. Holds the
 * activator's own spots, not parks: which of them count is decided at log
 * time, against the time of the contact. Only a history fetched successfully
 * within FRESH_MS is ever handed out; a failed request empties the entry.
 */
class NferCache {
  constructor({ fetchHistory, now = Date.now, ttlMs = 2 * 60 * 1000, failTtlMs = 60 * 1000, pendingMs = 15 * 1000, freshMs = FRESH_MS, max = 200 } = {}) {
    this._fetch = fetchHistory;
    this._now = now;
    this._ttl = ttlMs;
    this._failTtl = failTtlMs;
    this._pendingMs = pendingMs;
    this._freshMs = freshMs;
    this._max = max;
    this._map = new Map(); // key -> { spots, okAt, at, ttl, pending }
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
    const entry = { spots: e ? e.spots : [], okAt: e ? e.okAt : 0, at: this._now(), ttl: this._ttl, pending: true };
    this._map.delete(key);
    this._map.set(key, entry);
    Promise.resolve()
      .then(() => this._fetch(call, ref))
      .then((spots) => {
        if (!Array.isArray(spots)) throw new Error('not a spot history');
        // pota.app's history for call + park: every entry was posted at that park.
        // The newest 100, whatever order the answer came in; an unreadable time
        // sorts first, so it is kept and refuses (it might be the newest).
        const when = (x) => { const t = spotTimeMs(x); return Number.isFinite(t) ? t : Infinity; };
        entry.spots = selfSpots(spots, call).sort((x, y) => when(y) - when(x)).slice(0, 100).map(({ reference, ...x }) => x);
        entry.okAt = this._now();
      })
      .catch(() => { entry.spots = []; entry.okAt = 0; entry.ttl = this._failTtl; }) // old spots must not decide
      .finally(() => { entry.pending = false; entry.at = this._now(); });
    while (this._map.size > this._max) this._map.delete(this._map.keys().next().value);
  }

  /**
   * The activator's own spots from a fetch that SUCCEEDED within the last
   * freshMs, or null: never fetched, still pending with nothing recent, failed,
   * or too old. Never waits.
   */
  fresh(call, ref) {
    const e = this._map.get(this._key(call, ref));
    if (!e || !e.okAt || this._now() - e.okAt > this._freshMs) return null;
    return e.spots.slice();
  }

  /** fresh() or []. */
  get(call, ref) { return this.fresh(call, ref) || []; }
}

/**
 * "A QSO with this station has just started", once per QSO: the QSO state is
 * broadcast on every step, the spot-list lookup belongs to the first one only.
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
  MAX_SPOT_AGE_MS, MAX_SPOT_AHEAD_MS, FRESH_MS, MAX_EXTRA, MAX_COMMENT, APP_NAMES,
  baseCall, canonRef, commentRefs, selfSpots, nferExtraRefs, NferCache, QsoStartGate, parksText, nferNote, loggedLine,
};
