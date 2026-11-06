#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
// Hunt filters, piece 1 (docs/plan-jtcat-hunt-priorities.md): the status line
// that says why Hunt is quiet, and "Hide decodes below N dB" (nj2dx: only see
// stations a compromise antenna can work). Display only: Hunt's own minimum
// is a separate setting.
// Run: node test/jtcat-hunt-status-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
}
const read = (f) => readSrc(path.join(__dirname, '..', f));
const main = read('main.js');
const pop = read('renderer/jtcat-popout.js');
const html = read('renderer/jtcat-popout.html');

test('every CQ is counted under the first reason it was not workable', () => {
  const f = main.slice(main.indexOf('function jtcatWorkableCallers('), main.indexOf('let _jtcatFloorNoteAt'));
  assert.ok(/const reasons = \{ heard: 0, [^}]*notTarget: 0, [^}]*worked: 0, [^}]*ownSlot: 0, below: 0[^}]*\};/.test(f));
  for (const r of ['heard++', 'notTarget++', 'worked++', 'ownSlot++', 'below++']) assert.ok(f.includes('reasons.' + r), r);
  assert.ok(/out\.reasons = reasons;/.test(f));
});

test('the status goes out each period Hunt picks, and is cleared when Hunt stops', () => {
  assert.ok(/if \(!answeredCaller\) jtcatHuntStatusPush\(candidates, best(, huntPriority)?\);/.test(main));
  const push = main.slice(main.indexOf('function jtcatHuntStatusPush('), main.indexOf('function jtcatHuntStatusClear('));
  assert.ok(/status\.text = HuntFilters\.quietReasonText\(status\);/.test(push));
  assert.ok(/'jtcat-hunt-status'/.test(push) && /type: 'jtcat-hunt-status'/.test(push), 'window and ECHOCAT');
  assert.ok(/function broadcastAutoCqState\(\) \{\n  if \(jtcatAutoCqMode === 'off' && !jtcatHuntFallbackMode\) jtcatHuntStatusClear\(\);/.test(main));
  assert.ok(/'jtcat-hunt-status': \{ dir: Dir\.S2C, feature: 'jtcat' \}/.test(read('lib/echocat-protocol.js')));
  assert.ok(/'jtcat-hunt-status': same\('jtcat-hunt-status'\)/.test(read('lib/remote-bridge.js')), 'a laptop driving a shack sees it too');
  assert.ok(/onJtcatHuntStatus: \(cb\) => ipcRenderer\.on\('jtcat-hunt-status'/.test(read('preload-jtcat-popout.js')));
});

test('the window shows the line and hides it when Hunt stops', () => {
  assert.ok(/<div id="jp-hunt-status" class="jp-hunt-status" hidden aria-live="polite"><\/div>/.test(html));
  assert.ok(/if \(!st \|\| st\.off \|\| !st\.text\) \{ huntStatusEl\.hidden = true;/.test(pop));
});

test('hide-below hides weak decodes but never a call to me, and the header counts what it hid', () => {
  const start = pop.indexOf('var hideBelowDb = null;');
  const end = pop.indexOf('function updateHiddenNote()');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(pop.slice(start, end) + '\nthis.set = function (v) { hideBelowDb = v; }; this.hidden = hiddenByLevel;', ctx);
  const c = (db, directed) => ({ d: { db }, isDirected: !!directed });
  assert.strictEqual(ctx.hidden(c(-20)), false, 'off by default: nothing hidden');
  ctx.set(-15);
  assert.strictEqual(ctx.hidden(c(-20)), true);
  assert.strictEqual(ctx.hidden(c(-15)), false, 'at the limit is shown');
  assert.strictEqual(ctx.hidden(c(-24, true)), false, 'a station calling me is never hidden');
  assert.strictEqual(ctx.hidden({ d: {}, isDirected: false }), false, 'no level: shown');
  const vis = pop.slice(pop.indexOf('function decodeVisible(c) {'), pop.indexOf('function decodeVisible(c) {') + 120);
  assert.ok(/if \(hiddenByLevel\(c\)\) return false;/.test(vis));
  assert.ok(/note\.textContent = n \? n \+ ' hidden below ' \+ hideBelowDb \+ ' dB' : '';/.test(pop));
  assert.ok(/<span id="jp-hidden-note" class="jp-hidden-note" hidden><\/span>/.test(html));
});

test('the Filters button sits in the Hunt box, with the dot for a non-default filter; the setting is saved', () => {
  const box = html.slice(html.indexOf('<div class="jp-hunt-box">'), html.indexOf('</div>', html.indexOf('<div class="jp-hunt-box">')));
  assert.ok(/id="jp-hunt-filters-btn"/.test(box) && /id="jp-hunt-filters-dot" class="jp-dot" hidden/.test(box));
  assert.ok(/window\.api\.saveSettings\(\{ jtcatHideBelowDb: hideBelowDb == null \? '' : String\(hideBelowDb\) \}\);/.test(pop));
  assert.ok(!/jtcatHideBelowDb: [^,}]*-?\d/.test(main.slice(main.indexOf('const DEFAULT_SETTINGS'), main.indexOf('const DEFAULT_SETTINGS') + 20000)), 'off by default');
});

console.log(`\nHunt status and hide-below: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
