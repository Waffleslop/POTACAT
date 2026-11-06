#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
// og3e (activator mode, Mac, 2026-11-04): WWFF and SOTA references showed
// "Not in parks DB … check for typos", and the text ran under the grid box.
// Only POTA's park lists are loaded, so only POTA references are checked.
// Run: node test/park-db-check-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { checkable } = require('../lib/park-db-check');
const { normalizeParkRefs } = require('../lib/activation-program');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
}
const read = (f) => readSrc(path.join(__dirname, '..', f));

test('og3e\'s WWFF and SOTA references are never judged against the parks list; a POTA one still is', () => {
  const refs = normalizeParkRefs([{ ref: 'OHFF-0001', name: '' }, { ref: 'OH/KS-001', name: '' }, { ref: 'US-1234', name: '' }]);
  assert.deepStrictEqual(refs.map(checkable), [false, false, true]);
});

test('no program = POTA, as everywhere else', () => {
  assert.strictEqual(checkable({ ref: 'US-1234' }), true);
  assert.strictEqual(checkable(null), true);
  assert.strictEqual(checkable({ ref: 'X', program: 'llota' }), false);
});

test('the activator marks a missing reference unknown only when it is checkable', () => {
  const app = read('renderer/app.js');
  const f = app.slice(app.indexOf('function finalizeCommaSeparatedParks() {'), app.indexOf('if (activatorParkRefs.length === 1) {', app.indexOf('function finalizeCommaSeparatedParks() {')));
  assert.ok(/const checkable = ParkDbCheck\.checkable\(park\);/.test(f));
  assert.ok(/park\.unknown = checkable;/.test(f));
  assert.ok(!/park\.unknown = true;/.test(f), 'no unconditional flag left');
  assert.ok(/activatorParkNameEl\.title = msg;/.test(f), 'the full warning is in a tooltip');
  assert.ok(/<script src="\.\.\/lib\/park-db-check\.js"><\/script>/.test(read('renderer/index.html')));
});

test('the park name shrinks in the toolbar instead of running under the grid box', () => {
  const css = read('renderer/styles.css');
  const rule = css.slice(css.indexOf('.activator-park-name {'), css.indexOf('}', css.indexOf('.activator-park-name {')));
  assert.ok(/min-width: 0;/.test(rule) && /flex: 0 1 auto;/.test(rule) && /text-overflow: ellipsis;/.test(rule));
});

console.log(`\nPark DB check: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
