#!/usr/bin/env node
'use strict';
// The activator quick log's "their park" box takes a comma list (an n-fer).
// WD3D 2026-10-26: "US-1234, US-5678" for a 2-fer logged the QSO with NO park,
// silently — the box only ever read one reference. Now every reference becomes
// a hunted entry (logContact makes one record per park) and a token that is not
// a reference refuses the log with a reason instead of being dropped.
// Run: node test/activator-hunter-parks-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
const fnSrc = (src.match(/function parseHunterParkInput[\s\S]*?\n\}\n/) || [])[0];
const parse = new Function(fnSrc + ';return parseHunterParkInput;')();
const logFn = (src.match(/async function activatorLogContact\(\)[\s\S]*?\n\}\n/) || [''])[0];

console.log('Activator: their parks');
test('a comma list is every park, upper-cased, deduped', () => {
  assert.deepStrictEqual(parse('us-1234, US-5678,US-1234'), { refs: ['US-1234', 'US-5678'], bad: [] });
  assert.deepStrictEqual(parse('K-0001 K-0002').refs, ['K-0001', 'K-0002'], 'spaces separate too');
});
test('summits and bunkers are references', () => {
  assert.deepStrictEqual(parse('W4C/CM-001, B/US-1234').refs, ['W4C/CM-001', 'B/US-1234']);
});
test('a token that is not a reference is reported, not dropped', () => {
  assert.deepStrictEqual(parse('US-1234, Shenandoah').bad, ['SHENANDOAH']);
});
test('the log path refuses on a bad token and builds hunterParkRefs from the list', () => {
  assert.ok(/parseHunterParkInput\(hunterInput\.value\)/.test(logFn), 'the typed box is parsed at log time');
  assert.ok(/if \(parsed\.bad\.length\) \{[\s\S]{0,400}return;/.test(logFn), 'a bad token stops the log');
  assert.ok(/parsed\.refs\.length > 1 \|\| hunterParkRefs\.length === 0/.test(logFn), 'a list replaces a single dropdown pick');
  assert.ok(/hunted: hunterParkRefs\.map/.test(logFn), 'every park reaches logContact as hunted');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
