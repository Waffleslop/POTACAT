#!/usr/bin/env node
'use strict';
// "Near my home (about 1 mile)" (Casey 2026-11-20: "give users ability to
// change this. by default, make it with some ambiguity") and the APRS map's
// view (home at a local zoom on the first open, then wherever it was left).
//
//  - APRS 1.0.1 chapter 6, position ambiguity: the hundredths of a minute
//    become spaces in latitude and longitude ("4903.  N represents latitude
//    to nearest minute"). The receiver draws the middle of that one-minute
//    box, so the minutes are cut (never rounded) and the box holds the true
//    position.
//  - Home: the picked point, else the radio's GPS fix, else the Settings
//    grid's centre. The map centres there and draws the operator there.
//  - The default: near for anyone better than a 4-character grid; grid4 with
//    only a 4-character grid; a saved choice is never changed.
// Run: node test/aprs-position-ambiguity-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const B = require('../lib/aprs-beacon');
const P = require('../lib/aprs-position');
const M = require('../lib/aprs-map');
const W = require('../lib/aprs-window-state');
const E = require('../lib/aprs-echocat');
const { gridToLatLon } = require('../lib/grid');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8').replace(/\r\n/g, '\n');
const fnBody = (src, name) => {
  const i = src.indexOf('\nfunction ' + name + '(');
  assert.ok(i >= 0, name + ' exists');
  return src.slice(i, src.indexOf('\n}\n', i));
};

// 40 deg 05.37 min N, 75 deg 05.37 min W: a made-up home in FN20jb.
const LAT = 40 + 5.37 / 60;
const LON = -(75 + 5.37 / 60);
const FIX = { installed: true, fix: true, lat: 38.8895, lon: -77.0353, grid: 'FM18lv', tracked: 9, visible: 12, status: 'Fine Lock' };
const NOFIX = { installed: true, fix: false, lat: 0, lon: 0, grid: '', tracked: 0, visible: 12, status: 'Warming Up' };

console.log('APRS: near my home (position ambiguity) and the map view');

// ── the encoding ────────────────────────────────────────────────────────────
test('ambiguity: 40 deg 05.37 min N is "4005.  N", 75 deg 05.37 min W is "07505.  W"', () => {
  assert.strictEqual(B.coord(LAT, true, true), '4005.  N');
  assert.strictEqual(B.coord(LON, false, true), '07505.  W');
  assert.strictEqual(B.coord(LAT, true, false), '4005.37N', 'exact keeps the hundredths');
  assert.strictEqual(B.coord(LON, false, false), '07505.37W');
});

test('ambiguity: the minutes are cut, never rounded, so the box holds the true position', () => {
  // 05.99 min would round to 06; cut, it stays in the 05 box.
  assert.strictEqual(B.coord(40 + 5.99 / 60, true, true), '4005.  N');
  assert.strictEqual(B.coord(-(75 + 5.99 / 60), false, true), '07505.  W');
  assert.strictEqual(B.coord(-(33 + 52.8 / 60), true, true), '3352.  S', 'south');
  assert.strictEqual(B.coord(151 + 12.9 / 60, false, true), '15112.  E', 'east');
  assert.strictEqual(B.coord(40 + 59.999 / 60, true, true), '4059.  N', 'just under the next degree');
  assert.strictEqual(B.coord(40, true, true), '4000.  N');
  // The receiver's box: [DDMM, DDMM + 1 min). The true position is inside it.
  for (const v of [LAT, 12.3456, 51.99999, 0.0101, 89.5]) {
    const s = B.coord(v, true, true);
    const lo = Number(s.slice(0, 2)) + Number(s.slice(2, 4)) / 60;
    assert.ok(v >= lo - 1e-9 && v < lo + 1 / 60, v + ' is inside ' + s);
  }
});

test('ambiguity: both latitude and longitude carry the two spaces in the packet', () => {
  const b = B.buildBeacon({ settingsCall: 'K3ABC', lat: LAT, lon: LON, symbol: 'house', comment: '', approx: true });
  assert.ok(b.ok);
  assert.strictEqual(b.packet, 'K3ABC-10>APZPCT,TCPIP*:!4005.  N/07505.  W-');
});

// ── home ────────────────────────────────────────────────────────────────────
test('home: the picked point, else the GPS fix, else the 6-character grid, else the 4-character grid', () => {
  const g = { gridToLatLon };
  assert.deepStrictEqual(B.homePosition(Object.assign({ lat: LAT, lon: LON, gps: FIX, grid: 'FN20jb' }, g)), { lat: LAT, lon: LON, kind: 'map' });
  assert.deepStrictEqual(B.homePosition(Object.assign({ gps: FIX, grid: 'FN20jb' }, g)), { lat: 38.8895, lon: -77.0353, kind: 'gps' });
  assert.deepStrictEqual(B.homePosition(Object.assign({ gps: NOFIX, grid: 'FN20jb' }, g)), Object.assign({}, gridToLatLon('FN20jb'), { kind: 'grid6' }));
  assert.deepStrictEqual(B.homePosition(Object.assign({ grid: 'FN20' }, g)), Object.assign({}, gridToLatLon('FN20'), { kind: 'grid4' }));
  assert.strictEqual(B.homePosition(Object.assign({ grid: '' }, g)), null);
  assert.strictEqual(B.homePosition(Object.assign({ gps: { fix: true, lat: 0, lon: 0 }, grid: '' }, g)), null, 'never 0,0');
  assert.strictEqual(B.homePosition(Object.assign({ lat: LAT, lon: LON, gps: FIX, grid: 'FN20jb', source: 'gps' }, g)).kind, 'gps', 'with the GPS as the source a fix comes first');
});

// ── the default and the migration rule ──────────────────────────────────────
test('default: near for anyone better than a 4-character grid; grid4 with only a 4-character grid', () => {
  const home = (k) => ({ lat: 1, lon: 1, kind: k });
  assert.strictEqual(B.effectivePrecision({ precision: null, approx: true, source: 'settings', home: home('grid6') }), 'near');
  assert.strictEqual(B.effectivePrecision({ precision: null, approx: true, source: 'settings', home: home('map') }), 'near');
  assert.strictEqual(B.effectivePrecision({ precision: null, approx: true, source: 'settings', home: home('gps') }), 'near');
  assert.strictEqual(B.effectivePrecision({ precision: null, approx: true, source: 'settings', home: home('grid4') }), 'grid4', 'nothing better to send');
  assert.strictEqual(B.effectivePrecision({ precision: null, approx: true, source: 'gps', home: home('grid4') }), 'near', 'the GPS chosen: better than the grid');
  assert.strictEqual(B.effectivePrecision({ precision: null, approx: true, source: 'settings', home: null }), 'near');
});

test('migration: a saved choice is kept; the old "Approximate position" turned off stays exact', () => {
  for (const p of ['grid4', 'grid6', 'near', 'exact']) {
    assert.strictEqual(B.effectivePrecision({ precision: p, approx: p !== 'exact', source: 'settings', home: { kind: 'map' } }), p);
  }
  assert.strictEqual(B.effectivePrecision({ precision: null, approx: false, source: 'settings', home: { kind: 'map' } }), 'exact');
  assert.strictEqual(B.effectivePrecision({ precision: 'street', approx: true, source: 'settings', home: { kind: 'grid6' } }), 'near', 'junk is not a choice');
  // Nothing is written: the default is worked out each time, so settings never change on their own.
  assert.strictEqual(B.beaconSettings({}).precision, null);
  assert.strictEqual(B.beaconSettings({ aprsBeaconPrecision: 'near' }).precision, 'near');
  assert.strictEqual(B.approxFor('near'), true);
  assert.strictEqual(B.approxFor('grid4'), true);
  assert.strictEqual(B.approxFor('exact'), false);
});

// ── what goes out at each precision ─────────────────────────────────────────
function packetAt(precision, extra) {
  const o = Object.assign({ source: 'settings', lat: LAT, lon: LON, grid: 'FN20jb', gps: null }, extra || {});
  const home = B.homePosition({ lat: o.lat, lon: o.lon, gps: o.gps, grid: o.grid, gridToLatLon, source: o.source });
  const prec = B.effectivePrecision({ precision, approx: true, source: o.source, home });
  const pos = P.beaconPositionFrom({ source: o.source, precision: prec, gps: o.gps, lat: o.lat, lon: o.lon, grid: o.grid, gridToLatLon });
  if (!pos.ok) return pos;
  return B.buildBeacon({ settingsCall: 'K3ABC', lat: pos.lat, lon: pos.lon, symbol: 'house', comment: '', approx: B.approxFor(prec) }).packet.split(':!')[1];
}

test('sent: grid4, grid6, near and exact, for a picked point in FN20jb', () => {
  assert.strictEqual(packetAt('grid4'), '4030.  N/07500.  W-', 'the middle of FN20, to the minute');
  assert.strictEqual(packetAt('grid6'), '4003.  N/07512.  W-', 'the middle of FN20jb, to the minute');
  assert.strictEqual(packetAt('near'), '4005.  N/07505.  W-', 'the point, to the minute');
  assert.strictEqual(packetAt('exact'), '4005.37N/07505.37W-', 'the point');
  assert.strictEqual(packetAt(null), '4005.  N/07505.  W-', 'not set: near');
});

test('sent: near without a picked point takes the GPS fix, else the grid centre', () => {
  assert.strictEqual(packetAt('near', { lat: null, lon: null, gps: FIX }), '3853.  N/07702.  W-');
  assert.strictEqual(packetAt('near', { lat: null, lon: null, gps: NOFIX }), '4003.  N/07512.  W-');
  assert.strictEqual(packetAt(null, { lat: null, lon: null, grid: 'FN20' }), '4030.  N/07500.  W-', 'only a 4-character grid: grid4');
  const none = packetAt('near', { lat: null, lon: null, grid: '' });
  assert.strictEqual(none.ok, false);
  assert.strictEqual(none.sentence, B.SENTENCES.position);
});

test('sent: near with the GPS as the source sends the fix to the minute; no fix still refuses', () => {
  assert.strictEqual(packetAt('near', { source: 'gps', gps: FIX }), '3853.  N/07702.  W-');
  assert.strictEqual(packetAt('near', { source: 'gps', gps: NOFIX }).reason, 'gps-no-fix');
});

// ── the operator's marker ───────────────────────────────────────────────────
test('marker label: says what the beacon shows when it is less exact', () => {
  assert.strictEqual(W.homeLabel({ call: 'k3sbp', grid: 'FN20JB', precision: 'near' }), 'K3SBP (beacon: about 1 mile)');
  assert.strictEqual(W.homeLabel({ call: 'K3SBP', grid: 'FN20JB', precision: 'near', unit: 'km' }), 'K3SBP (beacon: about 2 km)');
  assert.strictEqual(W.homeLabel({ call: 'K3SBP', grid: 'FN20JB', precision: 'grid4' }), 'K3SBP (beacon: FN20)');
  assert.strictEqual(W.homeLabel({ call: 'K3SBP', grid: 'FN20JB', precision: 'grid6' }), 'K3SBP (beacon: FN20jb)');
  assert.strictEqual(W.homeLabel({ call: 'K3SBP', grid: 'FN20JB', gpsGrid: 'FM18lv', precision: 'grid6' }), 'K3SBP (beacon: FM18lv)', 'the GPS grid when the GPS is the source');
  assert.strictEqual(W.homeLabel({ call: 'K3SBP', grid: 'FN20JB', precision: 'exact' }), 'K3SBP');
  assert.strictEqual(W.homeLabel({ call: '', precision: 'exact' }), 'You');
});

// ── the map view ────────────────────────────────────────────────────────────
test('view: the local zoom shows about 25 miles (40 km) across', () => {
  for (const [w, lat] of [[700, 40], [1000, 40], [700, 52], [500, 20]]) {
    const z = M.localZoom(w, lat);
    const km = w * 156.543 * Math.cos(lat * Math.PI / 180) / Math.pow(2, z);
    assert.ok(km > 25 && km < 65, w + ' px at ' + lat + ': zoom ' + z + ' shows ' + km.toFixed(0) + ' km');
  }
  assert.strictEqual(M.localZoom(0, 40), 11, 'a map not laid out yet: zoom 11');
});

test('view: saved views are cleaned; the first open is home; no home keeps the country view', () => {
  assert.deepStrictEqual(M.cleanView({ lat: 40.1234567, lon: -435, zoom: 10.6 }), { lat: 40.12346, lon: -75, zoom: 11 });
  assert.strictEqual(M.cleanView({ lat: 'x', lon: 1, zoom: 3 }), null);
  assert.strictEqual(M.cleanView(null), null);
  assert.strictEqual(M.cleanView({ lat: 89, lon: 1, zoom: 3 }), null);
  assert.deepStrictEqual(M.cleanView({ lat: 1, lon: 2, zoom: 99 }).zoom, 17);
  assert.ok(M.sameView({ lat: 1.000001, lon: 2, zoom: 5 }, { lat: 1, lon: 2, zoom: 5 }));
  assert.ok(!M.sameView({ lat: 1, lon: 2, zoom: 5 }, { lat: 1, lon: 2, zoom: 6 }));
  assert.deepStrictEqual(M.startView({ saved: { lat: 41, lon: -72, zoom: 9 }, home: { lat: 40, lon: -75 }, widthPx: 700 }), { lat: 41, lon: -72, zoom: 9, from: 'saved' });
  assert.deepStrictEqual(M.startView({ saved: null, home: { lat: 40, lon: -75 }, widthPx: 700 }), { lat: 40, lon: -75, zoom: 11, from: 'home' });
  assert.strictEqual(M.startView({ saved: null, home: null, widthPx: 700 }), null);
});

// ── ECHOCAT never sees more than the packet ─────────────────────────────────
test('ECHOCAT: the beacon position on the wire follows the precision (near: whole minutes)', () => {
  const s = E.buildState({ beacon: { position: { lat: LAT, lon: LON, source: 'map', approx: true }, settings: { approx: true } } });
  assert.strictEqual(s.beacon.position.approx, true);
  assert.ok(Math.abs(s.beacon.position.lat - (40 + 5 / 60)) < 1e-9);
  const x = E.buildState({ beacon: { position: { lat: LAT, lon: LON, source: 'map', approx: false }, settings: { approx: true } } });
  assert.strictEqual(x.beacon.position.lat, LAT, 'exact');
});

// ── wiring ──────────────────────────────────────────────────────────────────
test('wiring: both beacons send at the precision that applies; home is the best known position', () => {
  const main = read('main.js');
  const send = main.slice(main.indexOf('\nasync function aprsBeaconSend('), main.indexOf('\nfunction aprsBeaconSchedule('));
  assert.ok(/approx: pos\.ok \? pos\.approx : true \}\);/.test(send), 'the internet beacon');
  assert.ok(/approx: pos\.ok \? pos\.approx : true, ssid: st\.rfSsid/.test(fnBody(main, 'aprsRfPlan')), 'the radio beacon');
  assert.ok(!/comment, approx: st\.approx/.test(main), 'nothing sends with the raw setting');
  assert.ok(/AprsBeacon\.homePosition\(/.test(fnBody(main, 'aprsHomePosition')));
  assert.ok(/AprsBeacon\.effectivePrecision\(/.test(fnBody(main, 'aprsBeaconPrecision')));
  assert.ok(/const p = aprsHomePosition\(\);/.test(main.slice(main.indexOf('function aprsHome()'), main.indexOf('function aprsHome()') + 400)), 'the map and feed centre on home');
  assert.ok(/mapView: AprsMap\.cleanView\(settings\.aprsMapView\)/.test(main), 'the saved view goes to the window on open');
  assert.ok(/ipcMain\.on\('aprs-map-view'/.test(main) && /settings\.aprsMapView = view;/.test(main), 'and is kept when it changes');
  assert.ok(/saveMapView: /.test(read('preload-aprs-popout.js')));
});

test('wiring: the Home button sits with the zoom buttons and goes home at the local zoom', () => {
  const js = read('renderer/aprs-popout.js');
  assert.ok(/'leaflet-bar aprs-home-bar'/.test(js), 'the zoom buttons\' own bar look');
  assert.ok(/setAttribute\('aria-label', 'Back to my home area'\)/.test(js));
  assert.ok(/AprsMap\.localZoom\(map\.getSize\(\)\.x, home\.lat\)/.test(js));
  assert.ok(/AprsMap\.startView\(\{ saved: d\.mapView/.test(js), 'the opening view');
  assert.ok(/window\.api\.saveMapView\(/.test(js) && /map\.on\('moveend'/.test(js), 'every move is kept (debounced)');
  assert.ok(/W\.homeLabel\(/.test(read('renderer/aprs-window.js')), 'the marker label');
});

test('the test is in scripts/run-tests.js', () => {
  assert.ok(read('scripts/run-tests.js').indexOf("'test/aprs-position-ambiguity-test.js'") >= 0);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
