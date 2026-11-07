#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
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
const KENWOOD = { brand: 'Kenwood', protocol: 'rigctld', caps: {} }; // raw `w PCnnn;` power writes
const YAESU = { brand: 'Yaesu', protocol: 'rigctld', caps: {} };     // raw `w` passthrough for everything but the basics

function makeCodec(model = MODEL) {
  const writes = [];
  const events = [];
  const codec = new RigctldCodec(model, (d) => writes.push(String(d)));
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
    // Once split reads ON, the cycle also asks `i` for the TX frequency
    // (22f41b06, Icom split / VFO B); none of the three is ever latched off.
    assert.deepStrictEqual(writes, i === 0 ? ['v\n', 's\n'] : ['v\n', 's\n', 'i\n']);
    codec.onData(i === 0 ? 'VFOB\n1\nVFOA\n' : 'VFOB\n1\nVFOA\n14075000\n');
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

test('a server that rejects `T` is named once as unable to key (KM4CFT, a logger\'s rigctld emulation)', () => {
  const { codec, logs, events } = makeCodec();
  let unavailable = 0;
  codec.on('ptt-unavailable', () => unavailable++);
  codec.setTransmit(false);                  // the connect safety T 0
  codec.onData('RPRT -11\n');
  assert.strictEqual(unavailable, 1);
  assert.ok(logs.some((l) => /cannot key the radio/.test(l) && /"T 0"/.test(l) && /RPRT -11/.test(l)), logs.join('\n'));
  codec.setTransmit(true);
  codec.onData('RPRT -11\n');
  codec.setTransmit(false);
  codec.onData('RPRT -11\n');
  assert.strictEqual(unavailable, 1, 'said once per connection');
  // A rejected `v` is not a PTT verdict.
  const c2 = makeCodec();
  let u2 = 0;
  c2.codec.on('ptt-unavailable', () => u2++);
  c2.codec.getVfoSplit();
  c2.codec.onData('RPRT -11\n');
  assert.strictEqual(u2, 0);
  // Wiring: the controller carries the flag and main's key-down names it.
  const fs = require('fs');
  const path = require('path');
  const rc = readSrc(path.join(__dirname, '..', 'lib', 'rig-controller.js'));
  assert.ok(/this\._codec\.on\('ptt-unavailable', \(\) => \{ this\.pttUnavailable = true;/.test(rc));
  assert.ok(/this\.pttUnavailable = false;/.test(rc), 'cleared on connect');
  const main = readSrc(path.join(__dirname, '..', 'main.js'));
  assert.ok(/if \(state && cat\.pttUnavailable\) \{\s*sendCatLog\('PTT FAILED: this rigctld server has no PTT/.test(main));
  assert.ok(/cat\.on\('ptt-unavailable'/.test(main), 'the rigctld Network branch raises a notice');
  void events;
});

// #128 (N5XHI, FT-857 through Hamlib with RTS PTT, 1.14.0): "PTT FAILED: this
// rigctld server has no PTT (it answered RPRT -11 to "T")" before every
// key-down of a packet session while the radio keyed every time. The verdict
// had been reached by a reply that was never an answer to `T`: a raw `w`
// write took no slot in the queue, so its rejection shifted onto the `T 1`
// behind it; and ANY failure code on a `T` entry counted, so the RPRT -1 an
// FT-857 answers to the TX-time `l ALC` poll latched it whenever the queue
// was one entry out of step.
test('#128: a rejected raw write ahead of `T 1` is blamed on the raw write, never on PTT', () => {
  const { codec, writes } = makeCodec(KENWOOD);
  let unavailable = 0;
  codec.on('ptt-unavailable', () => unavailable++);
  codec.setTxPowerWatts(50);   // raw `w PC050;` — used to take no slot in the queue
  codec.setTransmit(true);
  assert.deepStrictEqual(writes, ['w PC050;\n', 'T 1\n']);
  codec.onData('RPRT -11\nRPRT 0\n');   // the backend rejects the raw write; PTT is fine
  assert.strictEqual(unavailable, 0, 'the -11 answered the raw write');
  assert.strictEqual(codec._pending.length, 0, 'both entries consumed');
});

test('#128: only RPRT -11 is a verdict — the -1 an FT-857 answers to `l ALC` is not, even one entry out of step', () => {
  const { codec } = makeCodec();
  let unavailable = 0;
  codec.on('ptt-unavailable', () => unavailable++);
  codec.getMode();             // an `m` whose reply never comes
  codec.setTransmit(true);     // T 1 -> RPRT 0
  codec.getAlc();              // l ALC -> RPRT -1 (ft857 get_level has no ALC)
  codec.onData('RPRT 0\nRPRT -1\n');
  assert.strictEqual(unavailable, 0);
});

test('#128: a raw write the radio never answered does not swallow PTT\'s RPRT 0', () => {
  const { codec, writes } = makeCodec(YAESU);
  codec.sendRaw('AC011;');     // the ATU tune on a band change: rigctld prints nothing for a `w` that worked
  codec.setTransmit(true);
  assert.deepStrictEqual(writes, ['w AC011;\n', 'T 1\n']);
  codec.onData('RPRT 0\n');
  assert.strictEqual(codec._pending.length, 0, 'the RPRT 0 is T 1\'s; the raw entry goes with it');
  // ...while a rejection IS the raw write's own answer.
  codec.sendRaw('AC011;');
  codec.setTransmit(true);
  codec.onData('RPRT -11\nRPRT 0\n');
  assert.deepStrictEqual(codec._pending, []);
});

test('#128: entries nothing answered in 3 s are evicted before an RPRT is blamed', () => {
  const { codec, writes } = makeCodec();
  codec.getMode();
  codec._pending[0].ts -= 3500;   // a lost reply from the last cycle
  codec.getVfoSplit();
  codec.onData('RPRT -11\n');     // the backend has no get_vfo
  writes.length = 0;
  codec.getVfoSplit();
  assert.deepStrictEqual(writes, ['s\n'], 'the -11 reached `v`, which is now latched off');
});

test('#128: the verdict names what else was in flight, and a `T` the server accepts withdraws it', () => {
  const { codec, logs } = makeCodec();
  let unavailable = 0, available = 0;
  codec.on('ptt-unavailable', () => unavailable++);
  codec.on('ptt-available', () => available++);
  codec.setTransmit(true);
  codec.getSmeter();
  codec.onData('RPRT -11\n');
  assert.strictEqual(unavailable, 1);
  assert.ok(logs.some((l) => /cannot key the radio/.test(l) && /also in flight: l STRENGTH/.test(l)), logs.join('\n'));
  codec.onData('-30\n');          // the S-meter reply behind it still lands
  codec.setTransmit(false);
  codec.onData('RPRT 0\n');
  assert.strictEqual(available, 1, 'an accepted T withdraws the verdict');
  assert.ok(logs.some((l) => /withdrawn/.test(l)));
  codec.setTransmit(true);
  codec.onData('RPRT -11\n');
  assert.strictEqual(unavailable, 2, 'a later rejection is a new verdict, said again');
  // Wiring: the controller drops its flag on the withdrawal.
  const path = require('path');
  const rc = readSrc(path.join(__dirname, '..', 'lib', 'rig-controller.js'));
  assert.ok(/this\._codec\.on\('ptt-available', \(\) => \{ this\.pttUnavailable = false;/.test(rc));
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
