#!/usr/bin/env node
'use strict';
// Hunt filters, piece 7 (docs/plan-jtcat-hunt-priorities.md): ECHOCAT. A
// device edits the filters with C2S jtcat-hunt-filters (Guest Pass refused),
// the shack advertises `hunt-filters`, jtcat-auto-cq-state carries the whole
// panel, the web client has a Filters sheet and the status line, and an older
// phone keeps working with `mode` alone.
// Run: node test/jtcat-hunt-echocat-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const EventEmitter = require('events');
const HuntFilters = require('../lib/jtcat-hunt-filters');
const JtcatSnrFloor = require('../lib/jtcat-snr-floor');
const Protocol = require('../lib/echocat-protocol');
const { isGuestAllowed } = require('../lib/guest-pass-authority');
const RemoteBridge = require('../lib/remote-bridge');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
}
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const main = read('main.js');
const server = read('lib/remote-server.js');
const web = read('renderer/remote.js');
const webHtml = read('renderer/remote.html');

function loadSetter(settings) {
  const start = main.indexOf('const JTCAT_HUNT_FILTER_KEYS = ');
  const end = main.indexOf('function broadcastAutoCqState() {');
  assert.ok(start > 0 && end > start);
  const ctx = {
    settings, HuntFilters, JtcatSnrFloor, jtcatPopoutWin: null, saved: 0, logs: [], broadcasts: 0,
    saveSettings() { ctx.saved++; }, sendCatLog(l) { ctx.logs.push(l); }, broadcastAutoCqState() { ctx.broadcasts++; },
  };
  const helpers = main.slice(main.indexOf('function jtcatIgnoreList('), main.indexOf('function jtcatHuntProgramMatch('));
  vm.createContext(ctx);
  vm.runInContext(helpers + main.slice(start, end) + '\nthis.apply = applyJtcatHuntFilters; this.state = jtcatHuntFiltersState;', ctx);
  return ctx;
}

test('a device edit is cleaned, saved, logged and re-sent to every surface', () => {
  const s = {};
  const ctx = loadSetter(s);
  assert.strictEqual(ctx.apply({
    targets: ['pota', 'bogus', 'dx', 'pota'], priority: 'farthest', hideBelowDb: '-40',
    ignoreCalls: ['k1abc', 'VE3*', 'not ok!'], autoSkipMin: 999, minDb: '-18 dB', minDbByBand: '20M -20; 6m=-12',
  }, 'remote'), true);
  assert.strictEqual(s.jtcatHuntTargets, 'pota,dx');
  assert.strictEqual(s.jtcatHuntPriority, 'farthest');
  assert.strictEqual(s.jtcatHideBelowDb, '-30', 'clamped');
  assert.strictEqual(s.jtcatIgnoreCalls, 'K1ABC,VE3*');
  assert.strictEqual(s.jtcatAutoSkipMin, 240);
  assert.strictEqual(s.jtcatHuntMinDb, '-18');
  assert.strictEqual(s.jtcatHuntMinDbByBand, '20m -20, 6m -12');
  assert.strictEqual(ctx.saved, 1);
  assert.strictEqual(ctx.broadcasts, 1);
  assert.ok(/Hunt filters changed \(.*\) by an ECHOCAT device/.test(ctx.logs[0]));
  assert.deepStrictEqual(JSON.parse(JSON.stringify(ctx.state())), {
    hideBelowDb: -30, ignoreCalls: ['K1ABC', 'VE3*'], autoSkipMin: 240, minDb: -18, minDbByBand: '20m -20, 6m -12',
  });
});

test('null turns hide-below and the minimum off; an empty target list changes nothing; an empty message is ignored', () => {
  const s = { jtcatHideBelowDb: '-10', jtcatHuntMinDb: '-20', jtcatHuntTargets: 'pota,dx' };
  const ctx = loadSetter(s);
  ctx.apply({ hideBelowDb: null, minDb: null, targets: [] }, 'remote');
  assert.strictEqual(s.jtcatHideBelowDb, '');
  assert.strictEqual(s.jtcatHuntMinDb, '');
  assert.strictEqual(s.jtcatHuntTargets, 'pota,dx');
  assert.strictEqual(ctx.apply({}, 'remote'), false);
  assert.strictEqual(ctx.saved, 1);
});

test('the server passes the fields through, refuses a Guest Pass, and advertises hunt-filters', () => {
  const at = server.indexOf("case 'jtcat-hunt-filters':");
  const block = server.slice(at, server.indexOf("case 'jtcat-set-pref':", at));
  assert.ok(/if \(ws\._passSession\) break;/.test(block));
  assert.ok(/this\.emit\('jtcat-hunt-filters'/.test(block));
  assert.strictEqual(isGuestAllowed('jtcat-hunt-filters'), false);
  assert.ok(/'hunt-filters',/.test(server));
  assert.ok(Protocol.MESSAGES['jtcat-hunt-filters'], 'registered');
  assert.ok(/targets: msg\.targets, priority: msg\.priority, hideBelowDb: msg\.hideBelowDb,/.test(block));
  assert.ok(/remoteServer\.on\('jtcat-hunt-filters', \(msg = \{\}\) => applyJtcatHuntFilters\(msg, 'remote'\)\);/.test(main));
});

test('the state carries the whole panel, and an older phone still reads `mode`', () => {
  const f = main.slice(main.indexOf('function jtcatAutoCqStatePayload('), main.indexOf('function jtcatAutoCqStatePayload(') + 1500);
  assert.ok(/filters: jtcatHuntFiltersState\(\),/.test(f));
  assert.ok(/mode: chosen === 'custom' \? targets\[0\] : chosen,/.test(f));
  // The old C2S shape is untouched: a bare mode string.
  assert.ok(/case 'jtcat-auto-cq-mode':\s*\n\s*this\.emit\('jtcat-auto-cq-mode', \{ mode: msg\.mode \|\| 'off' \}\);/.test(server));
});

test('a laptop driving the shack carries priority and hide-below too', () => {
  assert.strictEqual(RemoteBridge.JTCAT_PREFS.jtcatHuntPriority, 'string');
  assert.strictEqual(RemoteBridge.JTCAT_PREFS.jtcatHideBelowDb, 'string');
});

test('ECHOCAT Web: Custom, the Filters sheet, the status line and hide-below', () => {
  assert.ok(/<option value="custom"[^>]*>Custom<\/option>/.test(webHtml));
  assert.ok(/id="ft8-hunt-filters-btn" class="ft8-ctrl-btn ft8-hf-btn hidden"/.test(webHtml), 'hidden until a shack that knows the filters answers');
  for (const id of ['ft8-hf-targets', 'ft8-hf-priority', 'ft8-hf-min-db', 'ft8-hf-min-db-band', 'ft8-hf-skip-on', 'ft8-hf-ignore', 'ft8-hf-hide-on', 'ft8-hunt-status']) {
    assert.ok(webHtml.includes('id="' + id + '"'), id);
  }
  assert.ok(/if \(!Array\.isArray\(msg\.targets\)\) return; \/\/ an older shack: no Filters/.test(web));
  assert.ok(/const send = \(patch\) => ft8Send\(Object\.assign\(\{ type: 'jtcat-hunt-filters' \}, patch\)\);/.test(web));
  assert.ok(/const chosenHunt = msg\.huntMode \|\| msg\.mode \|\| 'off';/.test(web));
  assert.ok(/case 'jtcat-hunt-status': \{/.test(web));
  assert.ok(/if \(ft8HideBelowDb != null && !isDirected && !isQsoPartner && typeof d\.db === 'number' && d\.db < ft8HideBelowDb\) return;/.test(web));
});

console.log(`\nHunt filters over ECHOCAT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
