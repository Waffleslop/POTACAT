'use strict';
// GitHub #406: the pota.app Connect step logged the first 80-200 characters of
// every stored value, which can be the start of a sign-in token, and the log
// goes into Report a Bug. Names and lengths only now.
const path = require('path');
const assert = require('assert');
const { readSrc } = require('./_src');
const { safeStoreName, describeStoredValues, urlWithoutQuery } = require('../lib/pota-sync-log');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

const JWT = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl';

test('describeStoredValues gives names and lengths, never a value', () => {
  const out = describeStoredValues({ 'cookie:accepted': 'true', tok: JWT });
  assert.strictEqual(out, `cookie:accepted (4 chars), tok (${JWT.length} chars)`);
  assert.ok(!out.includes('eyJ') && !out.includes('true'), 'no part of a value');
  assert.strictEqual(describeStoredValues({}), '(none)');
  assert.strictEqual(describeStoredValues(null), '(none)');
});

test('a Cognito name has its user id masked', () => {
  assert.strictEqual(
    safeStoreName('CognitoIdentityServiceProvider.abc123client.7f1c-uuid-99.idToken'),
    'CognitoIdentityServiceProvider.abc123client.<user>.idToken');
  assert.strictEqual(safeStoreName('cookie:accepted'), 'cookie:accepted');
  const out = describeStoredValues({ 'CognitoIdentityServiceProvider.c.u-1.idToken': JWT });
  assert.ok(!out.includes('u-1') && out.includes('<user>'));
});

test('the login URL is logged without its query or fragment', () => {
  assert.strictEqual(urlWithoutQuery('https://pota.app/?code=abc123&state=x'), 'https://pota.app/');
  assert.strictEqual(urlWithoutQuery('https://pota.app/#id_token=' + JWT), 'https://pota.app/');
});

// Source guards on lib/pota-sync.js (it needs Electron to load).
const SRC = readSrc(path.join(__dirname, '..', 'lib', 'pota-sync.js'));
const logCalls = SRC.split('\n').filter((l) => /this\._log\(/.test(l));

test('no pota-sync log line prints a slice of a value', () => {
  const bad = logCalls.filter((l) => /\.slice\(|\.substr(ing)?\(/.test(l));
  assert.deepStrictEqual(bad, [], 'log lines with a value slice');
  assert.ok(!/cidShort/.test(SRC), 'no clientId prefix');
});

test('the storage scan logs sizes through describeStoredValues', () => {
  for (const store of ['ls', 'ss', 'idb']) {
    assert.ok(SRC.includes('describeStoredValues(stores.' + store + ')'), store);
  }
  assert.ok(!/Object\.entries\(stores\.(ls|ss|idb)/.test(SRC), 'no per-value loop over the stores');
  assert.ok(/URL is \$\{urlWithoutQuery\(url\)\}/.test(SRC), 'the login URL loses its query');
  assert.ok(/cookies\.map\(c => safeStoreName\(c\.name\)\)|\(cookies \|\| \[\]\)\.map\(c => safeStoreName\(c\.name\)\)/.test(SRC), 'cookie names masked');
});

// Every other credential log line found in the #406 sweep: pairing tokens and
// Guest Pass codes are logged by length only.
test('main.js logs pairing tokens and Guest Pass codes by length only', () => {
  const MAIN = readSrc(path.join(__dirname, '..', 'main.js'));
  const lines = MAIN.split('\n').filter((l) => /sendCatLog\(/.test(l));
  // A token, secret or password, whole or sliced.
  const cred = /\$\{\s*([A-Za-z_.]*[Tt]oken|[A-Za-z_.]*[Ss]ecret|[A-Za-z_.]*[Pp]assword)\s*(\.slice\([^)]*\))?\s*\}/;
  // A Guest Pass code in a [pass] / [guest-pass] line; its length is fine
  // ("exit code ${code}" from a child process is not in such a line).
  const passCode = /\[(guest-)?pass\]/;
  const bad = lines.filter((l) => cred.test(l)
    || (passCode.test(l) && /\$\{(?![^}]*\.length\s*\})[^}]*\bcode\b[^}]*\}/.test(l)));
  assert.deepStrictEqual(bad, [], 'sendCatLog lines that print a token, Guest Pass code, secret or password');
});

console.log(`\npota.app connect logging: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
