'use strict';
// The DXCC entity of a POTA park (GitHub #662).
//
// An activator abroad often signs his home call with no prefix: W1ABC in a
// Cayman Islands park. His call resolves to the United States, so the spot
// said United States and not DX, while a ZF2 operator in the same park
// showed Cayman Islands and DX. DXCC counts where the station is, so for a
// POTA park whose entity is known, the park's entity is the station's.
//
// POTA knows every park's entity: each park has a location ("KY-GT",
// "US-AK", "GB-SCT"), and every location belongs to one DXCC entity
// (https://api.pota.app/locations). data/pota-location-entities.json holds
// that, named the way cty.dat names entities: a program whose locations all
// lie in one entity is listed once under `programs` ("KY": "Cayman Islands"),
// the others location by location under `locations` ("US-AK": "Alaska").
//
// Only POTA: WWFF, SOTA and the cluster carry no park location, so their
// spots keep the callsign's entity.

const DATA = require('../data/pota-location-entities.json');

function programOf(code) {
  const m = /^([A-Z0-9]{1,4})-[A-Z0-9]+$/.exec(code);
  return m ? m[1] : '';
}

/**
 * The entity of one POTA location or park reference ("KY-GT", "US-AK",
 * "KY-0001"): the location's own, else its program's when the program is
 * one entity. '' when unknown.
 */
function entityOfCode(code) {
  const c = String(code || '').trim().toUpperCase();
  if (!c) return '';
  if (Object.prototype.hasOwnProperty.call(DATA.locations, c)) return DATA.locations[c];
  const p = programOf(c);
  return p && Object.prototype.hasOwnProperty.call(DATA.programs, p) ? DATA.programs[p] : '';
}

/**
 * The DXCC entity (cty.dat name) a POTA park lies in, or '' when unknown.
 * `locationDesc` is the park's ("US-WA" or "US-WA,US-ID"); every location
 * listed must agree. Without one, the reference's program decides, and only
 * when the program is a single entity (US-1234 alone could be Alaska).
 */
function potaParkEntity(reference, locationDesc) {
  const locs = String(locationDesc || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (locs.length) {
    const names = new Set(locs.map(entityOfCode));
    if (names.size === 1 && !names.has('')) return [...names][0];
    return '';
  }
  const ref = String(reference || '').trim().toUpperCase();
  const p = programOf(ref);
  return p && Object.prototype.hasOwnProperty.call(DATA.programs, p) ? DATA.programs[p] : '';
}

/**
 * The park's entity when it differs from the one the callsign resolves to,
 * else ''. Entities are compared by DXCC code (`codeOf`, lib/dxcc-codes.js
 * dxccCodeForEntity) so a WAE-only name keeps its place: an IT9 call in an
 * Italian park stays Sicily, which is DXCC Italy.
 * @param {string} callEntity  cty.dat entity of the call ('' = unknown)
 * @param {string} parkEntity  potaParkEntity(...) ('' = unknown)
 * @param {(name: string) => number|null} [codeOf]
 */
function parkEntityOverride(callEntity, parkEntity, codeOf) {
  const park = String(parkEntity || '');
  if (!park) return '';
  const call = String(callEntity || '');
  if (!call) return park;
  if (call === park) return '';
  if (typeof codeOf === 'function') {
    const a = codeOf(call);
    const b = codeOf(park);
    if (a != null && b != null && Number(a) === Number(b)) return '';
  }
  return park;
}

module.exports = { potaParkEntity, parkEntityOverride, entityOfCode, DATA };
