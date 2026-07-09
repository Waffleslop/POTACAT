'use strict';

// Contest participation history — scans the ADIF log against each catalog
// contest's HISTORICAL year windows and produces the compact per-contest,
// per-year summary the ECHOCAT phone renders ("2025 — 47 QSOs · SSB ·
// 20/40/15m"). Spec: potacat-app docs/desktop-asks/
// contest-participation-history.md; the RESPONSE doc records the filter-
// token interpretations below.
//
// Pure module — no fs, no settings. main.js feeds it getAllContests() +
// parseAllRawQsos() records and ships the result in the remote-settings
// blob as `contestHistory`.

const { resolveStartForYear, YEAR_BOUND_RULE_RE } = require('./contests-db');

// --- Mode matching -------------------------------------------------------
// QSO modes fold before comparison: USB/LSB → SSB, CW-R → CW; digital modes
// stay distinct. Catalog `modes[]` tokens beyond plain mode names:
//   "any"     → no mode filter (same as empty list)
//   "PSK"     → any PSK flavor (PSK, PSK31, PSK63, …)
//   "DIGITAL" → anything that isn't phone or CW (FT8/FT4/JS8/RTTY/PSK/…)

function foldMode(mode) {
  const u = String(mode || '').toUpperCase().trim();
  if (u === 'USB' || u === 'LSB' || u === 'SSB') return 'SSB';
  if (u === 'CW-R' || u === 'CW') return 'CW';
  return u;
}

const PHONE_OR_CW = new Set(['SSB', 'AM', 'FM', 'CW']);

function buildModeMatcher(modes) {
  const list = (modes || []).map(m => String(m).toUpperCase().trim()).filter(Boolean);
  if (list.length === 0 || list.includes('ANY')) return () => true;
  const exact = new Set(list.filter(m => m !== 'PSK' && m !== 'DIGITAL'));
  const wantPsk = list.includes('PSK');
  const wantDigital = list.includes('DIGITAL');
  return (folded) => {
    if (!folded) return false;
    if (exact.has(folded)) return true;
    if (wantPsk && folded.startsWith('PSK')) return true;
    if (wantDigital && !PHONE_OR_CW.has(folded)) return true;
    return false;
  };
}

// --- Band matching -------------------------------------------------------
// QSO bands are lowercased ADIF band names. Catalog `bands[]` tokens:
//   "any"                → no band filter (same as empty list)
//   plain band ("20m")   → exact
//   "all HF"             → 160m–10m including WARC (generous on purpose — a
//                          WARC QSO inside a QSO-party window is vanishingly
//                          rare, and the mode/window filters do the real work)
//   "VHF" / "UHF"        → 6m–1.25m / 70cm–13cm
//   "144MHz" etc.        → that band ("222MHz"→1.25m, "432MHz"→70cm, "902MHz"→33cm)
//   trailing "+"         → that band and everything above in frequency

const BAND_ORDER = ['2190m', '630m', '160m', '80m', '60m', '40m', '30m', '20m',
  '17m', '15m', '12m', '10m', '6m', '4m', '2m', '1.25m', '70cm', '33cm',
  '23cm', '13cm', '9cm', '6cm', '3cm'];
const HF_BANDS = ['160m', '80m', '60m', '40m', '30m', '20m', '17m', '15m', '12m', '10m'];
const VHF_BANDS = ['6m', '4m', '2m', '1.25m'];
const UHF_BANDS = ['70cm', '33cm', '23cm', '13cm'];
const MHZ_TO_BAND = {
  '50mhz': '6m', '144mhz': '2m', '222mhz': '1.25m', '432mhz': '70cm',
  '902mhz': '33cm', '1.2ghz': '23cm',
};

function _bandsFromToken(tokenRaw) {
  const token = String(tokenRaw || '').toLowerCase().trim();
  if (!token) return [];
  if (token === 'all hf') return HF_BANDS;
  if (token === 'vhf') return VHF_BANDS;
  if (token === 'uhf') return UHF_BANDS;
  const plus = token.endsWith('+');
  const base = plus ? token.slice(0, -1) : token;
  const band = MHZ_TO_BAND[base] || base;
  const idx = BAND_ORDER.indexOf(band);
  if (idx === -1) return [band]; // unknown token — exact-match fallback
  return plus ? BAND_ORDER.slice(idx) : [band];
}

function buildBandMatcher(bands) {
  const list = (bands || []).map(b => String(b).toLowerCase().trim()).filter(Boolean);
  if (list.length === 0 || list.includes('any')) return () => true;
  const set = new Set();
  for (const token of list) for (const b of _bandsFromToken(token)) set.add(b);
  return (band) => set.has(band);
}

// --- Windows -------------------------------------------------------------

function _dayStr(date) {
  return date.toISOString().slice(0, 10).replace(/-/g, '');
}

/**
 * Day-granular inclusive window for a contest in a given year, or null for
 * year-agnostic / unresolvable rules. End day is the UTC day of
 * (start + durationHours − 1 ms), so a 48 h contest starting Saturday 0000z
 * spans exactly [Sat, Sun] — same day-inclusive philosophy as
 * qsoDayInScheduleEntry (lib/event-progress.js).
 */
function yearWindow(entry, year) {
  const start = resolveStartForYear(entry.whenComputed, year);
  if (!start) return null;
  const durMs = (entry.durationHours || 24) * 3600 * 1000;
  return {
    startDay: _dayStr(start),
    endDay: _dayStr(new Date(start.getTime() + durMs - 1)),
  };
}

// Windows longer than this are excluded from history: the catalog's
// year-bound entries above it are umbrella activities, not contest weekends
// — cq-dx-marathon (range:01-01:12-31, any/any) would put EVERY QSO of the
// year in its tally, and yota-month every December QSO. "Did I play this
// contest?" is a weekend-scale question; real contests top out at 48 h.
const MAX_WINDOW_HOURS = 120;

// --- Builder -------------------------------------------------------------

/**
 * @param contests catalog entries (data/contests.json .contests)
 * @param qsos raw ADIF records with uppercase keys (parseAllRawQsos shape:
 *             QSO_DATE 'YYYYMMDD', BAND, MODE)
 * @param opts.generatedAt override the stamp (tests)
 * @returns the `contestHistory` blob, or null when there is nothing to report
 */
function buildContestHistory(contests, qsos, opts = {}) {
  const records = (qsos || []).filter(r => r && /^\d{8}$/.test(r.QSO_DATE || ''));
  if (!records.length) return null;

  // Years that could START a window containing one of our QSOs: every QSO
  // year plus the year before (a late-December window is keyed by its start
  // year but can contain January QSOs).
  const qsoYears = new Set(records.map(r => parseInt(r.QSO_DATE.slice(0, 4), 10)));
  const startYears = new Set();
  for (const y of qsoYears) { startYears.add(y); startYears.add(y - 1); }

  // Pre-resolve windows, bucketed by start year for the per-QSO lookup.
  // Two sets: HEURISTIC windows respect MAX_WINDOW_HOURS (long umbrella
  // windows — CQ DX Marathon, 13 Colonies' 159 h — would false-positive on
  // unrelated QSOs), while PROVENANCE windows include every year-bound
  // contest: a stamped record carries identity proof, so the umbrella cap
  // would only block correct attribution.
  const windowsByYear = new Map();     // year -> [{id, startDay, endDay, modeOk, bandOk}]
  const provWindowsByYear = new Map(); // same shape, uncapped (stamp lookups)
  for (const c of contests || []) {
    if (!c || !c.id || !YEAR_BOUND_RULE_RE.test(c.whenComputed || '')) continue;
    const withinCap = (c.durationHours || 24) <= MAX_WINDOW_HOURS;
    const modeOk = buildModeMatcher(c.modes);
    const bandOk = buildBandMatcher(c.bands);
    for (const year of startYears) {
      const w = yearWindow(c, year);
      if (!w) continue;
      const entry = { id: c.id, year, ...w, modeOk, bandOk };
      if (!provWindowsByYear.has(year)) provWindowsByYear.set(year, []);
      provWindowsByYear.get(year).push(entry);
      if (withinCap) {
        if (!windowsByYear.has(year)) windowsByYear.set(year, []);
        windowsByYear.get(year).push(entry);
      }
    }
  }

  const acc = {}; // contestId -> yearStr -> summary
  const attribute = (id, year, day, band, folded) => {
    const byYear = acc[id] || (acc[id] = {});
    const yearKey = String(year);
    const s = byYear[yearKey] || (byYear[yearKey] = {
      qsos: 0, bands: {}, modes: {}, firstQso: day, lastQso: day,
    });
    s.qsos++;
    if (band) s.bands[band] = (s.bands[band] || 0) + 1;
    if (folded) s.modes[folded] = (s.modes[folded] || 0) + 1;
    if (day < s.firstQso) s.firstQso = day;
    if (day > s.lastQso) s.lastQso = day;
  };

  for (const rec of records) {
    const day = rec.QSO_DATE;
    const qsoYear = parseInt(day.slice(0, 4), 10);
    const folded = foldMode(rec.MODE);
    const band = String(rec.BAND || '').toLowerCase().trim();

    // Provenance-first (events-roadmap #5): a record stamped at log time
    // with APP_POTACAT_EVENT that names a KNOWN catalog contest is
    // attributed directly — no mode/band/window heuristics, since the stamp
    // is identity-proven. The year keys to the matching window when one
    // covers the QSO day, else the QSO's own year. Event ids resolve through
    // opts.eventAliases (unified registry Phase A, lib/event-registry.js) —
    // a stamp naming "13col-2026" attributes to the "13-colonies" catalog
    // contest. Ids that resolve to nothing fall through to the heuristics.
    const rawStampId = String(rec.APP_POTACAT_EVENT || '').trim();
    const stampedId = (opts.eventAliases && opts.eventAliases.get(rawStampId)) || rawStampId;
    let stampAttributed = false;
    if (stampedId) {
      for (const startYear of [qsoYear, qsoYear - 1]) {
        const windows = provWindowsByYear.get(startYear);
        if (!windows) continue;
        const w = windows.find((x) => x.id === stampedId && day >= x.startDay && day <= x.endDay);
        if (w) {
          attribute(w.id, w.year, day, band, folded);
          stampAttributed = true;
          break;
        }
      }
    }
    if (stampAttributed) continue;

    for (const startYear of [qsoYear, qsoYear - 1]) {
      const windows = windowsByYear.get(startYear);
      if (!windows) continue;
      for (const w of windows) {
        if (day < w.startDay || day > w.endDay) continue;
        if (!w.modeOk(folded)) continue;
        if (!w.bandOk(band)) continue;
        attribute(w.id, w.year, day, band, folded);
      }
    }
  }

  if (Object.keys(acc).length === 0) return null;
  return {
    version: 1,
    generatedAt: opts.generatedAt != null ? opts.generatedAt : Date.now(),
    contests: acc,
  };
}

module.exports = {
  buildContestHistory, yearWindow, foldMode, buildModeMatcher, buildBandMatcher,
  MAX_WINDOW_HOURS,
};
