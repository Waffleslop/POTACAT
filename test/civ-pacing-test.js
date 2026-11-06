#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
// One CI-V command in flight (lib/codecs/civ-codec.js CivPacer).
//
// NA4DQ's IC-7300 on a Mac (2026-11-05, Guest Pass FT8 never keyed): the poll
// tick wrote frequency, mode, PTT and S-meter back to back, and an Icom that
// hears new bytes while it is replying abandons the reply. Only the LAST
// command of each burst was answered: the DATA-mode read (last in the 5th-tick
// burst) every time, the mode (second in every tick) and the RF power
// (mid-burst) never. Mode stayed unknown and the pass could not check its
// power cap, so every FT8 transmission was refused.
//
// The fake radio below does what the real one does: it answers each command
// after a short turnaround, and drops a reply when another frame arrives first.
// Run: node test/civ-pacing-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { CivCodec, CivPacer } = require('../lib/codecs/civ-codec');

let pass = 0, fail = 0;
const queue = [];
function test(name, fn) { queue.push([name, fn]); }

const MODEL = { brand: 'Icom', protocol: 'civ', civAddr: 0x94, caps: { txpower: true }, cw: {}, maxPower: 100 };

/** An IC-7300 on a CI-V line: replies after `turnMs`, abandoned on collision. */
function fakeRadio(turnMs = 8) {
  let codec = null;
  let pending = null;
  const answered = [];
  const reply = (cmd, sub, data) => {
    const bytes = [0xFE, 0xFE, 0xE0, 0x94, cmd];
    if (sub != null) bytes.push(sub);
    bytes.push(...data, 0xFD);
    return Buffer.from(bytes);
  };
  function answer(frame) {
    const cmd = frame[4];
    const sub = frame.length > 6 ? frame[5] : null;
    if (cmd === 0x03) return reply(0x03, null, [0x00, 0x40, 0x07, 0x14, 0x00]);       // 14.074 MHz
    if (cmd === 0x04) return reply(0x04, null, [0x01, 0x01]);                         // USB FIL1
    if (cmd === 0x14 && sub === 0x0A) return reply(0x14, 0x0A, [0x00, 0x64]);         // 100/255
    if (cmd === 0x15 && sub === 0x02) return reply(0x15, 0x02, [0x01, 0x20]);
    if (cmd === 0x1C && sub === 0x00) return reply(0x1C, 0x00, [0x00]);
    if (cmd === 0x1A && sub === 0x06) return reply(0x1A, 0x06, [0x01, 0x01]);
    return Buffer.from([0xFE, 0xFE, 0xE0, 0x94, 0xFB, 0xFD]);                       // ACK
  }
  const write = (buf) => {
    const frame = Buffer.from(buf);
    if (pending) { clearTimeout(pending); pending = null; }   // collision: the reply in progress is lost
    pending = setTimeout(() => {
      pending = null;
      answered.push(frame[4]);
      codec.onData(answer(frame));
    }, turnMs);
  };
  return { write, answered, attach(c) { codec = c; } };
}

function pollBurst(codec) {
  // The shape of one RigController tick plus the 5th-tick burst.
  codec.getFrequency(); codec.getMode(); codec.getPtt && codec.getPtt(); codec.getSmeter();
  codec.getPower(); codec.getDataMode();
}

function collect(codec) {
  const got = { mode: null, power: null, freq: null };
  codec.on('mode', (m) => { got.mode = m; });
  codec.on('power', (w) => { got.power = w; });
  codec.on('frequency', (hz) => { got.freq = hz; });
  return got;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('without pacing, a burst loses every reply but the last (the field symptom)', async () => {
  const radio = fakeRadio();
  const codec = new CivCodec(MODEL, radio.write);
  radio.attach(codec);
  const got = collect(codec);
  pollBurst(codec);
  await wait(60);
  assert.strictEqual(got.mode, null, 'mode never arrives');
  assert.strictEqual(got.power, null, 'power never arrives');
  assert.deepStrictEqual(radio.answered, [0x1A], 'only the last command (DATA mode) is answered');
});

test('with pacing, every command in the burst is answered: frequency, mode and power arrive', async () => {
  const radio = fakeRadio();
  const codec = new CivCodec(MODEL, radio.write, { pace: true });
  radio.attach(codec);
  const got = collect(codec);
  pollBurst(codec);
  await wait(200);
  assert.strictEqual(got.freq, 14074000);
  assert.strictEqual(got.mode, 'USB');
  assert.strictEqual(got.power, Math.round((64 / 255) * 100));
  assert.ok(radio.answered.includes(0x04) && radio.answered.includes(0x14));
});

test('a radio that answers nothing never stalls the queue: each command times out and the next goes', async () => {
  const sent = [];
  const p = new CivPacer((b) => sent.push(b[0]), { replyTimeoutMs: 20 });
  p.send(Buffer.from([1])); p.send(Buffer.from([2])); p.send(Buffer.from([3]));
  assert.deepStrictEqual(sent, [1]);
  await wait(75);
  assert.deepStrictEqual(sent, [1, 2, 3]);
  assert.strictEqual(p.timeouts, 3);
});

test('an identical poll already waiting is not queued twice, and PTT jumps the queue', () => {
  const sent = [];
  const p = new CivPacer((b) => sent.push(b[0]), { replyTimeoutMs: 1000 });
  p.send(Buffer.from([1]));            // in flight
  p.send(Buffer.from([2])); p.send(Buffer.from([2])); p.send(Buffer.from([3]));
  assert.strictEqual(p.pending, 2);
  p.send(Buffer.from([9]), { urgent: true });
  p.replied();
  assert.deepStrictEqual(sent, [1, 9], 'PTT next');
  p.reset();
});

test('the radio\'s own unasked frames (scope stream, transceive) do not count as a reply', () => {
  const sent = [];
  const codec = new CivCodec(MODEL, (b) => sent.push(Buffer.from(b)), { pace: true, replyTimeoutMs: 1000 });
  codec.getMode(); codec.getPower();
  assert.strictEqual(sent.length, 1);
  codec.onData(Buffer.from([0xFE, 0xFE, 0xE0, 0x94, 0x27, 0x00, 0x00, 0x01, 0x11, 0xFD]));   // scope data
  codec.onData(Buffer.from([0xFE, 0xFE, 0x00, 0x94, 0x00, 0x00, 0x40, 0x07, 0x14, 0x00, 0xFD])); // transceive
  assert.strictEqual(sent.length, 1, 'still waiting for the mode reply');
  codec.onData(Buffer.from([0xFE, 0xFE, 0xE0, 0x94, 0x04, 0x01, 0x01, 0xFD]));
  assert.strictEqual(sent.length, 2, 'the mode reply releases the power read');
  codec._pacer.reset();
});

test('the serial and CI-V-over-TCP Icom links ask for pacing per rig; Icom Network is not paced', () => {
  const main = readSrc(path.join(__dirname, '..', 'main.js'));
  const serial = main.slice(main.indexOf("} else if (target.type === 'icom') {"), main.indexOf("} else if (target.type === 'icom') {") + 900);
  assert.ok(/new CivCodec\(model, \(data\) => transport\.write\(data\), \{ pace: civPaceFor\(target\) \}\);/.test(serial));
  assert.ok(/codec = new CivCodec\(model, \(data\) => transport\.write\(data\), \{ pace: civPaceFor\(target\) \}\); \/\/ a real CI-V bus behind the bridge/.test(main));
  assert.ok(/transport = new RsBa1Transport\(\);[\s\S]{0,300}codec = new CivCodec\(model, \(data\) => transport\.write\(data\)\);/.test(main));
});

(async () => {
  for (const [name, fn] of queue) {
    try { await fn(); pass++; console.log('  ok  ' + name); }
    catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
  }
  console.log(`\nCI-V pacing: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
