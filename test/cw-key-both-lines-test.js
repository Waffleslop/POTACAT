#!/usr/bin/env node
'use strict';
// N6UGP, Xiegu X5105 on Linux, 1.14.4, CW on a CW Key Port with an RTS keyer.
//
// 1. 60 s after the last remote client left, the radio went into transmit
//    and stayed there until VFO Stop. The ECHOCAT teardown "key-up" was
//    cwKeyPort.set({ dtr: false }); node-serialport fills a line left out of
//    set() with its default, HIGH, so it raised RTS. Every write to the key
//    port must now name both lines.
// 2. CW typed in ECHOCAT crashed rigctld (SIGSEGV) right after POTACAT sent
//    "L KEYSPD 18": Hamlib's X5105 backend crashes on it. KEYSPD is no longer
//    sent to a backend that cannot send Morse, or whose dump_caps set levels
//    leave KEYSPD out.
//
// Run: node test/cw-key-both-lines-test.js

const assert = require('assert');
const path = require('path');
const { EventEmitter } = require('events');
const { readSrc } = require('./_src');
const { RigctldCodec } = require('../lib/codecs/rigctld-codec');
const { RigController } = require('../lib/rig-controller');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + '\n    ' + (e.stack || e.message)); }
}

const main = readSrc(path.join(__dirname, '..', 'main.js'));

test('every write to the CW Key Port names both DTR and RTS', () => {
  const lines = main.split('\n');
  const calls = [];
  lines.forEach((ln, i) => { if (/cwKeyPort\.set\(/.test(ln)) calls.push(i); });
  assert.ok(calls.length >= 3, 'found the key port writes');
  for (const i of calls) {
    const ln = lines[i];
    const lit = ln.match(/cwKeyPort\.set\((\{[^}]*\})/);
    if (lit) {
      assert.ok(/\bdtr\b/.test(lit[1]) && /\brts\b/.test(lit[1]), `main.js line ${i + 1} names one line only: ${ln.trim()}`);
      continue;
    }
    const id = (ln.match(/cwKeyPort\.set\((\w+)/) || [])[1];
    assert.ok(id, `main.js line ${i + 1}: unexpected set() argument: ${ln.trim()}`);
    const before = lines.slice(Math.max(0, i - 15), i).join('\n');
    const def = before.match(new RegExp(`const ${id} = (\\{[^;]*\\});`));
    assert.ok(def, `main.js line ${i + 1}: ${id} is not built as one object literal just above`);
    assert.ok(/\bdtr\b/.test(def[1]) && /\brts\b/.test(def[1]), `main.js line ${i + 1}: ${id} names one line only: ${def[1]}`);
  }
});

test('the ECHOCAT teardown keys up through dropCwKeyLine', () => {
  const i = main.indexOf('_clientDisconnectGraceTimer = setTimeout(');
  assert.ok(i > 0);
  const body = main.slice(i, i + 6000);
  assert.ok(/dropCwKeyLine\('ECHOCAT client gone'\)/.test(body));
  assert.ok(!/cwKeyPort\.set\(\{ dtr: false \}/.test(body));
});

const HAMLIB = { brand: 'Hamlib', protocol: 'rigctld', caps: {}, cw: {} };
function rig() {
  const transport = new EventEmitter();
  transport.connect = () => {}; transport.disconnect = () => {}; transport.write = () => {};
  const writes = [];
  const codec = new RigctldCodec(HAMLIB, (d) => writes.push(String(d)));
  const r = new RigController(HAMLIB, transport, codec);
  r.connected = true;
  r._lastReadOkMs = Date.now();
  const logs = [];
  codec.on('log', (m) => logs.push(String(m)));
  return { rig: r, codec, writes, logs };
}
const keyspd = (writes) => writes.filter((w) => /^L KEYSPD/.test(w));

test('X5105 (Can send Morse: N): no KEYSPD, said once, the text keyer still gets the speed', () => {
  const { rig: r, codec, writes, logs } = rig();
  codec.probeCaps();
  codec.onData('Caps dump for model: 3089\nModel name:\tX5105\nSet level:\tPREAMP(0..0/0) ATT(0..0/0) AF(0..1/0) RFPOWER(0..1/0)\nCan send Morse:\tN\nRPRT 0\n');
  writes.length = 0;
  r.setCwSpeed(18);
  r.setCwSpeed(20);
  assert.deepStrictEqual(keyspd(writes), []);
  assert.strictEqual(logs.filter((m) => /CW speed is not sent/.test(m)).length, 1);
  assert.strictEqual(r._cwWpm, 20);
  r.disconnect();
});

test('Can send Morse: Y but no KEYSPD among the set levels: no KEYSPD', () => {
  const { rig: r, codec, writes } = rig();
  codec.probeCaps();
  codec.onData('Caps dump for model: 9999\nSet level:\tAF(0..1/0) RFPOWER(0..1/0)\nCan send Morse:\tY\nRPRT 0\n');
  writes.length = 0;
  r.setCwSpeed(22);
  assert.deepStrictEqual(keyspd(writes), []);
  r.disconnect();
});

test('a backend with KEYSPD still gets it', () => {
  const { rig: r, codec, writes } = rig();
  codec.probeCaps();
  codec.onData('Caps dump for model: 3073\nSet level:\tAF(0..1/0) KEYSPD(6..48/1) RFPOWER(0..1/0)\nCan send Morse:\tY\nRPRT 0\n');
  writes.length = 0;
  r.setCwSpeed(22);
  assert.deepStrictEqual(keyspd(writes), ['L KEYSPD 22\n']);
  r.disconnect();
});

test('no dump_caps answer (old rigctld): KEYSPD is sent as before', () => {
  const { rig: r, writes } = rig();
  r.setCwSpeed(25);
  assert.deepStrictEqual(keyspd(writes), ['L KEYSPD 25\n']);
  r.disconnect();
});

console.log(`\nCW key both lines: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
