#!/usr/bin/env node
'use strict';
// #1031: a configured winlinkDirewolfPath that is missing or not executable falls back to
// the bundled Dire Wolf; the log must say so. Run: node test/direwolf-skipped-path-log-test.js

const assert = require('assert');
const fs = require('fs');
const D = require('../lib/direwolf-process');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
const ok = () => {};
const boom = () => { throw new Error('no'); };

console.log('Dire Wolf configured path skipped (#1031)');

test('no configured path: nothing to say', () => {
  assert.strictEqual(D.skippedConfiguredPathMessage({}, boom, boom), '');
  assert.strictEqual(D.skippedConfiguredPathMessage(null, boom, boom), '');
});
test('a missing file is named as missing, with the bundled fallback', () => {
  const m = D.skippedConfiguredPathMessage({ winlinkDirewolfPath: '/opt/dw/direwolf' }, boom, ok);
  assert.strictEqual(m, 'winlinkDirewolfPath /opt/dw/direwolf is missing, using the bundled Dire Wolf');
});
test('a file that is not executable is named as such', () => {
  const m = D.skippedConfiguredPathMessage({ winlinkDirewolfPath: '/opt/dw/direwolf' }, ok, boom);
  assert.strictEqual(m, 'winlinkDirewolfPath /opt/dw/direwolf is not executable, using the bundled Dire Wolf');
});
test('a usable file is silent', () => {
  assert.strictEqual(D.skippedConfiguredPathMessage({ winlinkDirewolfPath: '/opt/dw/direwolf' }, ok, ok), '');
});
test('main.js logs the message from findDirewolf', () => {
  const src = fs.readFileSync(require('path').join(__dirname, '..', 'main.js'), 'utf8');
  assert.ok(/skippedConfiguredPathMessage\(/.test(src));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
