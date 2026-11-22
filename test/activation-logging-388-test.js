#!/usr/bin/env node
'use strict';
// #388 (first activation, Discord 2026-11-11):
//  1. Typing a two-digit report in RST Sent jumped to RST Rcvd by itself; a
//     habit Tab then went on to State, and the received report landed there.
//  2. A corrected park grid square was lost when the activation was ended and
//     started again (or the app restarted): the box was refilled from the park.
// Run: node test/activation-logging-388-test.js
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const RstAdvance = require('../lib/rst-advance');
const ParkGrid = require('../lib/park-grid');
const { activationStationFill } = require('../lib/activation-station');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
}
const read = (f) => readSrc(path.join(__dirname, '..', f));

// --- 1. RST auto-advance and Tab ---

test('a full report jumps to Rcvd: 2 on phone, 3 on CW and data; deleting never jumps', () => {
  assert.strictEqual(RstAdvance.shouldAdvance(1, 2, 'insertText'), false);
  assert.strictEqual(RstAdvance.shouldAdvance(2, 2, 'insertText'), true);
  assert.strictEqual(RstAdvance.shouldAdvance(2, 3, 'insertText'), false);
  assert.strictEqual(RstAdvance.shouldAdvance(3, 3, 'insertFromPaste'), true);
  assert.strictEqual(RstAdvance.shouldAdvance(3, 3, 'deleteContentBackward'), false);
  assert.strictEqual(RstAdvance.shouldAdvance(2, 2, undefined), true, 'a synthetic event counts as typing');
});

test('the reporter\'s case: "5", "9" jumps, the habit Tab is absorbed, the cursor stays in Rcvd', () => {
  const a = RstAdvance.create();
  assert.strictEqual(a.sentInput(1, 2, 'insertText'), false);
  assert.strictEqual(a.sentInput(2, 2, 'insertText'), true, 'jumped');
  assert.strictEqual(a.rcvdKeydown({ key: 'Tab' }), true, 'habit Tab absorbed');
  // Now the operator types the received report and Tabs on to State: normal
  assert.strictEqual(a.rcvdKeydown({ key: '5' }), false);
  assert.strictEqual(a.rcvdKeydown({ key: 'Tab' }), false, 'Tab after typing moves on');
});

test('only ONE Tab is ever absorbed: a second Tab moves on (keeping the filled-in Rcvd)', () => {
  const a = RstAdvance.create();
  a.sentInput(2, 2, 'insertText');
  assert.strictEqual(a.rcvdKeydown({ key: 'Tab' }), true);
  assert.strictEqual(a.rcvdKeydown({ key: 'Tab' }), false);
});

test('typing in Rcvd first, Shift+Tab, a click away or going back to Sent all end the window', () => {
  let a = RstAdvance.create();
  a.sentInput(2, 2, 'insertText');
  assert.strictEqual(a.rcvdKeydown({ key: '5' }), false);
  assert.strictEqual(a.rcvdKeydown({ key: 'Tab' }), false);

  a = RstAdvance.create();
  a.sentInput(2, 2, 'insertText');
  assert.strictEqual(a.rcvdKeydown({ key: 'Shift', shiftKey: true }), false, 'Shift alone keeps the window');
  assert.strictEqual(a.armed, true);
  assert.strictEqual(a.rcvdKeydown({ key: 'Tab', shiftKey: true }), false, 'Shift+Tab goes back, never absorbed');
  assert.strictEqual(a.rcvdKeydown({ key: 'Tab' }), false);

  a = RstAdvance.create();
  a.sentInput(2, 2, 'insertText');
  a.reset(); // blur / Sent focused
  assert.strictEqual(a.rcvdKeydown({ key: 'Tab' }), false);
});

test('without a jump nothing is absorbed (the operator Tabbed into Rcvd themselves)', () => {
  const a = RstAdvance.create();
  a.sentInput(1, 2, 'insertText');
  assert.strictEqual(a.rcvdKeydown({ key: 'Tab' }), false);
});

test('both RST pairs (Log dialog and Activator) go through lib/rst-advance.js', () => {
  const app = read('renderer/app.js');
  const f = app.slice(app.indexOf('function setupRstAutoAdvance('), app.indexOf('// Log dialog N1MM auto-advance'));
  assert.ok(/window\.RstAdvance\.create\(\)/.test(f));
  assert.ok(/adv\.sentInput\(sent\.value\.length, getExpectedLen\(\), e\.inputType\)\) rcvd\.focus\(\)/.test(f));
  assert.ok(/rcvd\.addEventListener\('keydown', \(e\) => \{\s*if \(adv\.rcvdKeydown\(e\)\) e\.preventDefault\(\);/.test(f));
  assert.ok(/rcvd\.addEventListener\('blur', \(\) => adv\.reset\(\)\)/.test(f));
  assert.ok(/sent\.addEventListener\('focus', \(\) => adv\.reset\(\)\)/.test(f));
  assert.ok(!/if \(sent\.value\.length >= expected\)/.test(f), 'no second, unguarded jump left');
  assert.ok(/setupRstAutoAdvance\('activator-rst-sent', 'activator-rst-rcvd'/.test(app));
  assert.ok(/setupRstAutoAdvance\('rst-sent-n1mm', 'rst-rcvd-n1mm'/.test(app));
  assert.ok(/<script src="\.\.\/lib\/rst-advance\.js"><\/script>/.test(read('renderer/index.html')));
});

test('the "N1MM-style RST logging" help says what ticking it does (split boxes), not the other mode', () => {
  const html = read('renderer/index.html');
  const i = html.indexOf('id="set-n1mm-rst"');
  const help = html.slice(i, html.indexOf('</span>', i));
  assert.ok(/On: one box per digit/.test(help));
  assert.ok(/Off: one field per report/.test(help));
  assert.ok(!/Single text field per RST/.test(html), 'the inverted help text is gone');
});

// --- 2. The park grid the operator typed ---

test('a corrected grid is remembered for that park and wins over the park\'s own', () => {
  const store = ParkGrid.remember({}, 'US-1234', 'fn20xr', 'FN20ab');
  assert.deepStrictEqual(store, { 'US-1234': 'FN20XR' });
  assert.strictEqual(ParkGrid.gridFor(store, 'US-1234', 'FN20ab'), 'FN20XR');
  assert.strictEqual(ParkGrid.gridFor(store, 'us-1234', 'FN20ab'), 'FN20XR', 'ref case does not matter');
  assert.strictEqual(ParkGrid.gridFor(store, 'US-9999', 'EM10aa'), 'EM10aa', 'another park keeps its own');
  assert.strictEqual(ParkGrid.gridFor(store, 'US-1234,US-5678', ''), 'FN20XR', 'multi-park: the first park');
});

test('typing the park\'s own grid back, a blank or a non-grid clears the correction', () => {
  const s = { 'US-1234': 'FN20XR', 'US-2': 'EM10' };
  assert.deepStrictEqual(ParkGrid.remember(s, 'US-1234', 'FN20AB', 'FN20ab'), { 'US-2': 'EM10' });
  assert.deepStrictEqual(ParkGrid.remember(s, 'US-1234', '', 'FN20ab'), { 'US-2': 'EM10' });
  assert.deepStrictEqual(ParkGrid.remember(s, 'US-1234', 'FN2', 'FN20ab'), { 'US-2': 'EM10' });
  assert.deepStrictEqual(s, { 'US-1234': 'FN20XR', 'US-2': 'EM10' }, 'never mutates the store');
});

test('grid shapes: 4, 6 and 8 characters; anything else is not a grid', () => {
  assert.strictEqual(ParkGrid.normalizeGrid('fn20'), 'FN20');
  assert.strictEqual(ParkGrid.normalizeGrid(' fn20ab '), 'FN20AB');
  assert.strictEqual(ParkGrid.normalizeGrid('FN20ab12'), 'FN20AB12');
  for (const bad of ['', 'F', 'FN2', 'ZZ20', 'FN20a', 'FN20ZZ', null, undefined]) assert.strictEqual(ParkGrid.normalizeGrid(bad), '', String(bad));
});

test('the store is bounded: the oldest park drops off', () => {
  let s = {};
  for (let i = 0; i < ParkGrid.MAX_PARKS + 5; i++) s = ParkGrid.remember(s, 'US-' + i, 'FN20XR', '');
  const keys = Object.keys(s);
  assert.strictEqual(keys.length, ParkGrid.MAX_PARKS);
  assert.strictEqual(keys[0], 'US-5');
  assert.strictEqual(keys[keys.length - 1], 'US-' + (ParkGrid.MAX_PARKS + 4));
});

test('main fills a blank MY_GRIDSQUARE with the operator\'s grid before the park centre', () => {
  const park = { latitude: 40.5, longitude: -74.5, locationDesc: 'US-NJ' };
  const ctx = { myCallsign: 'K3SBP', park, latLonToGrid: () => 'FN20AL', parkStates: () => ['NJ'], parkGrids: { 'US-1234': 'FN20XR' } };
  assert.strictEqual(activationStationFill({ mySigInfo: 'US-1234' }, ctx).myGridsquare, 'FN20XR');
  assert.strictEqual(activationStationFill({ mySigInfo: 'US-5555' }, ctx).myGridsquare, 'FN20AL', 'other park: its centre');
  assert.strictEqual(activationStationFill({ mySigInfo: 'US-1234', myGridsquare: 'FN21' }, ctx).myGridsquare, undefined, 'a grid on the record is kept');
  assert.strictEqual(activationStationFill({ mySigInfo: 'US-1234' }, { ...ctx, park: null }).myGridsquare, 'FN20XR', 'works for a park not in the list');
  assert.ok(/parkGrids: s\.activatorParkGrids/.test(read('main.js')));
});

test('every place that fills the grid box asks lib/park-grid.js, and an edit is saved', () => {
  const app = read('renderer/app.js');
  // The only derivation from a park's position is inside setActivatorGridForPark.
  const derived = app.match(/activatorParkGrid = latLonToGridLocal\(/g) || [];
  assert.strictEqual(derived.length, 0, 'no site fills the box from the park directly');
  const helper = app.slice(app.indexOf('function setActivatorGridForPark('), app.indexOf('function latLonToGridLocal('));
  assert.ok(/window\.ParkGrid\.gridFor\(activatorParkGrids, ref, activatorParkGridFromPark\)/.test(helper));
  assert.ok((app.match(/setActivatorGridForPark\(/g) || []).length >= 6, 'startup, resume, select, multi-select, typed ref');
  assert.ok(/activatorParkGrids = window\.ParkGrid\.remember\(activatorParkGrids, ref, gridInput\.value, activatorParkGridFromPark\);\s*window\.api\.saveSettings\(\{ activatorParkGrids \}\);/.test(app));
  assert.ok(/if \(settings\.activatorParkGrids && typeof settings\.activatorParkGrids === 'object'\) activatorParkGrids = settings\.activatorParkGrids;/.test(app));
  assert.ok(app.indexOf('activatorParkGrids = settings.activatorParkGrids') < app.indexOf("if (settings.appMode === 'activator') {"), 'loaded before the activator restore fills the box');
  assert.ok(/<script src="\.\.\/lib\/park-grid\.js"><\/script>/.test(read('renderer/index.html')));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
