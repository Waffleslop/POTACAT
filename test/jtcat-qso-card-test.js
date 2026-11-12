#!/usr/bin/env node
'use strict';
// JTCAT's "QSO logged" is a card in the middle of the pop-out (Casey
// 2026-11-11: the toast at the bottom was hard to see), in theme colours only,
// and never steals focus from the decode list. Errors and warnings stay on
// the bottom toast so a logged QSO never looks like one.
// Run: node test/jtcat-qso-card-test.js
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const root = path.join(__dirname, '..');
const html = readSrc(path.join(root, 'renderer', 'jtcat-popout.html'));
const js = readSrc(path.join(root, 'renderer', 'jtcat-popout.js'));

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

console.log('JTCAT QSO logged card');

test('a logged QSO shows the card, not the bottom toast', () => {
  const i = js.indexOf('window.api.onJtcatQsoLogged(');
  const f = js.slice(i, js.indexOf('});', i));
  assert.ok(/qsoCard\.classList\.add\('visible'\)/.test(f));
  assert.ok(!/qsoToast/.test(f), 'the toast is for errors and warnings');
  assert.ok(/textContent = data\.callsign/.test(f), 'the callsign is text, never HTML');
  assert.ok(/setTimeout\(hideQsoCard, 6000\)/.test(f));
});

test('centred, theme colours only', () => {
  const rules = html.match(/\.jp-qso-card[^{]*\{[^}]*\}/g) || [];
  assert.ok(rules.length >= 8, 'card rules found');
  assert.ok(/\.jp-qso-card \{[^}]*left: 50%; top: 46%; transform: translate\(-50%, -46%\)/.test(html));
  for (const r of rules) assert.ok(!/#[0-9a-f]{3,8}\b/i.test(r), 'a hard-coded colour: ' + r.slice(0, 60));
  assert.ok(/background: var\(--bg-secondary\)/.test(rules.join('')) && /var\(--accent-green\)/.test(rules.join('')));
});

test('never takes focus; Edit in log and OK', () => {
  assert.ok(/<button type="button" id="jp-qso-card-edit" tabindex="-1">Edit in log<\/button>/.test(html));
  assert.ok(/<button type="button" id="jp-qso-card-ok" class="jp-qso-card-ok" tabindex="-1">OK<\/button>/.test(html));
  assert.ok(!/qsoCard[^;\n]*\.focus\(/.test(js));
  assert.ok(/jp-qso-card-edit'\)\.addEventListener\('click', function\(\) \{ hideQsoCard\(\); window\.api\.focusMain\(\); \}\)/.test(js));
});

test('this test is in the list CI runs', () => {
  assert.ok(readSrc(path.join(root, 'scripts', 'run-tests.js')).includes("'test/jtcat-qso-card-test.js'"));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
