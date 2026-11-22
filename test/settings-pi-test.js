#!/usr/bin/env node
'use strict';
// The π in the Settings footer (Casey 2026-11-11): it sits in a band of its
// own under Save / Cancel, never on the buttons, and its toggle turns the
// feature off the same way it turns it on.
// Run: node test/settings-pi-test.js
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const root = path.join(__dirname, '..');
const css = readSrc(path.join(root, 'renderer', 'styles.css'));
const app = readSrc(path.join(root, 'renderer', 'app.js'));

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

console.log('Settings π');

test('the footer keeps a band under the buttons, and the π sits in it', () => {
  const footer = (css.match(/^\.settings-footer \{[^}]*\}/m) || [''])[0];
  assert.ok(/padding-bottom: (1[6-9]|[2-9]\d)px;/.test(footer), 'room under Save / Cancel');
  const pi = (css.match(/\.pi-access \{[^}]*\}/) || [''])[0];
  assert.ok(/bottom: 0;/.test(pi) && /right: \d+px;/.test(pi) && !/right: -/.test(pi), 'inside the band, left of the resize grip');
});

test('the same toggle turns it on and off', () => {
  const i = app.indexOf("piAccessEl.addEventListener('click'");
  const fn = app.slice(i, app.indexOf('\n});', i));
  assert.ok(/const next = e\.altKey \? false : !ultracatUnlocked;/.test(fn));
  assert.ok(!/if \(ultracatUnlocked\) return;/.test(fn), 'no early return that stops it turning off');
  assert.ok(/applyUltracat\(next\);/.test(fn) && /saveSettings\(\{ ultracat: next \}\)/.test(fn));
});

test('this test is in the list CI runs', () => {
  assert.ok(readSrc(path.join(root, 'scripts', 'run-tests.js')).includes("'test/settings-pi-test.js'"));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
