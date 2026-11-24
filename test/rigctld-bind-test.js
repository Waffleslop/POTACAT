#!/usr/bin/env node
'use strict';
// Where POTACAT's own rigctld listens (lib/rigctld-bind.js). Casey 2026-11-22:
// bind it to 127.0.0.1 unless remote access is set up. No setting reaches
// POTACAT's spawned rigctld from another machine today, so it is loopback
// always. Run: node test/rigctld-bind-test.js
const assert = require('assert');
const { RIGCTLD_HOST, rigctldBindAddress, rigctldListenArgs } = require('../lib/rigctld-bind');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

test('the host is the IPv4 loopback literal, not "localhost" (which can resolve to ::1)', () => {
  assert.strictEqual(RIGCTLD_HOST, '127.0.0.1');
});

test('the bind address is 127.0.0.1 with no settings, empty settings, or a full rig target', () => {
  assert.strictEqual(rigctldBindAddress(), '127.0.0.1');
  assert.strictEqual(rigctldBindAddress({}), '127.0.0.1');
  assert.strictEqual(rigctldBindAddress({ type: 'rigctld', rigId: 3073, serialPort: 'COM3', baudRate: 19200, rigctldPort: 4532 }), '127.0.0.1');
});

test('a host field on the target does not widen the bind (that field belongs to "rigctld Network", a rigctld someone else runs)', () => {
  assert.strictEqual(rigctldBindAddress({ host: '0.0.0.0' }), '127.0.0.1');
  assert.strictEqual(rigctldBindAddress({ host: '192.168.1.20' }), '127.0.0.1');
});

test('listen args are -T 127.0.0.1 -t <port>, port as a string', () => {
  assert.deepStrictEqual(rigctldListenArgs(4532), ['-T', '127.0.0.1', '-t', '4532']);
  assert.deepStrictEqual(rigctldListenArgs('4533'), ['-T', '127.0.0.1', '-t', '4533']);
});

test('a missing or bad port falls back to rigctld\'s own 4532', () => {
  assert.deepStrictEqual(rigctldListenArgs(), ['-T', '127.0.0.1', '-t', '4532']);
  assert.deepStrictEqual(rigctldListenArgs(''), ['-T', '127.0.0.1', '-t', '4532']);
  assert.deepStrictEqual(rigctldListenArgs('abc'), ['-T', '127.0.0.1', '-t', '4532']);
  assert.deepStrictEqual(rigctldListenArgs(0), ['-T', '127.0.0.1', '-t', '4532']);
  assert.deepStrictEqual(rigctldListenArgs(70000), ['-T', '127.0.0.1', '-t', '4532']);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
