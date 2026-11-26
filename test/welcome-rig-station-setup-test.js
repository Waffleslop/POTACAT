#!/usr/bin/env node
'use strict';
// A radio set up from the first run must get its Station Setup checklist, once
// the Welcome has closed, never on top of it (#1070 / #1076).
//
// A shorter first run (2026-11-26) replaced the Welcome rig editor: "Where is
// your radio?" > Here closes the Welcome and opens the full Settings rig editor,
// whose save opens Station Setup for a new radio (saveRigEditor). #1076's rule
// (only a radio added now, not an existing one shown on reopen) holds there:
// only a new radio sets _stationSetupOpenAfterSave.
// Run: node test/welcome-rig-station-setup-test.js
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const R = (f) => readSrc(path.join(__dirname, '..', f)).replace(/\r\n/g, '\n');
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
console.log('First-run radio opens Station Setup');
const app = R('renderer/app.js');
const html = R('renderer/index.html');
const a = app.indexOf('async function welcomeChooseWhere(');
const choose = app.slice(a, app.indexOf('\n}\n', a));

test('the Welcome has one rig editor: the Settings one', () => {
  assert.ok(!/welcome-rig-editor|welcome-radio-type|welcome-rig-save-btn/.test(html));
  assert.ok(!/welcomeRigIsNew|showWelcomeRigItem/.test(app));
});
test('Here closes the Welcome first, then opens Settings > Radio and Add', () => {
  assert.ok(a > 0 && choose.length > 200, 'welcomeChooseWhere found');
  const close = choose.indexOf('welcomeCloseFlow()');
  const open = choose.indexOf("await openSettingsDialog('radio')");
  const add = choose.indexOf("openRigEditor('add')");
  assert.ok(close > 0 && open > close && add > open, 'order: close the Welcome, open Settings, Add');
  assert.ok(/if \(r\.action === 'rig-editor'\)/.test(choose));
  assert.ok(/if \(!\(s\.rigs \|\| \[\]\)\.length\) openRigEditor\('add'\);/.test(choose), 'Add only when there is no radio yet');
});
test('saving a new radio in that editor opens its Station Setup, after the save', () => {
  const s = app.slice(app.indexOf('    currentRigs.push(newRig);'));
  assert.ok(/currentRigs\.push\(newRig\);\n\s*_stationSetupOpenAfterSave = newRig\.id;/.test(s), 'only a new radio is marked');
  assert.ok(/Promise\.resolve\(_ssSave\)\.then\(\(\) => window\.openStationSetup\(newId\)\)/.test(s), 'opens after the save');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
