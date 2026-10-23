#!/usr/bin/env node
'use strict';
// Worked-states / countries map tints (lib/worked-overlay.js) + the geo
// assets' DXCC mapping + the wiring across the four map windows.
// Run: node test/worked-overlay-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const WO = require('../lib/worked-overlay');
const WR = require('../lib/worked-roster');
const { loadCtyDat } = require('../lib/cty');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
const root = path.join(__dirname, '..');
const rd = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const geoCountries = JSON.parse(rd('assets/geo/countries.json'));
const geoStates = JSON.parse(rd('assets/geo/states.json'));
const cty = loadCtyDat(path.join(root, 'assets', 'cty.dat'));

test('tints are POTACAT\'s: blue worked, green confirmed, no fill when not worked, never yellow', () => {
  assert.strictEqual(WO.COLORS.worked, '#4fc3f7');
  assert.strictEqual(WO.COLORS.confirmed, '#4ecca3');
  assert.strictEqual(WO.styleFor('none').fill, false);
  assert.strictEqual(WO.styleFor('worked').fillColor, '#4fc3f7');
  assert.strictEqual(WO.styleFor('confirmed').fillColor, '#4ecca3');
  assert.ok(WO.styleFor('confirmed').fillOpacity > WO.styleFor('worked').fillOpacity, 'confirmed reads over worked');
  for (const k of Object.keys(WO.TINTS)) {
    assert.strictEqual(WO.TINTS[k].interactive, false, 'tints never swallow a marker click');
    assert.ok(!/ffd|ff0|ffff00|fdd835|ffeb3b/i.test(JSON.stringify(WO.TINTS[k])), 'no yellow');
  }
  assert.strictEqual(WO.styleFor('bogus').fill, false);
});

test('scope cycles F8 through the four scopes and labels follow the dial', () => {
  assert.deepStrictEqual(WO.SCOPES, ['any', 'band', 'band-mode', 'band-exact']);
  assert.strictEqual(WO.nextScope('any'), 'band');
  assert.strictEqual(WO.nextScope('band-exact'), 'any');
  assert.strictEqual(WO.nextScope(undefined), 'any');
  assert.strictEqual(WO.scopeText({ scope: 'band-mode', band: '20m', mode: 'FT8' }), 'on 20m digital');
  assert.strictEqual(WO.scopeText({ scope: 'band-mode', band: '20m', mode: 'USB' }), 'on 20m phone');
  assert.strictEqual(WO.scopeText({ scope: 'band', band: '40m', mode: 'CW' }), 'on 40m');
  assert.strictEqual(WO.scopeText({ scope: 'band-exact', band: '40m', mode: 'ft4' }), 'on 40m FT4');
  assert.strictEqual(WO.scopeText({ scope: 'any', band: '40m' }), 'any band');
  assert.strictEqual(WO.scopeText({ scope: 'band-mode', band: '' }), 'band + mode', 'no dial yet');
});

test('keyPatch: F6 states, F7 countries, F8 scope, nothing else', () => {
  assert.deepStrictEqual(WO.keyPatch('F6', { states: false }), { states: true });
  assert.deepStrictEqual(WO.keyPatch('F6', { states: true }), { states: false });
  assert.deepStrictEqual(WO.keyPatch('F7', null), { countries: true });
  assert.deepStrictEqual(WO.keyPatch('F8', { scope: 'band' }), { scope: 'band-mode' });
  assert.strictEqual(WO.keyPatch('F1', {}), null);
  assert.strictEqual(WO.keyPatch('F5', {}), null);
});

test('feature status: a state by its code, a country by the best of its DXCC names (GB = England/Scotland/Wales)', () => {
  const roster = WR.build([
    ['K1ABC', [{ band: '20M', mode: 'FT8', state: 'NJ', confirmed: true }]],
    ['G4XYZ', [{ band: '20M', mode: 'FT8' }]],
    ['GM0ABC', [{ band: '40M', mode: 'CW', confirmed: true }]],
  ], (c) => ({ K1ABC: 'United States', G4XYZ: 'England', GM0ABC: 'Scotland' })[c] || '');
  const nj = geoStates.features.find((f) => f.properties.code === 'NJ');
  const pa = geoStates.features.find((f) => f.properties.code === 'PA');
  assert.strictEqual(WO.featureStatus(roster, 'state', nj, { scope: 'any' }), 'confirmed');
  assert.strictEqual(WO.featureStatus(roster, 'state', pa, { scope: 'any' }), 'none');
  const gb = geoCountries.features.find((f) => f.properties.iso === 'GB' && f.properties.dxcc.includes('England'));
  assert.deepStrictEqual(gb.properties.dxcc, ['England', 'Scotland', 'Wales']);
  assert.strictEqual(WO.featureStatus(roster, 'entity', gb, { scope: 'any' }), 'confirmed', 'Scotland confirmed colours the island');
  assert.strictEqual(WO.featureStatus(roster, 'entity', gb, { scope: 'band', band: '20m' }), 'worked', 'only England on 20m');
  assert.strictEqual(WO.featureStatus(roster, 'entity', gb, { scope: 'band', band: '80m' }), 'none');
  const ni = geoCountries.features.find((f) => f.properties.iso === 'GB' && f.properties.dxcc.includes('Northern Ireland'));
  assert.ok(ni, 'Northern Ireland is its own part');
  assert.strictEqual(WO.featureStatus(roster, 'entity', ni, { scope: 'any' }), 'none');
});

test('geo: every polygon names real cty.dat entities; the split entities exist; the rest are points', () => {
  const names = new Set(cty.entities.map((e) => e.name));
  const covered = new Set();
  for (const f of geoCountries.features) {
    assert.ok(Array.isArray(f.properties.dxcc) && f.properties.dxcc.length, 'dxcc list on ' + f.properties.name);
    for (const n of f.properties.dxcc) { assert.ok(names.has(n), n + ' is not a cty.dat entity'); covered.add(n); }
  }
  for (const n of ['United States', 'Alaska', 'Hawaii', 'European Russia', 'Asiatic Russia', 'Kaliningrad', 'Fed. Rep. of Germany', 'Japan', 'Canada', 'Sardinia', 'Sicily', 'Crete', 'French Guiana', 'Svalbard', 'East Malaysia', 'West Malaysia', 'Corsica', 'Northern Ireland', 'Antarctica']) {
    assert.ok(covered.has(n), 'no polygon for ' + n);
  }
  // Natural Earth 110 m has no polygon for these: they draw as circles at cty.dat's lat/lon.
  for (const n of ['Hong Kong', 'Bermuda', 'Guam', 'Market Reef', 'Vatican City', 'Galapagos Islands']) assert.ok(!covered.has(n), n + ' should be a point');
  assert.ok(covered.size >= 185, 'polygons for ' + covered.size + ' entities');
  // the US polygon no longer contains Alaska or Hawaii
  const us = geoCountries.features.filter((f) => f.properties.dxcc.includes('United States'));
  assert.strictEqual(us.length, 1);
  for (const poly of us[0].geometry.coordinates) for (const [x, y] of poly[0]) assert.ok(!(y > 50 && x < -128) && !(y < 30 && x < -150), 'US polygon still holds Alaska/Hawaii at ' + x + ',' + y);
  // every lat/lon in range; states cover US + CA
  const codes = new Set(geoStates.features.map((f) => f.properties.cc + '-' + f.properties.code));
  assert.strictEqual(codes.size, 64);
});

test('buildLayer draws states and countries under a pane, circles only for worked island entities', () => {
  // a tiny Leaflet stand-in that records what was built
  const made = [];
  const L = {
    layerGroup: () => ({ _n: 0, addLayer(l) { made.push(l); this._n++; } }),
    geoJSON: (fc, o) => ({ kind: 'geojson', n: fc.features.length, pane: o.pane, style: o.style }),
    circle: (ll, o) => ({ kind: 'circle', ll, pane: o.pane, color: o.color }),
  };
  const roster = WR.build([['VP9ABC', [{ band: '20M', mode: 'FT8' }]], ['K1ABC', [{ band: '20M', mode: 'FT8', state: 'TX' }]]], (c) => c === 'VP9ABC' ? 'Bermuda' : 'United States');
  const geo = { states: geoStates, countries: geoCountries, points: [{ name: 'Bermuda', lat: 32.3, lon: -64.7 }, { name: 'Guam', lat: 13.4, lon: 144.7 }] };
  WO.buildLayer(L, geo, roster, { scope: 'any' }, { states: true, countries: true }, 'workedOverlayPane');
  const gj = made.filter((m) => m.kind === 'geojson');
  assert.strictEqual(gj.length, 2);
  assert.ok(gj.every((g) => g.pane === 'workedOverlayPane'));
  const circles = made.filter((m) => m.kind === 'circle');
  assert.strictEqual(circles.length, 3, 'Bermuda at three world copies, Guam (unworked) skipped');
  assert.ok(circles.every((c) => c.color === '#4fc3f7'));
  const tx = geoStates.features.find((f) => f.properties.code === 'TX');
  assert.strictEqual(gj[1].style(tx).fillColor, '#4fc3f7');
  made.length = 0;
  WO.buildLayer(L, geo, roster, { scope: 'any' }, { states: false, countries: false }, 'p');
  assert.strictEqual(made.length, 0, 'nothing drawn when both layers are off');
});

test('wiring: every map window attaches the overlay and its keys, main owns the state and follows the dial', () => {
  const main = rd('main.js');
  assert.ok(main.includes("ipcMain.handle('worked-overlay-get'") && main.includes("ipcMain.handle('worked-overlay-geo'") && main.includes("ipcMain.on('worked-overlay-set'"));
  assert.ok(/function sendCatFrequency[\s\S]{0,2500}workedOverlayFollowDial\(\);/.test(main), 'frequency sink re-pushes');
  assert.ok(/function sendCatMode[\s\S]{0,1500}workedOverlayFollowDial\(\);/.test(main), 'mode sink re-pushes');
  assert.ok(/for \(const w of workedOverlayWindows\(\)\) w\.webContents\.send\('worked-roster'/.test(main), 'the roster reaches every map window');
  assert.ok(/saveSettings\(settings\)/.test(main.slice(main.indexOf('function applyWorkedOverlayPatch'), main.indexOf('function applyWorkedOverlayPatch') + 2500)), 'F6/F7/F8 persist');
  for (const [file, needle] of [
    ['renderer/app.js', 'WorkedOverlay.attach(L, map, window.api)'],
    ['renderer/map-popout.js', 'WorkedOverlay.attach(L, map, window.api)'],
    ['renderer/jtcat-popout.js', 'WorkedOverlay.attach(L, map, window.api)'],
    ['renderer/jtcat-map-popout.js', 'WorkedOverlay.attach(L, map, window.api)'],
    ['renderer/index.html', '<script src="../lib/worked-overlay.js"></script>'],
    ['renderer/map-popout.html', '<script src="../lib/worked-overlay.js"></script>'],
    ['renderer/jtcat-popout.html', '<script src="../lib/worked-overlay.js"></script>'],
    ['renderer/jtcat-map-popout.html', '<script src="../lib/worked-overlay.js"></script>'],
    ['renderer/index.html', '<kbd>F6</kbd>'],
    ['renderer/index.html', '<kbd>F8</kbd>'],
  ]) assert.ok(rd(file).includes(needle), file + ' lacks ' + needle);
  assert.ok(/modeSelect\.value === 'JTTY'\) return; \/\/ F1-F12 are the JTTY macros/.test(rd('renderer/jtcat-popout.js')), 'JTTY pane keeps its macros');
  assert.ok(/\/\^F\[678\]\$\/\.test\(e\.key\)/.test(rd('renderer/app.js')), 'F6/F7/F8 in the main keydown');
  for (const pre of ['preload.js', 'preload-popout.js', 'preload-jtcat-popout.js']) {
    const p = rd(pre);
    for (const k of ['workedOverlayGet', 'workedOverlaySet', 'workedOverlayGeo', 'onWorkedOverlayState', 'getWorkedRoster', 'onWorkedRoster']) assert.ok(p.includes(k + ':'), pre + ' lacks ' + k);
  }
});

test('web: status maps draw the same tints without a roster; ECHOCAT wiring', () => {
  const statusOf = WO.mapStatusOf({ NJ: 'confirmed', TX: 'worked', XX: 'bogus' }, { Japan: 'worked' });
  assert.strictEqual(statusOf('state', 'NJ'), 'confirmed');
  assert.strictEqual(statusOf('state', 'XX'), 'none', 'an unknown status word is not worked');
  assert.strictEqual(statusOf('entity', 'Japan'), 'worked');
  assert.strictEqual(statusOf('entity', 'Alaska'), 'none');
  const gb = geoCountries.features.find((f) => f.properties.dxcc.includes('England'));
  assert.strictEqual(WO.featureStatusWith(WO.mapStatusOf({}, { Wales: 'confirmed' }), 'entity', gb), 'confirmed');
  const made = [];
  const L = { layerGroup: () => ({ addLayer(l) { made.push(l); } }), geoJSON: (fc, o) => ({ kind: 'geojson', style: o.style }), circle: (ll, o) => ({ kind: 'circle', color: o.color }) };
  WO.buildLayerWith(L, { states: geoStates, countries: geoCountries, points: [{ name: 'Guam', lat: 13, lon: 144 }] }, WO.mapStatusOf({ TX: 'worked' }, { Guam: 'confirmed' }), { states: true, countries: true }, 'p');
  assert.strictEqual(made.filter((m) => m.kind === 'circle').length, 3, 'Guam confirmed draws at three copies');
  assert.strictEqual(made.filter((m) => m.kind === 'circle')[0].color, '#4ecca3');
  // server + protocol + page
  const rs = rd('lib/remote-server.js');
  assert.ok(rs.includes("'worked-overlay',") && rs.includes("case 'worked-overlay-set':") && rs.includes('sendWorkedOverlay(payload)') && rs.includes("pathname === '/geo/worked-overlay.json'"));
  assert.ok(/if \(this\._lastWorkedOverlay\) this\._sendTo\(ws, this\._lastWorkedOverlay\);/.test(rs), 'hydrated at connect');
  assert.ok(/worked-overlay-refused', reason: 'guest-pass'/.test(rs), 'Guest Pass refused');
  assert.ok(/\['worked-roster-js', 'worked-roster\.js'\], \['worked-overlay-js', 'worked-overlay\.js'\]/.test(rs), 'both modules inlined into the page');
  const proto = rd('lib/echocat-protocol.js');
  for (const k of ["'worked-overlay':", "'worked-overlay-set':", "'worked-overlay-refused':"]) assert.ok(proto.includes(k), k);
  const html = rd('renderer/remote.html');
  assert.ok(html.includes('<!-- worked-roster-js -->') && html.includes('<!-- worked-overlay-js -->'));
  assert.ok(html.indexOf('<!-- worked-roster-js -->') < html.indexOf('<!-- worked-overlay-js -->'), 'roster before overlay');
  const rj = rd('renderer/remote.js');
  assert.strictEqual((rj.match(/workedOverlayAttach\(spotMap\)/g) || []).length, 2, 'both spot-map creations attach');
  assert.strictEqual((rj.match(/workedOverlayAttach\(ft8Map\)/g) || []).length, 1, 'the FT8 map attaches');
  assert.ok(rj.includes("case 'worked-overlay':") && rj.includes("type: 'worked-overlay-set'") && rj.includes("fetch('/geo/worked-overlay.json'"));
  const main = rd('main.js');
  assert.ok(main.includes("remoteServer.on('worked-overlay-set'") && main.includes('remoteServer.setWorkedOverlayGeo(') && /sendWorkedOverlay\(workedOverlayWebPayload\(\)\)/.test(main));
  const on = main.indexOf("remoteServer.on('worked-overlay-set'");
  const cr = main.indexOf('function connectRemote(');
  assert.ok(on > cr, 'wired inside connectRemote (the server is rebuilt on reconnect)');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
