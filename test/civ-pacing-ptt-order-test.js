#!/usr/bin/env node
'use strict';
// Transmit-safety review of CivPacer (HIGH): urgent frames were each pushed to
// the FRONT of the queue, so a key-down waiting behind a poll and a release
// inside the reply window went out poll, TX OFF, TX ON: the radio left keyed
// with the stuck-TX limit already disarmed. Now a PTT set replaces any PTT set
// still waiting, and urgent frames keep their order. Real CivPacer and codec.
// Run: node test/civ-pacing-ptt-order-test.js
const assert = require('assert');
const { CivCodec, CivPacer } = require('../lib/codecs/civ-codec');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
}
const MODEL = { brand: 'Icom', protocol: 'civ', civAddr: 0x94, caps: { txpower: true }, cw: {}, maxPower: 100 };
const name = (b) => {
  if (b[4] === 0x1C && b[5] === 0x00 && b.length === 8) return b[6] ? 'TX ON' : 'TX OFF';
  if (b[4] === 0x03) return 'freq?';
  if (b[4] === 0x04) return 'mode?';
  if (b[4] === 0x15) return 'meter?';
  return b.toString('hex');
};
function paced() {
  const sent = [];
  const codec = new CivCodec(MODEL, (b) => sent.push(name(Buffer.from(b))), { pace: 'always', replyTimeoutMs: 10000 });
  const reply = () => codec._pacer.replied();
  return { codec, sent, reply };
}

test('key-down queued behind a poll, then a release before it goes: the radio is never keyed', () => {
  const { codec, sent, reply } = paced();
  codec.getFrequency();                  // in flight
  codec.setTransmit(true);               // waits
  codec.setTransmit(false);              // released inside the window
  reply(); reply(); reply();
  assert.deepStrictEqual(sent, ['freq?', 'TX OFF'], 'only the newest key state goes out');
  codec._pacer.reset();
});

test('a key-down, then polls, then a release: ON before OFF, both ahead of the polls', () => {
  const { codec, sent, reply } = paced();
  codec.getFrequency();                  // in flight
  codec.getMode(); codec.getSmeter();    // polls waiting
  codec.setTransmit(true);
  reply();                               // TX ON goes
  codec.setTransmit(false);              // while TX ON is in flight
  reply(); reply(); reply(); reply();
  assert.deepStrictEqual(sent, ['freq?', 'TX ON', 'TX OFF', 'mode?', 'meter?']);
  codec._pacer.reset();
});

test('urgent frames keep their order among themselves', () => {
  const sent = [];
  const p = new CivPacer((b) => sent.push(b[0]), { replyTimeoutMs: 10000 });
  p.send(Buffer.from([1]));                      // in flight
  p.send(Buffer.from([2]));                      // poll
  p.send(Buffer.from([7]), { urgent: true });
  p.send(Buffer.from([8]), { urgent: true });
  for (let i = 0; i < 4; i++) p.replied();
  assert.deepStrictEqual(sent, [1, 7, 8, 2]);
  p.reset();
});

test('a full queue drops a poll, never a waiting PTT set', () => {
  const p = new CivPacer(() => {}, { replyTimeoutMs: 10000, maxQueue: 3 });
  const ptt = Buffer.from([0xFE, 0xFE, 0x94, 0xE0, 0x1C, 0x00, 0x00, 0xFD]);
  p.send(Buffer.from([1]));
  p.send(ptt, { urgent: true });
  p.send(Buffer.from([2])); p.send(Buffer.from([3])); p.send(Buffer.from([4]));
  assert.ok(p._queue.some((q) => CivPacer.isPttSet(q.buf)), 'the release is still queued');
  assert.strictEqual(p.pending, 3);
  p.reset();
});

test('a PTT read (1C 00, no data byte) is not a PTT set', () => {
  assert.strictEqual(CivPacer.isPttSet(Buffer.from([0xFE, 0xFE, 0x94, 0xE0, 0x1C, 0x00, 0xFD])), false);
  assert.strictEqual(CivPacer.isPttSet(Buffer.from([0xFE, 0xFE, 0x94, 0xE0, 0x1C, 0x00, 0x01, 0xFD])), true);
});

console.log(`\nCI-V pacing keeps PTT in order: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
