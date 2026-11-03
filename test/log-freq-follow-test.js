#!/usr/bin/env node
'use strict';
// The Log QSO form follows the radio (hoogskev 2026-10-31: the logger kept
// the frequency it opened with). Same rule as ECHOCAT Web's log sheet: held
// at the spot until the radio arrives within 500 Hz, then follows the dial;
// a typed frequency wins. Runs the real function from renderer/app.js.
// Run: node test/log-freq-follow-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const app = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

const start = app.indexOf('const logFreqFollow = {');
const end = app.indexOf("logFrequency.addEventListener('input'", start);
const src = app.slice(start, end);
function harness(open = true) {
  const ctx = { logDialog: { open }, logFrequency: { value: '14285.0' } };
  vm.createContext(ctx);
  vm.runInContext(src.replace('const logFreqFollow', 'var logFreqFollow') + '\nthis.f = logFreqFollowRadio; this.s = logFreqFollow;', ctx);
  return ctx;
}

test('held at the spot while the radio is still on its way', () => {
  const c = harness(); c.s.pinnedKhz = 14285.0;
  c.f(7074000);
  assert.strictEqual(c.logFrequency.value, '14285.0');
});
test('follows the dial once the radio has arrived', () => {
  const c = harness(); c.s.pinnedKhz = 14285.0;
  c.f(14285200);
  c.f(14287500);
  assert.strictEqual(c.logFrequency.value, '14287.5');
});
test('a typed frequency wins', () => {
  const c = harness(); c.s.pinnedKhz = 0; c.s.typed = true;
  c.f(14290000);
  assert.strictEqual(c.logFrequency.value, '14285.0');
});
test('nothing while the form is closed', () => {
  const c = harness(false);
  c.f(14290000);
  assert.strictEqual(c.logFrequency.value, '14285.0');
});
test('wired: CAT frequency, typing, and a reset on every open', () => {
  assert.ok(/window\.api\.onCatFrequency\(\(hz\) => \{ logFreqFollowRadio\(hz\); \}\);/.test(app));
  assert.ok(/logFrequency\.addEventListener\('input', \(\) => \{ logFreqFollow\.typed = true; \}\);/.test(app));
  const open = app.slice(app.indexOf('function openLogPopup(spot) {'), app.indexOf('function openLogPopup(spot) {') + 500);
  assert.ok(/logFreqFollow\.typed = false;/.test(open) && /logFreqFollow\.pinnedKhz = parseFloat\(spot\.frequency\)/.test(open));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
