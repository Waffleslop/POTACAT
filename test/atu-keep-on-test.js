#!/usr/bin/env node
'use strict';
// KF0HOG (FT-710 + mAT-30, 2026-10-20): the radio runs the tune on AC003;
// and then switches the external tuner OFF; he had to press TUNE on the
// radio every time. Per-rig "Keep the tuner on after a tune cycle": watch
// `AC;` and send AC001; when the radio reports the tuner off.
// Run: node test/atu-keep-on-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { parseAcReply, decideAtuKeepOn, ATU_KEEP_ON_TIMEOUT_MS } = require('../lib/atu-keep-on');

const R = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n');
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
console.log('ATU keep-on');

test('AC; replies: 0 off, 1 on, 2 tuning, anything else unknown', () => {
  assert.strictEqual(parseAcReply('AC000;'), 'off');
  assert.strictEqual(parseAcReply('AC001;'), 'on');
  assert.strictEqual(parseAcReply('AC002;'), 'tuning');
  assert.strictEqual(parseAcReply('AC003'), 'unknown');
  assert.strictEqual(parseAcReply('?;'), 'unknown');
  assert.strictEqual(parseAcReply(null), 'unknown');
});

test('decision: send AC001 only on OFF; keep polling while on, tuning or unreadable; stop at 20 s', () => {
  assert.strictEqual(decideAtuKeepOn({ reply: 'AC000;', elapsedMs: 3000 }).action, 'send-on');
  assert.strictEqual(decideAtuKeepOn({ reply: 'AC001;', elapsedMs: 3000 }).action, 'poll', 'ON mid-cycle is not the end — the OFF comes when the cycle completes');
  assert.strictEqual(decideAtuKeepOn({ reply: 'AC001;', elapsedMs: ATU_KEEP_ON_TIMEOUT_MS }).action, 'done');
  assert.strictEqual(decideAtuKeepOn({ reply: 'AC002;', elapsedMs: 3000 }).action, 'poll');
  assert.strictEqual(decideAtuKeepOn({ reply: null, elapsedMs: 3000 }).action, 'poll', 'a muted radio mid-tune is not a reason to stop');
  assert.strictEqual(decideAtuKeepOn({ reply: 'AC002;', elapsedMs: ATU_KEEP_ON_TIMEOUT_MS }).action, 'give-up');
  assert.strictEqual(decideAtuKeepOn({ reply: null, elapsedMs: ATU_KEEP_ON_TIMEOUT_MS + 1 }).action, 'give-up');
  assert.strictEqual(decideAtuKeepOn({ reply: 'AC000;', elapsedMs: ATU_KEEP_ON_TIMEOUT_MS + 1 }).action, 'send-on', 'an OFF that arrives late is still acted on');
});

test('main.js arms the watcher after the CAT tune, gated on the rig setting, sending through setAtuEnabled', () => {
  const main = R('main.js');
  assert.ok(/cat\.startTune\(\);\n\s*armAtuKeepOn\(rig\);/.test(main), 'armed right after startTune in atu-tune');
  const fn = main.slice(main.indexOf('function armAtuKeepOn('), main.indexOf('\n}\n', main.indexOf('function armAtuKeepOn(')));
  assert.ok(/if \(!rig \|\| !rig\.atuKeepOn\) return;/.test(fn), 'off by default');
  assert.ok(/cat\.queryRaw\('AC;'/.test(fn) && /cat\.setAtuEnabled\(true\)/.test(fn), 'polls AC; and enables through the controller');
  assert.ok(/if \(cat !== rigCat \|\| !cat \|\| !cat\.connected\) return;/.test(fn), 'a rig switch mid-watch ends it');
});

test('rig editor: checkbox saved and restored on both the edit and the new-rig path', () => {
  const html = R('renderer/index.html'), app = R('renderer/app.js');
  assert.ok(/id="set-atu-keep-on"/.test(html));
  assert.ok(/atuKeepOnEl\.checked = !!rig\.atuKeepOn;/.test(app), 'populate');
  assert.ok(/rig\.atuKeepOn = rigAtuKeepOn;/.test(app), 'edit save');
  assert.ok(/atuKeepOn: rigAtuKeepOn,/.test(app), 'new-rig save');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
