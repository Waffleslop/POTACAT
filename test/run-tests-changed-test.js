#!/usr/bin/env node
'use strict';
// `node scripts/run-tests.js --changed`: the quick filter picks the tests that
// mention a changed file; for main.js (mentioned by most tests) only those that
// mention a changed function or a string from a changed line. Pure parts here.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const C = require('../scripts/changed-tests.js');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

check('hunk headers give the changed line numbers on both sides and the changed text', () => {
  const h = C.parseHunks([
    'diff --git a/main.js b/main.js',
    '--- a/main.js',
    '+++ b/main.js',
    '@@ -10,2 +10,3 @@ function connectCat() {',
    "-  send('old-command-x');",
    '-  b();',
    "+  send('new-command-y');",
    '+  b();',
    '+  c();',
    '@@ -40 +41,0 @@',
    '-  gone();',
  ].join('\n'));
  assert.deepStrictEqual(h.oldLines, [10, 11, 40]);
  assert.deepStrictEqual(h.newLines, [10, 11, 12, 41]);
  assert.strictEqual(h.text.length, 6);
  assert.deepStrictEqual(h.headers, ['function connectCat() {']);
});

check('the enclosing function is found by indentation, for each declaration form', () => {
  const src = [
    'function outer(a) {',          // 0
    '  const x = 1;',                // 1
    '  if (a) {',                    // 2
    '    doThing();',                // 3
    '  }',                           // 4
    '}',                             // 5
    'const arrowFn = async (p) => {',// 6
    '  return p;',                   // 7
    '};',                            // 8
    "ipcMain.handle('jtcat-start', async () => {", // 9
    '  go();',                       // 10
    '});',                           // 11
    'top();',                        // 12
    'class K {',                     // 13
    '  method(a) {',                 // 14
    '    work(a);',                  // 15
    '  }',                           // 16
    '}',                             // 17
  ];
  assert.strictEqual(C.enclosingFunction(src, 3), 'outer');
  assert.strictEqual(C.enclosingFunction(src, 1), 'outer');
  assert.strictEqual(C.enclosingFunction(src, 0), 'outer');
  assert.strictEqual(C.enclosingFunction(src, 7), 'arrowFn');
  assert.strictEqual(C.enclosingFunction(src, 10), 'jtcat-start');
  assert.strictEqual(C.enclosingFunction(src, 12), null);
  assert.strictEqual(C.enclosingFunction(src, 15), 'method');
});

check('string literals of 6+ characters are taken from changed lines', () => {
  const s = C.stringLiterals(["send('EX040101'); log(\"short\"); x(`aprs-beacon-rf`); y('${no}')"]);
  assert.ok(s.has('EX040101') && s.has('aprs-beacon-rf'));
  assert.ok(!s.has('short'));
});

check('a changed lib file is found by path, file name or a distinctive bare name', () => {
  assert.deepStrictEqual(C.fileKeys('lib/aprs-rf-gate.js').sort(), ['aprs-rf-gate', 'aprs-rf-gate.js', 'lib/aprs-rf-gate'].sort());
  assert.ok(!C.fileKeys('renderer/app.js').includes('app'), 'a short bare name is not a key');
});

check('the picker: lib mentions, main.js narrowed by function and string, changed tests, runner checks', () => {
  const tests = ['test/a-test.js', 'test/b-test.js', 'test/c-test.js', 'test/d-test.js', 'test/e-test.js', 'test/run-tests-runner-test.js', 'test/run-tests-changed-test.js'];
  const sources = new Map([
    ['test/a-test.js', "require('../lib/aprs-rf-gate')"],
    ['test/b-test.js', "read('main.js'); assert(src.includes('function connectCat'))"],
    ['test/c-test.js', "read('main.js'); assert(src.includes('other'))"],
    ['test/d-test.js', "read('main.js'); assert(src.includes('new-command-y'))"],
    ['test/e-test.js', "connectCat but never reads the main file"],
    ['test/run-tests-runner-test.js', ''],
    ['test/run-tests-changed-test.js', ''],
  ]);
  const picked = C.pick({
    tests, sources, changes: [
      { file: 'lib/aprs-rf-gate.js' },
      { file: 'main.js', functions: new Set(['connectCat']), strings: new Set(['new-command-y']) },
      { file: 'test/e-test.js' },
      { file: 'scripts/run-tests.js' },
    ],
  });
  assert.ok(/aprs-rf-gate/.test(picked.get('test/a-test.js')));
  assert.ok(/connectCat/.test(picked.get('test/b-test.js')));
  assert.ok(!picked.has('test/c-test.js'), 'main.js alone is not enough');
  assert.ok(/new-command-y/.test(picked.get('test/d-test.js')));
  assert.strictEqual(picked.get('test/e-test.js'), 'the test file changed');
  assert.ok(picked.has('test/run-tests-runner-test.js') && picked.has('test/run-tests-changed-test.js'));
});

check('main.js terms match whole tokens, and a term most main.js tests mention is dropped', () => {
  assert.ok(C.mentions('x.refuse(1)', 'refuse'));
  assert.ok(!C.mentions('it was refused', 'refuse'), 'refuse is not refused');
  assert.ok(C.mentions("on('jtcat-qso-state')", 'jtcat-qso-state'));
  const tests = [];
  const sources = new Map();
  for (let i = 0; i <= C.MAX_TERM_HITS; i++) { const t = `test/w${i}-test.js`; tests.push(t); sources.set(t, "read('main.js'); new BrowserWindow(); window"); }
  tests.push('test/z-test.js'); sources.set('test/z-test.js', "read('main.js'); aprsRfGateState()");
  const skipped = [];
  const p = C.pick({ tests, sources, changes: [{ file: 'main.js', functions: new Set(['aprsRfGateState']), strings: new Set(['window']) }], skipped });
  assert.deepStrictEqual([...p.keys()], ['test/z-test.js']);
  assert.ok(skipped.length === 1 && /^window /.test(skipped[0]), skipped.join());
});

check('--changed is a quick filter: the help says the full run is not replaced', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'run-tests.js'), 'utf8');
  assert.ok(/--changed \[base\]/.test(src) && /NOT the full run/.test(src));
  assert.ok(src.includes("'test/run-tests-changed-test.js'"), 'this test is in the TESTS list');
});

console.log(`\nrun-tests --changed: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
