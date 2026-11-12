#!/usr/bin/env node
'use strict';
// A radio Winlink session keeps POTACAT awake (#187, docs/ardop-macos-plan.md
// L4): macOS App Nap starved the hidden bridge window's capture for up to
// 751 ms (1.2% of the audio lost) on a Mac runner. The power-save blocker is
// taken when a radio session starts and released on every way out.
// Run: node test/winlink-awake-test.js
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const main = readSrc(path.join(__dirname, '..', 'main.js'));
let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log('  ok  ' + n); } catch (e) { fail++; console.log('  FAIL ' + n + '\n       ' + e.message); } };
const body = (name) => { const i = main.indexOf('function ' + name + '('); assert.ok(i >= 0, name); return main.slice(i, main.indexOf('\nfunction ', i + 10)); };

console.log('Winlink keeps the app awake during a radio session (#187)');
t('held from the start of a radio session', () => {
  const s = body('winlinkStartSession');
  const hold = s.indexOf('if (radio) winlinkHoldAwake(true, mode);');
  assert.ok(hold > 0 && hold < s.indexOf("state: 'starting'"), 'before the session is announced');
});
t('released first thing at every session end, and at quit', () => {
  assert.ok(/function winlinkEndSession\([^)]*\) \{\n\s*winlinkHoldAwake\(false\);/.test(main.replace(/\r\n/g, '\n')), 'before any early return');
  assert.ok(/app\.on\('before-quit', \(e\) => \{\n\s*winlinkHoldAwake\(false\);/.test(main.replace(/\r\n/g, '\n')));
});
t('it is App Nap suspension that is blocked, once', () => {
  const s = body('winlinkHoldAwake');
  assert.ok(/powerSaveBlocker\.start\('prevent-app-suspension'\)/.test(s));
  assert.ok(/powerSaveBlocker\.isStarted\(_winlinkAwakeId\)/.test(s), 'never two blockers');
});
t('the bridge window is never throttled', () => {
  assert.ok(/modemBridgeWin = new BrowserWindow\(\{[\s\S]{0,400}backgroundThrottling: false/.test(main));
});
t('this test is in the list CI runs', () => {
  assert.ok(readSrc(path.join(__dirname, '..', 'scripts', 'run-tests.js')).includes("'test/winlink-awake-test.js'"));
});
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
