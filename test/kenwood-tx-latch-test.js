#!/usr/bin/env node
'use strict';
// Transmit-safety review of 044bf10d (CRITICAL): the controller stopped the
// frequency/mode/VFO polls while transmitting, and on a Kenwood-protocol radio
// (TS-480/590/2000/890/990, Elecraft, the Flex CAT shim) IF; went with them.
// IF; P8 is the only place such a radio reports TX, so after one hand-mic over
// POTACAT read it as keyed for good: frequency and mode frozen. Real codec,
// real controller, a TS-590 model.
// Run: node test/kenwood-tx-latch-test.js
const assert = require('assert');
const { EventEmitter } = require('events');
const { RigController } = require('../lib/rig-controller');
const { KenwoodCodec } = require('../lib/codecs/kenwood-codec');
const { RIG_MODELS } = require('../lib/rig-models');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
}

// IF; frame: 11-digit freq, 4 step, 6 RIT, then P4..P15. P8 at index 28.
function ifFrame(tx) {
  const s = 'IF' + '00014074000' + '0000' + '+00000' + '0' + '0' + '0' + '00' + (tx ? '1' : '0') + '2' + '0' + '0' + '0' + '0' + '00' + '0' + '0';
  assert.strictEqual(s.charAt(28), tx ? '1' : '0');
  return s + ';';
}

function rig() {
  const writes = [];
  const transport = new EventEmitter();
  transport.connect = () => {}; transport.disconnect = () => {};
  transport.write = (d) => writes.push(String(d));
  const model = Object.assign({}, RIG_MODELS['TS-590S/SG'], { pollIntervalMs: 60000 });
  const codec = new KenwoodCodec(model, (d) => transport.write(d));
  const rc = new RigController(model, transport, codec);
  rc.connected = true;
  rc._target = { host: 'test' };
  return { rc, codec, writes };
}
function tick(rc) { rc._startPolling(); rc._stopPolling(); }

test('a hand-mic over on a TS-590: IF; keeps being asked during TX, and the radio\'s RX report ends it', () => {
  const { rc, codec, writes } = rig();
  const ptt = [];
  rc.on('ptt', (on) => ptt.push(on));
  tick(rc);
  assert.ok(writes.some((w) => w.includes('IF;')), 'receive: IF; is polled');
  codec.onData(ifFrame(true));                 // the operator keys the hand mic
  assert.strictEqual(rc._transmitting, true);
  writes.length = 0;
  tick(rc);
  assert.ok(writes.some((w) => w.includes('IF;')), 'transmit: IF; still asked, so P8 can come back: ' + writes.join(' '));
  assert.ok(!writes.some((w) => /FA;|MD;/.test(w)), 'no frequency or mode read during TX');
  codec.onData(ifFrame(false));                // released
  assert.strictEqual(rc._transmitting, false, 'not latched in transmit');
  assert.deepStrictEqual(ptt, [true, false]);
  writes.length = 0;
  tick(rc);
  assert.ok(writes.some((w) => w.includes('FA;')), 'frequency polled again after the over');
});

test('during TX an IF; reply changes only the TX state, never the VFO or split', () => {
  const { codec } = rig();
  const seen = [];
  codec.on('vfo', (v) => seen.push('vfo:' + v));
  codec.on('split', (s) => seen.push('split:' + s));
  codec.onData(ifFrame(true));
  assert.deepStrictEqual(seen, []);
  codec.onData(ifFrame(false));
  assert.ok(seen.length > 0, 'on receive the VFO/split fields are read as before');
});

test('a radio with its own PTT read (Yaesu TX;) does not add IF; during TX', () => {
  const yaesu = new KenwoodCodec(Object.assign({}, RIG_MODELS['FT-991A'] || { brand: 'Yaesu', protocol: 'kenwood' }), () => {});
  assert.strictEqual(yaesu.pollPttDuringTx(), false);
});

console.log(`\nKenwood TX state during a hand-mic over: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
