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

function run(list, opts) {
  const code = `require(${JSON.stringify(path.join(root, 'scripts', 'run-tests.js'))}).runAll(${JSON.stringify(list)}, ${JSON.stringify(opts || {})})`;
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

  // 2026-11-21: files run in parallel, each its own process; output is buffered
  // per file and printed whole, so two files never interleave.
  const slow = (tag) => fx(`${tag}-slow.js`, `let i = 0; const t = setInterval(() => { console.log('${tag} line ' + i); console.error('${tag} err ' + i); if (++i === 5) { clearInterval(t); ${tag === 'q' ? 'process.exit(2);' : ''} } }, 20);`);
  const par = [slow('p'), slow('q'), slow('r'), slow('s')];
  const pr = run(par, { jobs: 4 });
  check('parallel: every file runs, a failure is named, the summary is unchanged', () => {
    assert.notStrictEqual(pr.status, 0, pr.out);
    assert.ok(/\[run-tests\] 3 of 4 test files passed, 1 failed/.test(pr.out), pr.out);
    assert.ok(pr.out.includes(`[run-tests] FAILED: ${par[1]} (exit 2)`), pr.out);
  });
  check("parallel: each file's output is printed whole, never interleaved", () => {
    for (const tag of ['p', 'q', 'r', 's']) {
      const lines = pr.out.split(/\r?\n/).map((l, i) => [l, i]).filter(([l]) => l.startsWith(tag + ' '));
      assert.strictEqual(lines.length, 10, tag + ': ' + pr.out);
      assert.strictEqual(lines[9][1] - lines[0][1], 9, tag + ' lines are contiguous');
    }
  });
  const ser = run([okA, bad, okC], { jobs: 1 });
  check('--jobs 1 runs one file at a time, in order, with the same summary', () => {
    assert.ok(ser.out.indexOf('a ran') < ser.out.indexOf('b ran') && ser.out.indexOf('b ran') < ser.out.indexOf('c ran'), ser.out);
    assert.ok(/\[run-tests\] 2 of 3 test files passed, 1 failed/.test(ser.out), ser.out);
    assert.notStrictEqual(ser.status, 0);
  });
  check('options: --jobs N, --jobs=N, -j N, --changed [base] and substring filters', () => {
    const { parseArgs, defaultJobs, SERIAL } = require('../scripts/run-tests.js');
    assert.strictEqual(parseArgs(['--jobs', '3']).jobs, 3);
    assert.strictEqual(parseArgs(['--jobs=5']).jobs, 5);
    assert.strictEqual(parseArgs(['-j', '1']).jobs, 1);
    assert.deepStrictEqual(parseArgs(['sstv', 'jtcat']).filters, ['sstv', 'jtcat']);
    const c = parseArgs(['--changed']);
    assert.ok(c.changed && c.base === 'origin/master');
    assert.strictEqual(parseArgs(['--changed', 'HEAD~3']).base, 'HEAD~3');
    assert.ok(defaultJobs() >= 2 || Number(process.env.POTACAT_TEST_JOBS) > 0);
    assert.ok(SERIAL instanceof Set);
    const { TESTS } = require('../scripts/run-tests.js');
    for (const f of SERIAL) assert.ok(TESTS.includes(f), f + ' in SERIAL is in TESTS');
    for (const f of require('../scripts/run-tests.js').SLOW_FIRST) assert.ok(TESTS.includes(f), f + ' in SLOW_FIRST is in TESTS');
  });
  // Casey 2026-11-22 "Retry timing tests": one more try, only for the SERIAL
  // timing files, only in the run-alone loop; a pass on the retry says FLAKY.
  check('a SERIAL timing test that fails gets exactly one retry; nothing else is retried', () => {
    const { SERIAL, RETRY_ONCE } = require('../scripts/run-tests.js');
    assert.ok(RETRY_ONCE instanceof Set && RETRY_ONCE.size > 0);
    for (const f of RETRY_ONCE) assert.ok(SERIAL.has(f), f + ' retried but not SERIAL');
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'scripts', 'run-tests.js'), 'utf8');
    assert.strictEqual((src.match(/RETRY_ONCE\.has\(/g) || []).length, 1, 'one retry site');
    const alone = src.slice(src.indexOf('for (const f of alone) {'), src.indexOf('failed.sort('));
    assert.ok(/if \(r\.code !== 0 && RETRY_ONCE\.has\(f\)\) \{[\s\S]*r = await runFile\(f, true\);[\s\S]*FLAKY:/.test(alone), 'the retry is in the alone loop and prints FLAKY');
    const pool = src.slice(src.indexOf('const worker = async'), src.indexOf('for (const f of alone) {'));
    assert.ok(!/RETRY_ONCE/.test(pool), 'the parallel pool never retries');
    assert.ok(!/RETRY_ONCE/.test(src.slice(src.indexOf('async function runSerial('), src.indexOf('async function runParallel('))), '--jobs 1 stays exactly as before');
  });
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\nrun-tests runner: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
