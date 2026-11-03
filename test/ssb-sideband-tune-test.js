#!/usr/bin/env node
'use strict';
// A spot's SSB becomes LSB or USB by the band plan in tuneRadio, before any
// codec sees it, and 60 m is USB by rule: the bare 10 MHz split there sent a
// 60 m SSB spot to the radio as LSB.
// Run: node test/ssb-sideband-tune-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { ssbSideband } = require('../lib/rig-utils');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
console.log('SSB sideband on a tune');
test('the band plan: 160/80/40 LSB, 60 m USB, 20 m and up USB', () => {
  assert.strictEqual(ssbSideband(1900000), 'LSB');
  assert.strictEqual(ssbSideband(3850000), 'LSB');
  assert.strictEqual(ssbSideband(5357000), 'USB');
  assert.strictEqual(ssbSideband(7200000), 'LSB');
  assert.strictEqual(ssbSideband(14250000), 'USB');
  assert.strictEqual(ssbSideband(28400000), 'USB');
});
test('tuneRadio resolves SSB with that rule, not a bare 10 MHz split', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.ok(/const resolvedMode = \(mode \|\| ''\)\.toUpperCase\(\) === 'SSB' \? require\('\.\/lib\/rig-utils'\)\.ssbSideband\(tuneFreqHz\) : mode;/.test(main));
  assert.ok(!/const resolvedMode = \(mode \|\| ''\)\.toUpperCase\(\) === 'SSB' \? \(tuneFreqHz >= 10000000/.test(main));
});
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
