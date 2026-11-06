#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
// DXCC prefix labels on the maps (artemisstiles 2026-10-31): a "Prefixes"
// box (F9) in the worked-overlay legend on every map window and ECHOCAT
// Web, each entity's main prefix at cty.dat's position, from zoom 3.
// Run: node test/prefix-overlay-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
global.WorkedRoster = require('../lib/worked-roster');
const WO = require('../lib/worked-overlay');
const read = (p) => readSrc(path.join(__dirname, '..', p));

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

function fakeL() {
  const made = [];
  return {
    made,
    layerGroup: () => ({ items: [], addTo(m) { return this; } }),
    divIcon: (o) => o,
    marker: (ll, o) => { const mk = { ll, o, addTo(g) { g.items.push(mk); return mk; } }; made.push(mk); return mk; },
  };
}

test('one label per entity, with its world-wrap copies, never clickable', () => {
  const L = fakeL();
  const g = WO.buildPrefixLayer(L, [{ p: 'K', n: 'United States', lat: 37.6, lon: -91.87 }, { p: 'JA', n: 'Japan', lat: 36.4, lon: 138.38 }, { p: '', lat: 0, lon: 0 }], 'pane');
  assert.strictEqual(g.items.length, 6, 'two entities x three copies; the blank one skipped');
  assert.deepStrictEqual(g.items.map((m) => m.ll[1]).slice(0, 3), [-451.87, -91.87, 268.13]);
  assert.ok(g.items.every((m) => m.o.interactive === false && m.o.pane === 'pane'));
  assert.ok(/>K</.test(g.items[1].o.icon.html) && /title="United States"/.test(g.items[1].o.icon.html));
});
test('F9 toggles the labels; F6/F7/F8 unchanged', () => {
  assert.deepStrictEqual(WO.keyPatch('F9', { prefixes: false }), { prefixes: true });
  assert.deepStrictEqual(WO.keyPatch('F9', { prefixes: true }), { prefixes: false });
  assert.deepStrictEqual(WO.keyPatch('F6', { states: false }), { states: true });
  assert.strictEqual(WO.PREFIX_MIN_ZOOM, 3);
});
test('the legend has the box; the layer follows the state and the zoom', () => {
  const src = read('lib/worked-overlay.js');
  assert.ok(/data-k="prefixes"/.test(src) && /Prefixes <kbd[^>]*>F9<\/kbd>/.test(src));
  assert.ok(/map\.on\('zoomend', drawPrefixes\)/.test(src));
  assert.ok(/if \(ctl\.legend\) ctl\.legend\.update\(st, lines\);\s*drawPrefixes\(\);/.test(src), 'drawn even when no tint is on');
});
test('main keeps the switch and serves the labels with the map geometry', () => {
  const main = read('main.js');
  assert.ok(/prefixes: settings\.workedOverlayPrefixes === true/.test(main));
  assert.ok(/typeof p\.prefixes === 'boolean' && settings\.workedOverlayPrefixes !== p\.prefixes/.test(main));
  assert.ok(/prefixLabels = ents[\s\S]{0,200}\(\{ p: e\.prefix, n: e\.name, lat: e\.lat, lon: e\.lon \}\)/.test(main));
  assert.ok(/show: \{ states: st\.states, countries: st\.countries, prefixes: st\.prefixes \}/.test(main));
});
test('ECHOCAT: a device can flip it and draws it', () => {
  assert.ok(/if \(typeof msg\.prefixes === 'boolean'\) patch\.prefixes = msg\.prefixes;/.test(read('lib/remote-server.js')));
  assert.ok(/'worked-overlay-set': \{[^}]*prefixes: f\.optBoolean/.test(read('lib/echocat-protocol.js')));
  assert.ok(/prefixes: !!\(msg\.show && msg\.show\.prefixes\)/.test(read('renderer/remote.js')));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
