#!/usr/bin/env node
'use strict';
// Hunt filters, piece 4 (docs/plan-jtcat-hunt-priorities.md): Hunt: Custom
// answers a station matching ANY ticked target (kilrath8954: POTA + new
// countries + watchlist at once), and the Hunt minimum dB moves from Options
// into the Filters panel (Casey's answer 8). Older phones see the first
// ticked target in `mode`.
// Run: node test/jtcat-hunt-custom-test.js
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

// Run main's own jtcatHuntTargets + jtcatHuntProgramMatch with the one-target
// match stubbed, so the ANY rule is exercised, not just looked at.
function loadMatch(settings, oneMatches) {
  const start = main.indexOf('function jtcatHuntTargets(');
  const end = main.indexOf('function jtcatHuntProgramMatchOne(');
  assert.ok(start > 0 && end > start, 'jtcatHuntTargets and jtcatHuntProgramMatch sit before the one-target match');
  const asked = [];
  const ctx = { settings, HuntFilters, asked, jtcatHuntProgramMatchOne: (d, t) => { asked.push(t); return oneMatches(d, t); } };
  vm.createContext(ctx);
  vm.runInContext(main.slice(start, end) + '\nthis.match = jtcatHuntProgramMatch; this.targets = jtcatHuntTargets;', ctx);
  return ctx;
}

test('Custom answers a station that matches any ticked target, and nothing else', () => {
  const ctx = loadMatch({ jtcatHuntTargets: 'pota,wanted-country,watchlist' }, (d, t) => d.is.includes(t));
  assert.strictEqual(ctx.match({ is: ['watchlist'] }, 'custom'), true);
  assert.strictEqual(ctx.match({ is: ['pota'] }, 'custom'), true);
  assert.strictEqual(ctx.match({ is: ['sota', 'dx'] }, 'custom'), false);
  assert.deepStrictEqual(Array.from(ctx.targets()), ['pota', 'wanted-country', 'watchlist']);
});

test('a single target still asks only that target; an empty Custom list means POTA', () => {
  const ctx = loadMatch({ jtcatHuntTargets: '' }, () => false);
  ctx.match({}, 'sota');
  assert.deepStrictEqual(Array.from(ctx.asked), ['sota']);
  assert.deepStrictEqual(Array.from(ctx.targets()), ['pota']);
  const junk = loadMatch({ jtcatHuntTargets: 'nonsense, dx ,dx' }, () => false);
  assert.deepStrictEqual(Array.from(junk.targets()), ['dx'], 'unknown and repeated targets dropped');
});

test('the state tells an older phone the first target, and a new one the whole choice', () => {
  const f = main.slice(main.indexOf('function jtcatAutoCqStatePayload('), main.indexOf('function jtcatAutoCqStatePayload(') + 1500);
  assert.ok(/mode: chosen === 'custom' \? targets\[0\] : chosen,/.test(f));
  assert.ok(/huntMode: chosen,/.test(f) && /\btargets,/.test(f) && /priority: HuntFilters\.normalizePriority\(settings\.jtcatHuntPriority\),/.test(f));
});

test('a saved filter change re-sends the state, here and from a laptop driving the shack', () => {
  assert.ok(/const JTCAT_HUNT_FILTER_KEYS = \['jtcatHuntTargets', 'jtcatHuntPriority', 'jtcatHideBelowDb', 'jtcatHuntMinDb', 'jtcatHuntMinDbByBand'\];/.test(main));
  assert.ok(/if \(newSettings && JTCAT_HUNT_FILTER_KEYS\.some\(\(k\) => k in newSettings\)\) setImmediate\(broadcastAutoCqState\);/.test(main));
  assert.ok(/if \(JTCAT_HUNT_FILTER_KEYS\.includes\(key\)\) broadcastAutoCqState\(\);/.test(main));
  assert.strictEqual(RemoteBridge.JTCAT_PREFS.jtcatHuntTargets, 'string');
  assert.strictEqual(RemoteBridge.acceptPref('jtcatHuntTargets', 'pota,dx'), 'pota,dx');
});

test('the FT8 window offers Custom, ticks targets in the Filters panel, and reads huntMode before mode', () => {
  assert.ok(/<option value="custom"[^>]*>Hunt: Custom<\/option>/.test(html));
  assert.ok(/<div id="jp-hunt-targets" class="jp-hf-targets" role="group" aria-label="Hunt targets"><\/div>/.test(html));
  assert.ok(/var chosen = state\.huntMode \|\| state\.mode \|\| 'off';/.test(pop));
  assert.ok(/'Custom \(' \+ huntTargets\.length \+ '\)'/.test(pop), 'the picker says how many targets');
  assert.ok(/var next = set\.length === 1 \? set\[0\] : 'custom';/.test(pop), 'two ticks make Custom, one tick is that target');
  assert.ok(/if \(!set\.length\) \{ e\.target\.checked = true; return; \}/.test(pop), 'the last box stays ticked');
  assert.ok(/window\.api\.saveSettings\(\{ jtcatHuntTargets: set\.join\(','\) \}\);/.test(pop));
});

test('the Hunt minimum dB lives in the Filters panel, not in Options', () => {
  const filters = html.slice(html.indexOf('<div id="jp-hunt-filters-pop"'), html.indexOf('<div id="jp-options-pop"'));
  const options = html.slice(html.indexOf('<div id="jp-options-pop"'));
  for (const id of ['jp-hunt-min-db', 'jp-hunt-min-db-band', 'jp-hunt-min-db-band-help']) {
    assert.ok(filters.includes('id="' + id + '"'), id + ' in Filters');
    assert.ok(!options.includes('id="' + id + '"'), id + ' gone from Options');
  }
});

console.log(`\nHunt custom targets: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
