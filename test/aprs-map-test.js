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
// Casey 2026-11-19: "cluster gets the heard-by-me ring when it holds an RF-heard station".
test('a cluster holding a station the radio heard carries the ring; one without does not', () => {
  const heard = (p) => !!p.rf;
  const pts = [{ x: 5, y: 5 }, { x: 15, y: 25, rf: true }, { x: 300, y: 300 }, { x: 310, y: 310 }];
  const r = M.cluster(pts, { cell: 60, ring: heard });
  assert.strictEqual(r.clusters.length, 2);
  const withRf = r.clusters.find((c) => c.members.some((p) => p.rf));
  const without = r.clusters.find((c) => !c.members.some((p) => p.rf));
  assert.strictEqual(withRf.ring, true);
  assert.strictEqual(without.ring, false);
});
test('the ring survives a merge: the host takes it from the cluster it absorbs', () => {
  const pts = [{ x: 55, y: 10 }, { x: 58, y: 12 }, { x: 59, y: 14 }, { x: 62, y: 10, rf: true }, { x: 65, y: 14 }];
  const r = M.cluster(pts, { cell: 60, ring: (p) => !!p.rf });
  assert.strictEqual(r.clusters.length, 1);
  assert.strictEqual(r.clusters[0].ring, true);
});
test('with no ring test every cluster has ring false', () => {
  const r = M.cluster([{ x: 1, y: 1, rf: true }, { x: 2, y: 2 }], { cell: 60 });
  assert.strictEqual(r.clusters[0].ring, false);
});
test('the APRS window asks for the ring and draws it on the cluster', () => {
  const fs = require('fs');
  const src = fs.readFileSync(require('path').join(__dirname, '..', 'renderer', 'aprs-popout.js'), 'utf8');
  assert.ok(/AprsMap\.cluster\(pts, \{ cell: CELL_PX, ring: /.test(src), 'recluster passes the ring test');
  const fn = src.slice(src.indexOf('function drawCluster('), src.indexOf('function draw(t)'));
  assert.ok(/if \(c\.ring\)/.test(fn), 'drawCluster checks c.ring');
  assert.ok(/strokeStyle = theme\.rf/.test(fn), 'in the heard-by-me colour');
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
// Casey 2026-11-20: "the pin points are clickable (good) but the flags are not".
test('the label flag sits right of the pin, as drawn: 4 px past the icon, 18 px tall, the text plus 10 px', () => {
  assert.deepStrictEqual(M.labelBox(100, 200, 40, 22), { x: 115, y: 191, w: 50, h: 18 });
});
test('a click on the label flag hits the station, the same as its pin', () => {
  const row = { key: 'K3SBP-9' };
  const hits = [{ x: 100, y: 200, rad: 14, box: M.labelBox(100, 200, 40, 22), row }];
  assert.strictEqual(M.hitTest(hits, { x: 102, y: 198 }).row, row, 'the pin');
  assert.strictEqual(M.hitTest(hits, { x: 140, y: 200 }).row, row, 'the middle of the flag');
  assert.strictEqual(M.hitTest(hits, { x: 164, y: 208 }).row, row, 'the flag\'s far corner');
  assert.strictEqual(M.hitTest(hits, { x: 175, y: 200 }), null, 'past the flag');
  assert.strictEqual(M.hitTest(hits, { x: 140, y: 230 }), null, 'below the flag');
});
test('no flag drawn (zoomed out): only the pin is a hit; the station drawn last wins an overlap', () => {
  const a = { key: 'A' }, b = { key: 'B' };
  assert.strictEqual(M.hitTest([{ x: 100, y: 200, rad: 14, box: null, row: a }], { x: 140, y: 200 }), null);
  const hits = [{ x: 100, y: 200, rad: 14, box: M.labelBox(100, 200, 60, 22), row: a }, { x: 150, y: 200, rad: 14, box: null, row: b }];
  assert.strictEqual(M.hitTest(hits, { x: 150, y: 200 }).row, b);
  assert.strictEqual(M.hitTest(hits, { x: 130, y: 200 }).row, a);
});
test('the window draws the flag from labelBox and hit-tests with hitTest (pin and flag alike, hover cursor too)', () => {
  const fs = require('fs');
  const path = require('path');
  const pop = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'aprs-popout.js'), 'utf8');
  assert.ok(/var box = AprsMap\.labelBox\(x, y, labelWidth\(ctx, text\), ICON_PX\);/.test(pop));
  assert.ok(/hits\.push\(\{ x: x, y: y, rad: ICON_PX \/ 2 \+ 3, box: flag, row: r \}\);/.test(pop));
  assert.ok(/function hitAt\(lp\) \{ return AprsMap\.hitTest\(hits, lp\); \}/.test(pop));
  assert.ok(/classList\.toggle\('aprs-hover', !!\(hoverPoint && hitAt\(hoverPoint\)\)\)/.test(pop), 'the pointer cursor over a flag too');
});
test('this test is in the list CI runs', () => {
  const fs = require('fs');
  const path = require('path');
  assert.ok(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'run-tests.js'), 'utf8').includes("'test/aprs-map-test.js'"));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
