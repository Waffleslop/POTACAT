#!/usr/bin/env node
'use strict';
// #687: ECHOCAT Web shows the shack's POTACAT version in Settings.
// Run: node test/shack-version-test.js
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const R = (f) => readSrc(path.join(__dirname, '..', f)).replace(/\r\n/g, '\n');
let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log('  ok  ' + name); } catch (e) { failed++; console.log('  FAIL  ' + name + '\n       ' + (e.message || e)); } }
console.log('Shack version (#687)');
test('Settings footer has a shack version line', () => {
  assert.ok(/<div id="so-shack-version" class="so-footer-version"><\/div>/.test(R('renderer/remote.html')));
});
test('the version line is styled like the footer byline', () => {
  assert.ok(/\.so-footer-version \{ font-size: 12px; color: var\(--text-dim\);/.test(R('renderer/remote.css')));
});
test('the hello handler fills it from the server version', () => {
  const web = R('renderer/remote.js');
  const at = web.indexOf("ws._serverVersion = String(msg.serverVersion || '');");
  assert.ok(at > 0, 'hello handler stores the server version');
  const blk = web.slice(at, at + 600);
  assert.ok(/getElementById\('so-shack-version'\)/.test(blk));
  assert.ok(/'Shack POTACAT v' \+ ws\._serverVersion/.test(blk));
});
console.log(`\nShack version: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
