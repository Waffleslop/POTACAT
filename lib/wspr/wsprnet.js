// SPDX-License-Identifier: Apache-2.0
// Copyright 2024-2026 Casey Stanton
//
// wsprnet.org spot upload. This is what makes a WSPR feature actually WSPR —
// the value is the global propagation map, keyed by your callsign + grid. We
// upload the spots our decoder (wsprd) found to wsprnet's classic per-spot
// "post" interface (the same one WSJT-X uses).
//
// Pure formatting + an INJECTABLE fetch so the param/URL construction is fully
// unit-tested without touching the network.

const POST_BASE_URL = 'http://wsprnet.org/post';

/**
 * Build the wsprnet "post" query parameters for one received spot.
 *
 * @param {object} spot  decoder output: { timeUtc('HHMM'), snr, dt, freqMHz,
 *                        drift, call, grid, dBm }
 * @param {object} rx    receiver identity: { call, grid }
 * @param {object} opts  { dialMHz, dateYYMMDD, timeHHMM?, version?, mode? }
 * @returns {object|null} param object, or null if the spot can't be reported
 *                        (hashed/compound message with no call+grid+dBm).
 */
function buildSpotParams(spot, rx, opts = {}) {
  if (!spot || !rx) return null;
  if (!spot.call || !spot.grid || spot.dBm == null) return null; // type-2/3, not reportable here
  if (!rx.call || !rx.grid) return null;
  if (opts.dialMHz == null) return null;
  const time = opts.timeHHMM || spot.timeUtc;
  if (!opts.dateYYMMDD || !time) return null;

  return {
    function: 'wspr',
    rcall: String(rx.call).toUpperCase(),
    rgrid: String(rx.grid).toUpperCase(),
    rqrg: Number(opts.dialMHz).toFixed(6),
    date: String(opts.dateYYMMDD),
    time: String(time),
    sig: String(spot.snr),
    dt: Number(spot.dt).toFixed(1),
    drift: String(spot.drift),
    tqrg: Number(spot.freqMHz).toFixed(6),
    tcall: String(spot.call).toUpperCase(),
    tgrid: String(spot.grid).toUpperCase(),
    dbm: String(spot.dBm),
    version: opts.version || 'POTACAT',
    mode: String(opts.mode || 2), // 2 = WSPR-2 (2-minute)
  };
}

/** Build the full GET URL for a param object. */
function buildPostUrl(params, baseUrl = POST_BASE_URL) {
  const qs = Object.keys(params)
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
    .join('&');
  return `${baseUrl}?${qs}`;
}

/**
 * Format the UTC date/time fields wsprnet wants from a JS Date (or ms epoch).
 * Kept separate so callers in main.js stamp the cycle time; never called from
 * tests with a live clock.
 * @returns {{dateYYMMDD:string, timeHHMM:string}}
 */
function utcStamp(dateOrMs) {
  const d = dateOrMs instanceof Date ? dateOrMs : new Date(dateOrMs);
  const p2 = (n) => String(n).padStart(2, '0');
  const yy = p2(d.getUTCFullYear() % 100);
  const dateYYMMDD = `${yy}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}`;
  const timeHHMM = `${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}`;
  return { dateYYMMDD, timeHHMM };
}

/** WSPR-2 window length: transmissions start on every even UTC minute. */
const WSPR_WINDOW_MS = 120000;

/**
 * The start of the 2-minute window a decode belongs to, which is what
 * wsprnet's date/time fields mean (WSJT-X reports the window start). The
 * decode finishes AFTER its window ends, so the clock at that moment names
 * the next window or later (W5JSS 2026-10-21: a :06 transmission reported
 * at :08 or :09).
 *   periodStartMs  the engine's record of the window this job's audio came
 *                  from (preferred; exact)
 *   finishedAtMs   when the decode came back; used only when the window is
 *                  unknown: the window before the one now running
 */
function wsprWindowStartMs(periodStartMs, finishedAtMs) {
  if (Number.isFinite(periodStartMs)) return Math.floor(periodStartMs / WSPR_WINDOW_MS) * WSPR_WINDOW_MS;
  const now = Number.isFinite(finishedAtMs) ? finishedAtMs : Date.now();
  return Math.floor(now / WSPR_WINDOW_MS) * WSPR_WINDOW_MS - WSPR_WINDOW_MS;
}

/**
 * Upload one spot. Network call is injected via opts.fetch (defaults to global
 * fetch in Electron main / Node 22+).
 * @returns {Promise<{ok:boolean, skipped?:boolean, status?:number, error?:string}>}
 */
async function uploadSpot(spot, rx, opts = {}) {
  const params = buildSpotParams(spot, rx, opts);
  if (!params) return { ok: false, skipped: true };
  const doFetch = opts.fetch || (typeof fetch !== 'undefined' ? fetch : null);
  if (!doFetch) return { ok: false, error: 'no fetch available' };
  const url = buildPostUrl(params, opts.baseUrl);
  try {
    const res = await doFetch(url, { method: 'GET' });
    return { ok: !!(res && res.ok !== false), status: res && res.status };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/**
 * Upload many spots; returns a summary. Sequential to be polite to wsprnet.
 * @returns {Promise<{uploaded:number, skipped:number, failed:number}>}
 */
async function uploadSpots(spots, rx, opts = {}) {
  let uploaded = 0, skipped = 0, failed = 0;
  for (const spot of spots || []) {
    const r = await uploadSpot(spot, rx, opts);
    if (r.skipped) skipped++;
    else if (r.ok) uploaded++;
    else failed++;
  }
  return { uploaded, skipped, failed };
}

module.exports = {
  buildSpotParams,
  buildPostUrl,
  utcStamp,
  wsprWindowStartMs,
  WSPR_WINDOW_MS,
  uploadSpot,
  uploadSpots,
  POST_BASE_URL,
};
