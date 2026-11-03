#!/usr/bin/env node
'use strict';
// A QSO started by clicking a station's RR73 or report logs with the grid
// they said earlier on the air (Casey via the echocat session, 2026-11-02).
// Run: node test/heard-grids-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { HeardGrids } = require('../lib/heard-grids');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

test('remembers the last grid a station said, case-folded, never RR73', () => {
  let t = 0;
  const h = new HeardGrids({ now: () => t });
  assert.ok(h.note('k1abc', 'fn42'));
  assert.strictEqual(h.get('K1ABC'), 'FN42');
  assert.ok(!h.note('K1ABC', 'RR73') && !h.note('K1ABC', '73') && !h.note('', 'FN42'));
  assert.strictEqual(h.get('K1ABC'), 'FN42', 'a non-grid never overwrites');
  h.note('K1ABC', 'FN31');
  assert.strictEqual(h.get('K1ABC'), 'FN31', 'the latest wins');
  assert.strictEqual(h.get('W9XYZ'), '');
});
test('forgets after the TTL and caps its size', () => {
  let t = 0;
  const h = new HeardGrids({ now: () => t, ttlMs: 1000, max: 2 });
  h.note('A1A', 'FN42'); h.note('B1B', 'FN42'); h.note('C1C', 'FN42');
  assert.strictEqual(h.size, 2, 'oldest dropped');
  assert.strictEqual(h.get('A1A'), '');
  t = 1001;
  assert.strictEqual(h.get('C1C'), '');
});
test('main: every decoded grid is noted; both reply handlers and the auto-log fill a missing grid', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.strictEqual((main.match(/jtcatHeardGrids\.note\(uc, r\.grid\);/g) || []).length, 2, 'single-slice and multi-slice decode sites');
  assert.ok(/const theirGrid = data\.theirGrid \|\| data\.grid \|\| jtcatHeardGrids\.get\(call\) \|\| '';/.test(main), 'ECHOCAT reply');
  assert.ok(/if \(!data\.theirGrid && !data\.grid\) \{ const g = jtcatHeardGrids\.get\(data\.call\); if \(g\) data\.grid = g; \}/.test(main), 'JTCAT window reply');
  const al = main.slice(main.indexOf('async function jtcatAutoLog('), main.indexOf('async function jtcatAutoLog(') + 900);
  assert.ok(/if \(!q\.grid\) \{ const g = jtcatHeardGrids\.get\(q\.call\); if \(g\) \{ q\.grid = g;/.test(al), 'auto-log (covers the compressed-reply QSO too)');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
