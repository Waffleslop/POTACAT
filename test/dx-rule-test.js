#!/usr/bin/env node
'use strict';
// What counts as DX (G4BFG + K3SBP, 2026-10-26): a different DXCC entity by
// default; optionally farther than the operator's distance, one for HF and one
// for 6 m and up. "DX" used to mean "came from the DX Cluster".
// Run: node test/dx-rule-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const R = require('../lib/dx-rule');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
console.log('DX rule');
test('default: a different DXCC entity is DX, the same one is not', () => {
  assert.strictEqual(R.isDx({ myEntity: 'Fed. Rep. of Germany', theirEntity: 'Bulgaria', distanceMi: 900, freqKhz: 14074 }), true);
  assert.strictEqual(R.isDx({ myEntity: 'United States', theirEntity: 'United States', distanceMi: 2500, freqKhz: 14074 }), false);
});
test('unknown entity is never DX', () => {
  assert.strictEqual(R.isDx({ myEntity: '', theirEntity: 'Bulgaria', freqKhz: 14074 }), false);
  assert.strictEqual(R.isDx({ myEntity: 'England', theirEntity: '', freqKhz: 14074 }), false);
});
test("G4BFG's distances: HF 2000 mi, 2 m 100 mi", () => {
  const o = { hfMi: 2000, vhfMi: 100 };
  assert.strictEqual(R.isDx({ myEntity: 'England', theirEntity: 'Bulgaria', distanceMi: 1300, freqKhz: 14074 }, o), false, 'Europe on HF is not DX at 2000');
  assert.strictEqual(R.isDx({ myEntity: 'England', theirEntity: 'United States', distanceMi: 3500, freqKhz: 14074 }, o), true);
  assert.strictEqual(R.isDx({ myEntity: 'England', theirEntity: 'England', distanceMi: 150, freqKhz: 144300 }, o), true, '2 m over 100 mi, same country');
  assert.strictEqual(R.isDx({ myEntity: 'England', theirEntity: 'France', distanceMi: 90, freqKhz: 144300 }, o), false);
});
test('6 m is judged by the 6 m-and-up distance', () => {
  assert.strictEqual(R.bandGroup(50313), 'vhf');
  assert.strictEqual(R.bandGroup(28074), 'hf');
  assert.strictEqual(R.isDx({ myEntity: 'A', theirEntity: 'A', distanceMi: 600, freqKhz: 50313 }, { hfMi: 2000, vhfMi: 500 }), true);
});
test('a set distance with no known distance falls back to the entity rule', () => {
  assert.strictEqual(R.isDx({ myEntity: 'A', theirEntity: 'B', distanceMi: null, freqKhz: 7074 }, { hfMi: 2000 }), true);
  assert.strictEqual(R.isDx({ myEntity: 'A', theirEntity: 'A', distanceMi: null, freqKhz: 7074 }, { hfMi: 2000 }), false);
});
test('blank, 0 or junk distance = entity rule', () => {
  for (const v of ['', 0, null, undefined, 'abc', -5]) assert.strictEqual(R.limitMiles(v), 0, String(v));
});
test('main stamps isDx on every merged spot, from the settings, and re-pushes on change', () => {
  const main = read('main.js');
  assert.ok(/CallZones\.stampSpotZones\(merged, callZonesOf\);\s*\n\s*stampSpotDx\(merged\);/.test(main));
  assert.ok(/hfMi: settings\.dxDistanceHf, vhfMi: settings\.dxDistanceVhf/.test(main));
  assert.ok(/if \(dxRuleChanged && !panadapterChanged\)/.test(main));
});
test('desktop: Cluster label, DX pill, DX only filter, distance boxes in the operator unit', () => {
  const app = read('renderer', 'app.js');
  const html = read('renderer', 'index.html');
  assert.ok(/dxc: 'Cluster'/.test(app), 'the cluster feed is labelled Cluster');
  assert.ok(/if \(dxOnly && !s\.isDx\) return false;/.test(app));
  assert.ok(/id="spots-dx-only"/.test(html) && /id="set-dx-dist-hf"/.test(html) && /id="set-dx-dist-vhf"/.test(html));
  assert.ok(/<script src="\.\.\/lib\/dx-rule\.js"><\/script>/.test(html));
  assert.ok(/n \/ MI_TO_KM/.test(app), 'km typed is stored as miles');
});
test('web: DX badge in the call cell, DX only filter carried in the roaming filters', () => {
  const SR = require('../lib/spot-row');
  const html = SR.spotRowHtml({ callsign: 'LZ1ABC', frequency: '14074', source: 'dxc', isDx: true }, {}, { colShow: {} });
  assert.ok(/<span class="spot-call">LZ1ABC<span class="dx-badge"/.test(html), html);
  assert.ok(!/dx-badge/.test(SR.spotRowHtml({ callsign: 'K1ABC', frequency: '14074', source: 'pota' }, {}, { colShow: {} })));
  const web = read('renderer', 'remote.js');
  assert.ok(/if \(dxOnly && !s\.isDx\) return false;/.test(web));
  assert.ok(/dxOnly: dxOnly,/.test(web) && /f\.dxOnly != null/.test(web));
});
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
