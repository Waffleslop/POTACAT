#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
// GitHub #109 (edenundo): the bundled rigctld died with "stack smashing
// detected" during G90 FT8 transmit. The G90 answers no CAT while keyed, so
// every poll in an over was a Hamlib timeout. The G90 model now sends no CAT
// during TX, also when it was set up as Other Rig (Hamlib) with no model.
// Run: node test/g90-tx-poll-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { RigController } = require('../lib/rig-controller');
const { RigctldCodec } = require('../lib/codecs/rigctld-codec');
const { RIG_MODELS, GENERIC_CAPS } = require('../lib/rig-models');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
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
const G90 = RIG_MODELS.G90;

test('the G90 model sends no CAT while transmitting', () => {
  assert.strictEqual(G90.pollDuringTx, false);
  assert.strictEqual(G90.hamlib.rigId, 3088);
});

test('a real RigController + rigctld codec writes nothing during an over and resumes after', () => {
  withFakeTimers((advance) => {
    const transport = new EventEmitter();
    transport.connect = () => {}; transport.disconnect = () => {}; transport.write = () => {};
    const writes = [];
    const r = new RigController(G90, transport, new RigctldCodec(G90, (d) => writes.push(String(d))));
    r.connected = true; r._target = { host: '127.0.0.1', port: 4532 }; r._lastReadOkMs = Date.now();
    r._startPolling();
    advance(2_000);
    assert.ok(writes.length > 0, 'polls while receiving');
    r._transmitting = true;
    const before = writes.length;
    advance(15_000);
    assert.strictEqual(writes.length, before, `sent during TX: ${writes.slice(before).join(' | ')}`);
    r._transmitting = false;
    advance(2_000);
    assert.ok(writes.length > before, 'polling resumes after TX');
    r._stopPolling();
  });
});

test('R2: no poll in the first 400 ms after an over ends (the G90 is still unkeying)', () => {
  withFakeTimers((advance) => {
    const transport = new EventEmitter();
    transport.connect = () => {}; transport.disconnect = () => {}; transport.write = () => {};
    const writes = [];
    const r = new RigController(G90, transport, new RigctldCodec(G90, (d) => writes.push(String(d))));
    r.connected = true; r._target = { host: '127.0.0.1', port: 4532 }; r._lastReadOkMs = Date.now();
    r._startPolling();
    r._transmitting = true;
    advance(15_200); // ticks every 500 ms; the over ends 200 ms after one
    r._transmitting = false;
    const before = writes.length;
    advance(300); // the tick 300 ms after key-up
    assert.strictEqual(writes.length, before, `polled ${writes.slice(before).join(' | ')} while the radio unkeys`);
    advance(500); // 800 ms after key-up
    assert.ok(writes.length > before, 'polling (and the PTT read) resumes right after the grace');
    r._stopPolling();
  });
});

test('R2: a radio that answers CAT in TX keeps polling straight after an over', () => {
  withFakeTimers((advance) => {
    const transport = new EventEmitter();
    transport.connect = () => {}; transport.disconnect = () => {}; transport.write = () => {};
    const writes = [];
    const model = GENERIC_CAPS.rigctld;
    const r = new RigController(model, transport, new RigctldCodec(model, (d) => writes.push(String(d))));
    r.connected = true; r._target = { host: '127.0.0.1', port: 4532 }; r._lastReadOkMs = Date.now();
    r._startPolling();
    r._transmitting = true;
    advance(15_200);
    r._transmitting = false;
    const before = writes.length;
    advance(300);
    assert.ok(writes.length > before, 'no grace for a model without pollDuringTx:false');
    r._stopPolling();
  });
});

test('Other Rig (Hamlib) 3088 with no Radio Model borrows the quirk', () => {
  const main = readSrc(path.join(__dirname, '..', 'main.js'));
  const fn = main.slice(main.indexOf('function getActiveRigModel()'), main.indexOf('function getActiveRigModel()') + 2500);
  assert.ok(/m\.hamlib && m\.hamlib\.rigId === hamlibId/.test(fn), 'matched by Hamlib number');
  assert.ok(/twin\.pollDuringTx === false\) return \{ \.\.\.generic, pollDuringTx: false \}/.test(fn), 'only the quirk is borrowed');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
