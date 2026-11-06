#!/usr/bin/env node
'use strict';
// No frequency/mode poll while PTT is asserted, and no frequency read acted on
// during TX (kg6odijohn, IC-7100 on a repeater memory: the poll during TX read
// the offset TX frequency and POTACAT acted on it). The meter reads that need
// TX keep going. Every radio type: the controller drops it, and main's CAT
// frequency handler ignores reads while it or the radio is transmitting.
// Run: node test/tx-no-freq-poll-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { RigController } = require('../lib/rig-controller');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
}

function rig() {
  const calls = [];
  const transport = new EventEmitter();
  transport.connect = () => {}; transport.disconnect = () => {}; transport.write = () => {};
  const codec = new EventEmitter();
  for (const m of ['getFrequency', 'getMode', 'getPtt', 'getVfoSplit', 'getSmeter', 'getSwr', 'getAlc', 'getPowerMeter']) codec[m] = () => calls.push(m);
  codec.setTransmit = (on) => calls.push('tx:' + on);
  const rc = new RigController({ brand: 'Icom', protocol: 'civ', caps: {}, cw: {}, pollIntervalMs: 60000 }, transport, codec);
  rc.connected = true;
  rc._target = { host: 'test' };
  return { rc, codec, calls };
}

// One poll cycle, run by hand (the real timer is a minute away and cleared).
function tick(rc) {
  rc._startPolling();       // a pollIntervalMs > 1000 model reads once immediately
  rc._stopPolling();
}

test('receive: the poll reads frequency and mode', () => {
  const { rc, calls } = rig();
  tick(rc);
  assert.ok(calls.includes('getFrequency') && calls.includes('getMode'), calls.join(','));
});

test('transmit: no frequency, mode or VFO poll; the PTT and SWR/ALC reads stay', () => {
  const { rc, calls } = rig();
  rc.setTransmit(true);
  calls.length = 0;
  tick(rc);
  assert.ok(!calls.includes('getFrequency') && !calls.includes('getMode') && !calls.includes('getVfoSplit'), calls.join(','));
  assert.ok(calls.includes('getPtt') && calls.includes('getSwr'), 'meters and PTT still read: ' + calls.join(','));
});

// The fake above has getPtt, which hid the Kenwood case: a codec whose TX
// report rides on the status poll (IF; P8) must still be asked during TX
// (transmit-safety review; test/kenwood-tx-latch-test.js runs the real codec).
test('transmit: a codec with no PTT read of its own is asked for its TX state', () => {
  const { rc, codec, calls } = rig();
  delete codec.getPtt;
  codec.pollPttDuringTx = () => calls.push('pollPttDuringTx');
  rc.setTransmit(true);
  calls.length = 0;
  tick(rc);
  assert.ok(calls.includes('pollPttDuringTx'), calls.join(','));
  rc.setTransmit(false);
  calls.length = 0;
  tick(rc);
  assert.ok(!calls.includes('pollPttDuringTx'), 'not on receive (the VFO/split poll carries it): ' + calls.join(','));
});

test('a frequency that arrives during TX is ignored; on receive it is used again', () => {
  const { rc, codec } = rig();
  const seen = [];
  rc.on('frequency', (hz) => seen.push(hz));
  codec.emit('frequency', 146520000);
  rc.setTransmit(true);
  codec.emit('frequency', 147120000); // the repeater's TX side
  rc.setTransmit(false);
  codec.emit('frequency', 146520000);
  assert.deepStrictEqual(seen, [146520000, 146520000]);
  assert.strictEqual(rc._lastFreqHz, 146520000);
});

test('main ignores a CAT frequency read while POTACAT or the radio transmits', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const i = main.indexOf('function catFrequencyHandler(hz) {');
  const body = main.slice(i, main.indexOf('\n}\n', i));
  assert.ok(/if \(_remoteTxState \|\| \(cat && cat\._transmitting\)\) return;/.test(body), body);
});

console.log(`\nno freq poll in TX: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
