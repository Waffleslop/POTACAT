#!/usr/bin/env node
'use strict';
// Contests view (2026-09-26 rework): titled "Contests", one aligned row per
// contest, "Later" split by month, and a Modes filter where a contest shows
// when ANY of its modes is ticked. Run: node test/contests-view-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'renderer', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');

function extract(name) {
  const start = app.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name + ' missing');
  let i = app.indexOf('{', start), depth = 0;
  for (; i < app.length; i++) {
    if (app[i] === '{') depth++;
    else if (app[i] === '}' && --depth === 0) break;
  }
  return app.slice(start, i + 1);
}
// eslint-disable-next-line no-new-func
const { fam, visible } = new Function(extract('_contestsModeFamily') + '\n' + extract('_contestsModeVisible') +
  '\nreturn { fam: _contestsModeFamily, visible: _contestsModeVisible };')();
const noCw = { cw: false, phone: true, digital: true };

console.log('contests view');

test('mode families', () => {
  assert.strictEqual(fam('CW'), 'cw');
  assert.strictEqual(fam('SSB'), 'phone');
  for (const m of ['RTTY', 'FT8', 'FT4', 'PSK', 'DIGITAL']) assert.strictEqual(fam(m), 'digital', m);
  assert.strictEqual(fam('any'), null);
});

test('CW-only contests hide for a non-CW operator; mixed and "any" stay', () => {
  assert.strictEqual(visible({ modes: ['CW'] }, noCw), false);
  assert.strictEqual(visible({ modes: ['CW', 'SSB'] }, noCw), true);
  assert.strictEqual(visible({ modes: ['any'] }, { cw: false, phone: false, digital: false }), true);
  assert.strictEqual(visible({ modes: [] }, noCw), true);
  assert.strictEqual(visible({ modes: ['RTTY'] }, { cw: true, phone: true, digital: false }), false);
});

test('the view is titled Contests and has the Modes filter', () => {
  assert.ok(!/<h2>What's Next<\/h2>/.test(html), 'old "What\'s Next" title is back');
  assert.ok(/<h2>Contests<\/h2>/.test(html));
  assert.ok(html.includes('id="contests-mode-filter"'));
  assert.ok(/modeFilter = _contestsModeFilter\(\)/.test(app) && /_contestsModeVisible\(c, modeFilter\)/.test(app));
});

test('"Later" is split into month sections', () => {
  assert.ok(/key === 'later' && r\._status\.start/.test(app));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
