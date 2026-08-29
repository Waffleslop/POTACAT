#!/usr/bin/env node
'use strict';
/**
 * rigctld response attribution — an RPRT answers ONE command, so it may cancel
 * only that command's pending read.
 *
 * Regression: v1.9.23 added the `v`/`s` VFO+split readback to the poll cycle.
 * Backends without get_vfo (IC-706MKIIG, N4RDX 2026-08-04) answer `v` with
 * RPRT -11 every cycle, and the old handler cleared EVERY outstanding
 * expectation on any RPRT — so the `l STRENGTH` reply still in flight behind
 * it arrived with nothing expecting it and was dropped on the floor. S-meter,
 * SWR and ALC all went dead, on the desktop and in the app.
 *
 * Run: node test/rigctld-attribution-test.js
 */

const assert = require('assert');
const { RigctldCodec } = require('../lib/codecs/rigctld-codec');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${e.message}`);
  }
}

const MODEL = { brand: 'Icom', protocol: 'rigctld', caps: {} };

function makeCodec() {
  const writes = [];
  const events = [];
  const codec = new RigctldCodec(MODEL, (d) => writes.push(String(d)));
  for (const ev of ['smeter', 'swr', 'alc', 'ptt', 'vfo', 'split', 'frequency', 'mode', 'nb']) {
    codec.on(ev, (v) => events.push([ev, v]));
  }
  const logs = [];
  codec.on('log', (l) => logs.push(l));
  return { codec, writes, events, logs };
}

function valueOf(events, name) {
  const hit = events.filter((e) => e[0] === name);
  return hit.length ? hit[hit.length - 1][1] : undefined;
}

// One full poll cycle in the order lib/rig-controller.js sends it.
function poll(codec) {
  codec.getFrequency();
  codec.getMode();
  codec.getPtt();
  codec.getVfoSplit();
  codec.getSmeter();
}

console.log('\n=== rigctld response attribution ===');

test('a healthy backend still parses every poll reply', () => {
  const { codec, events } = makeCodec();
  poll(codec);
  codec.onData('7182000\nLSB\n2400\n0\nVFOA\n0\nVFOA\n-30\n');
  assert.strictEqual(valueOf(events, 'frequency'), 7182000);
  assert.strictEqual(valueOf(events, 'mode'), 'LSB');
  assert.strictEqual(valueOf(events, 'ptt'), false);
  assert.strictEqual(valueOf(events, 'vfo'), 'A');
  assert.strictEqual(valueOf(events, 'split'), false);
  assert.strictEqual(valueOf(events, 'smeter'), 54); // (-30+54)*255/114
});

test('a rejected `v` no longer swallows the S-meter reply (the N4RDX bug)', () => {
  const { codec, events } = makeCodec();
  poll(codec);
  // IC-706MKIIG: get_vfo -> RPRT -11, split answers, STRENGTH answers.
  codec.onData('7182000\nLSB\n2400\n0\nRPRT -11\n0\nVFOA\n-30\n');
  assert.strictEqual(valueOf(events, 'smeter'), 54, 'S-meter must survive the rejection');
  assert.strictEqual(valueOf(events, 'vfo'), undefined);
});

test('rejected `v` AND `s` still leave the S-meter reading', () => {
  const { codec, events } = makeCodec();
  poll(codec);
  codec.onData('7182000\nLSB\n2400\n0\nRPRT -11\nRPRT -11\n-6\n');
  assert.strictEqual(valueOf(events, 'smeter'), 107);
});

test('SWR and ALC survive an unrelated rejection in the same cycle', () => {
  const { codec, events } = makeCodec();
  codec.getVfoSplit();
  codec.getSwr();
  codec.getAlc();
  codec.onData('RPRT -11\nRPRT -11\n1.5\n0.4\n');
  assert.strictEqual(valueOf(events, 'swr'), 30);  // (1.5-1)*60
  assert.strictEqual(valueOf(events, 'alc'), 102); // 0.4*255
});

test('an unsupported `v` is latched off so the poll stops sending it', () => {
  const { codec, writes, logs } = makeCodec();
  codec.getVfoSplit();
  assert.deepStrictEqual(writes, ['v\n', 's\n']);
  codec.onData('RPRT -11\n0\nVFOA\n');
  writes.length = 0;
  codec.getVfoSplit();
  assert.deepStrictEqual(writes, ['s\n'], 'v must not be sent again; s still works');
  assert.ok(logs.some((l) => /no active-VFO readback/.test(l)), 'the give-up is logged once');
});

test('an unsupported `s` is latched off independently of `v`', () => {
  const { codec, writes } = makeCodec();
  codec.getVfoSplit();
  codec.onData('VFOA\nRPRT -11\n');
  writes.length = 0;
  codec.getVfoSplit();
  assert.deepStrictEqual(writes, ['v\n']);
});

test('a working backend is never latched off', () => {
  const { codec, writes } = makeCodec();
  for (let i = 0; i < 5; i++) {
    writes.length = 0;
    codec.getVfoSplit();
    assert.deepStrictEqual(writes, ['v\n', 's\n']);
    codec.onData('VFOB\n1\nVFOA\n');
  }
});

test('a rejected PTT poll is still attributed and latched', () => {
  const { codec, writes } = makeCodec();
  codec.getPtt();
  codec.onData('RPRT -11\n');
  writes.length = 0;
  codec.getPtt();
  assert.deepStrictEqual(writes, [], 'PTT poll gives up as it always did');
});

test('a rejected `v` does not latch PTT off (the mis-blame this fixes)', () => {
  const { codec, writes, events } = makeCodec();
  codec.getPtt();
  codec.getVfoSplit();
  codec.onData('0\nRPRT -11\nRPRT -11\n');
  assert.strictEqual(valueOf(events, 'ptt'), false);
  writes.length = 0;
  codec.getPtt();
  assert.deepStrictEqual(writes, ['t\n'], 'PTT must still be polled');
});

test('a set command\'s RPRT 0 does not cancel a pending read', () => {
  const { codec, events } = makeCodec();
  codec.getSmeter();
  codec.setTransmit(false); // "T 0" -> RPRT 0
  codec.onData('-30\nRPRT 0\n');
  assert.strictEqual(valueOf(events, 'smeter'), 54);
});

test('the pending queue stays bounded when replies never come', () => {
  const { codec } = makeCodec();
  for (let i = 0; i < 200; i++) poll(codec);
  // The cap is a leak guard only. It was 12 until the K6RBJ fix
  // (2026-08-28) proved that smaller than one ~24-command ext cycle,
  // evicting live entries at write time and misattributing the whole
  // cycle - it must exceed the in-flight window, not approximate it.
  assert.ok(codec._pending.length <= 48, `queue grew to ${codec._pending.length}`);
});

// LZ3AW IC-7300 on v1.9.23: an RPRT disarmed the VFO/split expectations and the
// orphaned `VFOA` landed in the catch-all mode branch as a phantom mode every
// poll cycle. Both clients gate PTT and HALT on a voice-mode whitelist, so the
// operator's symptom was "the PTT and HALT buttons disappear a few seconds
// after connecting" while FT8 kept working. Attribution is the real fix; these
// pin the second line of defence, which holds even if _pending ever desyncs.
test('the exact v1.9.23 phantom-mode trace produces no phantom mode', () => {
  const { codec, events } = makeCodec();
  poll(codec);
  codec.onData('7182000\nLSB\n2400\n0\nRPRT -11\n0\nVFOA\n-30\n');
  const modes = events.filter((e) => e[0] === 'mode').map((e) => e[1]);
  assert.deepStrictEqual(modes, ['LSB'], 'VFOA must never be emitted as a mode');
  assert.strictEqual(valueOf(events, 'smeter'), 54, 'and the S-meter survives');
});

test('a VFO/memory name is refused as a mode even with nothing expecting it', () => {
  for (const tok of ['VFOA', 'VFOB', 'VFO', 'MEM', 'MAIN', 'SUB', 'CURRVFO']) {
    const { codec, events } = makeCodec();
    codec.onData(tok + '\n');   // fully desynced — no expectations armed
    assert.deepStrictEqual(events.filter((e) => e[0] === 'mode'), [],
      `${tok} must not reach the mode branch`);
  }
});

test('real modes still pass the never-modes filter', () => {
  const { codec, events } = makeCodec();
  for (const m of ['USB', 'LSB', 'CW', 'FM', 'AM', 'RTTY', 'PKTUSB', 'PKTLSB', 'FREEDV']) {
    codec._expectPassband = false;
    codec.onData(m + '\n');
  }
  const modes = events.filter((e) => e[0] === 'mode').map((e) => e[1]);
  assert.deepStrictEqual(modes,
    ['USB', 'LSB', 'CW', 'FM', 'AM', 'RTTY', 'PKTUSB', 'PKTLSB', 'FREEDV']);
});

test('a frequency reply arriving while the S-meter is pending is not stolen', () => {
  // AB9AI 2026-05-04 — the range guard that made this work must survive.
  const { codec, events } = makeCodec();
  codec.getSmeter();
  codec.onData('14250000\n-30\n');
  assert.strictEqual(valueOf(events, 'frequency'), 14250000);
  assert.strictEqual(valueOf(events, 'smeter'), 54);
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
