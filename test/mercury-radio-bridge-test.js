// Tests for lib/mercury-radio-bridge.js — the Mercury event→radio policy.
// Uses a fake emitter + spy hooks to assert ordering and the key decisions
// (acquire-or-abort, key-PTT + failsafe, release + unkey). Run: node test/mercury-radio-bridge-test.js
'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const { attachMercuryRadioBridge } = require('../lib/mercury-radio-bridge');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

function makeHooks({ acquireReturns = true } = {}) {
  const calls = [];
  const hooks = {
    keyPtt: (on) => calls.push(['keyPtt', on]),
    acquire: () => { calls.push(['acquire']); return acquireReturns; },
    release: () => calls.push(['release']),
    abort: () => calls.push(['abort']),
    armFailsafe: () => calls.push(['armFailsafe']),
    clearFailsafe: () => calls.push(['clearFailsafe']),
    log: (m) => calls.push(['log', m]),
    onIdle: () => calls.push(['onIdle']),
  };
  return { hooks, calls };
}
const names = (calls) => calls.map((c) => c[0]);

test('PTT ON takes the radio, keys the rig and arms the failsafe', () => {
  const c = new EventEmitter();
  const { hooks, calls } = makeHooks();
  attachMercuryRadioBridge(c, hooks);
  c.emit('ptt', { on: true });
  assert.deepStrictEqual(calls, [['acquire'], ['keyPtt', true], ['armFailsafe']]);
});

test('PTT OFF outside a session clears the failsafe, unkeys, and hands the radio back (#919)', () => {
  const c = new EventEmitter();
  const { hooks, calls } = makeHooks();
  attachMercuryRadioBridge(c, hooks);
  c.emit('ptt', { on: true });
  calls.length = 0;
  c.emit('ptt', { on: false });
  assert.deepStrictEqual(calls, [['clearFailsafe'], ['keyPtt', false], ['release']]);
});

// #919: Mercury in LISTEN must never key over FT8, a tune or the Transmit
// Test. A PTT ON while another feature owns the radio keys nothing and yields.
test('PTT ON while another feature holds the radio does not key; aborts to yield (#919)', () => {
  const c = new EventEmitter();
  const { hooks, calls } = makeHooks({ acquireReturns: false });
  const b = attachMercuryRadioBridge(c, hooks);
  c.emit('ptt', { on: true });
  assert.ok(!calls.some((x) => x[0] === 'keyPtt'), 'must not key a radio it does not own');
  assert.ok(!calls.some((x) => x[0] === 'armFailsafe'));
  assert.deepStrictEqual(names(calls), ['acquire', 'log', 'abort']);
  assert.strictEqual(b.isTxActive(), false);
  // ...and the PTT OFF that follows must not unkey the owner's transmission.
  calls.length = 0;
  c.emit('ptt', { on: false });
  assert.ok(!calls.some((x) => x[0] === 'keyPtt'), 'must not unkey FT8 / the test');
});

test('inside a session, PTT OFF keeps the radio; DISCONNECTED releases it (#919)', () => {
  const c = new EventEmitter();
  const { hooks, calls } = makeHooks();
  const b = attachMercuryRadioBridge(c, hooks);
  c.emit('connected', { source: 'A', dest: 'B', bandwidth: 500 });
  assert.strictEqual(b.isInSession(), true);
  c.emit('ptt', { on: true });
  c.emit('ptt', { on: false });
  assert.ok(!calls.some((x) => x[0] === 'release'), 'a session holds the radio between overs');
  c.emit('disconnected');
  assert.strictEqual(names(calls).filter((n) => n === 'release').length, 1);
  assert.strictEqual(b.isInSession(), false);
});

test('a repeated PTT ON while keyed only re-arms the failsafe', () => {
  const c = new EventEmitter();
  const { hooks, calls } = makeHooks();
  attachMercuryRadioBridge(c, hooks);
  c.emit('ptt', { on: true });
  calls.length = 0;
  c.emit('ptt', { on: true });
  assert.deepStrictEqual(names(calls), ['armFailsafe']);
});

test('BUFFER>0 while keyed re-arms the failsafe; ignored when idle', () => {
  const c = new EventEmitter();
  const { hooks, calls } = makeHooks();
  const b = attachMercuryRadioBridge(c, hooks);
  c.emit('buffer', { bytes: 100 });          // idle → ignored
  assert.strictEqual(calls.length, 0);
  c.emit('ptt', { on: true });
  calls.length = 0;
  c.emit('buffer', { bytes: 100 });          // active → re-arm
  c.emit('buffer', { bytes: 0 });            // drained → no re-arm
  assert.deepStrictEqual(names(calls), ['armFailsafe']);
  assert.strictEqual(b.isTxActive(), true);
});

test('CONNECTED acquires the radio when free', () => {
  const c = new EventEmitter();
  const { hooks, calls } = makeHooks({ acquireReturns: true });
  attachMercuryRadioBridge(c, hooks);
  c.emit('connected', { source: 'K3SBP', dest: 'W4MPT', bandwidth: 2300 });
  assert.strictEqual(names(calls)[0], 'acquire');
  assert.ok(!names(calls).includes('abort'));
});

test('CONNECTED while the radio is held → abort (yield), no PTT', () => {
  const c = new EventEmitter();
  const { hooks, calls } = makeHooks({ acquireReturns: false });
  attachMercuryRadioBridge(c, hooks);
  c.emit('connected', { source: 'K3SBP', dest: 'W4MPT', bandwidth: 2300 });
  assert.deepStrictEqual(names(calls), ['acquire', 'log', 'abort']);
});

test('DISCONNECTED clears failsafe, unkeys if keyed, releases, then onIdle', () => {
  const c = new EventEmitter();
  const { hooks, calls } = makeHooks();
  attachMercuryRadioBridge(c, hooks);
  c.emit('connected', { source: 'A', dest: 'B', bandwidth: 500 });
  c.emit('ptt', { on: true });
  calls.length = 0;
  c.emit('disconnected');
  assert.deepStrictEqual(names(calls), ['clearFailsafe', 'keyPtt', 'release', 'log', 'onIdle']);
  assert.deepStrictEqual(calls[1], ['keyPtt', false]);
});

test('DISCONNECTED when not keyed does not unkey', () => {
  const c = new EventEmitter();
  const { hooks, calls } = makeHooks();
  attachMercuryRadioBridge(c, hooks);
  c.emit('connected', { source: 'A', dest: 'B', bandwidth: 500 });
  calls.length = 0;
  c.emit('disconnected');
  assert.ok(!calls.some((x) => x[0] === 'keyPtt'), 'should not key/unkey when idle');
  assert.deepStrictEqual(names(calls), ['clearFailsafe', 'release', 'log', 'onIdle']);
});

console.log(`\nMercury radio bridge: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
