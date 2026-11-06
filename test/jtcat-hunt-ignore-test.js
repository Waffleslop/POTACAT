#!/usr/bin/env node
'use strict';
// Hunt filters, piece 5 (docs/plan-jtcat-hunt-priorities.md): "Never answer"
// (calls and PREFIX*, permanent until removed, right-click a decode to add)
// and auto-skip (a call whose QSO gave up is skipped 30 min on that band and
// mode; ON by default, Casey's answer 6).
// Run: node test/jtcat-hunt-ignore-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const HuntFilters = require('../lib/jtcat-hunt-filters');
const RemoteBridge = require('../lib/remote-bridge');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
}
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const main = read('main.js');
const html = read('renderer/jtcat-popout.html');
const pop = read('renderer/jtcat-popout.js');

function loadHelpers(settings) {
  const start = main.indexOf('function jtcatIgnoreList(');
  const end = main.indexOf('function jtcatHuntProgramMatch(');
  assert.ok(start > 0 && end > start, 'the helpers sit before the Hunt match');
  const ctx = { settings, HuntFilters };
  vm.createContext(ctx);
  vm.runInContext(main.slice(start, end) + '\nthis.ignore = jtcatIgnoreList; this.skipMin = jtcatAutoSkipMin; this.skip = jtcatAutoSkip;', ctx);
  return ctx;
}

test('Never answer reads calls and prefixes from the saved list', () => {
  const ctx = loadHelpers({ jtcatIgnoreCalls: 'k1abc, VE3*,bad entry!,K1ABC' });
  const list = Array.from(ctx.ignore());
  assert.deepStrictEqual(list, ['K1ABC', 'VE3*']);
  assert.strictEqual(HuntFilters.isIgnored('VE3XYZ', list), true);
  assert.strictEqual(HuntFilters.isIgnored('VE2XYZ', list), false);
});

test('auto-skip is 30 minutes when nothing is saved, 0 turns it off, and it expires', () => {
  assert.strictEqual(loadHelpers({}).skipMin(), 30, 'on by default');
  assert.strictEqual(loadHelpers({ jtcatAutoSkipMin: 0 }).skipMin(), 0);
  assert.strictEqual(loadHelpers({ jtcatAutoSkipMin: '45' }).skipMin(), 45);
  const ctx = loadHelpers({});
  ctx.skip.note('K1ABC', '20m', 'FT8', 0);
  assert.strictEqual(ctx.skip.has('K1ABC', '20m', 'FT8', 30, 29 * 60000), true);
  assert.strictEqual(ctx.skip.has('K1ABC', '40m', 'FT8', 30, 60000), false, 'another band is fresh');
  assert.strictEqual(ctx.skip.has('K1ABC', '20m', 'FT8', 30, 30 * 60000), false, 'expired');
});

test('Hunt counts ignored and skipped CQs, and the status line says so', () => {
  const f = main.slice(main.indexOf('function jtcatWorkableCallers('), main.indexOf('let _jtcatFloorNoteAt'));
  assert.ok(/if \(HuntFilters\.isIgnored\(d\.call, ignore\)\) \{ reasons\.ignored\+\+; return false; \}/.test(f));
  assert.ok(/if \(jtcatAutoSkip\.has\(d\.call, dupeBandMode\.band, dupeBandMode\.mode, skipMin\)\) \{ reasons\.skipped\+\+; return false; \}/.test(f));
  assert.ok(/ignored: r\.ignored \|\| 0, skipped: r\.skipped \|\| 0,/.test(main));
  assert.strictEqual(HuntFilters.quietReasonText({ heard: 3, ignored: 1, skipped: 2 }),
    'Hunt: 3 CQs heard, 1 ignored, 2 skipped after a failed QSO · nobody to answer this period');
});

test('a QSO that gives up at the tries cap puts its call on the skip list; a CQ never does', () => {
  const f = main.slice(main.indexOf('function jtcatHandleRetryStall('), main.indexOf('function jtcatQsoOwners('));
  const abort = f.slice(f.indexOf("outcome.action === 'abort'"));
  assert.ok(/if \(qso\.call && qso\.phase !== 'cq' && jtcatAutoSkipMin\(\) > 0\) \{/.test(abort));
  assert.ok(/jtcatAutoSkip\.note\(qso\.call, bm\.band, bm\.mode\);/.test(abort));
});

test('Never answer also covers stations calling me and Run\'s callers', () => {
  const direct = main.slice(main.indexOf('async function jtcatTryAnswerDirectCaller('), main.indexOf('async function jtcatTryAnswerDirectCaller(') + 2000);
  assert.ok(/!HuntFilters\.isIgnored\(parts\[1\], jtcatIgnoreList\(\)\)\)/.test(direct));
  assert.ok(/deps\.skipCall = \(call\) => jtcatIsWorkedCall\(call, band, mode\) \|\| HuntFilters\.isIgnored\(call, jtcatIgnoreList\(\)\);/.test(main));
});

test('both settings are per profile, bridged, and re-send the state', () => {
  assert.strictEqual(RemoteBridge.JTCAT_PREFS.jtcatIgnoreCalls, 'string');
  assert.strictEqual(RemoteBridge.JTCAT_PREFS.jtcatAutoSkipMin, 'number');
  assert.ok(/JTCAT_HUNT_FILTER_KEYS = \[[^\]]*'jtcatIgnoreCalls', 'jtcatAutoSkipMin'\]/.test(main));
});

test('the Filters panel lists and edits the calls; right-click on a decode adds or removes its station', () => {
  assert.ok(/id="jp-ignore-list"/.test(html) && /id="jp-ignore-add"/.test(html));
  assert.ok(/<input type="checkbox" id="jp-auto-skip-on" checked>/.test(html), 'auto-skip ticked by default');
  assert.ok(/row\.addEventListener\('contextmenu', \(function\(decode\) \{ return function\(e\) \{ openRowMenu\(e, decode\); \}; \}\)\(d\)\);/.test(pop));
  assert.ok(/'Never answer ' \+ call/.test(pop) && /'Answer ' \+ call \+ ' again'/.test(pop));
  assert.ok(/window\.api\.saveSettings\(\{ jtcatIgnoreCalls: ignoreCalls\.join\(','\) \}\);/.test(pop));
  assert.ok(/window\.api\.saveSettings\(\{ jtcatAutoSkipMin: on \? autoSkipMin : 0 \}\);/.test(pop));
  // The sender of a decode: the CQ's caller, else the second call.
  const start = pop.indexOf('  function senderCallOf(text) {');
  const end = pop.indexOf('  var rowMenu = ');
  const ctx = { JtcatParser: require('../renderer/jtcat-parser') };
  vm.createContext(ctx);
  vm.runInContext(pop.slice(start, end) + '\nthis.sender = senderCallOf;', ctx);
  assert.strictEqual(ctx.sender('CQ POTA K4ABC EM73'), 'K4ABC');
  assert.strictEqual(ctx.sender('W1AW K4ABC -12'), 'K4ABC');
  assert.strictEqual(ctx.sender('W1AW <PJ4/K1ABC> RR73'), 'PJ4/K1ABC');
});

console.log(`\nHunt never answer and auto-skip: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
