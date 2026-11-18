#!/usr/bin/env node
'use strict';
// The APRS map's arithmetic (lib/aprs-map.js): the grid clusterer, the eased
// glide between two fixes, and the fade. Run: node test/aprs-map-test.js

const assert = require('assert');
const M = require('../lib/aprs-map');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
const near = (a, b, eps) => Math.abs(a - b) <= (eps || 1e-9);

console.log('APRS map');
test('far-apart points stay single', () => {
  const r = M.cluster([{ x: 10, y: 10 }, { x: 300, y: 10 }, { x: 10, y: 300 }], { cell: 60 });
  assert.strictEqual(r.singles.length, 3);
  assert.strictEqual(r.clusters.length, 0);
});
test('points sharing a cell become one cluster at their mean, with the members', () => {
  const pts = [{ x: 5, y: 5, k: 'a' }, { x: 15, y: 25, k: 'b' }, { x: 40, y: 30, k: 'c' }, { x: 500, y: 500, k: 'd' }];
  const r = M.cluster(pts, { cell: 60 });
  assert.strictEqual(r.clusters.length, 1);
  assert.strictEqual(r.clusters[0].count, 3);
  assert.ok(near(r.clusters[0].x, 20) && near(r.clusters[0].y, 20));
  assert.deepStrictEqual(r.clusters[0].members.map((p) => p.k).sort(), ['a', 'b', 'c']);
  assert.deepStrictEqual(r.singles.map((p) => p.k), ['d']);
});
test('clusters either side of a cell edge merge', () => {
  const pts = [{ x: 55, y: 10 }, { x: 58, y: 12 }, { x: 62, y: 10 }, { x: 65, y: 14 }, { x: 66, y: 11 }];
  const r = M.cluster(pts, { cell: 60 });
  assert.strictEqual(r.clusters.length, 1);
  assert.strictEqual(r.clusters[0].count, 5);
  assert.strictEqual(r.clusters[0].members.length, 5);
});
test('min sets the smallest cluster', () => {
  const r = M.cluster([{ x: 1, y: 1 }, { x: 2, y: 2 }], { cell: 60, min: 3 });
  assert.strictEqual(r.clusters.length, 0);
  assert.strictEqual(r.singles.length, 2);
});
test('every point lands once, in a single or a cluster', () => {
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const pts = [];
  for (let i = 0; i < 3000; i++) pts.push({ x: rnd() * 1200, y: rnd() * 800, i });
  const t0 = Date.now();
  const r = M.cluster(pts, { cell: 60 });
  const ms = Date.now() - t0;
  const seen = new Set(r.singles.map((p) => p.i));
  for (const c of r.clusters) for (const p of c.members) { assert.ok(!seen.has(p.i)); seen.add(p.i); }
  assert.strictEqual(seen.size, 3000);
  assert.strictEqual(r.clusters.reduce((n, c) => n + c.count, 0) + r.singles.length, 3000);
  assert.ok(ms < 100, 'clustered 3000 points in ' + ms + ' ms');
});
test('bad points are skipped', () => {
  const r = M.cluster([{ x: NaN, y: 1 }, null, { x: 1, y: 1 }]);
  assert.strictEqual(r.singles.length, 1);
});
test('ease starts and ends still, passes the middle', () => {
  assert.strictEqual(M.ease(0), 0);
  assert.strictEqual(M.ease(1), 1);
  assert.ok(near(M.ease(0.5), 0.5));
  assert.ok(M.ease(0.1) < 0.1 && M.ease(0.9) > 0.9);
  assert.strictEqual(M.ease(-1), 0);
  assert.strictEqual(M.ease(2), 1);
});
test('glide goes from one fix to the next', () => {
  const a = { lat: 41, lon: -72 }, b = { lat: 42, lon: -71 };
  assert.deepStrictEqual(M.glide(a, b, 0), a);
  assert.deepStrictEqual(M.glide(a, b, 1), b);
  const mid = M.glide(a, b, 0.5);
  assert.ok(near(mid.lat, 41.5) && near(mid.lon, -71.5));
});
test('glide takes the short way across the date line', () => {
  const mid = M.glide({ lat: 0, lon: 179 }, { lat: 0, lon: -179 }, 0.5);
  assert.ok(Math.abs(Math.abs(mid.lon) - 180) < 1e-9, 'mid lon ' + mid.lon);
  const q = M.glide({ lat: 0, lon: -179 }, { lat: 0, lon: 179 }, 0.25);
  assert.ok(q.lon < -179 && q.lon >= -180, 'quarter lon ' + q.lon);
});
test('fade in and fade out', () => {
  assert.strictEqual(M.fade(1000, 1000, 400), 0);
  assert.strictEqual(M.fade(1000, 1200, 400), 0.5);
  assert.strictEqual(M.fade(1000, 2000, 400), 1);
  assert.strictEqual(M.fade(1000, 1000, 600, true), 1);
  assert.strictEqual(M.fade(1000, 1300, 600, true), 0.5);
  assert.strictEqual(M.fade(1000, 9000, 600, true), 0);
});
test('dual mode: window.AprsMap in a page', () => {
  const fs = require('fs');
  const vm = require('vm');
  const sandbox = {};
  sandbox.self = sandbox;
  vm.runInNewContext(fs.readFileSync(require.resolve('../lib/aprs-map'), 'utf8'), sandbox);
  assert.strictEqual(sandbox.AprsMap.cluster([{ x: 1, y: 1 }, { x: 2, y: 2 }]).clusters.length, 1);
});
test('this test is in the list CI runs', () => {
  const fs = require('fs');
  const path = require('path');
  assert.ok(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'run-tests.js'), 'utf8').includes("'test/aprs-map-test.js'"));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
