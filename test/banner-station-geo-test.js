#!/usr/bin/env node
'use strict';
// #1097: the Bottom Banner Logger showed a call-area estimate (EM12 for every
// US "5" call) exactly like a QRZ grid, with a distance and heading. Now:
//   - QRZ / spot grids read as before: "FN20 | 97mi | 92°"
//   - a call-area estimate reads "EM12 (estimate)", no distance, no heading
//   - a country-centre estimate keeps "~distance | heading" on a long path,
//     drops both when closer than 500 mi / 800 km
//   - the renderer uses this module, and marks the estimate muted
//   - the estimate is never logged (the banner sends no grid; the log's
//     GRIDSQUARE comes from QRZ only)
//   - the QRZ help text no longer says "a free QRZ account works"
// Run: node test/banner-station-geo-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const G = require('../lib/banner-station-geo');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8').replace(/\r\n/g, '\n');
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok -', name); };

t('QRZ grid reads as before', () => {
  const r = G.stationGeoReadout({ grid: 'fn20xr', source: 'qrz', distance: 97.4, heading: 91.6, unit: 'mi' });
  assert.strictEqual(r.text, 'FN20 | 97mi | 92°');
  assert.strictEqual(r.estimate, false);
  assert.strictEqual(r.title, 'Grid from QRZ profile');
});

t('spot grid reads as before, in km too', () => {
  const r = G.stationGeoReadout({ grid: 'EM12', source: 'spot', distance: 150, heading: 5, unit: 'km' });
  assert.strictEqual(r.text, 'EM12 | 150km | 5°');
  assert.strictEqual(r.estimate, false);
});

t('call-area estimate: marked, no distance, no heading', () => {
  const r = G.stationGeoReadout({
    grid: 'EM12', source: 'cty', distance: 408, heading: 269, unit: 'mi',
    estimate: { kind: 'callarea', area: '5', region: 'South Central', entity: 'United States' },
  });
  assert.strictEqual(r.text, 'EM12 (estimate)');
  assert.strictEqual(r.estimate, true);
  assert.ok(!/mi|°/.test(r.text), r.text);
  assert.ok(r.title.includes("not this station's grid"), r.title);
  assert.ok(r.title.includes('call area 5 (South Central, United States)'), r.title);
  assert.ok(r.title.includes('XML Data subscription'), r.title);
});

t('country-centre estimate, long path: marked, ~distance, heading', () => {
  const r = G.stationGeoReadout({
    grid: 'PM95', source: 'cty', distance: 650, heading: 330.2, unit: 'mi',
    estimate: { kind: 'entity', entity: 'Japan' },
  });
  assert.strictEqual(r.text, 'PM95 (estimate) | ~650mi | 330°');
  assert.strictEqual(r.estimate, true);
  assert.ok(r.title.includes('the middle of Japan'), r.title);
  const far = G.stationGeoReadout({ grid: 'PM95', source: 'cty', distance: 6500, heading: 330, unit: 'mi',
    estimate: { kind: 'entity', entity: 'Japan' } });
  assert.strictEqual(far.text, `PM95 (estimate) | ~${(6500).toLocaleString()}mi | 330°`);
});

t('country-centre estimate, close: no distance, no heading', () => {
  const r = G.stationGeoReadout({ grid: 'JO40', source: 'cty', distance: 300, heading: 90, unit: 'km',
    estimate: { kind: 'entity', entity: 'Fed. Rep. of Germany' } });
  assert.strictEqual(r.text, 'JO40 (estimate)');
  assert.ok(r.title.includes('too close'), r.title);
});

t('no own grid: the estimate still says so', () => {
  const r = G.stationGeoReadout({ grid: 'EM12', source: 'cty', distance: null, heading: null,
    estimate: { kind: 'callarea', area: '5', region: 'South Central', entity: 'United States' } });
  assert.strictEqual(r.text, 'EM12 (estimate)');
});

t('renderer uses the module and marks the estimate', () => {
  const app = read('renderer/app.js');
  const start = app.indexOf('function _blRenderStationInfo(');
  const fn = app.slice(start, app.indexOf("\nblCallsign.addEventListener('input'", start));
  assert.ok(fn.includes('BannerStationGeo.stationGeoReadout('), 'banner readout goes through lib/banner-station-geo.js');
  assert.ok(fn.includes("'bl-name-geo-estimate'"), 'estimate gets the muted class');
  assert.ok(!/distTxt\s*=/.test(fn), 'no hand-built distance text left in the renderer');
  assert.ok(read('renderer/index.html').includes('<script src="../lib/banner-station-geo.js"></script>'));
  assert.ok(/\.bl-name-geo\.bl-name-geo-estimate\s*\{[^}]*var\(--text-tertiary\)/.test(read('renderer/styles.css')));
  // main sends the call area and its region with a call-area answer
  const main = read('main.js');
  const h = main.slice(main.indexOf("ipcMain.handle('resolve-callsign-geo'"));
  assert.ok(/source: 'callarea', region: areaCoords\.region, area:/.test(h.slice(0, 800)));
});

t('the estimate is never logged', () => {
  const app = read('renderer/app.js');
  const save = app.slice(app.indexOf('async function saveBannerQso('));
  const call = save.slice(save.indexOf('window.api.logContact({'), save.indexOf('});', save.indexOf('window.api.logContact({')));
  assert.ok(!/grid/i.test(call), 'the banner sends no grid to logContact');
  const exp = read('lib/qso-expand.js');
  assert.ok(exp.includes("const homeGrid = station.gridsquare || info.grid || '';"), 'GRIDSQUARE: caller or QRZ, never cty.dat');
});

t('QRZ help text: a free account gives no grid squares', () => {
  const html = read('renderer/index.html');
  assert.ok(!html.includes('a free QRZ account works'));
  assert.ok(html.includes('A free QRZ account gives names but no grid squares; grid squares need a QRZ XML Data subscription.'));
});

console.log(`\n${n} passed`);
