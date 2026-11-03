#!/usr/bin/env node
'use strict';
// N5IRU (Windows, 1.13.7): "wsprd ETIMEDOUT" every WSPR cycle. The deep
// search ran past the 60 s limit on his PC each window, so WSPR never decoded.
// A slow or timed-out run now steps the search down: deep -> normal -> quick.
// Run: node test/wsprd-depth-test.js
const assert = require('assert');
const cp = require('child_process');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
console.log('wsprd search depth');

// A fake wsprd: the decoder destructures spawnSync at require time, so patch
// it first and load a fresh copy.
const calls = [];
let behave = () => ({ stdout: '', status: 0 });
const realSpawnSync = cp.spawnSync;
cp.spawnSync = (bin, args, opts) => { calls.push({ args, timeout: opts.timeout }); return behave(args); };
delete require.cache[require.resolve('../lib/wspr-decoder')];
const D = require('../lib/wspr-decoder');
cp.spawnSync = realSpawnSync;

const samples = new Float32Array(1200);
const run = () => D.decodeWspr(samples, { dialFreqMHz: 14.0956, wsprdPath: 'wsprd-fake' });
const timeout = () => { const e = new Error('spawnSync wsprd ETIMEDOUT'); e.code = 'ETIMEDOUT'; return { error: e, stdout: '' }; };

test('rule: a fast run keeps its depth; a slow or timed-out one steps down once; quick is the floor', () => {
  assert.deepStrictEqual(D.nextDepth(0, false, 2000), { depth: 0, stepped: false });
  assert.deepStrictEqual(D.nextDepth(0, true, 60000), { depth: 1, stepped: true });
  assert.deepStrictEqual(D.nextDepth(1, false, D.SLOW_MS + 1), { depth: 2, stepped: true });
  assert.deepStrictEqual(D.nextDepth(2, true, 60000), { depth: 2, stepped: false });
});

test('the first window runs the deep search under the 60 s limit', () => {
  D.resetWsprdDepth(); calls.length = 0;
  const r = run();
  assert.ok(r.ok);
  assert.deepStrictEqual(calls[0].args.slice(0, 1), ['-d']);
  assert.strictEqual(calls[0].timeout, 60000);
});

test('a timed-out deep search names the cause and the next window runs without -d', () => {
  D.resetWsprdDepth(); calls.length = 0;
  behave = timeout;
  const r1 = run();
  assert.ok(!r1.ok && /did not finish within 60 s \(deep search\)/.test(r1.error), r1.error);
  assert.ok(/using the normal search from the next window/.test(r1.notice), r1.notice);
  behave = () => ({ stdout: '', status: 0 });
  const r2 = run();
  assert.ok(r2.ok && !r2.notice);
  assert.ok(!calls[1].args.includes('-d') && !calls[1].args.includes('-q'), 'normal search');
  assert.strictEqual(D.wsprdDepthName(), 'normal');
});

test('timing out at every depth ends on quick and says what to check', () => {
  D.resetWsprdDepth(); calls.length = 0;
  behave = timeout;
  run(); run();
  const r3 = run();
  assert.deepStrictEqual(calls.map((c) => c.args[0]), ['-d', '-f', '-q']);
  assert.ok(/even at the quickest setting/.test(r3.error), r3.error);
  assert.strictEqual(D.wsprdDepthName(), 'quick');
});

test('the worker relays the notice and the engine logs it', () => {
  const fs = require('fs');
  const path = require('path');
  const w = fs.readFileSync(path.join(__dirname, '..', 'lib', 'ft8-worker.js'), 'utf8');
  const e = fs.readFileSync(path.join(__dirname, '..', 'lib', 'ft8-engine.js'), 'utf8');
  assert.ok(/type: 'wspr-result'[^\n]*notice: out\.notice \|\| null/.test(w));
  assert.ok(/if \(msg\.notice\) this\.emit\('log', `WSPR: \$\{msg\.notice\}`\);/.test(e));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
