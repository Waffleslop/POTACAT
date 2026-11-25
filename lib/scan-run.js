// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// A spot scan the phone starts and the desktop runs (ECHOCAT #37; Casey
// 2026-11-21, "move the scan loop to the desktop (phone starts and stops it)").
// iOS suspends the phone's own scan timer when the phone locks, so a phone
// with `scan-remote-v1` from the shack sends `scan-control {action:'start',
// filters, dwellSec, fromFreqKhz}` and the desktop steps the radio. The loop
// lives in the main process (main.js glue, this module's rules): headless
// POTACAT has no renderer, and a hidden window's timers are throttled.
//
// The phone's filters are reproduced exactly as its `applyFilters` does them
// (echocat src/utils/spotsFilter.ts, the ask docs/desktop-asks/2026-11-21-
// scan-on-the-desktop.md "The filters, exactly"); the shared vectors in
// test/fixtures/scan/scan-filter-vectors.json are run by both apps. On top of
// them the desktop's own always-on exclusions apply: mute rules, hidden and
// skipped spots, and worked today (always, as the phone's scan does).
//
// Pure apart from the deps of createScanRun (timers, tune, the spot list).
'use strict';

const SpotMuteRules = require('./spot-mute-rules');

const CONTINENTS = ['NA', 'SA', 'EU', 'AS', 'OC', 'AF', 'AN'];
const SSTV_CALLING_KHZ = [3730, 3845, 7165, 7171, 14227, 14230, 14233, 18161, 21340, 24975, 28680, 50680];
const PREFIX_REGION = [
  ['NA', ['US', 'CA', 'MX', 'GU', 'PR', 'VI', 'AK', 'HI']],
  ['SA', ['BR', 'AR', 'CL', 'PE', 'VE', 'CO', 'UY', 'PY', 'BO', 'EC', 'GY', 'SR']],
  ['AS', ['JA', 'JP', 'CN', 'BV', 'KR', 'IN', 'TH', 'PH', 'VN', 'ID', 'MY', 'SG', 'HK', 'TW']],
  ['OC', ['VK', 'ZL', 'FK', 'YJ', 'KH', 'P2', 'OC']],
  ['AF', ['ZS', 'V5', '5N', 'SU', 'EA9', 'CN', '5T', '5R', '7Q', '9G', '9J', '9L', '9X', '9Y']],
];
const NAME_REGION = [
  ['NA', ['united states', 'canada', 'mexico']],
  ['SA', ['brazil', 'argentin', 'chile']],
  ['AS', ['japan', 'china', 'korea', 'india']],
  ['OC', ['australia', 'new zealand']],
  ['AF', ['south africa', 'nigeria', 'egypt']],
];
const SORTS = ['age', 'freq', 'dist', 'source', 'event'];

/** The phone's mode category (spec step 4). */
function modeCategory(spot) {
  const mode = String((spot && spot.mode) || '');
  const m = mode.toUpperCase();
  if (m.includes('SSTV')) return 'SSTV';
  if (String((spot && spot.comment) || '').toUpperCase().includes('SSTV')) return 'SSTV';
  if (m === 'USB' || m === 'LSB' || m === 'SSB' || m === '') {
    const f = parseFloat(spot && spot.frequency);
    if (Number.isFinite(f) && SSTV_CALLING_KHZ.some((c) => Math.abs(f - c) < 1)) return 'SSTV';
  }
  if (m === '') return 'OTHER';
  if (m === 'USB' || m === 'LSB' || m === 'SSB') return 'SSB';
  if (m === 'CW' || m === 'CW-R') return 'CW';
  if (m === 'FT8' || m === 'FT4' || m === 'FT2') return m;
  if (m === 'FM' || m === 'NFM' || m === 'WFM') return 'FM';
  if (m === 'RTTY') return 'RTTY';
  if (m === 'PSK31' || m === 'PSK') return 'PSK31';
  if (m === 'JS8' || m === 'JS8CALL') return 'JS8';
  if (m.startsWith('FREEDV') || m === 'FDV') return 'FREEDV';
  return 'OTHER';
}

/** The phone's region of a spot (spec step 5); '' never matches. */
function regionOf(spot) {
  const c = String((spot && spot.continent) || '').toUpperCase();
  if (CONTINENTS.includes(c)) return c;
  const loc = String((spot && spot.locationDesc) || '');
  const up = loc.toUpperCase();
  const pm = /^([A-Z0-9]{1,3})-/.exec(up);
  if (pm) {
    for (const [region, prefixes] of PREFIX_REGION) if (prefixes.includes(pm[1])) return region;
    return 'EU';
  }
  const low = loc.toLowerCase();
  for (const [region, names] of NAME_REGION) if (names.some((n) => low.includes(n))) return region;
  return low.trim() ? 'EU' : '';
}

function num(v) { const n = parseFloat(v); return Number.isFinite(n) ? n : NaN; }

/** The phone's sort (spec step 9): stable, no secondary key. */
function sortSpots(list, sort) {
  const s = SORTS.includes(sort) ? sort : 'age';
  const age = (a, b) => String((b && b.spotTime) || '').localeCompare(String((a && a.spotTime) || ''));
  const cmp = {
    age,
    event: age, // the scan has no event rank: age
    freq: (a, b) => (num(a.frequency) || 0) - (num(b.frequency) || 0),
    dist: (a, b) => { const d = (x) => num(x.distance) || Infinity; const da = d(a), db = d(b); return da === db ? 0 : (da < db ? -1 : 1); },
    source: (a, b) => String(a.source).localeCompare(String(b.source)),
  }[s];
  return list.map((v, i) => [v, i]).sort((x, y) => cmp(x[0], y[0]) || x[1] - y[1]).map((p) => p[0]);
}

/** Phone criteria as received, each field cleaned. */
function cleanCriteria(f) {
  const x = f || {};
  const arr = (v) => (Array.isArray(v) ? v.filter((s) => typeof s === 'string' && s) : []);
  return {
    bands: arr(x.bands), modes: arr(x.modes), regions: arr(x.regions), sources: arr(x.sources),
    newOnly: x.newOnly === true, hideWorked: x.hideWorked === true,
    sort: SORTS.includes(x.sort) ? x.sort : 'age',
  };
}

/**
 * The scan list for a phone-started run, in the order the run walks it.
 * ctx: { muteRules, isHidden(spot), isSkipped(spot), isWorkedToday(spot) } — the desktop's own exclusions.
 */
function scanList(spots, criteria, ctx) {
  const c = cleanCriteria(criteria);
  const x = ctx || {};
  let out = Array.isArray(spots) ? spots.slice() : [];
  if (c.sources.length) out = out.filter((s) => c.sources.includes(String(s.source || '').toLowerCase()));
  if (c.bands.length) out = out.filter((s) => s.band && c.bands.includes(s.band));
  if (x.muteRules && x.muteRules.length) out = out.filter((s) => !SpotMuteRules.matchesMuteRule(s, x.muteRules));
  if (c.modes.length) out = out.filter((s) => c.modes.includes(modeCategory(s)));
  if (c.regions.length) out = out.filter((s) => { const r = regionOf(s); return !!r && c.regions.includes(r); });
  if (c.newOnly) out = out.filter((s) => !!s.isAtno || s.newPark === true);
  if (typeof x.isWorkedToday === 'function') out = out.filter((s) => !x.isWorkedToday(s)); // always, whatever hideWorked says
  if (typeof x.isHidden === 'function') out = out.filter((s) => !x.isHidden(s));
  if (typeof x.isSkipped === 'function') out = out.filter((s) => !x.isSkipped(s));
  return sortSpots(out, c.sort);
}

/** Where a run starts (spec): within 0.05 kHz of fromFreqKhz, else within 0.2 kHz of the dial, else 0. */
function startIndex(list, fromFreqKhz, dialKhz) {
  const near = (khz, tol) => (Number.isFinite(khz) ? list.findIndex((s) => Math.abs(num(s.frequency) - khz) <= tol) : -1);
  let i = near(Number(fromFreqKhz), 0.05);
  if (i < 0) i = near(Number(dialKhz), 0.2);
  return i < 0 ? 0 : i;
}

/** The next spot after the one on `freq`: consecutive spots on the same frequency string are stepped over; wraps. */
function nextIndex(list, freq) {
  if (!list.length) return -1;
  let i = list.findIndex((s) => String(s.frequency) === String(freq));
  if (i < 0) return 0;
  let n = 0;
  while (n < list.length && String(list[i].frequency) === String(freq)) { i = (i + 1) % list.length; n++; }
  return i;
}

/**
 * Worked today, the desktop's own test (renderer/app.js isWorkedSpot, the
 * table's grey rows): a call logged today on this spot's band and mode, and
 * on its park/summit when the spot names one. entries are main's workedQsos
 * values ({date YYYYMMDD, ref, band UPPER, mode with USB/LSB as SSB}).
 */
function workedToday(spot, entries, todayUtc) {
  const today = (entries || []).filter((e) => e && e.date === todayUtc);
  if (!today.length) return false;
  const band = String(spot.band || '').toUpperCase();
  let mode = String(spot.mode || '').toUpperCase();
  if (mode === 'USB' || mode === 'LSB') mode = 'SSB';
  if (mode === 'DIGI' || mode === 'DATA' || mode === 'DIGITAL') mode = '';
  const ref = String(spot.reference || '').toUpperCase();
  if (ref) return today.some((e) => String(e.ref || '').toUpperCase() === ref && (!band || e.band === band) && (!mode || e.mode === mode));
  if (band || mode) return today.some((e) => (!band || e.band === band) && (!mode || e.mode === mode));
  return true;
}

/** Hidden by main's one hide list (lib/spot-hides.js keys: '*', whole kHz, band:<label>; null = forever). */
function hiddenBy(hides, spot, now) {
  const entry = hides && hides[String(spot.callsign || '').toUpperCase()];
  if (!entry) return false;
  const live = (k) => Object.prototype.hasOwnProperty.call(entry, k) && (entry[k] === null || entry[k] > now);
  if (live('*')) return true;
  const f = parseFloat(spot.frequency);
  if (Number.isFinite(f) && live(String(Math.round(f)))) return true;
  return !!spot.band && live('band:' + spot.band);
}

/** Whole-run log words for an ending. */
const END_WORDS = {
  empty: 'no spot is left to scan',
  'manual-qsy': 'the radio was tuned by hand',
  transmit: 'the radio transmitted',
  stop: 'stop was pressed',
  'desktop-scan': 'the desktop Scan button took over',
  'not-tunable': 'the radio cannot be tuned',
  'pass-ended': 'the Guest Pass ended',
  'pass-paused': 'the owner took the radio back',
};

/**
 * #961: the scan-run ending for a Guest Pass event (main's
 * passLeaseStopTransmitters reasons). 'paused' is the owner taking the radio
 * back; 'resumed' hands it to the guest again, when no guest run can be live;
 * every other reason (expired, revoked, owner_override, disconnected,
 * superseded, left) is the pass ending.
 */
function guestScanEndWhy(reason) {
  if (reason === 'resumed') return null;
  return reason === 'paused' ? 'pass-paused' : 'pass-ended';
}

/**
 * The run. deps:
 *   getSpots() -> spot[]           the list the phones see (spots within max age)
 *   ctx() -> {muteRules, isHidden, isSkipped, isWorkedToday}
 *   tune(spot) -> bool             tune the radio; false = cannot (the run ends)
 *   dialKhz() -> number|NaN
 *   txActive() -> bool
 *   onState(scanning, why)         scanning changed (main broadcasts scan-state)
 *   log(line), now(), setTimer(fn, ms), clearTimer(h)
 */
const MOVED_TOL_KHZ = 4;      // an FT8 spot tunes the band's dial, up to 3 kHz below it
const MOVED_GRACE_MS = 2500;  // readbacks settle after each step before a move counts

function createScanRun(deps) {
  const d = deps;
  let run = null; // { criteria, dwellMs, freq, tunedKhz, tunedAt, timer, by }

  function end(why) {
    if (!run) return false;
    if (run.timer) d.clearTimer(run.timer);
    run = null;
    d.log(`scan from the phone ended: ${END_WORDS[why] || why}`);
    d.onState(false, why);
    return true;
  }

  function step() {
    if (!run) return;
    run.timer = null;
    if (d.txActive && d.txActive()) { end('transmit'); return; }
    const list = scanList(d.getSpots(), run.criteria, d.ctx());
    if (!list.length) { end('empty'); return; }
    const i = run.freq == null ? startIndex(list, run.fromFreqKhz, d.dialKhz()) : nextIndex(list, run.freq);
    const spot = list[i < 0 ? 0 : i];
    const mine = run;
    mine.freq = String(spot.frequency);
    mine.tunedKhz = num(spot.frequency);
    mine.tunedAt = d.now();
    const ok = d.tune(spot) !== false;
    if (run !== mine) return;
    if (!ok) { end('not-tunable'); return; }
    mine.tunedAt = d.now();
    mine.timer = d.setTimer(step, mine.dwellMs);
  }

  return {
    get scanning() { return !!run; },
    /** Who started the run: 'guest' (a Guest Pass phone) or 'owner'; '' when none runs. */
    get startedBy() { return run ? run.by : ''; },
    /**
     * scan-control start from a phone. by: 'guest' for a Guest Pass phone,
     * else the owner's. Returns false when nothing is left to scan.
     */
    start({ filters, dwellSec, fromFreqKhz, by } = {}) {
      if (run) end('stop');
      const sec = Number(dwellSec);
      run = {
        criteria: cleanCriteria(filters),
        dwellMs: Math.round((Number.isFinite(sec) && sec >= 1 && sec <= 120 ? sec : 7) * 1000),
        fromFreqKhz: Number(fromFreqKhz),
        freq: null, tunedKhz: NaN, tunedAt: 0, timer: null,
        by: by === 'guest' ? 'guest' : 'owner',
      };
      d.log(`scan from the phone: ${run.dwellMs / 1000} s a frequency${run.criteria.bands.length ? ', bands ' + run.criteria.bands.join(' ') : ''}${run.criteria.modes.length ? ', modes ' + run.criteria.modes.join(' ') : ''}, sorted by ${run.criteria.sort}`);
      d.onState(true, 'start');
      step();
      return !!run;
    },
    stop(why) { return end(why || 'stop'); },
    /**
     * #961: the end of a Guest Pass (or the owner taking the radio back) stops
     * a run the guest started, and never one the owner started. The radio
     * stays on the frequency it was on: nothing is tuned or keyed.
     */
    stopGuestRun(why) { return !!run && run.by === 'guest' && end(why || 'pass-ended'); },
    /** Every dial readback: the radio leaving the spot it was put on, by hand, ends the run. */
    noteDial(khz) {
      if (!run || !Number.isFinite(run.tunedKhz) || !(khz > 0)) return;
      if (d.now() - run.tunedAt < MOVED_GRACE_MS) return;
      if (Math.abs(khz - run.tunedKhz) > MOVED_TOL_KHZ) end('manual-qsy');
    },
    /** A key-down anywhere ends the run. */
    noteTransmit() { if (run) end('transmit'); },
  };
}

module.exports = { modeCategory, regionOf, sortSpots, cleanCriteria, scanList, startIndex, nextIndex, workedToday, hiddenBy, guestScanEndWhy, createScanRun, MOVED_TOL_KHZ, MOVED_GRACE_MS, END_WORDS };
