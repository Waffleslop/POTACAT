#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
// GitHub #246 (electricfalcon): on the map, CW-spot and SOTA markers vanished
// and came back on every refresh, so the station being chased was lost. Both
// maps cleared every marker on each spots push and rebuilt them all. They now
// reconcile by spot key: unchanged markers stay, changed ones update in place,
// and only spots that are gone are removed.
// Run: node test/map-marker-reconcile-test.js
const assert = require('assert');
const path = require('path');
const R = require('../lib/map-marker-reconcile');
const src = (f) => readSrc(path.join(__dirname, '..', f));

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); }
}

const sota = { source: 'sota', callsign: 'W7ABC/P', frequency: '14062', lat: 34.1, lon: -112.2 };
const cw = { source: 'cwspots', callsign: 'K1XYZ', frequency: '7030.1', lat: 42.0, lon: -71.0 };
const pota = { source: 'pota', callsign: 'N0POT', frequency: '14285', lat: 39.0, lon: -95.0 };
const item = (s, sig) => ({ key: R.spotKey(s), sig: sig || 'v1' });
const prevOf = (items) => new Map(items.map((i) => [i.key, i.sig]));

test('the key is source + callsign + frequency, case-blind on the call', () => {
  assert.strictEqual(R.spotKey(sota), 'sota|W7ABC/P|14062');
  assert.strictEqual(R.spotKey({ ...sota, callsign: 'w7abc/p' }), R.spotKey(sota));
  assert.notStrictEqual(R.spotKey({ ...sota, source: 'cwspots' }), R.spotKey(sota), 'a CW spot and a SOTA spot of one station are two markers');
  assert.notStrictEqual(R.spotKey({ ...sota, frequency: '14063' }), R.spotKey(sota));
});

test('unchanged spots keep their marker (nothing added, updated or removed)', () => {
  const items = [item(sota), item(cw), item(pota)];
  const p = R.planMarkers(prevOf(items), items);
  assert.deepStrictEqual(p.keep.sort(), items.map((i) => i.key).sort());
  assert.deepStrictEqual([p.add, p.update, p.remove], [[], [], []]);
});

test('a new order alone changes nothing', () => {
  const items = [item(sota), item(cw), item(pota)];
  const p = R.planMarkers(prevOf(items), items.slice().reverse());
  assert.deepStrictEqual([p.add, p.update, p.remove], [[], [], []]);
});

test('a changed spot is updated in place, the others kept', () => {
  const before = [item(sota), item(cw)];
  const after = [item(sota, 'v2'), item(cw)];
  const p = R.planMarkers(prevOf(before), after);
  assert.deepStrictEqual(p.update, [R.spotKey(sota)]);
  assert.deepStrictEqual(p.keep, [R.spotKey(cw)]);
  assert.deepStrictEqual([p.add, p.remove], [[], []]);
});

test('a gone spot is removed and only that one', () => {
  const before = [item(sota), item(cw), item(pota)];
  const p = R.planMarkers(prevOf(before), [item(sota), item(pota)]);
  assert.deepStrictEqual(p.remove, [R.spotKey(cw)]);
  assert.deepStrictEqual(p.keep.sort(), [R.spotKey(sota), R.spotKey(pota)].sort());
  assert.deepStrictEqual([p.add, p.update], [[], []]);
});

test('a new spot is added; a duplicate key in one push is planned once', () => {
  const p = R.planMarkers(new Map(), [item(sota), item(sota, 'v9'), item(cw)]);
  assert.deepStrictEqual(p.add, [R.spotKey(sota), R.spotKey(cw)]);
  assert.strictEqual(p.next.get(R.spotKey(sota)), 'v1', 'first occurrence wins');
});

test('a re-spot of one CW station on a new frequency replaces its marker in the same pass', () => {
  const moved = { ...cw, frequency: '7030.3' };
  const p = R.planMarkers(prevOf([item(cw), item(sota)]), [item(moved), item(sota)]);
  assert.deepStrictEqual(p.remove, [R.spotKey(cw)]);
  assert.deepStrictEqual(p.add, [R.spotKey(moved)]);
  assert.deepStrictEqual(p.keep, [R.spotKey(sota)], 'the SOTA marker is untouched');
});

test('an empty previous map and empty push are harmless', () => {
  const p = R.planMarkers(null, []);
  assert.deepStrictEqual([p.add, p.update, p.keep, p.remove], [[], [], [], []]);
});

// --- Wiring: both maps reconcile, neither clears every marker per push ---
for (const file of ['renderer/app.js', 'renderer/map-popout.js']) {
  test(`${file}: updateMapMarkers reconciles by key instead of clearing the layer`, () => {
    const text = src(file);
    const at = text.indexOf('function updateMapMarkers(');
    assert.ok(at > 0);
    const body = text.slice(at, text.indexOf('\n}\n', at));
    assert.ok(!/markerLayer\.clearLayers\(\)/.test(body), 'no clearLayers on every push');
    assert.ok(/MapMarkerReconcile\.planMarkers\(/.test(body), 'uses the pure planner');
    assert.ok(/hasOpenPopup/.test(body), 'open-popup protection kept');
    assert.ok(/clearTuneArc\(\)/.test(body), 'tune arc still cleared when its spot is gone');
    assert.ok(/setPopupContent\(/.test(body) && /setLatLng\(/.test(body), 'changed markers update in place');
  });
}

test('both map pages load the planner before their script', () => {
  const idx = src('renderer/index.html');
  assert.ok(idx.indexOf('../lib/map-marker-reconcile.js') > 0 && idx.indexOf('../lib/map-marker-reconcile.js') < idx.indexOf('src="app.js"'));
  const pop = src('renderer/map-popout.html');
  assert.ok(pop.indexOf('../lib/map-marker-reconcile.js') > 0 && pop.indexOf('../lib/map-marker-reconcile.js') < pop.indexOf('map-popout.js"'));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
