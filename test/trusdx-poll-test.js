#!/usr/bin/env node
'use strict';
// KQ4VUU (tr)uSDX, 2026-09-28: "At 1 second intervals, there is a click
// sound, which not only can be heard (cutting out the signal noise in the
// process) but also seen on the waterfall." The truSDX driver carries the
// radio's audio over the same USB serial link as CAT, and every CAT command
// interrupts the stream; POTACAT polled every second (and, while
// transmitting, asked for meters every cycle). Its WSJT-X users poll every
// 30-80 s. The (tr)uSDX model now polls every 30 s and never during TX.
// Run: node test/trusdx-poll-test.js
const assert = require('assert');
const { EventEmitter } = require('events');
const { RigController } = require('../lib/rig-controller');
const { KenwoodCodec } = require('../lib/codecs/kenwood-codec');
const { RIG_MODELS, getModelList } = require('../lib/rig-models');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
const TRUSDX = RIG_MODELS['(tr)uSDX'];

// Fake timers so a 30 s poll can be tested without waiting 30 s.
function withFakeTimers(fn) {
  const real = { setInterval, clearInterval, now: Date.now };
  let t = 1_000_000;
  const timers = [];
  global.setInterval = (cb, ms) => { const h = { cb, ms, next: t + ms }; timers.push(h); return h; };
  global.clearInterval = (h) => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); };
  Date.now = () => t;
  const advance = (ms) => {
    const end = t + ms;
    for (;;) {
      const due = timers.filter((h) => h.next <= end).sort((a, b) => a.next - b.next)[0];
      if (!due) break;
      t = due.next; due.next += due.ms; due.cb();
    }
    t = end;
  };
  try { fn(advance); } finally { global.setInterval = real.setInterval; global.clearInterval = real.clearInterval; Date.now = real.now; }
}

function rig() {
  const transport = new EventEmitter();
  transport.connect = () => {}; transport.disconnect = () => {}; transport.write = () => {};
  const writes = [];
  const codec = new KenwoodCodec(TRUSDX, (d) => writes.push(String(d)));
  const r = new RigController(TRUSDX, transport, codec);
  r.connected = true;
  r._target = { path: 'COM8' };
  r._lastReadOkMs = Date.now();
  return { r, writes };
}

console.log('(tr)uSDX CAT polling');

test('the model exists, is listed under its own name, and polls slowly and never during TX', () => {
  assert.ok(TRUSDX, 'model missing');
  assert.ok(TRUSDX.pollIntervalMs >= 30000, `poll every ${TRUSDX.pollIntervalMs} ms`);
  assert.strictEqual(TRUSDX.pollDuringTx, false);
  assert.strictEqual(TRUSDX.protocol, 'kenwood');
  assert.ok(getModelList().some((g) => g.models.includes('(tr)uSDX') && /usdx/i.test(g.brand)), 'findable in the picker');
});

test('it reads frequency and mode at once, then only every 30 s', () => {
  withFakeTimers((advance) => {
    const { r, writes } = rig();
    r._startPolling();
    assert.ok(writes.some((w) => /^FA;|^IF;/.test(w)), 'first read happens immediately');
    const first = writes.length;
    advance(29_000);
    assert.strictEqual(writes.length, first, 'nothing sent between polls (each command is a click)');
    advance(1_500);
    assert.ok(writes.length > first, 'the next poll at 30 s');
    r._stopPolling();
  });
});

test('no CAT at all while transmitting (it breaks the transmitted audio)', () => {
  withFakeTimers((advance) => {
    const { r, writes } = rig();
    r._startPolling();
    r._transmitting = true;
    const before = writes.length;
    advance(95_000);
    assert.strictEqual(writes.length, before, `sent during TX: ${writes.slice(before).join(' ')}`);
    r._transmitting = false;
    advance(30_000);
    assert.ok(writes.length > before, 'polling resumes after TX');
    r._stopPolling();
  });
});

test('a healthy radio is not declared down between two 30 s polls', () => {
  withFakeTimers((advance) => {
    const { r } = rig();
    let down = false;
    r.on('status', (s) => { if (s && s.stale) down = true; });
    r._startPolling();
    r._lastReadOkMs = Date.now(); // the immediate read was answered
    advance(60_500); // two polls; the radio answers each
    assert.strictEqual(down, false, 'declared DOWN between polls');
    r._stopPolling();
  });
});

test('every other radio keeps its one-second poll and the 10 s watchdog', () => {
  withFakeTimers((advance) => {
    const transport = new EventEmitter();
    transport.connect = () => {}; transport.disconnect = () => {}; transport.write = () => {};
    const writes = [];
    const TS480 = RIG_MODELS['TS-480'];
    const r = new RigController(TS480, transport, new KenwoodCodec(TS480, (d) => writes.push(String(d))));
    r.connected = true; r._target = { path: 'COM9' }; r._lastReadOkMs = Date.now();
    r._startPolling();
    assert.strictEqual(writes.length, 0, 'no immediate read (unchanged start)');
    advance(1_000);
    assert.ok(writes.length > 0, 'polled after 1 s');
    assert.strictEqual(r._pollStaleMs, 10000);
    r._stopPolling();
  });
});

console.log(`\n(tr)uSDX CAT polling: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
