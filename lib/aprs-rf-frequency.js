// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// The 2 m APRS frequency for the operator's grid square (APRS phase 2,
// "Listen on my radio"). Pure: the caller hands in the country outlines
// (assets/geo/countries.json, Natural Earth 1:110m) so this needs no disk.
//
// Every entry below was checked against a published band plan on 2026-11-18,
// and each cites it. A country with no verified entry gets null and the
// window says so; it is never given a neighbour's frequency. Left out because
// no band plan was found that names their APRS frequency, or because the
// regional plan and known national practice differ:
//   - Japan (JARL's plan is in Japanese; 144.640 vs 144.660 not confirmed),
//   - China, Korea, India and the rest of IARU Region 3 apart from AU and NZ,
//   - Brazil, Argentina, Chile and the rest of South and Central America
//     (the IARU R2 plan names 144.390, but national practice was not
//     confirmed against a national plan),
//   - the Caribbean (IARU R2 2020 note 3 protects 145.010 MHz for APRS there,
//     which is not the 144.390 the rest of the region uses),
//   - Greenland (IARU Region 2, not in either regional entry),
//   - Mexico (Casey 2026-11-19, "verified regions only": its 144.390 came from
//     the IARU Region 2 regional plan alone; no national or society plan was
//     checked, so it has no entry until one is).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AprsRfFrequency = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ITU / IARU Region 1 countries present in assets/geo/countries.json:
  // Europe, Africa, the Middle East west of Iran, the former USSR, Mongolia.
  const REGION_1 = [
    // Europe
    'AL', 'AT', 'BA', 'BE', 'BG', 'BY', 'CH', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GB', 'GR', 'HR', 'HU',
    'IE', 'IS', 'IT', 'LT', 'LU', 'LV', 'MD', 'ME', 'MK', 'NL', 'NO', 'PL', 'PT', 'RO', 'RS', 'RU', 'SE', 'SI', 'SK',
    'UA', 'XK', 'TR',
    // Caucasus, Central Asia, Mongolia
    'AM', 'AZ', 'GE', 'KZ', 'KG', 'TJ', 'TM', 'UZ', 'MN',
    // Middle East (Region 1 part)
    'AE', 'IL', 'IQ', 'JO', 'KW', 'LB', 'OM', 'PS', 'QA', 'SA', 'SY', 'YE',
    // Africa
    'AO', 'BF', 'BI', 'BJ', 'BW', 'CD', 'CF', 'CG', 'CI', 'CM', 'DJ', 'DZ', 'EG', 'EH', 'ER', 'ET', 'GA', 'GH', 'GM',
    'GN', 'GQ', 'GW', 'KE', 'LR', 'LS', 'LY', 'MA', 'MG', 'ML', 'MR', 'MW', 'MZ', 'NA', 'NE', 'NG', 'RW', 'SD', 'SL',
    'SN', 'SO', 'SS', 'SZ', 'TD', 'TG', 'TN', 'TZ', 'UG', 'ZA', 'ZM', 'ZW',
  ];

  const ENTRIES = [
    {
      id: 'us', hz: 144390000, countries: ['US'],
      // IARU Region 2 Band Plan, September 2020 revision (iaru.org/wp-content/uploads/2020/10/IARU-Region-2-Band-plan.pdf),
      // p.11: "144.360-144.400 ... DM ... ACDS, APRS Center of Activity 144.390 MHz".
      // (ARRL's own band plan page lists no APRS line; its packet PDF dates from 1988.)
      source: 'IARU Region 2 Band Plan, September 2020, p.11: APRS Center of Activity 144.390 MHz',
    },
    {
      id: 'ca', hz: 144390000, countries: ['CA'],
      // Radio Amateurs of Canada, 144 MHz (2M) band plan (approved October 2020), rac.ca/?p=4072:
      // "144.390 – National APRS Frequency. See Note 6." Also IARU R2 2020 p.11 as above.
      source: 'Radio Amateurs of Canada 2 m band plan (October 2020): 144.390 National APRS Frequency',
    },
    {
      id: 'iaru-r1', hz: 144800000, countries: REGION_1,
      // IARU Region 1 VHF band plan ("VHF Bandplan", file of 2 December 2020, modified 7 July 2021;
      // irts.ie/dnloads/IARU-R1-Bandplan-VHF-2020.pdf), p.2: "144.794 - 144.9625, 12 kHz,
      // MGM Digital Communication: 144.800 APRS".
      source: 'IARU Region 1 VHF band plan (2020, rev. July 2021), p.2: 144.800 APRS',
    },
    {
      id: 'au', hz: 145175000, countries: ['AU'],
      // WIA Australian Amateur Radio Band Plan, February 2026
      // (wia.org.au/members/bandplans/data/documents/WIA Australian Band Plan 2026.pdf), p.19:
      // "145.175 MHz – National AX.25 APRS".
      source: 'WIA Australian Band Plan, February 2026, p.19: 145.175 MHz National AX.25 APRS',
    },
    {
      id: 'nz', hz: 144575000, countries: ['NZ'],
      // NZART New Zealand Amateur Radio Band Plans, NZ 2 m Band Plan (copyright NZART April 2026;
      // nzart.org.nz/wp-content/uploads/2026/07/Bandplan-2026-June.pdf), p.3:
      // "144.575 MHz APRS and Simplex Data. (Note-1)".
      source: 'NZART NZ 2 m Band Plan, April 2026, p.3: 144.575 MHz APRS and Simplex Data',
    },
  ];

  const BY_COUNTRY = new Map();
  for (const e of ENTRIES) for (const c of e.countries) BY_COUNTRY.set(c, e);

  /** Grid centre (4 or 6 characters) → {lat, lon}, or null. Same arithmetic as lib/grid.js. */
  function gridCentre(grid) {
    const g = String(grid || '').trim().toUpperCase();
    if (!/^[A-R]{2}[0-9]{2}([A-X]{2})?/.test(g)) return null;
    let lon = (g.charCodeAt(0) - 65) * 20 + Number(g[2]) * 2 - 180;
    let lat = (g.charCodeAt(1) - 65) * 10 + Number(g[3]) - 90;
    if (/^[A-R]{2}[0-9]{2}[A-X]{2}/.test(g)) {
      lon += (g.charCodeAt(4) - 65) * (2 / 24) + 1 / 24;
      lat += (g.charCodeAt(5) - 65) * (1 / 24) + 1 / 48;
    } else { lon += 1; lat += 0.5; }
    return { lat, lon };
  }

  function inRing(lon, lat, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function polygonsOf(geom) {
    if (!geom) return [];
    if (geom.type === 'Polygon') return [geom.coordinates];
    if (geom.type === 'MultiPolygon') return geom.coordinates;
    return [];
  }
  function kmBetween(lat1, lon1, lat2, lon2) {
    const r = Math.PI / 180;
    const a = Math.sin((lat2 - lat1) * r / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin((lon2 - lon1) * r / 2) ** 2;
    return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  /** How far a grid centre may sit off the 1:110m coastline and still count as that country. */
  const COAST_KM = 150;

  /**
   * ISO code of the country at lat/lon: inside an outline (holes respected),
   * else the nearest outline vertex within COAST_KM (the 110 m outlines are
   * coarse, so a coastal grid's centre can fall just offshore). '' for none.
   */
  function countryAt(lat, lon, countries) {
    const feats = (countries && countries.features) || [];
    for (const f of feats) {
      for (const poly of polygonsOf(f.geometry)) {
        if (!poly.length || !inRing(lon, lat, poly[0])) continue;
        let hole = false;
        for (let h = 1; h < poly.length; h++) if (inRing(lon, lat, poly[h])) { hole = true; break; }
        if (!hole) return (f.properties && f.properties.iso) || '';
      }
    }
    let best = '', bestKm = COAST_KM;
    for (const f of feats) {
      const iso = f.properties && f.properties.iso;
      if (!iso) continue;
      for (const poly of polygonsOf(f.geometry)) {
        for (const p of poly[0] || []) {
          if (Math.abs(p[1] - lat) > 2 || Math.abs(p[0] - lon) > 3) continue;
          const km = kmBetween(lat, lon, p[1], p[0]);
          if (km < bestKm) { bestKm = km; best = iso; }
        }
      }
    }
    return best;
  }

  function mhzText(hz) { return (hz / 1e6).toFixed(3); }

  function describe(e, iso) {
    return e ? { hz: e.hz, mhz: mhzText(e.hz), id: e.id, country: iso, source: e.source } : null;
  }

  /** The entry for an ISO country code, or null when none is verified. */
  function frequencyForCountry(iso) {
    const e = BY_COUNTRY.get(String(iso || '').toUpperCase());
    return describe(e || null, String(iso || '').toUpperCase());
  }

  /** {hz, mhz, id, country, source} for the grid square, or null. */
  function frequencyForGrid(grid, countries) {
    const c = gridCentre(grid);
    if (!c) return null;
    const iso = countryAt(c.lat, c.lon, countries);
    return iso ? frequencyForCountry(iso) : null;
  }

  return { ENTRIES, REGION_1, gridCentre, countryAt, frequencyForCountry, frequencyForGrid, mhzText, COAST_KM };
});
