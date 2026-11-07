#!/usr/bin/env node
'use strict';
// scripts/run-tests.js (GitHub #175): one failing file must not hide the rest.
// The runner stopped at the first failure (file ~208 of 433), so everything
// after it never ran and a partial run looked like the whole picture. It now
// runs every file, prints a summary naming each failure, and still exits
// non-zero when any file failed. Driven here with tiny fixture files.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'potacat-runner-'));
const fx = (name, body) => { const p = path.join(dir, name); fs.writeFileSync(p, body); return p; };
const okA = fx('a-pass.js', "console.log('a ran');");
const bad = fx('b-fail.js', "console.log('b ran'); process.exit(3);");
const okC = fx('c-pass.js', "console.log('c ran');");
const bad2 = fx('d-fail.js', "throw new Error('d threw');");

function run(list) {
  const code = `require(${JSON.stringify(path.join(root, 'scripts', 'run-tests.js'))}).runAll(${JSON.stringify(list)})`;
  const r = spawnSync(process.execPath, ['-e', code], { cwd: root, encoding: 'utf8' });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

try {
  check('runAll is exported and the file list is not run on require', () => {
    const mod = require('../scripts/run-tests.js');
    assert.strictEqual(typeof mod.runAll, 'function');
    assert.ok(Array.isArray(mod.TESTS) && mod.TESTS.length > 100, 'TESTS list exported');
    assert.ok(mod.TESTS.includes('test/run-tests-runner-test.js'), 'this test is in the npm test list');
  });

  const mixed = run([okA, bad, okC, bad2]);
  check('a failing file does not stop the run: files after it still run', () => {
    assert.ok(/a ran/.test(mixed.out) && /b ran/.test(mixed.out) && /c ran/.test(mixed.out), mixed.out);
    assert.ok(/d threw/.test(mixed.out), mixed.out);
  });
  check('any failure makes the run exit non-zero', () => {
    assert.notStrictEqual(mixed.status, 0, 'exit ' + mixed.status);
  });
  check('the summary counts passed and failed files and names each failure', () => {
    assert.ok(/\[run-tests\] 2 of 4 test files passed, 2 failed/.test(mixed.out), mixed.out);
    assert.ok(mixed.out.includes(bad) && mixed.out.includes(bad2), 'both failed files named');
    assert.ok(/exit 3/.test(mixed.out), 'the exit code of a failed file is shown');
  });

  const clean = run([okA, okC]);
  check('an all-pass run exits 0 with the old "all N passed" line', () => {
    assert.strictEqual(clean.status, 0, clean.out);
    assert.ok(/\[run-tests\] all 2 test files passed/.test(clean.out), clean.out);
  });
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\nrun-tests runner: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
