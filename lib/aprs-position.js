// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// Where the APRS beacon's position comes from. Both beacons (APRS-IS and the
// radio) ask this one place.
//
//  - 'settings' (the default): the point picked on the map, else the
//    Settings grid's centre (lib/aprs-beacon.js beaconPosition).
//  - 'gps': the radio's GPS (lib/flex-gps.js), the latest fix at the moment
//    of the beacon. With no GPS or no fix the beacon is refused in one plain
//    sentence. It never sends 0,0 and never falls back to another position.
//
// The chosen precision applies to either source: a 4- or 6-character grid
// sends that grid square's centre (from the GPS grid when the source is the
// GPS); exact sends the point; the packet builder then cuts to the minute when
// the position is approximate.
'use strict';

const AprsBeacon = require('./aprs-beacon');
const FlexGps = require('./flex-gps');

const SOURCES = Object.freeze(['settings', 'gps']);

function cleanSource(v) { return v === 'gps' ? 'gps' : 'settings'; }

/**
 * @returns {{ok:true, lat:number, lon:number, source:'map'|'grid'|'gps'}|{ok:false, reason:string, sentence:string}}
 */
function beaconPositionFrom({ source, precision, gps, lat, lon, grid, gridToLatLon }) {
  if (cleanSource(source) === 'gps') {
    if (!gps || !gps.installed) {
      return { ok: false, reason: 'gps-none', sentence: "Your beacon position is your radio's GPS, but no radio with a GPS is connected, so nothing was sent." };
    }
    const okPoint = gps.fix === true && typeof gps.lat === 'number' && typeof gps.lon === 'number'
      && isFinite(gps.lat) && isFinite(gps.lon) && gps.lat !== 0 && gps.lon !== 0
      && Math.abs(gps.lat) <= 90 && Math.abs(gps.lon) <= 180;
    if (!okPoint) {
      return { ok: false, reason: 'gps-no-fix', sentence: `Your radio's GPS has no fix yet (${FlexGps.statusLine(gps)}), so nothing was sent.` };
    }
    // A grid precision sends the centre of the GPS grid square, never the fix itself.
    if (precision === 'grid4' || precision === 'grid6') {
      const g = String(gps.grid || '').slice(0, precision === 'grid4' ? 4 : 6);
      const c = g.length >= 4 && typeof gridToLatLon === 'function' ? gridToLatLon(g) : null;
      if (!c || !AprsBeacon.validPoint(c.lat, c.lon)) {
        return { ok: false, reason: 'gps-no-fix', sentence: `Your radio's GPS has no grid yet (${FlexGps.statusLine(gps)}), so nothing was sent.` };
      }
      return { ok: true, lat: c.lat, lon: c.lon, source: 'gps' };
    }
    return { ok: true, lat: gps.lat, lon: gps.lon, source: 'gps' };
  }
  // The Settings position at its precision (lib/aprs-beacon.js positionInputs): a grid never uses a picked point.
  const at = AprsBeacon.positionInputs({ precision, lat, lon, grid });
  const p = AprsBeacon.beaconPosition({ lat: at.lat, lon: at.lon, grid: at.grid, gridToLatLon });
  if (!p) return { ok: false, reason: 'position', sentence: AprsBeacon.SENTENCES.position };
  return { ok: true, lat: p.lat, lon: p.lon, source: p.source };
}

module.exports = { SOURCES, cleanSource, beaconPositionFrom };
