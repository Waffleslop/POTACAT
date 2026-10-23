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
const countries = readGeo('ne_110m_admin_0_countries.geojson');
const outCountries = { type: 'FeatureCollection', features: [] };
for (const f of countries.features) {
  const p = f.properties;
  const iso = (p.ISO_A2_EH && p.ISO_A2_EH !== '-99') ? p.ISO_A2_EH : ((p.ISO_A2 && p.ISO_A2 !== '-99') ? p.ISO_A2 : '');
  const geom = cleanGeometry({ type: f.geometry.type, coordinates: roundCoords(f.geometry.coordinates, 2) });
  if (!geom) continue;
  outCountries.features.push({ type: 'Feature', properties: { iso, name: p.NAME, long: p.NAME_LONG, a3: p.ADM0_A3, sov: p.SOVEREIGNT }, geometry: geom });
}
fs.writeFileSync(path.join(outDir, 'countries.json'), JSON.stringify(outCountries));
console.log('countries.json:', outCountries.features.length, 'features,', (fs.statSync(path.join(outDir, 'countries.json')).size / 1024).toFixed(0), 'KB');

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
