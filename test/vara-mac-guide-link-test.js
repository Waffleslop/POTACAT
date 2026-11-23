#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
/**
 * On macOS, Settings > Station > Winlink shows "Running VARA on a Mac?" beside
 * Use VARA HF, linking to potacat.com/guides/vara-on-mac/ and opening in the
 * browser (Casey, 2026-11-22). Hidden on Windows and Linux.
 *
 * Run: node test/vara-mac-guide-link-test.js
 */
const assert = require('assert');
const path = require('path');
let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
const rd = (p) => readSrc(path.join(__dirname, '..', p)).replace(/\r\n/g, '\n');
const html = rd('renderer/index.html');
const app = rd('renderer/app.js');
const main = rd('main.js');

test('the link sits right after Use VARA HF, hidden by default, opening in the browser', () => {
  assert.ok(/id="set-vara-hf-enable"> Use VARA HF<\/label>\n\s*<a class="vara-mac-only hidden" id="vara-mac-guide" href="https:\/\/potacat\.com\/guides\/vara-on-mac\/" data-external[^>]*>Running VARA on a Mac\?<\/a>/.test(html));
});
test('shown only on macOS', () => {
  assert.ok(/querySelectorAll\('\.vara-mac-only'\)\.forEach\(\(el\) => el\.classList\.toggle\('hidden', window\.api\.platform !== 'darwin'\)\)/.test(app));
});
test('potacat.com is on the open-external allowlist', () => {
  assert.ok(main.includes("'https://potacat.com/'"));
});
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
