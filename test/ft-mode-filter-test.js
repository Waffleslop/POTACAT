#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
// Separate FT8 / FT4 / FT2 spot filters (jgedmond 2026-10-31): the desktop
// had one combined "FT8/4/2" entry, so an FT4 hunter could not hide FT8.
// A saved combined selection still means all three. The web list gains FT2.
// Run: node test/ft-mode-filter-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = (p) => readSrc(path.join(__dirname, '..', p));

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

const html = read('renderer/index.html');
const modeMenu = html.slice(html.indexOf('id="mode-filter"'), html.indexOf('</div>', html.indexOf('id="mode-filter"') + 200) + 400);
const app = read('renderer/app.js');

test('the desktop mode filter has FT8, FT4 and FT2 as their own entries', () => {
  for (const m of ['FT8', 'FT4', 'FT2']) assert.ok(modeMenu.includes(`<input type="checkbox" value="${m}"> ${m}</label>`), m);
  assert.ok(!modeMenu.includes('value="FT"'), 'no combined entry');
});
test('a saved combined "FT" restores as all three', () => {
  const at = app.indexOf("if (modeSet.has('FT')) {");
  assert.ok(at > 0);
  const body = app.slice(at, at + 200);
  for (const m of ['FT8', 'FT4', 'FT2']) assert.ok(body.includes(`modeSet.add('${m}')`), m);
});
test('a spot matches its own FT entry (exact mode), so FT4 alone hides FT8', () => {
  const fn = app.slice(app.indexOf('if (!spotMode) return false;'), app.indexOf('if (!spotMode) return false;') + 200);
  assert.ok(/if \(selectedModes\.has\(spotMode\)\) return true;/.test(fn));
});
test('ECHOCAT Web lists FT2 and classes FT2 spots as FT2', () => {
  assert.ok(read('renderer/remote.html').includes('<input type="checkbox" value="FT2"> FT2</label>'));
  assert.ok(/KNOWN_MODES = new Set\(\[[^\]]*'FT2'/.test(read('renderer/remote.js')));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
