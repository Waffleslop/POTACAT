#!/usr/bin/env node
'use strict';
// The APRS window's station list (lib/aprs-stations.js): one row per station
// or object, distance and bearing from home, an hour's memory, sort and search.
// Run: node test/aprs-stations-test.js

const assert = require('assert');
const P = require('../lib/aprs-parser');
const S = require('../lib/aprs-stations');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

const HOME = { lat: 41.5, lon: -72.5 }; // central Connecticut
function store() {
  let t = 1000000;
  const s = S.createStore({ home: HOME, now: () => t });
  s.tick = (ms) => { t += ms; };
  return s;
}

console.log('APRS stations');

test('distance and bearing (Hartford area to Boston: about 140 km, east-north-east)', () => {
  const d = S.distanceKm(41.5, -72.5, 42.36, -71.06);
  assert.ok(d > 145 && d < 160, String(d));
  const b = S.bearingDeg(41.5, -72.5, 42.36, -71.06);
  assert.ok(b > 45 && b < 60, String(b));
  assert.strictEqual(S.compass(b), 'NE');
  assert.strictEqual(S.compass(0), 'N');
  assert.strictEqual(S.compass(359), 'N');
  assert.strictEqual(S.compass(180), 'S');
  assert.strictEqual(S.compass(null), '');
});

test('age wording', () => {
  assert.strictEqual(S.formatAge(10000), 'now');
  assert.strictEqual(S.formatAge(4 * 60000), '4 min');
  assert.strictEqual(S.formatAge(65 * 60000), '1 h 5 min');
  assert.strictEqual(S.formatAge(120 * 60000), '2 h');
});

test('a position makes a row with distance, bearing and icon', () => {
  const s = store();
  const r = s.add(P.parse('W1AW>APRS:=4142.00N/07243.00W-Newington'));
  assert.strictEqual(r.call, 'W1AW');
  assert.strictEqual(r.cls, 'house');
  assert.ok(r.distanceKm > 20 && r.distanceKm < 40);
  assert.strictEqual(s.size, 1);
  s.add(P.parse('W1AW>APRS:=4142.00N/07243.00W-Newington'));
  assert.strictEqual(s.size, 1, 'one row per station');
  assert.strictEqual(s.get('W1AW').packets, 2);
});

test('status updates a known station only; messages change nothing', () => {
  const s = store();
  assert.strictEqual(s.add(P.parse('W1AW>APRS:>QRV 146.52')), null);
  assert.strictEqual(s.size, 0);
  s.add(P.parse('W1AW>APRS:=4142.00N/07243.00W-'));
  s.add(P.parse('W1AW>APRS:>QRV 146.52'));
  assert.strictEqual(s.get('W1AW').status, 'QRV 146.52');
  assert.strictEqual(s.add(P.parse('W1AW>APRS::K3SBP    :hello{1')), null);
  assert.strictEqual(s.size, 1);
});

test('objects are keyed by name; a killed object leaves at once', () => {
  const s = store();
  s.add(P.parse('N1ABC>APRS:;LEADER   *092345z4130.00N/07230.00W>'));
  s.add(P.parse('N2DEF>APRS:;LEADER   *092346z4131.00N/07230.00W>'));
  assert.strictEqual(s.size, 1);
  const r = s.get('obj:LEADER');
  assert.strictEqual(r.cls, 'car', 'an object is drawn by its own symbol');
  assert.strictEqual(r.label, 'LEADER');
  assert.strictEqual(r.call, 'N2DEF', 'the latest sender');
  s.add(P.parse('N2DEF>APRS:;LEADER   _092347z4131.00N/07230.00W>'));
  assert.strictEqual(s.size, 0);
});

test('stations not heard for 60 minutes age out', () => {
  const s = store();
  s.add(P.parse('W1AW>APRS:=4142.00N/07243.00W-'));
  s.tick(30 * 60000);
  s.add(P.parse('N0CALL>APRS:=4130.00N/07230.00W>'));
  s.tick(31 * 60000);
  assert.deepStrictEqual(s.prune(), ['W1AW']);
  assert.strictEqual(s.size, 1);
});

test('sort by distance, call, age; search by call, name or comment', () => {
  const s = store();
  s.add(P.parse('KB1FAR>APRS:=4230.00N/07100.00W-far away'));
  s.tick(1000);
  s.add(P.parse('W1NEAR>APRS:=4131.00N/07231.00W_'));
  s.tick(1000);
  s.add(P.parse('AA1MID>APRS:=4200.00N/07200.00W>Mobile on I-84'));
  assert.deepStrictEqual(s.list({ sort: 'distance' }).map((r) => r.call), ['W1NEAR', 'AA1MID', 'KB1FAR']);
  assert.deepStrictEqual(s.list({ sort: 'distance', desc: true }).map((r) => r.call), ['KB1FAR', 'AA1MID', 'W1NEAR']);
  assert.deepStrictEqual(s.list({ sort: 'call' }).map((r) => r.call), ['AA1MID', 'KB1FAR', 'W1NEAR']);
  assert.deepStrictEqual(s.list({ sort: 'age' }).map((r) => r.call), ['AA1MID', 'W1NEAR', 'KB1FAR'], 'newest first');
  assert.deepStrictEqual(s.list({ query: 'i-84' }).map((r) => r.call), ['AA1MID']);
  assert.deepStrictEqual(s.list({ query: 'w1n' }).map((r) => r.call), ['W1NEAR']);
  assert.strictEqual(s.get('W1NEAR').cls, 'weather');
});

test('dual mode: window.AprsStations beside window.AprsParser', () => {
  const fs = require('fs');
  const vm = require('vm');
  const sandbox = {};
  sandbox.self = sandbox;
  vm.runInNewContext(fs.readFileSync(require.resolve('../lib/aprs-parser'), 'utf8'), sandbox);
  vm.runInNewContext(fs.readFileSync(require.resolve('../lib/aprs-symbols'), 'utf8'), sandbox);
  vm.runInNewContext(fs.readFileSync(require.resolve('../lib/aprs-stations'), 'utf8'), sandbox);
  const st = sandbox.AprsStations.createStore({ home: HOME });
  const r = st.add(sandbox.AprsParser.parse('W1AW>APRS:=4142.00N/07243.00W>'));
  assert.strictEqual(r.cls, 'car');
});

test('visibleRange: only the rows in view, plus overscan, with the space around them', () => {
  // 3000 rows of 32 px in a 640 px view scrolled to row 1000.
  const v = S.visibleRange(32000, 640, 32, 3000, 5);
  assert.strictEqual(v.start, 995);
  assert.strictEqual(v.end, 1025);
  assert.strictEqual(v.top, 995 * 32);
  assert.strictEqual(v.bottom, (3000 - 1025) * 32);
  assert.strictEqual(v.top + (v.end - v.start) * 32 + v.bottom, 3000 * 32, 'the scroll height never changes');
  assert.deepStrictEqual(S.visibleRange(0, 640, 32, 10, 5), { start: 0, end: 10, top: 0, bottom: 0 }, 'short list: all of it');
  assert.deepStrictEqual(S.visibleRange(0, 640, 32, 0, 5), { start: 0, end: 0, top: 0, bottom: 0 });
  const past = S.visibleRange(999999, 640, 32, 100, 5);
  assert.ok(past.start <= past.end && past.end === 100, 'scrolled past the end stays in range');
});

test('this test is in the list CI runs', () => {
  const fs = require('fs');
  const path = require('path');
  assert.ok(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'run-tests.js'), 'utf8').includes("'test/aprs-stations-test.js'"));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
