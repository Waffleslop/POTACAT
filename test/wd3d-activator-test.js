#!/usr/bin/env node
'use strict';
/**
 * WD3D's activation thread (Discord 2026-10-29): the toolbar buttons (Spot,
 * Export ADIF, Logbook, Settings) left the window at full screen with a large
 * text size, and a park-to-park click filled only one park of a two-fer.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
const app = fs.readFileSync(path.join(ROOT, 'renderer/app.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'renderer/styles.css'), 'utf8');

// Lift the pure helper out of app.js and run it as written.
const start = app.indexOf('function hunterParkRefsFromSpot(s) {');
const end = app.indexOf('\nfunction fillActivatorFromSpot(s) {');
assert.ok(start > 0 && end > start, 'hunterParkRefsFromSpot sits right before fillActivatorFromSpot');
const ctx = {};
vm.runInNewContext(app.slice(start, end) + '\nthis.fn = hunterParkRefsFromSpot;', ctx);
const refsFor = (spot) => JSON.parse(JSON.stringify(ctx.fn(spot)));   // out of the sandbox, so deepStrictEqual compares values

console.log('Park-to-park references from a spot');
check('a plain POTA spot: one park, with its name', () => {
  assert.deepStrictEqual(refsFor({ source: 'pota', reference: 'US-1234', parkName: 'Big Park' }), [{ ref: 'US-1234', name: 'Big Park', program: 'POTA' }]);
});
check('a two-fer (comma list in the primary field): both parks, POTA credit for each', () => {
  const r = refsFor({ source: 'pota', reference: 'US-1234, US-5678', parkName: 'Big Park' });
  assert.deepStrictEqual(r.map((x) => x.ref), ['US-1234', 'US-5678']);
  assert.ok(r.every((x) => x.program === 'POTA'));
});
check('an n-fer across programs: the other programs\' fields come too, primary first', () => {
  const r = refsFor({ source: 'pota', reference: 'US-1234', parkName: 'Big Park', wwffReference: 'KFF-0001', sotaReference: 'W4C/CM-001' });
  assert.deepStrictEqual(r.map((x) => x.program + ' ' + x.ref), ['POTA US-1234', 'WWFF KFF-0001', 'SOTA W4C/CM-001']);
});
check('a spot with no creditable reference fills nothing; duplicates collapse', () => {
  assert.deepStrictEqual(refsFor({ source: 'dxc', reference: '' }), []);
  assert.strictEqual(refsFor({ source: 'pota', reference: 'US-1,US-1' }).length, 1);
});
check('fillActivatorFromSpot uses it', () => {
  assert.ok(/hunterParkRefs = hunterParkRefsFromSpot\(s\);\s+updateHunterParkDisplay\(\);/.test(app));
});

console.log('The activator toolbar');
check('wraps instead of pushing its buttons off the window', () => {
  const block = css.slice(css.indexOf('.activator-toolbar {'), css.indexOf('}', css.indexOf('.activator-toolbar {')));
  assert.ok(/flex-wrap: wrap;/.test(block), 'flex-wrap on .activator-toolbar');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
