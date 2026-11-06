#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
// LZ3AW round 7 (TS-480, 2026-09-26): "when the radio is on CW, when I click
// another call on CW, the radio goes there but with an SSB filter" and "the
// VFO pane's filter field shows the right value on SSB but not on CW". In CW
// the passband is an FW slot and nothing read it back, so the display kept
// the last SSB slope width and a CW->CW spot click re-sent it. Now CW reads
// FW; and the same-family tune sends no width (GitHub #85, 709a4d2).
// Run: node test/lz3aw-round7-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { KenwoodCodec } = require('../lib/codecs/kenwood-codec');
const { RIG_MODELS } = require('../lib/rig-models');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
const TS480 = RIG_MODELS['TS-480'];
function make() {
  const writes = [];
  const codec = new KenwoodCodec(TS480, (d) => writes.push(String(d)));
  const passbands = [];
  codec.on('passband', (hz) => passbands.push(hz));
  return { codec, writes, passbands };
}

console.log('LZ3AW round 7');

test('CW: the filter readback asks FW; and reports the slot width', () => {
  const { codec, writes, passbands } = make();
  codec.onData('MD3;');
  writes.length = 0;
  codec.getFilter();
  assert.deepStrictEqual(writes, ['FW;']);
  codec.onData('FW0500;');
  assert.deepStrictEqual(passbands, [500]);
});

test('a radio that answers FW; with "?" is not asked again and raises no error', () => {
  const { codec, writes } = make();
  const errors = [], logs = [];
  codec.on('error', (e) => errors.push(e));
  codec.on('log', (l) => logs.push(l));
  codec.onData('MD3;');
  codec.getFilter();
  codec.onData('?;');
  assert.deepStrictEqual(errors, []);
  assert.ok(logs.some((l) => /does not answer FW/.test(l)));
  writes.length = 0;
  codec.getFilter();
  assert.deepStrictEqual(writes, []);
});

test('SSB still reads the slope pair, not FW', () => {
  const { codec, writes } = make();
  codec.onData('MD2;');
  writes.length = 0;
  codec.getFilter();
  assert.deepStrictEqual(writes, ['SL;', 'SH;']);
});

test('an FW reply in SSB is a slot, not a width, and is not reported as one', () => {
  const { codec, passbands } = make();
  codec.onData('MD2;');
  codec.onData('FW0000;');
  assert.deepStrictEqual(passbands, []);
});

test('AM maps the slot value to its width', () => {
  const { codec, passbands } = make();
  codec.onData('MD5;');
  codec.onData('FW0001;');
  assert.deepStrictEqual(passbands, [2400]);
});

test('a same-family (CW->CW) tune sends no width', () => {
  const main = readSrc(path.join(__dirname, '..', 'main.js')).replace(/\r\n/g, '\n');
  assert.ok(/  if \(sameCategory\) \{[\s\S]{0,700}?filterWidth = 0;\n  \} else if \(m === 'CW'\) \{/.test(main));
});

// TinyMidi paddle, "no change" through rounds 4-7: the TS-480 model says
// paddleKey 'ta', no codec implements TA, and the fallback was bare CAT PTT
// on top of the CW Key Port's real keying.
test('the TS-480 codec cannot key with TA, so the controller says so', () => {
  const { RigController } = require('../lib/rig-controller');
  const { EventEmitter } = require('events');
  const transport = new EventEmitter();
  transport.write = () => {}; transport.connected = true;
  const rig = new RigController(TS480, transport, new KenwoodCodec(TS480, () => {}));
  assert.strictEqual(rig.supportsCwKeyTa(), false);
});

test('the paddle takes the TA route only when the codec supports it', () => {
  const main = readSrc(path.join(__dirname, '..', 'main.js'));
  assert.ok(/paddleMethod === 'ta' && cwCaps\.taKey && typeof cat\.supportsCwKeyTa === 'function' && cat\.supportsCwKeyTa\(\)/.test(main));
});

console.log(`\nLZ3AW round 7: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
