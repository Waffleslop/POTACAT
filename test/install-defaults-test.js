'use strict';
/**
 * "Just works" defaults (Casey 2026-10-27): logging, solar indices, band
 * activity and PSKReporter Propagation have no switch; SOTA/WWFF/LLOTA and a
 * randomly picked DX cluster node are on once per profile; a node POTACAT
 * picked is swapped for another when it dies. lib/install-defaults.js +
 * main.js/renderer wiring.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const D = require('../lib/install-defaults');

const ROOT = path.join(__dirname, '..');
let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ FAIL: ' + name + '\n      ' + e.message); }
}
const PRESETS = [
  { name: 'W3LPL', host: 'w3lpl.net', port: 7373 },
  { name: 'VE7CC', host: 'dxc.ve7cc.net', port: 23 },
  { name: 'K1TTT', host: 'k1ttt.net', port: 7373 },
];

console.log('always on:');
check('an old saved false cannot hide them', () => {
  const s = D.applyAlwaysOn({ enableLogging: false, enableSolar: false, enableBandActivity: false, enablePskrMap: false });
  for (const k of D.ALWAYS_ON) assert.strictEqual(s[k], true, k);
});

console.log('once per profile:');
check('a fresh profile gets SOTA/WWFF/LLOTA and a random cluster node', () => {
  const s = {};
  const changed = D.applyDefaultsOnce(s, PRESETS, () => 0.5);
  assert.strictEqual(s.enableSota, true);
  assert.strictEqual(s.enableWwff, true);
  assert.strictEqual(s.enableLlota, true);
  assert.strictEqual(s.enableCluster, true);
  assert.strictEqual(s.clusterNodes.length, 1);
  assert.strictEqual(s.clusterNodes[0].name, 'VE7CC', 'rand 0.5 of 3 → the middle preset');
  assert.strictEqual(s.clusterNodes[0].auto, true);
  assert.strictEqual(s.installDefaultsRev, D.DEFAULTS_REV);
  assert.ok(changed.length >= 4);
});
check('the pick spreads across the whole list', () => {
  const seen = new Set();
  for (const r of [0, 0.34, 0.67, 0.999]) {
    const s = {};
    D.applyDefaultsOnce(s, PRESETS, () => r);
    seen.add(s.clusterNodes[0].name);
  }
  assert.strictEqual(seen.size, 3);
});
check('it runs once: an operator who unticks SOTA afterwards keeps it off', () => {
  const s = {};
  D.applyDefaultsOnce(s, PRESETS, () => 0);
  s.enableSota = false;
  assert.deepStrictEqual(D.applyDefaultsOnce(s, PRESETS, () => 0), []);
  assert.strictEqual(s.enableSota, false);
});
check('a station with its own nodes keeps its cluster choice, on or off', () => {
  const mine = [{ id: 'x', name: 'HamAlert', host: 'hamalert.org', port: 7300, enabled: true }];
  const s = { clusterNodes: mine.slice(), enableCluster: false };
  D.applyDefaultsOnce(s, PRESETS, () => 0);
  assert.strictEqual(s.enableCluster, false);
  assert.deepStrictEqual(s.clusterNodes, mine);
});

console.log('dead node:');
check('a node POTACAT picked is replaced by an untried preset', () => {
  const s = {};
  D.applyDefaultsOnce(s, PRESETS, () => 0);           // W3LPL
  const r1 = D.replaceDeadAutoNode(s.clusterNodes, s.clusterNodes[0].id, PRESETS, () => 0);
  assert.strictEqual(r1.from, 'W3LPL');
  assert.strictEqual(r1.to, 'VE7CC');
  const r2 = D.replaceDeadAutoNode(r1.nodes, r1.nodes[0].id, PRESETS, () => 0);
  assert.strictEqual(r2.to, 'K1TTT');
  assert.strictEqual(D.replaceDeadAutoNode(r2.nodes, r2.nodes[0].id, PRESETS, () => 0), null, 'every preset tried: stop');
});
check('a node the operator chose is never replaced', () => {
  const nodes = [{ id: 'x', name: 'W3LPL', host: 'w3lpl.net', port: 7373, enabled: true }];
  assert.strictEqual(D.replaceDeadAutoNode(nodes, 'x', PRESETS, () => 0), null);
});

console.log('wiring:');
const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'renderer/app.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'renderer/index.html'), 'utf8');
check('every settings load and save forces the always-on features', () => {
  assert.ok(/return InstallDefaults\.applyAlwaysOn\(loadSettingsFromDisk\(\)\)/.test(main));
  assert.ok(/for \(const k of InstallDefaults\.ALWAYS_ON\) if \(k in newSettings\) newSettings\[k\] = true;/.test(main));
});
check('startup applies the one-time defaults with the real preset list', () => {
  assert.ok(/InstallDefaults\.applyDefaultsOnce\(settings, CLUSTER_PRESETS\)/.test(main));
  assert.ok(/InstallDefaults\.replaceDeadAutoNode\(settings\.clusterNodes, node\.id, CLUSTER_PRESETS\)/.test(main));
});
check('no checkbox can switch them off', () => {
  for (const id of ['set-enable-logging', 'set-enable-solar', 'set-enable-band-activity', 'set-enable-pskr-map', 'set-enable-rbn']) {
    assert.ok(!html.includes('id="' + id + '"'), id + ' is back');
  }
  assert.ok(!/id="logging-config" class="radio-sub hidden"/.test(html), 'the logging options are hidden');
  assert.ok(/enableLogging = true;/.test(app));
  assert.ok(/enableSolar = true;/.test(app));
  assert.ok(/enableBandActivity = true;/.test(app));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
