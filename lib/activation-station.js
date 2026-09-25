'use strict';

// The STATION side of a record logged during an activation: who sent it
// (OPERATOR / STATION_CALLSIGN), where from (MY_GRIDSQUARE) and which state
// (MY_STATE). N7VBN 2026-09-22, hunting while activating: of 19 records in
// one activation export, 13 had no MY_GRIDSQUARE, OPERATOR or
// STATION_CALLSIGN, none had MY_STATE, and the activator's own contacts had
// FREQ "NaN" and no BAND.
//
// Four renderer paths and two main paths build activation records, and each
// carried a different subset: the spot-log and banner paths added only
// MY_SIG/MY_SIG_INFO, the Act-screen logger added the grid and callsigns,
// the resume path dropped the grid, and the FT8 bridge stamped the operator's
// HOME grid (settings.grid) onto contacts made in a park. main.js stamps
// OPERATOR / STATION_CALLSIGN in saveQsoRecord — on its own copy, so the
// renderer's export never saw them.
//
// So the fill happens in main at the choke points every record passes
// (saveQsoRecord, and each activation export handler), from the park
// database, and only ever FILLS a blank — a grid the operator typed into the
// activation's grid box always wins over one derived from the park.
//
// MY_STATE only when the park lies in exactly ONE state: a park spanning two
// states cannot say which side the activator was on, and a wrong MY_STATE
// is worse than none (the same rule promptParkState applies to STATE).
//
// Pure: test/activation-station-test.js.

const FIELDS = ['operator', 'stationCallsign', 'myGridsquare', 'myState'];

function blank(v) { return v == null || String(v).trim() === ''; }

/**
 * @param {object} rec   qsoData-shaped record (camelCase fields)
 * @param {object} ctx
 *   myCallsign         settings.myCallsign
 *   park               park DB entry for rec.mySigInfo, or null
 *   latLonToGrid(lat, lon) -> 6-char grid
 *   parkStates(locationDesc) -> ['WA'] etc.
 * @returns {object} ONLY the fields that were blank and could be filled
 */
function activationStationFill(rec, ctx) {
  const out = {};
  if (!rec || blank(rec.mySigInfo)) return out; // not an activation record
  const c = ctx || {};
  const call = String(c.myCallsign || '').trim().toUpperCase();
  if (call && blank(rec.operator)) out.operator = call;
  if (call && blank(rec.stationCallsign)) out.stationCallsign = call;
  const park = c.park || null;
  if (park) {
    const lat = parseFloat(park.latitude);
    const lon = parseFloat(park.longitude);
    if (blank(rec.myGridsquare) && Number.isFinite(lat) && Number.isFinite(lon) && typeof c.latLonToGrid === 'function') {
      const g = c.latLonToGrid(lat, lon);
      if (g) out.myGridsquare = g;
    }
    if (blank(rec.myState) && typeof c.parkStates === 'function') {
      const states = c.parkStates(park.locationDesc) || [];
      if (states.length === 1) out.myState = states[0];
    }
  }
  return out;
}

module.exports = { activationStationFill, FIELDS };
