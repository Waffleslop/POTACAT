#!/usr/bin/env node
'use strict';
/**
 * Build the geo assets for the worked-states / worked-countries overlays
 * (docs/worked-states-countries-plan.md) from Natural Earth (public domain):
 *
 *   node scripts/build-geo-assets.js <dir with the three .geojson files>
 *
 *   <dir>/ne_110m_admin_0_countries.geojson        -> assets/geo/countries.json
 *   <dir>/ne_50m_admin_1_states_provinces.geojson  -> assets/geo/states.json
 *                                                   + assets/geo/grid-states.json
 *
 * Download (raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/):
 *   ne_110m_admin_0_countries.geojson, ne_50m_admin_1_states_provinces.geojson
 *
 * Outputs are checked in; run this only to refresh them. Nothing here runs
 * in the app.
 *
 * countries.json: { type:'FeatureCollection', features:[ { type:'Feature',
 *   properties:{ iso:'US', name:'United States of America', a3:'USA' },
 *   geometry } ] } — 110 m geometry, coordinates rounded to 0.01°.
 * states.json: US states (51 incl. DC) + Canadian provinces, 50 m geometry
 *   simplified (Douglas-Peucker 0.02°) and rounded to 0.001°;
 *   properties { cc:'US', code:'NJ', name:'New Jersey' }.
 * grid-states.json: { 'FN20': ['NJ','PA'], ... } — every 4-character
 *   Maidenhead grid that touches a US state or Canadian province, with the
 *   codes it touches, from the UNSIMPLIFIED 50 m polygons. A single code
 *   means the whole land area of that grid lies in one state ("certain");
 *   several mean a straddler. Built by point sampling (24 x 24 cell centres
 *   per grid) plus any polygon vertex strictly inside the grid, so a sliver
 *   smaller than a sample step still registers.
 */
const fs = require('fs');
const path = require('path');

const inDir = process.argv[2];
if (!inDir) { console.error('usage: node scripts/build-geo-assets.js <dir with Natural Earth geojson>'); process.exit(2); }
const outDir = path.join(__dirname, '..', 'assets', 'geo');
fs.mkdirSync(outDir, { recursive: true });

function readGeo(name) {
  return JSON.parse(fs.readFileSync(path.join(inDir, name), 'utf8'));
}

const round = (n, p) => { const f = Math.pow(10, p); return Math.round(n * f) / f; };

function roundCoords(coords, p) {
  if (typeof coords[0] === 'number') return [round(coords[0], p), round(coords[1], p)];
  return coords.map((c) => roundCoords(c, p));
}

/** Drop consecutive duplicate points a rounding pass creates; keep rings closed. */
function dedupeRing(ring) {
  const out = [];
  for (const pt of ring) {
    const last = out[out.length - 1];
    if (!last || last[0] !== pt[0] || last[1] !== pt[1]) out.push(pt);
  }
  if (out.length > 1) {
    const a = out[0], b = out[out.length - 1];
    if (a[0] !== b[0] || a[1] !== b[1]) out.push([a[0], a[1]]);
  }
  return out;
}

function cleanGeometry(geom) {
  if (geom.type === 'Polygon') {
    const rings = geom.coordinates.map(dedupeRing).filter((r) => r.length >= 4);
    return rings.length ? { type: 'Polygon', coordinates: rings } : null;
  }
  if (geom.type === 'MultiPolygon') {
    const polys = geom.coordinates.map((p) => p.map(dedupeRing).filter((r) => r.length >= 4)).filter((p) => p.length);
    return polys.length ? { type: 'MultiPolygon', coordinates: polys } : null;
  }
  return null;
}

// --- Douglas-Peucker on a ring (lon/lat degrees) ---
function perpDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  if (dx === 0 && dy === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}
function dp(points, tol) {
  if (points.length <= 2) return points.slice();
  let maxD = -1, idx = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpDist(points[i], points[0], points[points.length - 1]);
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (maxD <= tol) return [points[0], points[points.length - 1]];
  const left = dp(points.slice(0, idx + 1), tol);
  const right = dp(points.slice(idx), tol);
  return left.slice(0, -1).concat(right);
}
function simplifyRing(ring, tol) {
  // Closed ring: simplify as an open line from the point farthest from the
  // first one, so the seam is not a straight cut through a real corner.
  const open = ring.slice(0, -1);
  if (open.length < 4) return ring;
  let far = 0, fd = -1;
  for (let i = 1; i < open.length; i++) { const d = Math.hypot(open[i][0] - open[0][0], open[i][1] - open[0][1]); if (d > fd) { fd = d; far = i; } }
  const a = dp(open.slice(0, far + 1), tol);
  const b = dp(open.slice(far).concat([open[0]]), tol);
  const out = a.slice(0, -1).concat(b);
  return out.length >= 4 ? out : ring;
}
function simplifyGeometry(geom, tol) {
  const simp = (ring) => simplifyRing(ring, tol);
  if (geom.type === 'Polygon') return { type: 'Polygon', coordinates: geom.coordinates.map(simp) };
  return { type: 'MultiPolygon', coordinates: geom.coordinates.map((p) => p.map(simp)) };
}

// --- point in polygon (ray casting, holes honoured) ---
function inRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
function inPolygon(x, y, poly) {
  if (!inRing(x, y, poly[0])) return false;
  for (let h = 1; h < poly.length; h++) if (inRing(x, y, poly[h])) return false;
  return true;
}
function polygonsOf(geom) {
  return geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
}
function bboxOf(geom) {
  let minX = 180, minY = 90, maxX = -180, maxY = -90;
  for (const poly of polygonsOf(geom)) for (const ring of poly) for (const [x, y] of ring) {
    if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

// --- Maidenhead 4-char grid <-> lon/lat box ---
function gridBox(grid) {
  const lonField = grid.charCodeAt(0) - 65, latField = grid.charCodeAt(1) - 65;
  const lonSq = +grid[2], latSq = +grid[3];
  const lon0 = -180 + lonField * 20 + lonSq * 2;
  const lat0 = -90 + latField * 10 + latSq;
  return [lon0, lat0, lon0 + 2, lat0 + 1];
}
function gridAt(lon, lat) {
  const lonField = Math.floor((lon + 180) / 20), latField = Math.floor((lat + 90) / 10);
  const lonSq = Math.floor(((lon + 180) % 20) / 2), latSq = Math.floor((lat + 90) % 10);
  return String.fromCharCode(65 + lonField) + String.fromCharCode(65 + latField) + lonSq + latSq;
}

// ---------------------------------------------------------------- countries
// Every output feature carries `dxcc`: the cty.dat ENTITY NAMES it stands
// for (the worked roster is keyed by those names), so the renderer needs no
// mapping of its own. Most come from name matching against cty.dat; the rest
// from DXCC_BY_ISO. Some entities are PARTS of a Natural Earth country
// (Alaska and Hawaii inside the US, Sardinia inside Italy, the Galapagos
// inside Ecuador): PART_RULES assign a multipolygon part to another entity by
// the box its centroid falls in. European and Asiatic Russia are one
// polygon, clipped at 60 E (CLIP_RULES) — the DXCC line follows the Urals,
// and a straight line there is within a degree of it for a map tint.
// Entities with no polygon (islands, bases) are drawn as circles at cty.dat's
// own lat/lon by the app, so nothing here has to be complete.
const { loadCtyDat } = require('../lib/cty');
const cty = loadCtyDat(path.join(__dirname, '..', 'assets', 'cty.dat'));
const ctyNames = new Set(cty.entities.map((e) => e.name));
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
const ctyByNorm = new Map(cty.entities.map((e) => [norm(e.name), e.name]));

const DXCC_BY_ISO = {
  BA: ['Bosnia-Herzegovina'], CI: ["Cote d'Ivoire"], CD: ['Dem. Rep. of the Congo'], KP: ['DPR of Korea'],
  DE: ['Fed. Rep. of Germany'], SK: ['Slovak Republic'], XK: ['Republic of Kosovo'], SS: ['Republic of South Sudan'],
  TT: ['Trinidad & Tobago'], FK: ['Falkland Islands'], TR: ['Asiatic Turkey'], TF: ['Kerguelen Islands'],
  GB: ['England', 'Scotland', 'Wales'], CY: ['Cyprus'], SO: ['Somalia'],
};
// NE features with no ISO: N. Cyprus and Somaliland are parts of those entities for DXCC.
const DXCC_BY_NAME = { 'N. Cyprus': ['Cyprus'], 'Somaliland': ['Somalia'] };

// [minLon, minLat, maxLon, maxLat] boxes, tested against a PART's centroid.
const PART_RULES = [
  { iso: 'US', dxcc: ['Alaska'], box: [-180, 50, -128, 75] },
  { iso: 'US', dxcc: ['Alaska'], box: [165, 50, 180, 75] },           // Aleutians past the antimeridian
  { iso: 'US', dxcc: ['Hawaii'], box: [-180, 15, -150, 30] },
  { iso: 'FR', dxcc: ['French Guiana'], box: [-60, 0, -48, 8] },
  { iso: 'FR', dxcc: ['Corsica'], box: [8, 41, 10, 43.2] },
  { iso: 'NO', dxcc: ['Svalbard'], box: [8, 73, 36, 82] },
  { iso: 'NO', dxcc: ['Jan Mayen'], box: [-10, 70, -7, 72] },
  { iso: 'RU', dxcc: ['Kaliningrad'], box: [19, 54, 23.5, 56] },
  { iso: 'RU', dxcc: ['Franz Josef Land'], box: [40, 79, 70, 83] },
  { iso: 'IT', dxcc: ['Sardinia'], box: [8, 38.7, 10, 41.4] },
  { iso: 'IT', dxcc: ['Sicily'], box: [12, 36.5, 15.8, 38.4] },
  { iso: 'GR', dxcc: ['Crete'], box: [23, 34.5, 26.5, 35.8] },
  { iso: 'GR', dxcc: ['Dodecanese'], box: [26.5, 35, 29, 37.5] },
  { iso: 'ES', dxcc: ['Balearic Islands'], box: [1, 38.5, 4.5, 40.2] },
  { iso: 'ES', dxcc: ['Canary Islands'], box: [-19, 27, -13, 29.5] },
  { iso: 'PT', dxcc: ['Azores'], box: [-32, 36, -24, 40] },
  { iso: 'PT', dxcc: ['Madeira Islands'], box: [-18, 32, -16, 33.5] },
  { iso: 'IN', dxcc: ['Andaman & Nicobar Is.'], box: [90, 5, 95, 15] },
  { iso: 'EC', dxcc: ['Galapagos Islands'], box: [-93, -2.5, -88, 1.5] },
  { iso: 'MY', dxcc: ['East Malaysia'], box: [108, 0, 120, 8] },
  { iso: 'GB', dxcc: ['Northern Ireland'], box: [-8.5, 53.9, -5.3, 55.5] },
  { iso: 'GB', dxcc: ['Shetland Islands'], box: [-2, 59.7, 0, 61] },
  { iso: 'DK', dxcc: ['Faroe Islands'], box: [-8, 61, -6, 63] },
  { iso: 'CL', dxcc: ['Easter Island'], box: [-110.5, -27.5, -108.5, -26.5] },
  { iso: 'CL', dxcc: ['Juan Fernandez Islands'], box: [-81, -34.5, -78, -33] },
  { iso: 'BR', dxcc: ['Fernando de Noronha'], box: [-33, -4.5, -32, -3.5] },
  { iso: 'JP', dxcc: ['Ogasawara'], box: [141, 24, 143, 28] },
  { iso: 'CN', dxcc: ['Hong Kong'], box: [113.8, 22.1, 114.5, 22.6] },
  { iso: 'AU', dxcc: ['Lord Howe Island'], box: [158, -32, 160, -31] },
  { iso: 'NZ', dxcc: ['Chatham Islands'], box: [-177.5, -44.5, -175.5, -43.5] },
  { iso: 'NZ', dxcc: ['N.Z. Subantarctic Is.'], box: [165, -53, 180, -47.5] },
  { iso: 'YE', dxcc: ['Yemen'], box: [52, 12, 55, 13] },              // Socotra stays Yemen
  { iso: 'MY', dxcc: ['West Malaysia'], box: [99, 0, 105, 8] },
];
// A vertical cut through one country: the part west of `lon` is one entity, east another.
const CLIP_RULES = [
  { iso: 'RU', lon: 60, west: ['European Russia'], east: ['Asiatic Russia'] },
];

function centroidOf(poly) {
  let sx = 0, sy = 0, n = 0;
  for (const [x, y] of poly[0]) { sx += x; sy += y; n++; }
  return [sx / n, sy / n];
}
function inBox(c, b) { return c[0] >= b[0] && c[0] <= b[2] && c[1] >= b[1] && c[1] <= b[3]; }

// Sutherland-Hodgman clip of a ring against lon = x, keeping one side.
function clipRingLon(ring, x, keepWest) {
  const inside = (p) => keepWest ? p[0] <= x : p[0] >= x;
  const cross = (a, b) => { const t = (x - a[0]) / (b[0] - a[0]); return [x, a[1] + t * (b[1] - a[1])]; };
  const out = [];
  const pts = ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring.slice(0, -1) : ring;
  for (let i = 0; i < pts.length; i++) {
    const cur = pts[i], prev = pts[(i + pts.length - 1) % pts.length];
    if (inside(cur)) { if (!inside(prev)) out.push(cross(prev, cur)); out.push(cur); }
    else if (inside(prev)) out.push(cross(prev, cur));
  }
  if (out.length < 3) return null;
  out.push([out[0][0], out[0][1]]);
  return out;
}
function clipPolygonLon(poly, x, keepWest) {
  const outer = clipRingLon(poly[0], x, keepWest);
  if (!outer) return null;
  const holes = poly.slice(1).map((h) => clipRingLon(h, x, keepWest)).filter(Boolean);
  return [outer, ...holes];
}

const countries = readGeo('ne_110m_admin_0_countries.geojson');
const outCountries = { type: 'FeatureCollection', features: [] };
const assigned = new Set();
const partLog = [];
for (const f of countries.features) {
  const p = f.properties;
  const iso = (p.ISO_A2_EH && p.ISO_A2_EH !== '-99') ? p.ISO_A2_EH : ((p.ISO_A2 && p.ISO_A2 !== '-99') ? p.ISO_A2 : '');
  // the entity names this country stands for
  let dxcc = DXCC_BY_ISO[iso] || DXCC_BY_NAME[p.NAME] || [];
  if (!dxcc.length) {
    for (const k of [p.NAME, p.NAME_LONG, p.SOVEREIGNT, p.ADMIN, p.FORMAL_EN]) {
      const hit = ctyByNorm.get(norm(k));
      if (hit) { dxcc = [hit]; break; }
    }
  }
  if (!dxcc.length) console.warn('no DXCC entity for', iso, p.NAME);
  // split multipolygon parts to other entities where PART_RULES say so
  const polys = polygonsOf(f.geometry);
  const groups = new Map(); // key -> { dxcc, polys }
  for (const poly of polys) {
    const c = centroidOf(poly);
    const rule = PART_RULES.find((r) => r.iso === iso && inBox(c, r.box));
    const names = rule ? rule.dxcc : dxcc;
    const key = names.join('|');
    if (!groups.has(key)) groups.set(key, { dxcc: names, polys: [] });
    groups.get(key).polys.push(poly);
    if (rule) partLog.push(`${iso} part at ${c[0].toFixed(1)},${c[1].toFixed(1)} -> ${names.join('/')}`);
  }
  for (const g of groups.values()) {
    let pieces = [{ dxcc: g.dxcc, polys: g.polys }];
    const clip = CLIP_RULES.find((r) => r.iso === iso && g.dxcc === dxcc);
    if (clip) {
      const west = g.polys.map((poly) => clipPolygonLon(poly, clip.lon, true)).filter(Boolean);
      const east = g.polys.map((poly) => clipPolygonLon(poly, clip.lon, false)).filter(Boolean);
      pieces = [{ dxcc: clip.west, polys: west }, { dxcc: clip.east, polys: east }];
    }
    for (const piece of pieces) {
      if (!piece.polys.length) continue;
      const geom = cleanGeometry({ type: 'MultiPolygon', coordinates: roundCoords(piece.polys, 2) });
      if (!geom) continue;
      piece.dxcc.forEach((n) => assigned.add(n));
      for (const n of piece.dxcc) if (!ctyNames.has(n)) console.warn('DXCC name not in cty.dat:', n);
      outCountries.features.push({ type: 'Feature', properties: { iso, name: p.NAME, dxcc: piece.dxcc }, geometry: geom });
    }
  }
}
fs.writeFileSync(path.join(outDir, 'countries.json'), JSON.stringify(outCountries));
console.log('countries.json:', outCountries.features.length, 'features,', (fs.statSync(path.join(outDir, 'countries.json')).size / 1024).toFixed(0), 'KB;',
  assigned.size, 'of', cty.entities.length, 'DXCC entities have a polygon (the rest draw as circles)');
console.log(partLog.join('\n'));
console.log('circle entities:', cty.entities.filter((e) => !assigned.has(e.name)).map((e) => e.name).join(', '));

// ------------------------------------------------------------------- states
const admin1 = readGeo('ne_50m_admin_1_states_provinces.geojson');
const WANT = { US: 1, CA: 1 };
const states = [];
for (const f of admin1.features) {
  const p = f.properties;
  if (!WANT[p.iso_a2]) continue;
  const code = String(p.postal || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) { console.warn('skip', p.iso_a2, p.name, p.postal); continue; }
  states.push({ cc: p.iso_a2, code, name: p.name, geometry: f.geometry });
}
states.sort((a, b) => (a.cc + a.code).localeCompare(b.cc + b.code));

const outStates = { type: 'FeatureCollection', features: [] };
for (const s of states) {
  const geom = cleanGeometry({ type: s.geometry.type, coordinates: roundCoords(simplifyGeometry(s.geometry, 0.02).coordinates, 3) });
  if (!geom) { console.warn('empty after simplify', s.code); continue; }
  outStates.features.push({ type: 'Feature', properties: { cc: s.cc, code: s.code, name: s.name }, geometry: geom });
}
fs.writeFileSync(path.join(outDir, 'states.json'), JSON.stringify(outStates));
console.log('states.json:', outStates.features.length, 'features,', (fs.statSync(path.join(outDir, 'states.json')).size / 1024).toFixed(0), 'KB');

// ------------------------------------------------------------- grid -> states
const N = 24;
const table = {};
const add = (grid, code) => { (table[grid] = table[grid] || new Set()).add(code); };
for (const s of states) {
  const polys = polygonsOf(s.geometry);
  const [minX, minY, maxX, maxY] = bboxOf(s.geometry);
  // every polygon vertex strictly INSIDE a grid marks it (slivers). A vertex
  // on a grid edge is skipped: many state lines run along whole degrees
  // (42 N, 49 N, 32 N), which are grid edges too, and both neighbours own
  // those vertices, so the grid north of the line would gain the state south.
  for (const poly of polys) for (const ring of poly) for (const [x, y] of ring) {
    if (Number.isInteger(y) || (Number.isInteger(x) && x % 2 === 0)) continue;
    add(gridAt(x, y), s.code);
  }
  // sample every grid the bbox touches
  const g0 = gridBox(gridAt(minX, minY)), g1 = gridBox(gridAt(Math.min(maxX, 179.999), Math.min(maxY, 89.999)));
  for (let lat0 = g0[1]; lat0 <= g1[1]; lat0 += 1) {
    for (let lon0 = g0[0]; lon0 <= g1[0]; lon0 += 2) {
      const grid = gridAt(lon0 + 0.001, lat0 + 0.001);
      let hit = false;
      const pts = [];
      // cell centres, never the grid's own edges (a state line on a whole degree)
      for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) pts.push([lon0 + (2 * (i + 0.5)) / N, lat0 + (j + 0.5) / N]);
      for (const [x, y] of pts) {
        if (x < minX || x > maxX || y < minY || y > maxY) continue;
        for (const poly of polys) { if (inPolygon(x, y, poly)) { hit = true; break; } }
        if (hit) break;
      }
      if (hit) add(grid, s.code);
    }
  }
}
const outTable = {};
for (const grid of Object.keys(table).sort()) outTable[grid] = [...table[grid]].sort();
fs.writeFileSync(path.join(outDir, 'grid-states.json'), JSON.stringify(outTable));
const multi = Object.values(outTable).filter((v) => v.length > 1).length;
console.log('grid-states.json:', Object.keys(outTable).length, 'grids,', multi, 'straddlers,', (fs.statSync(path.join(outDir, 'grid-states.json')).size / 1024).toFixed(0), 'KB');
console.log('spot checks: FN20', outTable.FN20, '| FN31', outTable.FN31, '| CN87', outTable.CN87, '| EM12', outTable.EM12, '| BL11', outTable.BL11, '| BP51', outTable.BP51, '| DM04', outTable.DM04);

fs.writeFileSync(path.join(outDir, 'LICENSE'), [
  'The files in this folder are derived from Natural Earth (naturalearthdata.com),',
  '1:110m Admin 0 Countries and 1:50m Admin 1 States and Provinces.',
  'Natural Earth is in the public domain: no permission is needed to use, modify',
  'or redistribute it. Rebuilt with scripts/build-geo-assets.js.',
  '',
].join('\n'));
