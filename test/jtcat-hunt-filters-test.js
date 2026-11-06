#!/usr/bin/env node
'use strict';
// JTCAT Hunt filters and priority (docs/plan-jtcat-hunt-priorities.md, Casey's
// yes 2026-11-05): the pure rules. Asks: r3314 (SNR, DX only, prefer long
// distance, target or avoid calls), nj2dx (hide weak decodes), level_death
// (new grids), kilrath8954 (several targets at once).
// Run: node test/jtcat-hunt-filters-test.js
const assert = require('assert');
const H = require('../lib/jtcat-hunt-filters');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
}

const callers = () => [
  { call: 'K4POT', db: -4, grid: 'EM85' },
  { call: 'DL2ABC', db: -14, grid: 'JO62', newGrid: true },
  { call: 'VK3ABC', db: -10, grid: 'QF22', newDxcc: true },
  { call: 'N5ZZ', db: -2 },
];
const order = (list) => list.map((d) => d.call).join(' ');

test('Strongest is today\'s order: SNR', () => {
  assert.strictEqual(order(H.rankCallers(callers(), { priority: 'strongest', myGrid: 'FN20' })), 'N5ZZ K4POT VK3ABC DL2ABC');
  assert.strictEqual(order(H.rankCallers(callers(), { myGrid: 'FN20' })), 'N5ZZ K4POT VK3ABC DL2ABC', 'the default');
});

test('Farthest: by distance from our grid; a caller with no grid goes last', () => {
  assert.strictEqual(order(H.rankCallers(callers(), { priority: 'farthest', myGrid: 'FN20' })), 'VK3ABC DL2ABC K4POT N5ZZ');
});

test('Needed first: new country, then new grid, then the rest, strongest within each', () => {
  assert.strictEqual(order(H.rankCallers(callers(), { priority: 'needed', myGrid: 'FN20' })), 'VK3ABC DL2ABC N5ZZ K4POT');
  const wanted = [{ call: 'A', db: -1 }, { call: 'B', db: -20, wantedCountry: true }];
  assert.strictEqual(order(H.rankCallers(wanted, { priority: 'needed' })), 'B A', 'wantedCountry counts as a new country');
});

test('an event station still goes first in every priority', () => {
  const list = callers().concat([{ call: 'W1E', db: -20, eventMatch: { status: 'needed' } }]);
  for (const p of H.PRIORITIES) assert.strictEqual(H.rankCallers(list, { priority: p, myGrid: 'FN20' })[0].call, 'W1E', p);
});

test('ranking never reorders the caller\'s array', () => {
  const list = callers();
  H.rankCallers(list, { priority: 'farthest', myGrid: 'FN20' });
  assert.strictEqual(order(list), 'K4POT DL2ABC VK3ABC N5ZZ');
});

test('distance in km between grids; null when a grid is missing', () => {
  const km = H.distanceKm('FN20', 'PM95');
  assert.ok(km > 10500 && km < 11200, String(km));
  assert.strictEqual(H.distanceKm('FN20', ''), null);
  assert.strictEqual(H.distanceKm('', 'FN20'), null);
});

test('targets: Custom is the saved list (known targets only, no repeats); a single mode is itself', () => {
  assert.deepStrictEqual(H.targetsForMode('custom', ['pota', 'new-grid', 'pota', 'bogus']), ['pota', 'new-grid']);
  assert.deepStrictEqual(H.targetsForMode('custom', []), ['pota'], 'never an empty Custom');
  assert.deepStrictEqual(H.targetsForMode('dx', ['pota']), ['dx']);
  assert.ok(H.HUNT_TARGETS.includes('new-grid'));
});

test('Never answer: exact calls and XX* prefixes; entries are cleaned', () => {
  const list = H.normalizeIgnoreList(['ve3*', ' K1ABC ', 'bad entry!', 'K1ABC']);
  assert.deepStrictEqual(list, ['VE3*', 'K1ABC']);
  assert.ok(H.isIgnored('VE3KP', list));
  assert.ok(H.isIgnored('k1abc', list));
  assert.ok(!H.isIgnored('K1ABCD', list), 'exact means exact');
  assert.ok(!H.isIgnored('W1AW', list));
});

test('auto-skip: a failed QSO\'s call is skipped for the minutes set, per band and mode, then forgotten', () => {
  const s = new H.AutoSkip();
  const t0 = 1_000_000;
  s.note('JA1XYZ', '20m', 'FT8', t0);
  assert.ok(s.has('JA1XYZ', '20m', 'FT8', 30, t0 + 29 * 60000));
  assert.ok(!s.has('JA1XYZ', '40m', 'FT8', 30, t0 + 60000), 'another band is a new chance');
  assert.ok(!s.has('JA1XYZ', '20m', 'FT8', 0, t0 + 60000), '0 = off');
  assert.ok(!s.has('JA1XYZ', '20m', 'FT8', 30, t0 + 30 * 60000), 'expired');
});

test('CQ DX is not for the caller\'s own continent; CQ NA/EU/... only for that continent; plain CQs unchanged', () => {
  assert.strictEqual(H.cqAimedAtUs('CQ DX K1ABC FN42', 'NA', 'NA'), false);
  assert.strictEqual(H.cqAimedAtUs('CQ DX JA1XYZ PM95', 'AS', 'NA'), true);
  assert.strictEqual(H.cqAimedAtUs('CQ EU DL1ABC JO62', 'EU', 'NA'), false);
  assert.strictEqual(H.cqAimedAtUs('CQ NA K1ABC FN42', 'NA', 'NA'), true);
  assert.strictEqual(H.cqAimedAtUs('CQ POTA K1ABC FN42', 'NA', 'NA'), true, 'POTA is not a continent');
  assert.strictEqual(H.cqAimedAtUs('CQ K1ABC FN42', 'NA', 'NA'), true);
  assert.strictEqual(H.cqAimedAtUs('CQ DX K1ABC FN42', '', 'NA'), true, 'unknown caller continent: answered as before');
  assert.strictEqual(H.cqAimedAtUs('CQ EU DL1ABC JO62', 'EU', ''), true, 'unknown home continent: as before');
});

test('the quiet-reason line says what was heard and why nobody was answered, or who is next', () => {
  assert.strictEqual(H.quietReasonText({ heard: 9, below: 6, floor: -15, worked: 2, ignored: 1, next: null }),
    'Hunt: 9 CQs heard, 6 below -15 dB, 2 worked, 1 ignored · nobody to answer this period');
  assert.strictEqual(H.quietReasonText({ heard: 3, worked: 1, next: { call: 'K4POT', why: '-4 dB' } }),
    'Hunt: 3 CQs heard, 1 worked · answering K4POT next (-4 dB)');
  assert.strictEqual(H.quietReasonText({ heard: 1 }), 'Hunt: 1 CQ heard · nobody to answer this period');
});

console.log(`\nHunt filters: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
