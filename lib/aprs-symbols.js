// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// APRS symbol (table + code) to one of the nine icons the APRS window draws:
// car, house, digi, igate, weather, hiker, boat, aircraft, other.
//
// Codes are read from the symbol tables in the APRS 1.0.1 spec (appendix 2)
// and the alternate-table overlay rules: table '/' is the primary table, '\'
// the alternate table, and any other table character (0-9, A-Z) is an overlay
// drawn on the alternate table's symbol (so 'I&' is an iGate, '1#' a digi).
// Anything not listed here is 'other'. The drawings are POTACAT's own
// (renderer/aprs-icons.js); no APRS bitmap is used.
//
// Dual-mode: require() in tests and in lib/aprs-stations.js, window.AprsSymbols
// in the APRS window.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AprsSymbols = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const ICONS = ['car', 'house', 'digi', 'igate', 'weather', 'hiker', 'boat', 'aircraft', 'other'];

  // Icons drawn from above, nose up, so they can turn to the station's course.
  const HEADED = new Set(['car', 'boat', 'aircraft']);

  // Primary table '/'.
  const PRIMARY = {
    car: '><=FPRUabfjkuv*',   // car, motorcycle, rail engine, farm vehicle, police, RV, bus,
                              // ambulance, bike, fire truck, jeep, truck, 18-wheeler, van, snowmobile
    house: '-y',              // house QTH (VHF), yagi at QTH
    digi: '#',                // digipeater
    igate: '&',               // HF gateway
    weather: '_W@',           // weather station, NWS site, hurricane prediction
    hiker: '[',               // human / person
    boat: 'YsC',              // yacht (sail), ship (power boat), canoe
    aircraft: "'^XgO",        // small aircraft, large aircraft, helicopter, glider, balloon
  };

  // Alternate table '\' and its overlays.
  const ALTERNATE = {
    car: '>kuv',              // car, SUV / special vehicle, truck, van (all with overlay)
    house: '-',               // house (HF)
    digi: '#',                // digipeater with overlay
    igate: '&',               // gateway with overlay (I& iGate, R& receive-only, ...)
    // weather station with digi, NWS site, advisory, hurricane, and the weather
    // conditions: cloudy, snow, hail, blowing snow, drizzle, freezing rain, snow
    // shower, haze, rain shower, lightning, thunderstorm, sunny, wall cloud, rain,
    // blowing dust, sleet, funnel cloud, gale flags, partly cloudy, tornado, flooding
    weather: '_W<@(*:BDFGHIJTU[`befgptw',
    boat: 'sC',               // ship / boat (top view), coast guard
    aircraft: '^',            // aircraft with overlay
  };

  function index(tbl) {
    const m = new Map();
    for (const icon of Object.keys(tbl)) for (const c of tbl[icon]) m.set(c, icon);
    return m;
  }
  const P = index(PRIMARY);
  const A = index(ALTERNATE);

  /** The icon for a symbol table character and code; 'other' when unknown. */
  function iconFor(table, code) {
    if (typeof table !== 'string' || typeof code !== 'string' || table.length !== 1 || code.length !== 1) return 'other';
    if (table === '/') return P.get(code) || 'other';
    if (table === '\\' || /[0-9A-Z]/.test(table)) return A.get(code) || 'other';
    return 'other';
  }

  function isHeaded(icon) { return HEADED.has(icon); }

  return { iconFor, isHeaded, ICONS };
});
