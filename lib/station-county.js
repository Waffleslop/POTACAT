// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// The operator's OWN state and county on each contact (ADIF MY_STATE and
// MY_CNTY), for LoTW and every logger a record is forwarded to (AE5JE
// 2026-10-27: "add the operator's county and state ... this may cause issues
// for those that activate from many locations").
//
// So it is never one pair of fields stamped on everything:
//   - an ACTIVATION contact takes the county the operator chose for THAT park
//     (asked once per park, remembered per park: settings.parkCounties), and
//     the state from the park when it lies in one state, else from that choice;
//   - any other contact takes the HOME state and county (Settings > Station),
//     and only when it was made from the home grid square: a portable contact
//     with another grid gets neither, rather than the wrong county.
// Only blank fields are filled; whatever a logging path supplied is kept.
//
// MY_CNTY is "ST,County" with the county spelled as LoTW / TQSL spell it
// (assets/geo/us-counties.json, from TQSL's config.xml).
'use strict';

function str(v) { return v == null ? '' : String(v).trim(); }

/** ADIF MY_CNTY / CNTY value: "VA,Fairfax", or '' when either half is missing. */
function countyValue(state, county) {
  const s = str(state).toUpperCase();
  const c = str(county);
  return s && c ? `${s},${c}` : '';
}

/** "VA,Fairfax" -> { state: 'VA', county: 'Fairfax' } (null when not that shape). */
function parseCountyValue(v) {
  const m = /^([A-Za-z]{2})\s*,\s*(.+)$/.exec(str(v));
  return m ? { state: m[1].toUpperCase(), county: m[2].trim() } : null;
}

/** A US park reference, the only kind that has a US county. */
function isUsParkRef(ref) {
  return /^(US|K)-\d+$/i.test(str(ref));
}

/** The county as the list spells it (case-insensitive match), or ''. */
function knownCounty(list, state, county) {
  const rows = list && list[str(state).toUpperCase()];
  if (!Array.isArray(rows)) return '';
  const want = str(county).toLowerCase();
  for (const r of rows) {
    const v = Array.isArray(r) ? r[0] : r;
    if (String(v).toLowerCase() === want) return String(v);
  }
  return '';
}

/**
 * The MY_STATE / MY_CNTY a record should carry, for its BLANK fields only.
 * @param {object} rec   qsoData (mySigInfo, myState, myCounty, myGridsquare)
 * @param {object} ctx
 *   home        { state, county, grid } from the operator's settings
 *   parkCounty  (ref) -> { state, county } | null, the operator's choice for a park
 * @returns {{ myState?: string, myCounty?: string }}
 */
function stationLocationFor(rec, ctx = {}) {
  const out = {};
  if (!rec) return out;
  const haveState = !!str(rec.myState);
  const haveCounty = !!str(rec.myCounty);
  if (haveState && haveCounty) return out;
  const refs = str(rec.mySigInfo).split(',').map((r) => r.trim()).filter(Boolean);
  if (refs.length) {
    // An activation: the park's own choice, never the home one.
    for (const ref of refs) {
      const pc = typeof ctx.parkCounty === 'function' ? ctx.parkCounty(ref.toUpperCase()) : null;
      if (!pc || !str(pc.state)) continue;
      const state = haveState ? str(rec.myState).toUpperCase() : str(pc.state).toUpperCase();
      if (!haveState) out.myState = state;
      // A county is only true with its own state.
      if (!haveCounty && str(pc.county) && state === str(pc.state).toUpperCase()) out.myCounty = countyValue(state, pc.county);
      break;
    }
    return out;
  }
  const home = ctx.home || {};
  const hs = str(home.state).toUpperCase();
  if (!hs) return out;
  const grid = str(rec.myGridsquare).toUpperCase();
  const hg = str(home.grid).toUpperCase();
  if (grid && hg && grid.slice(0, 4) !== hg.slice(0, 4)) return out; // not made from home
  if (!haveState) out.myState = hs;
  if (!haveCounty && str(home.county) && (!haveState || str(rec.myState).toUpperCase() === hs)) out.myCounty = countyValue(hs, home.county);
  return out;
}

/**
 * The home grid for a FORWARDED copy of a home contact (AE5JE 2026-10-28: his
 * N3FJP log gets MY_STATE / MY_CNTY from POTACAT and wanted MY_GRIDSQUARE
 * too). Only for the record handed to another logger: the stored ADIF and the
 * LoTW batch keep no grid, so TQSL's location check never sees one that
 * disagrees with the Station Location. Never on an activation, never over a
 * grid the record has, never when the record says another state.
 * @returns {string} the grid to use, or ''
 */
function forwardHomeGrid(rec, home) {
  if (!rec || !home) return '';
  const hg = str(home.grid).toUpperCase();
  if (!/^[A-R]{2}[0-9]{2}([A-X]{2})?$/.test(hg)) return '';
  if (str(rec.myGridsquare)) return '';
  if (str(rec.mySigInfo) || str(rec.mySotaRef) || str(rec.myWwffRef) || str(rec.myPotaRef)) return '';
  const rs = str(rec.myState).toUpperCase();
  const hs = str(home.state).toUpperCase();
  if (rs && hs && rs !== hs) return '';
  return str(home.grid);
}

const api = { countyValue, parseCountyValue, isUsParkRef, knownCounty, stationLocationFor, forwardHomeGrid };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.StationCounty = api;
