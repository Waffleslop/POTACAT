#!/usr/bin/env node
'use strict';
// APRS A1: the message formats (lib/aprs-message.js), one test per rule.
// APRS 1.0.1 chapter 14 (message, ack, rej, 67 characters, 9-character
// addressee, 1-5 character number), aprs.org/aprs11/replyacks.txt (reply-acks),
// aprs-is.net/javAPRSFilter.aspx (the g/ group message filter).
// Run: node test/aprs-message-test.js

const assert = require('assert');
const M = require('../lib/aprs-message');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); }
}

console.log('APRS messages: formats');

test('the addressee field is exactly 9 characters, capitals, padded with spaces', () => {
  assert.strictEqual(M.padAddressee('kc3zzz-7'), 'KC3ZZZ-7 ');
  assert.strictEqual(M.padAddressee('WXBOT'), 'WXBOT    ');
  assert.strictEqual(M.padAddressee('APRS2SOTA'), 'APRS2SOTA');
  assert.strictEqual(M.padAddressee('W'), 'W        ');
});

test('a message: FROM>APZPCT,TCPIP*::ADDRESSEE:text{number', () => {
  assert.strictEqual(M.buildMessage({ from: 'k3sbp-10', to: 'kc3zzz-7', text: 'Thanks for the QSO', id: '12' }),
    'K3SBP-10>APZPCT,TCPIP*::KC3ZZZ-7 :Thanks for the QSO{12');
  assert.strictEqual(M.buildMessage({ from: 'K3SBP-10', to: 'WHO-IS', text: 'K3SBP' }), 'K3SBP-10>APZPCT,TCPIP*::WHO-IS   :K3SBP', 'no number, no {');
});

test('the text is at most 67 characters; 67 goes, 68 is refused in plain words', () => {
  const t67 = 'x'.repeat(67);
  assert.ok(M.buildMessage({ from: 'K3SBP-10', to: 'W1AW', text: t67, id: '1' }).endsWith(':' + t67 + '{1'));
  assert.strictEqual(M.buildMessage({ from: 'K3SBP-10', to: 'W1AW', text: t67 + 'x', id: '1' }), null);
  const c = M.checkText(t67 + 'x');
  assert.strictEqual(c.ok, false);
  assert.strictEqual(c.sentence, 'The message is 68 characters; APRS takes at most 67.');
  assert.deepStrictEqual(M.counter('Thanks for the QSO, see you at the park Saturday'), { n: 48, max: 67, over: false, label: '48 / 67' });
  assert.strictEqual(M.counter(t67 + 'x').over, true);
});

test('| ~ and { are reserved in message text: taken out; non-printable characters become spaces', () => {
  assert.strictEqual(M.cleanText('a|b~c{d'), 'abcd');
  assert.strictEqual(M.cleanText('tab\there'), 'tab here');
  assert.strictEqual(M.checkText('  {{  ').ok, false, 'nothing left is nothing to send');
  assert.strictEqual(M.checkText('').sentence, 'Type a message first.');
});

test('the To field: 1 to 9 letters, digits and -; plain-word refusals', () => {
  assert.deepStrictEqual(M.checkAddressee(' kc3zzz-7 '), { ok: true, call: 'KC3ZZZ-7' });
  assert.strictEqual(M.checkAddressee('EMAIL-2').ok, true);
  assert.strictEqual(M.checkAddressee('APRS2SOTA').ok, true);
  assert.strictEqual(M.checkAddressee('').sentence, 'Type who the message is to.');
  assert.match(M.checkAddressee('ABCDEFGHIJ').sentence, /at most 9 characters/);
  assert.match(M.checkAddressee('K3SBP/P').sentence, /not a call APRS can send to/);
  assert.strictEqual(M.checkAddressee('-K3SBP').ok, false);
});

test('message numbers: 1 to 99999, then 1 again', () => {
  assert.strictEqual(M.nextMessageId(0), 1);
  assert.strictEqual(M.nextMessageId(41), 42);
  assert.strictEqual(M.nextMessageId(99998), 99999);
  assert.strictEqual(M.nextMessageId(99999), 1);
  assert.strictEqual(M.nextMessageId('junk'), 1);
  assert.strictEqual(M.buildMessage({ from: 'K3SBP-10', to: 'W1AW', text: 'hi', id: '123456' }), null, 'six characters is not a number');
});

test('ack and rej: the text is ack or rej and the number, no number of its own', () => {
  assert.strictEqual(M.buildAckLine({ from: 'K3SBP-10', to: 'KC3ZZZ-7', id: '42' }), 'K3SBP-10>APZPCT,TCPIP*::KC3ZZZ-7 :ack42');
  assert.strictEqual(M.buildAckLine({ from: 'K3SBP-10', to: 'KC3ZZZ-7', id: '42', kind: 'rej' }), 'K3SBP-10>APZPCT,TCPIP*::KC3ZZZ-7 :rej42');
  assert.strictEqual(M.buildAckLine({ from: 'K3SBP-10', to: 'KC3ZZZ-7', id: '' }), null);
});

test('reply-acks: the ack copies the whole number ("ackMM}AA")', () => {
  assert.strictEqual(M.buildAckLine({ from: 'K3SBP-10', to: 'KC3ZZZ-7', id: '7}12' }), 'K3SBP-10>APZPCT,TCPIP*::KC3ZZZ-7 :ack7}12');
});

test('parse: a message to us, with its number', () => {
  const p = M.parseMessageLine('KC3ZZZ-7>APDR16,TCPIP*,qAC,T2TEST::K3SBP-10 :What time Saturday?{55\r\n');
  assert.deepStrictEqual(p, { from: 'KC3ZZZ-7', addressee: 'K3SBP-10', kind: 'message', text: 'What time Saturday?', id: '55', ackId: null, replyAck: null });
});

test('parse: ack and rej answer our number', () => {
  assert.deepStrictEqual(M.parseMessageLine('KC3ZZZ-7>APDR16,TCPIP*,qAC,T2TEST::K3SBP-10 :ack12'),
    { from: 'KC3ZZZ-7', addressee: 'K3SBP-10', kind: 'ack', text: '', id: null, ackId: '12', replyAck: null });
  assert.strictEqual(M.parseMessageLine('W1AW>APRS::K3SBP-10 :rej12').kind, 'rej');
  assert.strictEqual(M.parseMessageLine('W1AW>APRS::K3SBP-10 :ack12}').ackId, '12', 'a reply-ack style ack still answers 12');
});

test('parse: a reply-ack number carries a free ack for our message', () => {
  const p = M.parseMessageLine('W1AW>APRS::K3SBP-10 :Sounds good{7}12');
  assert.strictEqual(p.text, 'Sounds good');
  assert.strictEqual(p.id, '7}12');
  assert.strictEqual(p.replyAck, '12');
  const q = M.parseMessageLine('W1AW>APRS::K3SBP-10 :hello{7}');
  assert.strictEqual(q.id, '7}');
  assert.strictEqual(q.replyAck, null);
});

test('parse: a message with no number, a third-party packet, and things that are not messages', () => {
  assert.strictEqual(M.parseMessageLine('W1AW>APRS::K3SBP    :hello').id, null);
  assert.strictEqual(M.parseMessageLine('IGATE>APRS,TCPIP*,qAC,T2:}W1AW>APRS,TCPIP,IGATE*::K3SBP    :via rf{3').from, 'W1AW');
  assert.strictEqual(M.parseMessageLine('W1AW>APRS:!4142.00N/07239.00W-'), null);
  assert.strictEqual(M.parseMessageLine('W1AW>APRS::K3SBP:short'), null, 'the addressee field must be 9 characters');
  assert.strictEqual(M.parseMessageLine('# logresp K3SBP verified'), null);
  assert.strictEqual(M.parseMessageLine(''), null);
});

test('ours: the Settings base with any SSID or none, never a longer call', () => {
  assert.strictEqual(M.isForMe('K3SBP', 'K3SBP'), true);
  assert.strictEqual(M.isForMe('K3SBP-10', 'K3SBP'), true);
  assert.strictEqual(M.isForMe('K3SBP-7', 'k3sbp-10'), true);
  assert.strictEqual(M.isForMe('K3SBPX', 'K3SBP'), false);
  assert.strictEqual(M.isForMe('K3SB', 'K3SBP'), false);
  assert.strictEqual(M.isForMe('K3SBP-', 'K3SBP'), false);
  assert.strictEqual(M.isForMe('K3SBP', ''), false);
});

test('the feed filter for our messages: g/BASE/BASE-* (any SSID), none without a callsign', () => {
  assert.strictEqual(M.messageFilter('K3SBP'), 'g/K3SBP/K3SBP-*');
  assert.strictEqual(M.messageFilter('k3sbp-7'), 'g/K3SBP/K3SBP-*');
  assert.strictEqual(M.messageFilter(''), null);
  assert.strictEqual(M.messageFilter('PCAT'), null);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
