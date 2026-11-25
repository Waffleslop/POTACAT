#!/usr/bin/env node
'use strict';
// After pairing to a remote shack from the Welcome window the status text said
// "Click Save to finish", but the window's button is "Get Started". The text
// must name the real button.
// Run: node test/welcome-pair-text-test.js
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const R = (f) => readSrc(path.join(__dirname, '..', f)).replace(/\r\n/g, '\n');
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
console.log('Welcome pairing text');
const app = R('renderer/app.js'), html = R('renderer/index.html');
const start = app.indexOf('// ─── Welcome → Connect to a Remote Shack');
const block = app.slice(start, app.indexOf('async function checkFirstRun(', start));

test('the Welcome button is labelled Get Started', () => {
  assert.ok(/id="welcome-start"[^>]*>Get Started</.test(html));
});
test('the pairing block was found', () => {
  assert.ok(start > 0 && block.length > 1000);
});
test('no pairing text tells the operator to click Save', () => {
  assert.ok(!/Click Save/.test(block), 'Click Save found in the Welcome pairing flow');
});
test('every success text names Get Started', () => {
  const lines = block.split('\n').filter(l => /_welcomeRemoteStatus\([^)]*Paired with/.test(l));
  assert.ok(lines.length >= 3, 'expected 3 paired texts, found ' + lines.length);
  for (const l of lines) assert.ok(/Get Started/.test(l), l.trim());
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
