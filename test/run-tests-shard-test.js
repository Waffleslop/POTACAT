#!/usr/bin/env node
'use strict';
// CI runs the suite as four parallel shards (TEST_SHARD=1/4 .. 4/4). Every
// test file must land in exactly one shard, or a file silently stops running
// in CI. Also: the two Electron tests skip at once on a Linux box with no
// display instead of waiting out a 2-minute spawn timeout, and still run (and
// fail hard) under the layout-tests job's xvfb.
// Run: node test/run-tests-shard-test.js
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const R = require('../scripts/run-tests.js');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
}
const root = path.join(__dirname, '..');

console.log('Test shards');

test('four shards cover every test file exactly once', () => {
  const seen = new Map();
  for (let k = 1; k <= 4; k++) for (const f of R.shardOf(R.TESTS, k, 4)) seen.set(f, (seen.get(f) || 0) + 1);
  assert.strictEqual(seen.size, R.TESTS.length, 'every file is in a shard');
  for (const [f, c] of seen) assert.strictEqual(c, 1, f + ' is in ' + c + ' shards');
});

test('any shard count partitions the list, and keeps the list order inside a shard', () => {
  for (const n of [1, 2, 3, 5]) {
    const all = [];
    for (let k = 1; k <= n; k++) {
      const s = R.shardOf(R.TESTS, k, n);
      const idx = s.map((f) => R.TESTS.indexOf(f));
      assert.deepStrictEqual(idx, idx.slice().sort((a, b) => a - b), `shard ${k}/${n} in list order`);
      all.push(...s);
    }
    assert.strictEqual(all.length, R.TESTS.length);
    assert.strictEqual(new Set(all).size, R.TESTS.length);
  }
});

test('the measured-slow files are spread out, not stacked in one shard', () => {
  const slow = Object.keys(R.SLOW_SECONDS).filter((f) => R.TESTS.includes(f));
  if (slow.length < 4) return;
  const load = [1, 2, 3, 4].map((k) => R.shardOf(R.TESTS, k, 4).reduce((t, f) => t + (Number(R.SLOW_SECONDS[f]) || 1), 0));
  const max = Math.max(...load), min = Math.min(...load);
  assert.ok(max - min <= Math.max(...slow.map((f) => R.SLOW_SECONDS[f])), 'balanced within one file: ' + load.map((x) => x.toFixed(0)).join(', '));
});

test('TEST_SHARD is read as k/n; anything else is refused', () => {
  assert.deepStrictEqual(R.parseShard('2/4'), { k: 2, n: 4 });
  assert.strictEqual(R.parseShard('5/4'), null);
  assert.strictEqual(R.parseShard('x'), null);
  assert.strictEqual(R.parseShard(''), null);
});

test('the workflow runs all four shards, and cancels only superseded PR runs', () => {
  const wf = readSrc(path.join(root, '.github', 'workflows', 'test.yml'));
  assert.ok(/shard: \[1, 2, 3, 4\]/.test(wf), 'a four-shard matrix');
  assert.ok(/TEST_SHARD: \$\{\{ matrix\.shard \}\}\/4/.test(wf));
  assert.ok(/cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/.test(wf), 'a master push is never cancelled');
  // Branch protection requires a check named jtcat-tests: it must still exist and wait on every shard.
  assert.ok(/\n  jtcat-tests:\n    needs: test-shard\n    if: always\(\)/.test(wf.replace(/\r\n/g, '\n')), 'the required jtcat-tests check gathers the shards');
});

test('the Electron tests skip at once without a display, unless the job requires them', () => {
  const lay = readSrc(path.join(root, 'test', 'layout-alignment-test.js'));
  const mb = readSrc(path.join(root, 'test', 'modem-bridge-test.js'));
  assert.ok(/process\.platform === 'linux' && !process\.env\.DISPLAY && !process\.env\.WAYLAND_DISPLAY/.test(lay) && /noDisplay && !required/.test(lay));
  assert.ok(/process\.platform === 'linux' && !process\.env\.DISPLAY && !process\.env\.WAYLAND_DISPLAY && !required/.test(mb));
  const wf = readSrc(path.join(root, '.github', 'workflows', 'test.yml'));
  assert.ok(/LAYOUT_REQUIRED: '1'\n\s+run: xvfb-run -a node test\/layout-alignment-test\.js/.test(wf.replace(/\r\n/g, '\n')), 'the layout job still runs it for real');
  assert.ok(/LAYOUT_REQUIRED: '1'\n\s+run: xvfb-run -a node test\/modem-bridge-test\.js/.test(wf.replace(/\r\n/g, '\n')));
});

test('this test is in the list CI runs', () => {
  assert.ok(R.TESTS.includes('test/run-tests-shard-test.js'));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
