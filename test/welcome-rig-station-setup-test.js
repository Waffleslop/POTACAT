#!/usr/bin/env node
'use strict';
// Saving a new radio in Settings opens its Station Setup checklist. Saving a
// radio from the Welcome window and pressing Get Started did not. It must open
// once Welcome has closed, never on top of it.
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
console.log('Welcome rig opens Station Setup');
const app = R('renderer/app.js');
const a = app.indexOf("document.getElementById('welcome-start').addEventListener('click'");
const handler = app.slice(a, app.indexOf('// ─── Welcome → Connect to a Remote Shack', a));

test('the Get Started handler was found', () => assert.ok(a > 0 && handler.length > 500));
test('Station Setup opens for the Welcome rig', () => {
  assert.ok(/openStationSetup\(welcomeRig\.id\)/.test(handler));
});
test('only when a rig was added in Welcome, not the existing one a reopened Welcome shows', () => {
  assert.ok(/if \(welcomeRig && welcomeRigIsNew && typeof window\.openStationSetup === 'function'\)/.test(handler));
  const add = app.slice(app.indexOf("getElementById('welcome-rig-save-btn').addEventListener('click'"));
  assert.ok(/welcomeRig = \{ id: 'rig_' \+ Date\.now\(\), name, catTarget \};\n\s*welcomeRigIsNew = true;/.test(add), 'adding a radio marks it new');
  const reset = app.slice(app.indexOf('// Reset welcome rig state'));
  assert.ok(/welcomeRig = null;\n\s*welcomeRigIsNew = false;/.test(reset), 'reopening Welcome clears it');
  const shown = reset.slice(0, reset.indexOf('welcomeDialog.showModal()'));
  assert.ok(/welcomeRig = activeRig;/.test(shown) && !/welcomeRigIsNew = true/.test(shown), 'the existing radio is not new');
});
test('after the settings save and after Welcome closes', () => {
  const save = handler.indexOf('await window.api.saveSettings(saveData)');
  const close = handler.indexOf('welcomeDialog.close()');
  const open = handler.indexOf('openStationSetup(welcomeRig.id)');
  assert.ok(save > 0 && close > save && open > close, 'order: save, close, open');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
