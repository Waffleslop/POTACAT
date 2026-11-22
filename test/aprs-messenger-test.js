#!/usr/bin/env node
'use strict';
// APRS A1: the messenger (lib/aprs-messenger.js) on a fake clock with fake
// APRS-IS lines: the retry schedule (30 s, 60 s, 120 s, 5 min, five tries),
// stop on ack / rej / Stop, the link wait, acks we owe, duplicates, unread
// counts, the bounds and the saved file.
// Run: node test/aprs-messenger-test.js

const assert = require('assert');
const { createMessenger, MAX_TRIES, statusWords } = require('../lib/aprs-messenger');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); }
}

function rig({ up = true } = {}) {
  const r = { t: 1000000, sent: [], up };
  r.m = createMessenger({ now: () => r.t, send: (l) => { if (!r.up) return false; r.sent.push(l); return true; }, canSend: () => r.up, myCall: 'K3SBP-10', myBase: 'K3SBP' });
  r.at = (sec) => { r.t += sec * 1000; return r.m.tick(); };
  return r;
}
const msgOf = (r, call) => r.m.thread(call).filter((x) => x.dir === 'out').pop();
const IN = (body) => 'KC3ZZZ-7>APDR16,TCPIP*,qAC,T2TEST::' + body;

console.log('APRS messenger');

test('compose queues; the first try goes out at once on tick, "Sending, try 1 of 5"', () => {
  const r = rig();
  const c = r.m.compose('kc3zzz-7', 'Around 15z on 14.062 CW');
  assert.ok(c.ok);
  assert.strictEqual(c.msg.state, 'queued');
  assert.strictEqual(statusWords(c.msg), 'Waiting for APRS-IS');
  const wake = r.m.tick();
  assert.deepStrictEqual(r.sent, ['K3SBP-10>APZPCT,TCPIP*::KC3ZZZ-7 :Around 15z on 14.062 CW{1']);
  assert.strictEqual(wake, 30000);
  assert.strictEqual(msgOf(r, 'KC3ZZZ-7').status, 'Sending, try 1 of 5');
});

test('retry schedule: 30 s, 60 s, 120 s, 5 min, then 5 min more and "No reply after 5 tries"', () => {
  const r = rig();
  r.m.compose('KC3ZZZ-7', 'hello');
  r.m.tick();
  assert.strictEqual(r.at(29.9), 100, 'not yet');
  assert.strictEqual(r.sent.length, 1);
  assert.strictEqual(r.at(0.1), 60000); assert.strictEqual(r.sent.length, 2);
  assert.strictEqual(r.at(60), 120000); assert.strictEqual(r.sent.length, 3);
  assert.strictEqual(r.at(120), 300000); assert.strictEqual(r.sent.length, 4);
  assert.strictEqual(r.at(300), 300000); assert.strictEqual(r.sent.length, 5);
  assert.strictEqual(msgOf(r, 'KC3ZZZ-7').status, 'Sending, try 5 of 5');
  assert.strictEqual(r.at(300), null, 'nothing waiting');
  assert.strictEqual(r.sent.length, MAX_TRIES, 'never a sixth');
  assert.strictEqual(msgOf(r, 'KC3ZZZ-7').state, 'failed');
  assert.strictEqual(msgOf(r, 'KC3ZZZ-7').status, 'No reply after 5 tries');
  assert.ok(r.sent.every((l) => l.endsWith(':hello{1')), 'every try is the same line, same number');
});

test('an ack stops the retries: "Delivered (ack)"', () => {
  const r = rig();
  r.m.compose('KC3ZZZ-7', 'hello');
  r.m.tick();
  const res = r.m.receive(IN('K3SBP-10 :ack1'));
  assert.deepStrictEqual(res, { changed: true, kind: 'ack', call: 'KC3ZZZ-7' });
  assert.strictEqual(msgOf(r, 'KC3ZZZ-7').status, 'Delivered (ack)');
  assert.strictEqual(r.at(600), null);
  assert.strictEqual(r.sent.length, 1);
});

test('a rej stops the retries: "Rejected (rej)"', () => {
  const r = rig();
  r.m.compose('KC3ZZZ-7', 'hello');
  r.m.tick(); r.at(30);
  r.m.receive(IN('K3SBP-10 :rej1'));
  assert.strictEqual(msgOf(r, 'KC3ZZZ-7').state, 'rejected');
  r.at(600);
  assert.strictEqual(r.sent.length, 2);
});

test('an ack for another number, or from another station, changes nothing', () => {
  const r = rig();
  r.m.compose('KC3ZZZ-7', 'hello');
  r.m.tick();
  assert.strictEqual(r.m.receive(IN('K3SBP-10 :ack9')).changed, false);
  assert.strictEqual(r.m.receive('W1AW>APRS::K3SBP-10 :ack1').changed, false);
  assert.strictEqual(msgOf(r, 'KC3ZZZ-7').state, 'sending');
});

test('Stop ends the retries', () => {
  const r = rig();
  const { msg } = r.m.compose('KC3ZZZ-7', 'hello');
  r.m.tick();
  assert.strictEqual(r.m.stop(msg.lid), true);
  assert.strictEqual(msgOf(r, 'KC3ZZZ-7').status, 'Stopped');
  r.at(600);
  assert.strictEqual(r.sent.length, 1);
  assert.strictEqual(r.m.stop(msg.lid), false, 'already stopped');
});

test('a late ack after "No reply" still marks it delivered', () => {
  const r = rig();
  r.m.compose('KC3ZZZ-7', 'hello');
  r.m.tick(); r.at(30); r.at(60); r.at(120); r.at(300); r.at(300);
  assert.strictEqual(msgOf(r, 'KC3ZZZ-7').state, 'failed');
  r.m.receive(IN('K3SBP-10 :ack1'));
  assert.strictEqual(msgOf(r, 'KC3ZZZ-7').state, 'delivered');
});

test('a reply-ack inside their message counts as the ack for ours', () => {
  const r = rig();
  r.m.compose('KC3ZZZ-7', 'hello');
  r.m.tick();
  r.m.receive(IN('K3SBP-10 :hi back{4}1'));
  assert.strictEqual(msgOf(r, 'KC3ZZZ-7').state, 'delivered');
  assert.strictEqual(r.sent[1], 'K3SBP-10>APZPCT,TCPIP*::KC3ZZZ-7 :ack4}1', 'their number acked as an exact copy');
});

test('message numbers count up across messages and survive the saved file', () => {
  const r = rig();
  r.m.compose('W1AW', 'one'); r.m.compose('W1AW', 'two');
  r.m.tick();
  assert.ok(r.sent[0].endsWith('{1') && r.sent[1].endsWith('{2'));
  const saved = JSON.parse(JSON.stringify(r.m.serialize()));
  const r2 = rig();
  r2.m.load(saved);
  r2.m.compose('W1AW', 'three');
  r2.m.tick();
  assert.ok(r2.sent.pop().endsWith(':three{3'));
});

test('no link: the message waits ("Waiting for APRS-IS"), goes when the link is verified', () => {
  const r = rig({ up: false });
  r.m.compose('KC3ZZZ-7', 'hello');
  assert.strictEqual(r.m.tick(), 5000);
  assert.strictEqual(msgOf(r, 'KC3ZZZ-7').state, 'queued');
  r.at(5);
  r.up = true;
  r.at(5);
  assert.strictEqual(r.sent.length, 1);
  assert.strictEqual(msgOf(r, 'KC3ZZZ-7').status, 'Sending, try 1 of 5');
});

test('no link for two minutes: "APRS-IS could not be reached", nothing sent', () => {
  const r = rig({ up: false });
  r.m.compose('KC3ZZZ-7', 'hello');
  r.m.tick();
  for (let i = 0; i < 24; i++) r.at(5);
  assert.strictEqual(msgOf(r, 'KC3ZZZ-7').state, 'failed');
  assert.strictEqual(msgOf(r, 'KC3ZZZ-7').status, 'APRS-IS could not be reached, so it was not sent');
  assert.strictEqual(r.m.needsLink(), false);
});

test('a message to us is shown, counted unread and acked over the internet at once', () => {
  const r = rig();
  const res = r.m.receive(IN('K3SBP    :What time Saturday?{55'));
  assert.deepStrictEqual(res, { changed: true, kind: 'message', call: 'KC3ZZZ-7' });
  assert.deepStrictEqual(r.sent, ['K3SBP-10>APZPCT,TCPIP*::KC3ZZZ-7 :ack55']);
  assert.strictEqual(r.m.unread(), 1);
  assert.deepStrictEqual(r.m.list().map((c) => [c.call, c.unread, c.last]), [['KC3ZZZ-7', 1, 'What time Saturday?']]);
  assert.strictEqual(r.m.markRead('kc3zzz-7'), true);
  assert.strictEqual(r.m.unread(), 0);
  const t = r.m.thread('KC3ZZZ-7');
  assert.strictEqual(t.length, 1);
  assert.strictEqual(t[0].via, 'internet');
});

test('any SSID of ours counts; a longer call does not; a message with no number is shown and not acked', () => {
  const r = rig();
  assert.strictEqual(r.m.receive(IN('K3SBP-7  :to my HT{1')).kind, 'message');
  assert.strictEqual(r.m.receive(IN('K3SBPX   :not mine{2')).kind, null);
  assert.strictEqual(r.m.receive(IN('K3SBP    :no number')).kind, 'message');
  assert.strictEqual(r.sent.length, 1);
  assert.strictEqual(r.m.unread(), 2);
});

test('duplicates within 30 s: dropped, no second ack; a later copy (their retry) is acked again, shown once', () => {
  const r = rig();
  r.m.receive(IN('K3SBP-10 :hello{7'));
  assert.strictEqual(r.m.receive(IN('K3SBP-10 :hello{7')).kind, 'duplicate');
  r.t += 29000;
  assert.strictEqual(r.m.receive(IN('K3SBP-10 :hello{7')).kind, 'duplicate');
  assert.strictEqual(r.sent.length, 1, 'one ack for one copy');
  r.t += 31000;
  assert.strictEqual(r.m.receive(IN('K3SBP-10 :hello{7')).kind, 'retry-copy');
  assert.strictEqual(r.sent.length, 2, 'their retry means our ack was lost: ack again');
  assert.strictEqual(r.m.thread('KC3ZZZ-7').length, 1, 'shown once');
  assert.strictEqual(r.m.unread(), 1);
});

test('an ack we owe with no link waits up to 60 s for it, then is dropped', () => {
  const r = rig({ up: false });
  r.m.receive(IN('K3SBP-10 :hello{7'));
  assert.strictEqual(r.m.needsLink(), true, 'main asks for the uplink');
  r.at(5);
  r.up = true;
  r.at(5);
  assert.deepStrictEqual(r.sent, ['K3SBP-10>APZPCT,TCPIP*::KC3ZZZ-7 :ack7']);
  assert.strictEqual(r.m.needsLink(), false);
  const r2 = rig({ up: false });
  r2.m.receive(IN('K3SBP-10 :hello{7'));
  r2.at(61);
  assert.strictEqual(r2.m.needsLink(), false);
});

test('refusals in plain words: no callsign, own call, empty, too long', () => {
  const r = rig();
  assert.strictEqual(r.m.compose('K3SBP-10', 'hi').sentence, 'K3SBP-10 is your own call.');
  assert.strictEqual(r.m.compose('W1AW', '').sentence, 'Type a message first.');
  assert.match(r.m.compose('W1AW', 'x'.repeat(68)).sentence, /at most 67/);
  const n = createMessenger({ myCall: '', myBase: '' });
  assert.strictEqual(n.compose('W1AW', 'hi').sentence, 'Set your callsign in Settings first.');
});

test('our own lines coming back over the feed are not messages to us', () => {
  const r = rig();
  assert.strictEqual(r.m.receive('K3SBP-10>APZPCT,TCPIP*,qAC,T2::K3SBP-7  :note to self{3').kind, null);
});

test('bounded: 200 messages a conversation, 100 conversations, never one still sending', () => {
  const r = rig();
  for (let i = 0; i < 230; i++) { r.t += 1000; r.m.receive(IN(`K3SBP    :n${i}`)); }
  assert.strictEqual(r.m.thread('KC3ZZZ-7').length, 200);
  assert.strictEqual(r.m.thread('KC3ZZZ-7')[0].text, 'n30');
  r.m.compose('W0OLD', 'still going');
  r.m.tick();
  for (let i = 0; i < 120; i++) { r.t += 1000; r.m.receive(`W${i}AA>APRS::K3SBP    :hi`); }
  assert.strictEqual(r.m.list().length, 100);
  assert.ok(r.m.list().some((c) => c.call === 'W0OLD'), 'a conversation with a message going out stays');
});

test('the saved file: a message still going out comes back as "Not sent: POTACAT closed"', () => {
  const r = rig();
  r.m.compose('KC3ZZZ-7', 'hello');
  r.m.tick();
  r.m.receive(IN('K3SBP-10 :reply{2'));
  const r2 = rig();
  r2.m.load(JSON.parse(JSON.stringify(r.m.serialize())));
  const out = msgOf(r2, 'KC3ZZZ-7');
  assert.strictEqual(out.state, 'failed');
  assert.strictEqual(out.status, 'Not sent: POTACAT closed');
  assert.strictEqual(r2.m.unread(), 1);
  assert.strictEqual(r2.m.needsLink(), false);
  r2.m.load({ v: 1, convos: [null, { call: 5 }, { call: 'X', msgs: [{ dir: 'evil', text: 1 }] }] });
  assert.deepStrictEqual(r2.m.list().map((c) => c.call), ['X']);
  assert.deepStrictEqual(r2.m.thread('X'), []);
  r2.m.load('garbage');
  assert.deepStrictEqual(r2.m.list(), []);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
