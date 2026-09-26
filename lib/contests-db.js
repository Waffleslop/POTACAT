// Contests DB — loads data/contests.json and resolves each entry's
// `whenComputed` rule into concrete UTC occurrences.
//
// Two consumers resolve with this same file:
//   - the desktop (main.js `get-contests`, the JTCAT Field Day window,
//     lib/contest-history.js), which asks for the NEXT occurrence;
//   - the contests feed job on api.potacat.com (docs/contests-feed.md), which
//     VENDORS this file and asks for EVERY occurrence in a horizon.
// So everything below `loadContests` is pure: no fs, no settings, no clock
// except the dates passed in. Keep it that way.
//
// Grammar (full table with examples: data/README.md):
//
//   rule := form [ ":" HHMM "z" ] [ "@" YYYY [ "-" YYYY ] ] { ";" YYYY "=" MM "-" DD }
//
//   Annual forms (resolve one start per year):
//     nth-weekend-of:<MM>:<n>[:Sat|Sun[±d]]  nth FULL Sat+Sun weekend; n<0 counts
//                                         from the end (-1 last, -2 second-to-last);
//                                         :Sun = its Sunday, :Sat-1 = the Friday before
//     nth-weekday-of:<MM>:<n>:<Day>[±d]   nth weekday of the month (+/-d days)
//     weekday-nearest:<MM-DD>:<Day>[±d]   the <Day> closest to the date
//     weekday-on-or-after:<MM-DD>:<Day>[±d]
//     weekday-on-or-before:<MM-DD>:<Day>[±d]
//     fixed:<MM-DD>                       same calendar date every year
//     range:<MM-DD>:<MM-DD>               starts on the first date (the second
//                                         is informational; durationHours rules)
//   Recurring forms:
//     weekly:<Day>:<HHMM>z[,<Day>:<HHMM>z…]   one or more weekly sessions
//     monthly-first-weekend               first full weekend of every month
//     monthly-nth:<n>:<Day>[±d]           nth weekday of every month
//   Unresolvable:
//     custom:<text>                       no dates; the UI shows whenRule
//
//   Suffixes: `:HHMMz` sets the UTC start time of an annual/monthly form (the
//   default is 0000z, which every rule written before it relies on); `@2026`
//   or `@2026-2028` limits a rule to those start years (one-off events);
//   `;2028=04-09` moves one year of an annual rule to a sponsor-announced
//   date (a contest that steps aside for Easter). It lives in the rule text so
//   resolveStartForYear — contest history — sees it too.
//
// Events with no rule at all (a series the sponsor announces each year) are
// `custom:` plus dates on the ENTRY:
//   "explicitWindows": [{ "start": ISO, "end": ISO }]
// Same shape lib/event-registry.js produces and lib/contest-history.js reads,
// and it lives in contests.json — the only file the feed job fetches, which is
// why there is no separate exceptions file.

const path = require('path');

let _cache = null;

function loadContests() {
  if (_cache) return _cache;
  const file = path.join(__dirname, '..', 'data', 'contests.json');
  try {
    const raw = require(file); // require caches; reset by clearing _cache
    _cache = raw;
  } catch (err) {
    _cache = { schemaVersion: '1', contests: [], _loadError: err.message };
  }
  return _cache;
}

// --- Date utilities (UTC throughout) ---

const DAY_MS = 86400000;
const HOUR_MS = 3600000;
const DAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function utcDate(y, m, d, hh = 0, mm = 0) {
  return new Date(Date.UTC(y, m - 1, d, hh, mm, 0, 0));
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

// Pick the nth element (1-based) of a list, or count from the end for n<0.
function pickNth(list, n) {
  if (!list.length || n === 0) return null;
  const idx = n < 0 ? list.length + n : n - 1;
  return idx >= 0 && idx < list.length ? list[idx] : null;
}

// nth full Sat+Sun weekend. "Full" = Saturday is in the month and
// Sunday (Sat+1) is also in the month. -1 = the LAST such weekend,
// -2 the one before it.
function nthFullWeekendOf(year, month, n) {
  const sats = [];
  const lastDay = daysInMonth(year, month);
  for (let d = 1; d + 1 <= lastDay; d++) {
    if (utcDate(year, month, d).getUTCDay() === 6) sats.push(d);
  }
  const d = pickNth(sats, n);
  return d == null ? null : utcDate(year, month, d);
}

// nth specific weekday of month. n=-1 = last, -2 = second-to-last.
function nthWeekdayOf(year, month, n, weekday) {
  const wd = DAYS[weekday];
  if (wd == null) return null;
  const days = [];
  const lastDay = daysInMonth(year, month);
  for (let d = 1; d <= lastDay; d++) {
    if (utcDate(year, month, d).getUTCDay() === wd) days.push(d);
  }
  const d = pickNth(days, n);
  return d == null ? null : utcDate(year, month, d);
}

// The <weekday> nearest / on-or-after / on-or-before a calendar date.
// "Nearest" breaks no ties: a date is never exactly 3.5 days from a weekday.
function weekdayRelativeTo(year, month, day, weekday, dir) {
  const wd = DAYS[weekday];
  if (wd == null) return null;
  const anchor = utcDate(year, month, day);
  const fwd = (wd - anchor.getUTCDay() + 7) % 7;   // days forward to it
  const back = (anchor.getUTCDay() - wd + 7) % 7;  // days back to it
  let delta;
  if (dir === 'after') delta = fwd;
  else if (dir === 'before') delta = -back;
  else delta = fwd <= back ? fwd : -back;
  return new Date(anchor.getTime() + delta * DAY_MS);
}

function withOffset(date, offset) {
  if (!date || !offset) return date;
  return new Date(date.getTime() + parseInt(offset, 10) * DAY_MS);
}

function validMonthDay(mm, dd) {
  const m = parseInt(mm, 10), d = parseInt(dd, 10);
  return m >= 1 && m <= 12 && d >= 1 && d <= 31;
}

// --- Rule parser ---
//
// parseRule(rule) → a compiled rule, or null when the text is not a rule:
//   { kind: 'annual',  startForYear(year) → Date|null, years }
//   { kind: 'monthly', startForMonth(year, month) → Date|null, years }
//   { kind: 'weekly',  sessions: [{ day, hh, mm }], years }
//   { kind: 'custom',  text }
// `years` is { from, to } or null (unbounded).

const DAY = '(Sun|Mon|Tue|Wed|Thu|Fri|Sat)';
const OFFSET = '([+-]\\d+)?';

const ANNUAL_FORMS = [
  // nth-weekend-of:<MM>:<n>[:Sat|Sun[±d]] — the day picks one day of the
  // weekend (Sunday-only QSO parties); an offset reaches the Friday a
  // weekend contest opens on (CQ 160, ARRL 160: `:Sat-1:2200z`).
  [/^nth-weekend-of:(\d+):(-?\d+)(?::(Sat|Sun)([+-]\d+)?)?$/, (m) => (year) => {
    const sat = nthFullWeekendOf(year, parseInt(m[1], 10), parseInt(m[2], 10));
    return withOffset(m[3] === 'Sun' ? withOffset(sat, '+1') : sat, m[4]);
  }],
  // nth-weekday-of:<MM>:<n>:<Day>[±d] — the offset pins an event to a holiday
  // rather than a weekend: Route 66 On The Air starts the Saturday AFTER
  // Labor Day (1st Monday of September), `nth-weekday-of:9:1:Mon+5`: the
  // 6th through the 12th, while the 2nd Saturday runs 8th–14th.
  [new RegExp('^nth-weekday-of:(\\d+):(-?\\d+):' + DAY + OFFSET + '$'), (m) => (year) =>
    withOffset(nthWeekdayOf(year, parseInt(m[1], 10), parseInt(m[2], 10), m[3]), m[4])],
  // weekday-nearest / -on-or-after / -on-or-before:<MM-DD>:<Day>[±d]
  [new RegExp('^weekday-(nearest|on-or-after|on-or-before):(\\d{2})-(\\d{2}):' + DAY + OFFSET + '$'), (m) => {
    if (!validMonthDay(m[2], m[3])) return null;
    const dir = m[1] === 'on-or-after' ? 'after' : m[1] === 'on-or-before' ? 'before' : 'nearest';
    return (year) => withOffset(
      weekdayRelativeTo(year, parseInt(m[2], 10), parseInt(m[3], 10), m[4], dir), m[5]);
  }],
  // fixed:<MM-DD>
  [/^fixed:(\d+)-(\d+)$/, (m) => (validMonthDay(m[1], m[2])
    ? (year) => utcDate(year, parseInt(m[1], 10), parseInt(m[2], 10)) : null)],
  // range:<MM-DD>:<MM-DD> — 13 Colonies (Jul 1-7), YOTA Month (Dec 1-31).
  // The end date is informational; the entry's durationHours sets the end.
  [/^range:(\d+)-(\d+):(\d+)-(\d+)$/, (m) => (validMonthDay(m[1], m[2]) && validMonthDay(m[3], m[4])
    ? (year) => utcDate(year, parseInt(m[1], 10), parseInt(m[2], 10)) : null)],
];

// The annual verbs — lib/contest-history.js builds per-year windows only for
// these (weekly/monthly have no "the 2024 one").
const YEAR_BOUND_RULE_RE =
  /^(fixed|nth-weekend-of|nth-weekday-of|range|weekday-nearest|weekday-on-or-after|weekday-on-or-before):/;

function parseRule(rule) {
  if (typeof rule !== 'string' || !rule) return null;
  if (rule.startsWith('custom:')) return { kind: 'custom', text: rule.slice(7), years: null };

  // `;YYYY=MM-DD` — the sponsor moved one year's date (ARRL Rookie Roundup
  // SSB steps a week early when its Sunday is Easter). Kept in the rule text,
  // not beside it, so resolveStartForYear (contest history) sees it too.
  const [head, ...moves] = rule.split(';');
  const overrides = new Map();
  for (const mv of moves) {
    const o = mv.trim().match(/^(\d{4})=(\d{2})-(\d{2})$/);
    if (!o || !validMonthDay(o[2], o[3])) return null;
    overrides.set(parseInt(o[1], 10), [parseInt(o[2], 10), parseInt(o[3], 10)]);
  }

  let body = head;
  let years = null;
  const ym = body.match(/@(\d{4})(?:-(\d{4}))?$/);
  if (ym) {
    years = { from: parseInt(ym[1], 10), to: parseInt(ym[2] || ym[1], 10) };
    if (years.to < years.from) return null;
    body = body.slice(0, ym.index);
  }

  // weekly:<Day>:<HHMM>z[,<Day>:<HHMM>z…] — CWT runs four sessions a week,
  // K1USN SST two; each is its own occurrence.
  if (body.startsWith('weekly:')) {
    if (overrides.size) return null; // a year override means nothing here
    const sessions = [];
    for (const part of body.slice(7).split(',')) {
      const s = part.trim().match(new RegExp('^' + DAY + ':(\\d{2})(\\d{2})z?$', 'i'));
      if (!s) return null;
      const day = s[1][0].toUpperCase() + s[1].slice(1, 3).toLowerCase();
      const hh = parseInt(s[2], 10), mm = parseInt(s[3], 10);
      if (hh > 23 || mm > 59) return null;
      sessions.push({ day, hh, mm });
    }
    return sessions.length ? { kind: 'weekly', sessions, years } : null;
  }

  // Optional UTC start time for every other form.
  let hh = 0, mm = 0;
  const tm = body.match(/:(\d{2})(\d{2})z$/);
  if (tm) {
    hh = parseInt(tm[1], 10); mm = parseInt(tm[2], 10);
    if (hh > 23 || mm > 59) return null;
    body = body.slice(0, tm.index);
  }
  const at = (d) => (d ? new Date(d.getTime() + (hh * 60 + mm) * 60000) : null);

  if (overrides.size && body.startsWith('monthly-')) return null;
  if (body === 'monthly-first-weekend') {
    return { kind: 'monthly', years, startForMonth: (y, m) => at(nthFullWeekendOf(y, m, 1)) };
  }
  const mn = body.match(new RegExp('^monthly-nth:(-?\\d+):' + DAY + OFFSET + '$'));
  if (mn) {
    const n = parseInt(mn[1], 10);
    return { kind: 'monthly', years,
      startForMonth: (y, m) => at(withOffset(nthWeekdayOf(y, m, n, mn[2]), mn[3])) };
  }

  for (const [re, build] of ANNUAL_FORMS) {
    const m = body.match(re);
    if (!m) continue;
    const fn = build(m);
    if (!fn) return null;
    return { kind: 'annual', years, startForYear: (year) => {
      const o = overrides.get(year);
      return at(o ? utcDate(year, o[0], o[1]) : fn(year));
    } };
  }
  return null;
}

function _inYears(years, date) {
  if (!years || !date) return true;
  const y = date.getUTCFullYear();
  return y >= years.from && y <= years.to;
}

// --- Occurrences ---

function _durationMs(entry) {
  return (entry.durationHours || 24) * HOUR_MS;
}

// Raw rule occurrences whose [start, end) overlaps (from, to): end > from
// and start < to. Sorted by start.
function _ruleOccurrences(parsed, durMs, from, to) {
  const out = [];
  const push = (start) => {
    if (!start || !_inYears(parsed.years, start)) return;
    const end = new Date(start.getTime() + durMs);
    if (end.getTime() > from.getTime() && start.getTime() < to.getTime()) out.push({ start, end });
  };
  // Look back far enough to catch an occurrence that started before `from`
  // and is still running.
  const lookBack = new Date(from.getTime() - durMs - 2 * DAY_MS);

  if (parsed.kind === 'annual') {
    for (let y = lookBack.getUTCFullYear() - 1; y <= to.getUTCFullYear(); y++) push(parsed.startForYear(y));
  } else if (parsed.kind === 'monthly') {
    let y = lookBack.getUTCFullYear(), m = lookBack.getUTCMonth(); // one month early (offsets)
    if (m === 0) { y--; m = 12; }
    const endKey = to.getUTCFullYear() * 12 + to.getUTCMonth() + 1;
    for (; y * 12 + m <= endKey; m === 12 ? (y++, m = 1) : m++) push(parsed.startForMonth(y, m));
  } else if (parsed.kind === 'weekly') {
    const day0 = Date.UTC(lookBack.getUTCFullYear(), lookBack.getUTCMonth(), lookBack.getUTCDate());
    for (let t = day0; t < to.getTime(); t += DAY_MS) {
      const wd = new Date(t).getUTCDay();
      for (const s of parsed.sessions) {
        if (DAYS[s.day] === wd) push(new Date(t + (s.hh * 60 + s.mm) * 60000));
      }
    }
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

function _explicitWindows(entry) {
  const out = [];
  for (const w of Array.isArray(entry.explicitWindows) ? entry.explicitWindows : []) {
    const start = w && w.start ? new Date(w.start) : null;
    const end = w && w.end ? new Date(w.end) : null;
    if (start && end && !isNaN(start) && !isNaN(end) && end > start) out.push({ start, end });
  }
  return out;
}

// Every occurrence of `entry` overlapping [fromDate, toDate): end after
// `fromDate`, start before `toDate`, sorted by start. Unresolvable rules
// (custom: without explicit windows, a one-off whose year has passed) give [].
// The feed job calls this with its horizon; the desktop through
// resolveOccurrence below.
function resolveOccurrences(entry, fromDate, toDate) {
  if (!entry) return [];
  const from = new Date(fromDate), to = new Date(toDate);
  const parsed = parseRule(entry.whenComputed || '');
  if (parsed && parsed.kind !== 'custom') return _ruleOccurrences(parsed, _durationMs(entry), from, to);
  // No rule: the sponsor-announced windows are the whole schedule.
  return _explicitWindows(entry)
    .filter((w) => w.end.getTime() > from.getTime() && w.start.getTime() < to.getTime())
    .sort((a, b) => a.start - b.start);
}

// How far ahead the next occurrence can be, by rule kind.
const NEXT_HORIZON_DAYS = { annual: 800, monthly: 400, weekly: 15, custom: 800 };

// The live-or-next occurrence: { start, end } as Dates (UTC), or nulls when
// the rule can't be resolved. `durationHours` sets end relative to start.
// An occurrence that ends exactly at `now` still counts (it has not ended).
function resolveOccurrence(entry, now) {
  const parsed = parseRule((entry && entry.whenComputed) || '');
  const kind = parsed ? parsed.kind : 'custom';
  const t = now.getTime();
  const occ = resolveOccurrences(entry, new Date(t - 1), new Date(t + NEXT_HORIZON_DAYS[kind] * DAY_MS));
  return occ.length ? { start: occ[0].start, end: occ[0].end } : { start: null, end: null };
}

// Year-bound start resolution for a SPECIFIC (possibly past) year —
// lib/contest-history.js uses this to build historical contest windows for
// the ECHOCAT participation-history blob. Only the annual rules have a
// per-year start; weekly/monthly return null by design, as does a year
// outside an `@YYYY` bound.
function resolveStartForYear(rule, year) {
  if (!YEAR_BOUND_RULE_RE.test(rule || '')) return null;
  const parsed = parseRule(rule);
  if (!parsed || parsed.kind !== 'annual') return null;
  if (parsed.years && (year < parsed.years.from || year > parsed.years.to)) return null;
  return parsed.startForYear(year);
}

// --- Validation ---
//
// The shape every catalog entry must have. The feed job refuses to publish a
// catalog with errors (docs/contests-feed.md), and test/contests-db-test.js
// runs the same check in CI, so a bad edit fails in the PR, not on the server.

const KNOWN_CATEGORIES = [
  'worldwide-dx', 'north-american', 'state-qso-party', 'special-event', 'operating-event',
  'single-band', 'vhf-uhf', 'digital', 'weekly-sprint', 'monthly-qrp', 'monthly',
  'newcomer', 'pota-sota', 'regional',
];
const REQUIRED_STRINGS = ['id', 'name', 'sponsor', 'website', 'rulesUrl', 'whenRule', 'whenComputed', 'category'];

function validateEntry(c) {
  const errs = [];
  if (!c || typeof c !== 'object') return ['not an object'];
  for (const k of REQUIRED_STRINGS) {
    if (typeof c[k] !== 'string' || !c[k].trim()) errs.push(`missing ${k}`);
  }
  if (c.id && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(c.id)) errs.push('id is not kebab-case');
  for (const k of ['website', 'rulesUrl']) {
    if (c[k] && !/^https?:\/\/[^\s]+$/i.test(c[k])) errs.push(`${k} is not an http(s) URL`);
  }
  if (c.category && !KNOWN_CATEGORIES.includes(c.category)) errs.push(`unknown category ${c.category}`);
  const parsed = parseRule(c.whenComputed);
  if (!parsed) errs.push(`unparseable whenComputed "${c.whenComputed}"`);
  const custom = parsed && parsed.kind === 'custom';
  if (!custom || c.durationHours != null) {
    if (!(typeof c.durationHours === 'number' && c.durationHours > 0)) errs.push('durationHours must be > 0');
  }
  for (const k of ['bands', 'modes']) {
    if (!Array.isArray(c[k]) || !c[k].length || !c[k].every((x) => typeof x === 'string' && x)) {
      errs.push(`${k} must be a non-empty string list`);
    }
  }
  if (c.explicitWindows != null) {
    // Rule-less events only: contest history reads a windowed entry's windows
    // INSTEAD of its rule, so a rule plus windows would lose every other year.
    if (!custom) errs.push('explicitWindows needs a custom: rule (move one year of a rule with ;YYYY=MM-DD)');
    const raw = Array.isArray(c.explicitWindows) ? c.explicitWindows.length : -1;
    if (raw < 1 || _explicitWindows(c).length !== raw) errs.push('explicitWindows must be [{start, end}] ISO pairs, end after start');
  }
  return errs;
}

// → [{ id, errors: [...] }] for every bad entry, plus duplicate ids.
function validateCatalog(catalog) {
  const list = Array.isArray(catalog) ? catalog : (catalog && catalog.contests) || [];
  const out = [];
  const seen = new Set();
  list.forEach((c, i) => {
    const errors = validateEntry(c);
    const id = (c && c.id) || `#${i}`;
    if (seen.has(id)) errors.push('duplicate id');
    seen.add(id);
    if (errors.length) out.push({ id, errors });
  });
  return out;
}

// --- Query API ---

function getAllContests() {
  return loadContests().contests;
}

// Resolve every contest's next occurrence; attach { start, end }.
// Returns array sorted by start ascending (unresolvable entries at the end).
function getResolved(now = new Date()) {
  const out = [];
  for (const c of getAllContests()) {
    const occ = resolveOccurrence(c, now);
    out.push({ ...c, start: occ.start, end: occ.end });
  }
  out.sort((a, b) => {
    const sa = a.start ? a.start.getTime() : Infinity;
    const sb = b.start ? b.start.getTime() : Infinity;
    return sa - sb;
  });
  return out;
}

function getRunning(now = new Date()) {
  return getResolved(now).filter((c) =>
    c.start && c.end && c.start.getTime() <= now.getTime() && c.end.getTime() >= now.getTime(),
  );
}

function getUpcoming(now = new Date(), days = 30) {
  const cutoff = now.getTime() + days * 24 * 3600 * 1000;
  return getResolved(now).filter((c) =>
    c.start && c.start.getTime() > now.getTime() && c.start.getTime() <= cutoff,
  );
}

function getByCategory(now = new Date()) {
  const groups = new Map();
  for (const c of getResolved(now)) {
    const k = c.category || 'other';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  }
  return groups;
}

module.exports = {
  loadContests,
  parseRule,
  resolveOccurrence,
  resolveOccurrences,
  resolveStartForYear,
  validateEntry,
  validateCatalog,
  KNOWN_CATEGORIES,
  YEAR_BOUND_RULE_RE,
  getAllContests,
  getResolved,
  getRunning,
  getUpcoming,
  getByCategory,
};
