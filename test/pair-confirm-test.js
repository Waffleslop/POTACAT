// Two-step pairing bookkeeping (lib/pair-confirm.js, ECHOCAT report, 2026-11-25):
// a held pairing commits once, releases once, times out, and an old phone's
// body (no confirm) never asks for it.
// Run: node test/pair-confirm-test.js
'use strict';

const assert = require('assert');
const { HeldPairs, wantsConfirm, HOLD_MS } = require('../lib/pair-confirm');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n    ' + (e && e.stack || e)); process.exitCode = 1; }
}

function fakeTimers() {
  const list = [];
  return {
    setTimer: (fn, ms) => { const t = { fn, ms, live: true }; list.push(t); return t; },
    clearTimer: (t) => { if (t) t.live = false; },
    fireAll: () => { for (const t of list) if (t.live) { t.live = false; t.fn(); } },
    list,
  };
}

console.log('pair-confirm');

test('only an explicit confirm asks for two steps; old bodies do not', () => {
  assert.strictEqual(wantsConfirm({ confirm: 1 }), true);
  assert.strictEqual(wantsConfirm({ confirm: true }), true);
  assert.strictEqual(wantsConfirm({ confirm: '1' }), true);
  assert.strictEqual(wantsConfirm({}), false);
  assert.strictEqual(wantsConfirm({ confirm: 0 }), false);
  assert.strictEqual(wantsConfirm(null), false);
  assert.strictEqual(HOLD_MS, 60000);
});

test('commit runs once and returns the device', () => {
  const t = fakeTimers();
  const h = new HeldPairs(t);
  const log = [];
  h.hold({ token: 'dt1', id: 'd1' }, { onCommit: (d) => log.push('commit ' + d.id), onRelease: (d, r) => log.push('release ' + r) });
  assert.ok(h.has('dt1'));
  assert.strictEqual(h.commit('dt1').id, 'd1');
  assert.strictEqual(h.commit('dt1'), null, 'second commit does nothing');
  assert.strictEqual(h.release('dt1'), false, 'no release after commit');
  t.fireAll();
  assert.deepStrictEqual(log, ['commit d1'], 'the timeout was cleared');
});

test('release gives the code back once, with the reason', () => {
  const h = new HeldPairs(fakeTimers());
  const log = [];
  h.hold({ token: 'dt2', id: 'd2' }, { onCommit: () => log.push('commit'), onRelease: (d, r) => log.push(r) });
  assert.strictEqual(h.release('dt2', 'mismatch'), true);
  assert.strictEqual(h.commit('dt2'), null, 'a released pairing cannot be committed');
  assert.deepStrictEqual(log, ['mismatch']);
});

test('no answer: the timeout releases it', () => {
  const t = fakeTimers();
  const h = new HeldPairs({ ...t, holdMs: 1234 });
  const log = [];
  h.hold({ token: 'dt3', id: 'd3' }, { onCommit: () => log.push('commit'), onRelease: (d, r) => log.push(r) });
  assert.strictEqual(t.list[0].ms, 1234);
  t.fireAll();
  assert.deepStrictEqual(log, ['timeout']);
  assert.strictEqual(h.size, 0);
});

test('releaseAll on stop', () => {
  const h = new HeldPairs(fakeTimers());
  const log = [];
  for (const k of ['a', 'b']) h.hold({ token: k, id: k }, { onCommit: () => {}, onRelease: (d, r) => log.push(d.id + ':' + r) });
  h.releaseAll('stopped');
  assert.deepStrictEqual(log.sort(), ['a:stopped', 'b:stopped']);
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
