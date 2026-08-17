'use strict';
/**
 * Worked-before policy for JTCAT's automatic paths (Hunt candidate filter,
 * Run mode's answerer selection) and the manual double-click dupe toast.
 *
 * Why this exists (KQ4MHD 2026-08-17): "worked before" was all-time on the
 * same band+mode — a 20m FT8 contact from months ago blocked that station
 * forever — and had no program awareness, so an activator worked yesterday
 * from park A was silently skipped while activating park B today, even
 * though POTA counts that as a fresh hunter credit. Two relaxations:
 *
 *   1. Rework window (reworkDays): log entries older than N days stop
 *      counting as worked. 0 = all-time (the pre-2026-08-17 behavior).
 *   2. Program-activator exception (activatorRefs): a station currently
 *      spotted as a POTA/SOTA/WWFF/... activator only blocks if we already
 *      worked them on this band+mode at one of TODAY's spotted parks on
 *      today's UTC day — a different park or a new day counts fresh,
 *      matching how the programs themselves count credit.
 *
 * Pure module (no Electron, no settings) — table-tested in
 * test/worked-before-test.js. main.js's jtcatWorkedInfo() supplies the
 * live inputs (log entries, rework setting, spotted refs, today's stamp).
 */

/** Date → ADIF-style 'YYYYMMDD' UTC stamp. */
function utcDateStamp(d) {
  const n = d instanceof Date ? d : new Date(d);
  return n.getUTCFullYear().toString() +
    String(n.getUTCMonth() + 1).padStart(2, '0') +
    String(n.getUTCDate()).padStart(2, '0');
}

/** 'YYYYMMDD' minus N days → 'YYYYMMDD' (UTC calendar math). */
function cutoffStamp(todayUtc, days) {
  const t = new Date(Date.UTC(
    parseInt(todayUtc.slice(0, 4), 10),
    parseInt(todayUtc.slice(4, 6), 10) - 1,
    parseInt(todayUtc.slice(6, 8), 10)));
  t.setUTCDate(t.getUTCDate() - days);
  return utcDateStamp(t);
}

/**
 * Decide whether a station counts as already worked.
 *
 * @param {Array}  entries  workedQsos entries for the call:
 *                          [{date:'YYYYMMDD', ref, myRef, band, mode}, ...]
 * @param {object} opts
 * @param {string} opts.band          current band, e.g. '20M'
 * @param {string} opts.mode          current mode, e.g. 'FT8'
 * @param {number} [opts.reworkDays]  0 (default) = worked-before never expires
 * @param {string} opts.todayUtc      'YYYYMMDD' UTC stamp for "today"
 * @param {Array}  [opts.activatorRefs] park refs the station is CURRENTLY
 *                          spotted at (null/empty = not a spotted activator)
 * @returns {{worked:boolean, sameBandMode:boolean, blocking:boolean,
 *            reason:string, entries:Array, last:object|null}}
 *   worked/sameBandMode keep their historical all-time meaning (the toast
 *   text uses them); blocking is what the automatic paths act on. reason:
 *   'unworked' | 'other-band-mode' | 'blocking' | 'recent' | 'aged-out' |
 *   'park-today' | 'new-park'.
 */
function decideWorkedBefore(entries, opts) {
  const list = Array.isArray(entries) ? entries : [];
  const out = {
    worked: list.length > 0,
    sameBandMode: false,
    blocking: false,
    reason: 'unworked',
    entries: list,
    last: list.length ? list[list.length - 1] : null,
  };
  if (!list.length) return out;

  const b = (opts.band || '').toUpperCase();
  const m = (opts.mode || '').toUpperCase();
  const sameBM = list.filter((w) =>
    (w.band || '').toUpperCase() === b && (w.mode || '').toUpperCase() === m);
  out.sameBandMode = sameBM.length > 0;
  if (!sameBM.length) { out.reason = 'other-band-mode'; return out; }

  const refs = Array.isArray(opts.activatorRefs)
    ? opts.activatorRefs.map((r) => (r || '').toUpperCase()).filter(Boolean)
    : [];
  if (refs.length) {
    // Spotted activator: program rules. Only a same-UTC-day contact at one
    // of the currently spotted parks blocks. A same-day entry with NO park
    // recorded also blocks (it may well have BEEN this activation, logged
    // before the spot appeared) — but yesterday's contact, or today's at a
    // different park, is a legitimate new credit.
    out.blocking = sameBM.some((w) => w.date === opts.todayUtc &&
      (!(w.ref || '').trim() || refs.includes((w.ref || '').toUpperCase())));
    out.reason = out.blocking ? 'park-today' : 'new-park';
    return out;
  }

  const days = Number.isFinite(opts.reworkDays) && opts.reworkDays > 0
    ? Math.floor(opts.reworkDays) : 0;
  if (!days) { out.blocking = true; out.reason = 'blocking'; return out; }
  // Window active: an entry with no date can't prove it's old — block
  // (our own writers always stamp date; this only guards foreign ADIFs).
  const cutoff = cutoffStamp(opts.todayUtc, days);
  out.blocking = sameBM.some((w) => !(w.date || '').trim() || w.date >= cutoff);
  out.reason = out.blocking ? 'recent' : 'aged-out';
  return out;
}

module.exports = { decideWorkedBefore, utcDateStamp, cutoffStamp };
