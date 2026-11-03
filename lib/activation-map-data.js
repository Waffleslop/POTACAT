'use strict';
/**
 * What the desktop's LOG says about the contacts of an activation, for the
 * phone's recap (get-activation-map-data). NA4DQ 2026-10-24: the recap read
 * the phone's own thin copies and showed "0 States", "Bands: other" and no
 * pins. A state or grid is taken ONLY from a saved record, never from the
 * cty.dat call area (a call area is a guess, a logged STATE is a fact).
 *
 * Pure. `records` are parseAllRawQsos rows (upper-case ADIF keys).
 */

const PROGRAM_REF_KEYS = ['MY_SIG_INFO', 'MY_POTA_REF', 'MY_SOTA_REF', 'MY_WWFF_REF'];

function s(v) { return v == null ? '' : String(v).trim(); }

function atPark(rec, parkRef) {
  if (!parkRef) return false;
  const want = parkRef.toUpperCase();
  return PROGRAM_REF_KEYS.some((k) => s(rec[k]).toUpperCase().split(/[\s,]+/).includes(want));
}

/**
 * For each wanted callsign, the newest saved record — one logged at
 * `parkRef` wins over any other — reduced to the fields the recap shows.
 * @returns {Map<string, {state, gridsquare, band, freq, county, country}>} keyed by upper-case call
 */
function logDetailsFor(records, calls, parkRef) {
  const wanted = new Set((calls || []).map((c) => s(c).toUpperCase()).filter(Boolean));
  const best = new Map(); // call -> { rec, park, key }
  for (const r of records || []) {
    const call = s(r && r.CALL).toUpperCase();
    if (!wanted.has(call)) continue;
    const park = atPark(r, parkRef);
    const key = s(r.QSO_DATE) + s(r.TIME_ON).padEnd(6, '0');
    const cur = best.get(call);
    if (!cur || (park && !cur.park) || (park === cur.park && key >= cur.key)) best.set(call, { rec: r, park, key });
  }
  const out = new Map();
  for (const [call, { rec }] of best) {
    const d = {};
    const put = (k, v) => { const t = s(v); if (t) d[k] = t; };
    put('state', rec.STATE);
    put('gridsquare', rec.GRIDSQUARE);
    put('band', s(rec.BAND).toLowerCase());
    put('freq', rec.FREQ);
    put('county', rec.CNTY);
    put('country', rec.COUNTRY);
    out.set(call, d);
  }
  return out;
}

module.exports = { logDetailsFor };
