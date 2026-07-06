// Contests DB — loads data/contests.json and resolves each entry's
// `whenComputed` cadence into concrete start/end Date objects for the
// current cycle (this year or the immediate next occurrence).
//
// The renderer uses this to render the Contests view's category cards
// with live "starts in 4 days" / "running, ends in 6h" countdowns.
//
// DSL grammar — see data/README.md. Supported patterns:
//   nth-weekend-of:<MM>:<n>          first..-1 = last full Sat+Sun weekend of month
//   nth-weekday-of:<MM>:<n>:<day>    nth weekday of month
//   fixed:<MM-DD>                    fixed calendar date every year
//   weekly:<day>:<HHMM>z             recurring weekly UTC slot
//   monthly-first-weekend            first full weekend of every month
//   monthly-nth:<n>:<day>            nth weekday of every month
//   custom:<text>                    unresolvable; null start/end

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

const DAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function utcDate(y, m, d, hh = 0, mm = 0) {
  return new Date(Date.UTC(y, m - 1, d, hh, mm, 0, 0));
}

// First Saturday of (year, month). 1-indexed month.
function firstSaturdayOfMonth(year, month) {
  for (let d = 1; d <= 7; d++) {
    if (utcDate(year, month, d).getUTCDay() === 6) return d;
  }
  return 1;
}

// nth full Sat+Sun weekend. "Full" = Saturday is in the month and
// Sunday (Sat+1) is also in the month. -1 means the LAST such weekend.
function nthFullWeekendOf(year, month, n) {
  const sats = [];
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  for (let d = 1; d <= lastDay; d++) {
    if (utcDate(year, month, d).getUTCDay() === 6 && d + 1 <= lastDay) {
      sats.push(d);
    }
  }
  if (!sats.length) return null;
  const idx = n === -1 ? sats.length - 1 : n - 1;
  if (idx < 0 || idx >= sats.length) return null;
  return utcDate(year, month, sats[idx]);
}

// nth specific weekday of month. n=-1 = last.
function nthWeekdayOf(year, month, n, weekday) {
  const wd = DAYS[weekday];
  if (wd == null) return null;
  const days = [];
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  for (let d = 1; d <= lastDay; d++) {
    if (utcDate(year, month, d).getUTCDay() === wd) days.push(d);
  }
  if (!days.length) return null;
  const idx = n === -1 ? days.length - 1 : n - 1;
  if (idx < 0 || idx >= days.length) return null;
  return utcDate(year, month, days[idx]);
}

// Next occurrence of weekday (UTC) at or after `from`. Day = Sun..Sat name.
function nextWeekday(from, weekday, hh = 0, mm = 0) {
  const wd = DAYS[weekday];
  if (wd == null) return null;
  const out = new Date(from.getTime());
  out.setUTCHours(hh, mm, 0, 0);
  while (out.getUTCDay() !== wd || out.getTime() < from.getTime()) {
    out.setUTCDate(out.getUTCDate() + 1);
    out.setUTCHours(hh, mm, 0, 0);
  }
  return out;
}

// --- DSL resolver ---
//
// Returns { start, end } as Date objects (UTC), or { start: null, end: null }
// for unresolvable / custom entries. `durationHours` from the entry sets the
// end relative to start.
function resolveOccurrence(entry, now) {
  const rule = entry.whenComputed || '';
  const dur = (entry.durationHours || 24) * 3600 * 1000;
  const refYear = now.getUTCFullYear();

  // Try the current year first, then next year if the result is in the past.
  for (const year of [refYear, refYear + 1]) {
    const start = _resolveForYear(rule, year, now);
    if (!start) break; // unresolvable — won't help to try another year
    const end = new Date(start.getTime() + dur);
    // If event already ended, try next year.
    if (end.getTime() < now.getTime()) continue;
    return { start, end };
  }
  return { start: null, end: null };
}

function _resolveForYear(rule, year, now) {
  if (!rule) return null;

  let m;

  // nth-weekend-of:<MM>:<n>
  m = rule.match(/^nth-weekend-of:(\d+):(-?\d+)$/);
  if (m) {
    return nthFullWeekendOf(year, parseInt(m[1], 10), parseInt(m[2], 10));
  }

  // nth-weekday-of:<MM>:<n>:<day>
  m = rule.match(/^nth-weekday-of:(\d+):(-?\d+):([A-Za-z]+)$/);
  if (m) {
    return nthWeekdayOf(year, parseInt(m[1], 10), parseInt(m[2], 10), m[3]);
  }

  // fixed:<MM-DD>
  m = rule.match(/^fixed:(\d+)-(\d+)$/);
  if (m) {
    return utcDate(year, parseInt(m[1], 10), parseInt(m[2], 10));
  }

  // range:<MM-DD>:<MM-DD> — fixed start/end calendar dates each year.
  // 13 Colonies (Jul 1-7), YOTA Month (Dec 1-31), CQ DX Marathon (Jan 1-Dec 31).
  // The end date is informational only — duration is computed by the caller
  // from entry.durationHours; this rule just resolves the START.
  m = rule.match(/^range:(\d+)-(\d+):(\d+)-(\d+)$/);
  if (m) {
    return utcDate(year, parseInt(m[1], 10), parseInt(m[2], 10));
  }

  // weekly:<day>:<HHMM>z — next occurrence relative to `now`, year-agnostic
  m = rule.match(/^weekly:([A-Za-z]+):(\d{2})(\d{2})z?$/i);
  if (m) {
    return nextWeekday(now, m[1], parseInt(m[2], 10), parseInt(m[3], 10));
  }

  // monthly-first-weekend — next first weekend of any month
  if (rule === 'monthly-first-weekend') {
    const thisMonth = now.getUTCMonth() + 1;
    for (let monthOffset = 0; monthOffset < 12; monthOffset++) {
      const month = ((thisMonth - 1 + monthOffset) % 12) + 1;
      const y = year + Math.floor((thisMonth - 1 + monthOffset) / 12);
      const start = nthFullWeekendOf(y, month, 1);
      if (start && start.getTime() >= now.getTime() - 36 * 3600 * 1000) return start;
    }
    return null;
  }

  // monthly-nth:<n>:<day>
  m = rule.match(/^monthly-nth:(-?\d+):([A-Za-z]+)$/);
  if (m) {
    const n = parseInt(m[1], 10);
    const day = m[2];
    const thisMonth = now.getUTCMonth() + 1;
    for (let monthOffset = 0; monthOffset < 12; monthOffset++) {
      const month = ((thisMonth - 1 + monthOffset) % 12) + 1;
      const y = year + Math.floor((thisMonth - 1 + monthOffset) / 12);
      const start = nthWeekdayOf(y, month, n, day);
      if (start && start.getTime() >= now.getTime() - 36 * 3600 * 1000) return start;
    }
    return null;
  }

  // custom:<text> — unresolvable; the renderer falls back to whenRule text.
  if (rule.startsWith('custom:')) return null;

  return null;
}

// Year-bound start resolution for a SPECIFIC (possibly past) year —
// lib/contest-history.js uses this to build historical contest windows for
// the ECHOCAT participation-history blob. Only meaningful for the
// year-anchored rules (fixed:/range:/nth-weekend-of:/nth-weekday-of:); the
// year-agnostic weekly/monthly patterns resolve relative to `now`, so they
// return null here by design.
const YEAR_BOUND_RULE_RE = /^(fixed|nth-weekend-of|nth-weekday-of|range):/;
function resolveStartForYear(rule, year) {
  if (!YEAR_BOUND_RULE_RE.test(rule || '')) return null;
  return _resolveForYear(rule, year, new Date(0)); // `now` unused by these branches
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
  resolveOccurrence,
  resolveStartForYear,
  YEAR_BOUND_RULE_RE,
  getAllContests,
  getResolved,
  getRunning,
  getUpcoming,
  getByCategory,
};
