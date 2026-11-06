#!/usr/bin/env node
'use strict';
// Hunt filters, piece 6 (docs/plan-jtcat-hunt-priorities.md): the CQ DX /
// CQ <continent> rule, no setting (Casey 2026-11-05). Hunt never answers a
// CQ DX from a station on our own continent, nor a CQ NA/EU/... aimed at a
// continent we are not on. This runs main's real jtcatWorkableCallers with
// its surroundings stubbed.
// Run: node test/jtcat-hunt-cq-dx-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const HuntFilters = require('../lib/jtcat-hunt-filters');
const JtcatParser = require('../renderer/jtcat-parser');
const sm = require('../lib/jtcat-state-machine');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
}
const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

function workable(home, results) {
  const src = main.slice(main.indexOf('function jtcatWorkableCallers('), main.indexOf('let _jtcatFloorNoteAt'));
  const ctx = {
    HuntFilters, settings: {}, ft8Engine: {},
    jtcatCurrentBandMode: () => ({ band: '20m', mode: 'FT8' }),
    jtcatIsWorkedCall: () => false,
    JtcatSnrFloor: { floorFor: () => null, passes: () => true },
    jtcatIgnoreList: () => [], jtcatAutoSkipMin: () => 30, jtcatAutoSkip: new HuntFilters.AutoSkip(),
    jtcatHomeContinent: () => home,
    matchesAutoCqFilter: (t, m) => sm.matchesHuntFilter(t, m),
    parseCqMessage: (t) => JtcatParser.parseCq(t),
    jtcatHuntProgramMatch: () => true,
    jtcatSessionHas: () => false,
    JtcatTxSlot: { workableUnderLock: () => true }, jtcatTxSlotLock: () => 'auto',
  };
  vm.createContext(ctx);
  vm.runInContext(src + '\nthis.fn = jtcatWorkableCallers;', ctx);
  return ctx.fn(results, 'K3SBP', { filterMode: 'all' });
}
const calls = (out) => Array.from(out).map((d) => d.call).join(' ');

test('a CQ DX from my own continent is not for me; from another continent it is', () => {
  const out = workable('NA', [
    { text: 'CQ DX W5ABC EM12', continent: 'NA', db: -5 },
    { text: 'CQ DX DL2ABC JO62', continent: 'EU', db: -9 },
  ]);
  assert.strictEqual(calls(out), 'DL2ABC');
  assert.strictEqual(out.reasons.notForUs, 1);
});

test('CQ NA is only for North America; CQ EU only for Europe', () => {
  const res = [
    { text: 'CQ NA DL2ABC JO62', continent: 'EU', db: -9 },
    { text: 'CQ EU W5ABC EM12', continent: 'NA', db: -5 },
  ];
  assert.strictEqual(calls(workable('NA', res)), 'DL2ABC');
  assert.strictEqual(calls(workable('EU', res)), 'W5ABC');
});

test('a plain CQ, or an unknown continent, is answered as before', () => {
  assert.strictEqual(calls(workable('NA', [{ text: 'CQ W5ABC EM12', continent: 'NA', db: -5 }])), 'W5ABC');
  assert.strictEqual(calls(workable('', [{ text: 'CQ DX W5ABC EM12', continent: 'NA', db: -5 }])), 'W5ABC', 'no home continent');
  assert.strictEqual(calls(workable('NA', [{ text: 'CQ DX W5ABC EM12', db: -5 }])), 'W5ABC', 'no caller continent');
});

test('the status line names the CQs that were not calling us', () => {
  assert.ok(/notForUs: r\.notForUs \|\| 0,/.test(main));
  assert.ok(/1 not calling us \(CQ DX or another continent\)/.test(HuntFilters.quietReasonText({ heard: 1, notForUs: 1 })));
});

console.log(`\nHunt CQ DX rule: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
