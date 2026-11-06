#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
// Hunt filters, piece 2 (docs/plan-jtcat-hunt-priorities.md): a "New grids"
// Hunt target, and the Wanted view filter split into New DXCC and New grid
// (level_death 2026-11-04: show only new grids or new DX entities).
// Run: node test/jtcat-hunt-new-grid-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const sm = require('../lib/jtcat-state-machine');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
}
const read = (f) => readSrc(path.join(__dirname, '..', f));

test('Hunt: New grids answers a CQ from a grid not yet worked on this band and mode, and nothing else', () => {
  assert.strictEqual(sm.matchesHuntFilter('CQ DL2ABC JO62', 'new-grid', { gridWanted: true }), true);
  assert.strictEqual(sm.matchesHuntFilter('CQ DL2ABC JO62', 'new-grid', { gridWanted: false }), false);
  assert.strictEqual(sm.matchesHuntFilter('CQ DL2ABC JO62', 'new-grid', {}), false);
  assert.strictEqual(sm.matchesHuntFilter('K1ABC DL2ABC JO62', 'new-grid', { gridWanted: true }), false, 'still only a CQ');
});

test('main hands the decode\'s own newGrid flag to the match, and says why in the log', () => {
  const main = read('main.js');
  const f = main.slice(main.indexOf('function jtcatHuntProgramMatch('), main.indexOf('function jtcatHuntProgramMatch(') + 4500);
  assert.ok(/gridWanted: !!d\.newGrid,/.test(f));
  assert.ok(/'new-grid': `\$\{d\.grid\} is a grid you still need here`/.test(f));
});

test('the FT8 window and ECHOCAT Web offer the target', () => {
  assert.ok(/<option value="new-grid"[^>]*>Hunt: New grids<\/option>/.test(read('renderer/jtcat-popout.html')));
  assert.ok(/'new-grid': 'New grids'/.test(read('renderer/jtcat-popout.js')));
  assert.ok(/<option value="new-grid">New grids<\/option>/.test(read('renderer/remote.html')));
});

test('the Wanted filter cycles Wanted, New DXCC, New grid, off; an older true save is the full Wanted filter', () => {
  const pop = read('renderer/jtcat-popout.js');
  const start = pop.indexOf("  var wantedFilter = '';");
  const end = pop.indexOf('  function reflectWantedBtn()');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(pop.slice(start, end) + '\nthis.set = function (v) { wantedFilter = v; }; this.matches = wantedMatches; this.cycle = WANTED_CYCLE;', ctx);
  assert.deepStrictEqual(Array.from(ctx.cycle), ['', 'wanted', 'dxcc', 'grid']);
  const dxcc = { isWanted: true, d: { newDxcc: true } };
  const grid = { isWanted: true, d: { newGrid: true } };
  const call = { isWanted: true, d: { newCall: true } };
  ctx.set('wanted'); assert.deepStrictEqual([dxcc, grid, call].map(ctx.matches), [true, true, true]);
  ctx.set('dxcc'); assert.deepStrictEqual([dxcc, grid, call].map(ctx.matches), [true, false, false]);
  ctx.set('grid'); assert.deepStrictEqual([dxcc, grid, call].map(ctx.matches), [false, true, false]);
  assert.ok(/wantedFilter = saved\.wanted === true \? 'wanted' :/.test(pop), 'an older saved true still shows Wanted');
  assert.ok(/if \(wantedFilter && !wantedMatches\(c\) && !c\.isDirected && !c\.is73\) return false;/.test(pop));
});

console.log(`\nHunt new grids: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
