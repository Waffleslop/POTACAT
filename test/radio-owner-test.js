// Unit tests for lib/radio-owner.js — the pure radio mutual-exclusion arbiter.
// Run: node test/radio-owner-test.js
'use strict';

const assert = require('assert');
const { decideAcquire, decideRelease, canAcquire } = require('../lib/radio-owner');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

// ---- acquire ----
test('free radio can be acquired by anyone', () => {
  assert.deepStrictEqual(decideAcquire('none', 'jtcat'), { ok: true, owner: 'jtcat' });
  assert.deepStrictEqual(decideAcquire('none', 'mercury'), { ok: true, owner: 'mercury' });
});

test('re-acquiring by the current owner is a no-op ok', () => {
  assert.strictEqual(decideAcquire('mercury', 'mercury').ok, true);
  assert.strictEqual(decideAcquire('jtcat', 'jtcat').ok, true);
});

test('mercury cannot take the radio while jtcat holds it, and vice-versa', () => {
  const a = decideAcquire('jtcat', 'mercury');
  assert.strictEqual(a.ok, false);
  assert.strictEqual(a.owner, 'jtcat');
  assert.ok(/in use by jtcat/.test(a.reason));
  const b = decideAcquire('mercury', 'jtcat');
  assert.strictEqual(b.ok, false);
  assert.strictEqual(b.owner, 'mercury');
});

test('invalid / none requester is rejected', () => {
  assert.strictEqual(decideAcquire('none', 'none').ok, false);
  assert.strictEqual(decideAcquire('none', 'nonsense').ok, false);
  assert.strictEqual(decideAcquire('none', undefined).ok, false);
});

test('unknown current owner is treated as none', () => {
  assert.deepStrictEqual(decideAcquire('garbage', 'mercury'), { ok: true, owner: 'mercury' });
});

// ---- release ----
test('current owner releases to none', () => {
  assert.deepStrictEqual(decideRelease('mercury', 'mercury'), { ok: true, owner: 'none' });
});

test('a non-owner release does NOT steal ownership', () => {
  const r = decideRelease('mercury', 'jtcat');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.owner, 'mercury'); // still mercury's
});

test('force release always clears', () => {
  assert.deepStrictEqual(decideRelease('jtcat', 'force'), { ok: true, owner: 'none' });
  assert.deepStrictEqual(decideRelease('mercury', 'force'), { ok: true, owner: 'none' });
});

test('releasing an already-free radio is ok', () => {
  assert.deepStrictEqual(decideRelease('none', 'mercury'), { ok: true, owner: 'none' });
});

// ---- canAcquire convenience ----
test('canAcquire mirrors decideAcquire.ok', () => {
  assert.strictEqual(canAcquire('none', 'jtcat'), true);
  assert.strictEqual(canAcquire('jtcat', 'mercury'), false);
});

// ---- full mutual-exclusion sequence ----
test('sequence: jtcat holds through its TX, mercury blocked until release', () => {
  let owner = 'none';
  owner = decideAcquire(owner, 'jtcat').owner;          // JTCAT keys
  assert.strictEqual(canAcquire(owner, 'mercury'), false); // Mercury blocked
  owner = decideRelease(owner, 'jtcat').owner;          // JTCAT unkeys
  assert.strictEqual(owner, 'none');
  const acq = decideAcquire(owner, 'mercury');          // now Mercury can
  assert.strictEqual(acq.ok, true);
  owner = acq.owner;
  assert.strictEqual(canAcquire(owner, 'jtcat'), false); // JTCAT now blocked
});

console.log(`\nRadio-owner arbiter: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
