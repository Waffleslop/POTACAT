#!/usr/bin/env node
'use strict';
/**
 * The phone's CQ target reaches main (K3SBP 2026-10-18: a phone set to
 * Target: DX called a bare CQ). The relay emitted 'jtcat-call-cq' with no
 * fields, and 'jtcat-set-chase-target' had no case at all. Also sweeps the
 * registry: every C2S type must have a case in the demux.
 *
 * Run: node test/cq-target-relay-test.js
 */
require('./ws-stub-if-missing');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { RemoteServer } = require('../lib/remote-server');
const protocol = require('../lib/echocat-protocol');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
function rig() {
  const rs = new RemoteServer();
  const ws = { _authenticated: true, readyState: 1, send: () => {} };
  rs._client = ws;
  return { rs, send: (m) => rs._handleMessage(ws, m, {}) };
}
console.log('CQ target over ECHOCAT');

test('jtcat-call-cq carries the modifier to main', () => {
  const { rs, send } = rig();
  const got = [];
  rs.on('jtcat-call-cq', (e) => got.push(e));
  send({ type: 'jtcat-call-cq', modifier: 'DX' });
  send({ type: 'jtcat-call-cq', modifier: '' });
  send({ type: 'jtcat-call-cq' });
  send({ type: 'jtcat-call-cq', modifier: 7 });
  assert.strictEqual(got.length, 4);
  assert.strictEqual(got[0].modifier, 'DX');
  assert.strictEqual(got[1].modifier, '', 'empty string = deliberate plain CQ');
  assert.strictEqual(got[2].modifier, undefined, 'missing stays undefined so main falls back to the chase target');
  assert.strictEqual(got[3].modifier, undefined, 'a non-string is treated as missing');
});

test('jtcat-set-chase-target reaches main', () => {
  const { rs, send } = rig();
  const got = [];
  rs.on('jtcat-set-chase-target', (e) => got.push(e));
  send({ type: 'jtcat-set-chase-target', tag: 'DX' });
  send({ type: 'jtcat-set-chase-target' });
  assert.deepStrictEqual(got, [{ tag: 'DX' }, { tag: '' }]);
});

test('main falls back to the chase target only when the modifier is missing', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.ok(/remoteServer\.on\('jtcat-call-cq', async \(\{ modifier \} = \{\}\)/.test(src));
  assert.ok(src.includes("modifier != null ? modifier : (settings.jtcatChaseTarget || '')"));
  assert.ok(/remoteServer\.on\('jtcat-set-chase-target', \(\{ tag \} = \{\}\) => \{\s*applyChaseTarget\(tag\)/.test(src));
});

test('every registered C2S type has a case in the demux', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'remote-server.js'), 'utf8');
  // Not top-level messages: auth, pass-leave, pass-take-over and
  // owner-presence are handled before the demux (they come from sockets that
  // may not be admitted: a paused guest, an owner device waiting), and
  // start-audio/sdp/ice travel inside a 'signal' envelope.
  const notTopLevel = new Set(['auth', 'pass-leave', 'pass-take-over', 'owner-presence', 'start-audio', 'sdp', 'ice', 'scan:control']);
  for (const t of ['pass-leave', 'pass-take-over', 'owner-presence']) {
    assert.ok(src.includes("msg.type === '" + t + "'"), t + ' is handled before the demux');
  }
  const missing = Object.entries(protocol.MESSAGES)
    .filter(([t, d]) => d.dir === protocol.Dir.C2S && !notTopLevel.has(t))
    .map(([t]) => t)
    .filter((t) => !src.includes("case '" + t + "'"));
  assert.deepStrictEqual(missing, [], 'C2S types the desktop never handles');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
