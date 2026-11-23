#!/usr/bin/env node
'use strict';
// CI runs only the TESTS list in scripts/run-tests.js. A test file that is not
// on it never runs anywhere, and nothing said so: 34 tracked test files had
// drifted off the list by 2026-11-22. Every tracked file in test/ or lib/ named
// *-test.js or *.test.js must now be either in TESTS or in EXCEPTIONS (with a
// one-line reason that starts with a known kind). A new file on neither list
// fails here, by name.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const { TESTS, EXCEPTIONS } = require('../scripts/run-tests.js');
const IS_TEST = /(-test|\.test)\.js$/;
const KINDS = ['manual:', 'needs hardware:', 'needs network:', 'harness:', 'superseded by ', 'stale:'];

function walk(dir, out) {
  for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = dir + '/' + e.name;
    if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'build') walk(rel, out); }
    else out.push(rel);
  }
  return out;
}

// Tracked files from git; a source tree without .git falls back to the disk.
function testFiles() {
  let all;
  try {
    all = execFileSync('git', ['ls-files', '--', 'test', 'lib'], { cwd: root, encoding: 'utf8' })
      .split(/\r?\n/).filter(Boolean);
  } catch (_) {
    all = walk('test', []).concat(walk('lib', []));
  }
  return all.filter((f) => IS_TEST.test(f)).sort();
}

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message.split('\n').join('\n       ')); }
}

const files = testFiles();
const inTests = new Set(TESTS);

check('EXCEPTIONS is exported as a plain map of file -> reason', () => {
  assert.ok(EXCEPTIONS && typeof EXCEPTIONS === 'object' && !Array.isArray(EXCEPTIONS), 'scripts/run-tests.js exports EXCEPTIONS');
});

const exc = EXCEPTIONS || {};

check('the scan finds the test files (sanity)', () => {
  assert.ok(files.length > 100, 'found ' + files.length);
  assert.ok(files.includes('test/run-tests-runner-test.js'));
});

check('every test file in test/ and lib/ is in TESTS or in EXCEPTIONS', () => {
  const missing = files.filter((f) => !inTests.has(f) && !Object.prototype.hasOwnProperty.call(exc, f));
  assert.strictEqual(missing.length, 0,
    missing.length + ' test file(s) CI never runs:\n' + missing.map((f) => '  ' + f).join('\n') +
    '\nAdd each to TESTS in scripts/run-tests.js, or to EXCEPTIONS there with the reason it cannot run in CI.');
});

check('no file is in both TESTS and EXCEPTIONS', () => {
  const both = Object.keys(exc).filter((f) => inTests.has(f));
  assert.deepStrictEqual(both, []);
});

check('every EXCEPTIONS entry is a tracked test file (no stale entries)', () => {
  const gone = Object.keys(exc).filter((f) => !files.includes(f));
  assert.deepStrictEqual(gone, [], 'remove these from EXCEPTIONS');
});

check('every EXCEPTIONS reason starts with a known kind and says why', () => {
  const bad = Object.entries(exc).filter(([, why]) =>
    typeof why !== 'string' || !KINDS.some((k) => why.startsWith(k)) || why.length < 20);
  assert.deepStrictEqual(bad.map(([f]) => f), [], 'reasons start with one of: ' + KINDS.join(' | '));
});

check('this test is in TESTS', () => {
  assert.ok(inTests.has('test/test-manifest-complete-test.js'));
});

console.log(`\ntest manifest: ${files.length} test files, ${files.filter((f) => inTests.has(f)).length} in TESTS, ${Object.keys(exc).length} exceptions; ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
