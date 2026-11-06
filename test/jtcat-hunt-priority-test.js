#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
// Hunt filters, piece 3 (docs/plan-jtcat-hunt-priorities.md): "Who goes
// first" — Strongest (the old order, the default), Farthest, Needed first.
// Event-needed stations still go first in every priority.
// Run: node test/jtcat-hunt-priority-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const H = require('../lib/jtcat-hunt-filters');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
}
const read = (f) => readSrc(path.join(__dirname, '..', f));
const main = read('main.js');

test('a 0 dB caller outranks a -5 dB one under Strongest (0 is a level, not a missing one)', () => {
  const r = H.rankCallers([{ call: 'A', db: -5 }, { call: 'B', db: 0 }, { call: 'C' }], { priority: 'strongest' });
  assert.deepStrictEqual(r.map((d) => d.call), ['B', 'A', 'C']);
});

test('the pick ranks by the saved priority, and the status line says why the next station was chosen', () => {
  const at = main.indexOf('// --- Auto-CQ Response ---');
  const pick = main.slice(at, at + 6000);
  assert.ok(/const huntPriority = HuntFilters\.normalizePriority\(settings\.jtcatHuntPriority\);/.test(pick));
  assert.ok(/const ranked = HuntFilters\.rankCallers\(candidates, \{ priority: huntPriority, myGrid \}\);\n\s+const best = ranked\[0\];/.test(pick));
  assert.ok(!/candidates\.sort\(/.test(pick), 'the old SNR-only sort is gone');
  assert.ok(/jtcatHuntStatusPush\(candidates, best, huntPriority\)/.test(pick));
  assert.ok(/c\.distanceKm = km;/.test(pick), 'Farthest stamps each caller\'s distance, so the status can say how far');
  const push = main.slice(main.indexOf('function jtcatHuntStatusPush('), main.indexOf('function jtcatHuntStatusClear('));
  assert.ok(/HuntFilters\.nextWhy\(best, priority\)/.test(push));
});

test('Strongest picks the same station the old sort did, for the same callers', () => {
  const callers = [
    { call: 'K1A', db: -12 }, { call: 'K2B', db: 3 }, { call: 'K3C', db: -3, eventMatch: { status: 'needed' } }, { call: 'K4D', db: 0 },
  ];
  const evRank = (d) => (d.eventMatch && d.eventMatch.status !== 'worked') ? 1 : 0;
  const old = callers.slice().sort((a, b) => (evRank(b) - evRank(a)) || (b.db - a.db)).map((d) => d.call);
  assert.deepStrictEqual(H.rankCallers(callers, { priority: 'strongest' }).map((d) => d.call), old);
  assert.deepStrictEqual(H.rankCallers(callers, {}).map((d) => d.call), old, 'nothing saved = Strongest');
});

test('the Filters panel offers the three choices and saves the one picked', () => {
  const html = read('renderer/jtcat-popout.html');
  for (const v of ['strongest', 'farthest', 'needed']) assert.ok(new RegExp('name="jp-hunt-priority" value="' + v + '"').test(html), v);
  const pop = read('renderer/jtcat-popout.js');
  assert.ok(/window\.api\.saveSettings\(\{ jtcatHuntPriority: huntPriority \}\);/.test(pop));
  assert.ok(/hfDot\.hidden = hideBelowDb == null && huntPriority === 'strongest'[;\s&]/.test(pop), 'the dot shows for a non-default priority');
});

console.log(`\nHunt priority: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
