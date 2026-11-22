#!/usr/bin/env node
'use strict';
// APRS phase 4: the receive-only iGate's rules (lib/aprs-igate.js), one test
// per rule. The rules and where each comes from (checked 2026-11-18):
//   aprs-is.net/IGating.aspx       "IGating RF to APRS-IS"
//   aprs-is.net/IGateDetails.aspx  "IGate Details"
//   aprs-is.net/q.aspx             "q Construct"
//   aprs-is.net/ServerDesign.aspx  duplicate checking
//   aprs-is.net/Connecting.aspx    the login line
// Run: node test/aprs-igate-test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Igate = require('../lib/aprs-igate');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

const CALL = 'K3ABC-10';
const gate = (line) => Igate.gateLine(line, CALL);

// ── receive only ─────────────────────────────────────────────────────────────
test('receive only: RF to APRS-IS, and nothing from APRS-IS goes anywhere', () => {
  assert.strictEqual(Igate.DIRECTION, 'rf-to-is');
  const ig = Igate.createIgate({ call: CALL, send: () => true });
  assert.deepStrictEqual(Object.keys(ig).sort(), ['offer', 'stats']);
  // main.js: lines the uplink receives are never handed on (no listener at all).
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.ok(!/aprsUplink\.on\(\s*['"]line['"]/.test(main), 'the uplink has no line listener in main.js');
  assert.ok(/aprsIgateOfferRf\(/.test(main), 'RF frames reach the iGate');
});

// ── what is not gated ────────────────────────────────────────────────────────
test('TCPIP or TCPXX in the path: it came from the internet, not gated', () => {
  assert.strictEqual(gate('W1AW>APRS,TCPIP*:>hello').reason, 'from-internet');
  assert.strictEqual(gate('W1AW>APRS,WIDE1-1,TCPXX*:>hello').reason, 'from-internet');
  assert.strictEqual(gate('W1AW>APRS,TCPIP:>hello').reason, 'from-internet');
  assert.strictEqual(gate('W1AW>APRS,tcpip*:>hello').reason, 'from-internet');
});

test('NOGATE or RFONLY in the path: not gated', () => {
  assert.strictEqual(gate('W1AW>APRS,NOGATE:>hello').reason, 'nogate');
  assert.strictEqual(gate('W1AW>APRS,WIDE1-1*,RFONLY:>hello').reason, 'nogate');
  assert.strictEqual(gate('W1AW>APRS,WIDE2-1,NOGATE*:>hello').reason, 'nogate');
});

test('a path that already holds a q construct came off APRS-IS: not gated', () => {
  assert.strictEqual(gate('W1AW>APRS,qAR,W2XYZ:>hello').reason, 'from-internet');
  assert.strictEqual(gate('W1AW>APRS,WIDE1*,qAO,W2XYZ:>hello').reason, 'from-internet');
});

test('generic queries (data type ?) are not gated', () => {
  assert.strictEqual(gate('W1AW>APRS,WIDE1-1:?APRS?').reason, 'query');
  assert.strictEqual(gate('W1AW>APRS:?IGATE?').reason, 'query');
  // A directed query is a message (data type :), which is gated.
  assert.ok(gate('W1AW>APRS::K3ABC    :?APRSP').ok);
});

test('third party (data type }): with TCPIP or TCPXX inside, not gated', () => {
  assert.strictEqual(gate('W2XYZ>APRS,WIDE1-1:}W1AW>APRS,TCPIP,W2XYZ*:>hi').reason, 'from-internet');
  assert.strictEqual(gate('W2XYZ>APRS:}W1AW>APRS,TCPXX,W2XYZ*:>hi').reason, 'from-internet');
});

test('third party without TCPIP: the RF header and the } are stripped, the inner packet is gated', () => {
  const r = gate('W2XYZ>APRS,WIDE1-1*:}W1AW>APOT21,WIDE2-1:!4130.00N/07200.00W-home');
  assert.ok(r.ok, r.reason);
  assert.strictEqual(r.out, 'W1AW>APOT21,WIDE2-1,qAO,K3ABC-10:!4130.00N/07200.00W-home');
  // The rules apply to the inner packet as well.
  assert.strictEqual(gate('W2XYZ>APRS:}W1AW>APRS,NOGATE:>hi').reason, 'nogate');
  assert.strictEqual(gate('W2XYZ>APRS:}W1AW>APRS:?APRS?').reason, 'query');
});

test('control characters in the data: not gated (the data may never be changed)', () => {
  assert.strictEqual(gate('W1AW>APRS:>hello\rthere').reason, 'bad-data');
  assert.strictEqual(gate('W1AW>APRS:>hello\nthere').reason, 'bad-data');
  assert.strictEqual(gate('W1AW>APRS:>hello\u0000').reason, 'bad-data');
});

test('a bad header or empty data: not gated', () => {
  assert.strictEqual(gate('').reason, 'bad-header');
  assert.strictEqual(gate('no header here').reason, 'bad-header');
  assert.strictEqual(gate('W1AW>APRS:').reason, 'bad-header');
  assert.strictEqual(gate('W1 AW>APRS:>x').reason, 'bad-header');
});

// ── the q construct ──────────────────────────────────────────────────────────
test('only ,qAO,<igate call> is added, at the end of the path; nothing else changes', () => {
  assert.strictEqual(Igate.Q_CONSTRUCT, 'qAO');
  const lines = [
    'K1ABC-9>T2TQ5U,WIDE1-1,WIDE2-1:`c51l k/]"4(}=',
    'W1AW>APDR16,KB1XYZ-1*,WIDE2-1:=4130.00N/07200.00W-PHG2360 Newington',
    'N0XYZ>APRS::K3ABC    :hello{12',
    'W1AW>APRS:>status text with  two spaces ',
  ];
  for (const l of lines) {
    const r = gate(l);
    assert.ok(r.ok, l + ' -> ' + r.reason);
    const colon = l.indexOf(':');
    assert.strictEqual(r.out, l.slice(0, colon) + ',qAO,' + CALL + l.slice(colon));
  }
  // No path at all: the q construct follows the destination.
  assert.strictEqual(gate('W1AW>APRS:>hi').out, 'W1AW>APRS,qAO,K3ABC-10:>hi');
});

// ── duplicates ───────────────────────────────────────────────────────────────
test('no duplicate within 30 s: same source, destination (SSID ignored) and data; the path is ignored', () => {
  assert.strictEqual(Igate.DUPE_WINDOW_MS, 30000);
  let t = 1000000;
  const sent = [];
  const ig = Igate.createIgate({ call: CALL, send: (l) => { sent.push(l); return true; }, now: () => t });
  assert.ok(ig.offer('W1AW>APRS,WIDE1-1:>hi').ok);
  t += 2000;
  assert.strictEqual(ig.offer('W1AW>APRS,KB1XYZ-1*,WIDE2-1:>hi').reason, 'duplicate', 'a digipeated copy');
  assert.strictEqual(ig.offer('W1AW>APRS-3,WIDE1-1:>hi').reason, 'duplicate', 'destination SSID ignored');
  assert.ok(ig.offer('W1AW>APRS,WIDE1-1:>hi there').ok, 'other data is not a duplicate');
  assert.ok(ig.offer('W1AW-1>APRS,WIDE1-1:>hi').ok, 'another SSID is another source');
  t += 28001; // 30.001 s after the first
  assert.ok(ig.offer('W1AW>APRS,WIDE1-1:>hi').ok, 'after the window it goes again');
  assert.strictEqual(sent.length, 4);
});

// ── the login ────────────────────────────────────────────────────────────────
test('the login names the software and its version, one word each', () => {
  const l = Igate.loginLine({ call: 'K3ABC-10', version: '1.14.7' });
  assert.strictEqual(l, 'user K3ABC-10 pass ' + require('../lib/aprs-passcode').aprsPasscode('K3ABC') + ' vers POTACAT 1.14.7');
  assert.ok(/vers POTACAT 1\.14\.7-beta$/.test(Igate.loginLine({ call: 'K3ABC-10', version: '1.14.7 -beta' })), 'no spaces in the version');
  assert.ok(!/filter/.test(l), 'an uplink asks for no feed');
});

test('the iGate call: the Settings callsign with SSID -10; placeholders and bad calls refused in a plain sentence', () => {
  assert.deepStrictEqual(Igate.uplinkLogin('k3abc'), { ok: true, call: 'K3ABC-10', base: 'K3ABC' });
  assert.deepStrictEqual(Igate.uplinkLogin('K3ABC-7'), { ok: true, call: 'K3ABC-10', base: 'K3ABC' });
  const none = Igate.uplinkLogin('');
  assert.strictEqual(none.ok, false); assert.strictEqual(none.reason, 'no-call');
  assert.strictEqual(none.sentence, 'Set your callsign in Settings first.');
  for (const p of ['N0CALL', 'NOCALL', 'n0call-5', 'PCAT1234']) {
    const r = Igate.uplinkLogin(p);
    assert.strictEqual(r.reason, 'placeholder', p);
    assert.ok(/is a placeholder\. Set your own callsign in Settings\.$/.test(r.sentence), r.sentence);
  }
  for (const b of ['K3ABC/P', 'ABCDEFG1', 'KKK', '12345']) assert.strictEqual(Igate.uplinkLogin(b).reason, 'invalid', b);
});

test('verified only: "# logresp CALL verified" counts, "unverified" never does', () => {
  assert.strictEqual(Igate.logrespVerified('# logresp K3ABC-10 verified, server T2TEST', 'K3ABC-10'), true);
  assert.strictEqual(Igate.logrespVerified('# logresp K3ABC-10 unverified, server T2TEST', 'K3ABC-10'), false);
  assert.strictEqual(Igate.logrespVerified('# logresp W1AW-10 verified, server T2TEST', 'K3ABC-10'), false, 'someone else');
  assert.strictEqual(Igate.logrespVerified('# aprsc 2.1.14 verified', 'K3ABC-10'), false);
});

test('logrespForLog: the server line as it came, one line, no passcode ever', () => {
  assert.strictEqual(Igate.logrespForLog('# logresp K3ABC-10 verified, server T2TEST'), '# logresp K3ABC-10 verified, server T2TEST');
  assert.strictEqual(Igate.logrespForLog('# logresp K3ABC-10 unverified, server T2TEST\r\n'),'# logresp K3ABC-10 unverified, server T2TEST');
  const echoed = Igate.logrespForLog('# logresp K3ABC-10 unverified, server T2TEST (user K3ABC-10 pass 12345 vers POTACAT 1)');
  assert.ok(!/12345/.test(echoed) && /pass \*\*\*/.test(echoed), echoed);
  assert.strictEqual(Igate.logrespForLog(null), '');
  assert.ok(Igate.logrespForLog('# logresp ' + 'x'.repeat(500)).length <= 200);
});

// ── counts ───────────────────────────────────────────────────────────────────
test('stats: gated count, the last one gated, and what was dropped', () => {
  let t = 5000;
  const ig = Igate.createIgate({ call: CALL, send: () => true, now: () => t });
  ig.offer('W1AW>APRS:>a');
  t = 9000;
  ig.offer('W2XYZ>APRS:>b');
  ig.offer('W2XYZ>APRS,TCPIP*:>c');
  ig.offer('W2XYZ>APRS:?APRS?');
  const s = ig.stats();
  assert.strictEqual(s.gated, 2);
  assert.strictEqual(s.lastAt, 9000);
  assert.strictEqual(s.lastFrom, 'W2XYZ');
  assert.strictEqual(s.dropped['from-internet'], 1);
  assert.strictEqual(s.dropped.query, 1);
});

test('nothing is counted as gated when the send fails (not verified)', () => {
  const ig = Igate.createIgate({ call: CALL, send: () => false });
  const r = ig.offer('W1AW>APRS:>a');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'not-sent');
  assert.strictEqual(ig.stats().gated, 0);
  // and it is not remembered as a duplicate, so the next copy may go
  const ig2 = Igate.createIgate({ call: CALL, send: (() => { let n = 0; return () => n++ > 0; })() });
  ig2.offer('W1AW>APRS:>a');
  assert.ok(ig2.offer('W1AW>APRS,WIDE1*:>a').ok);
});

// Casey 2026-11-19: "iGate off during a Guest Pass", whoever started listening.
test('during a Guest Pass the iGate gates nothing and says why; it resumes when the pass ends', () => {
  assert.strictEqual(Igate.igatePause({ guestPass: false }), null);
  const p = Igate.igatePause({ guestPass: true });
  assert.strictEqual(p.reason, 'guest-pass');
  assert.strictEqual(p.sentence, 'iGate paused: a guest has the radio');
  let guest = true;
  const sent = [];
  const ig = Igate.createIgate({ call: CALL, send: (l) => { sent.push(l); return true; }, paused: () => Igate.igatePause({ guestPass: guest }) });
  const r = ig.offer('W1AW>APRS,WIDE1*:>held');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'guest-pass');
  assert.strictEqual(sent.length, 0, 'nothing sent');
  assert.strictEqual(ig.stats().dropped['guest-pass'], 1);
  guest = false;
  assert.ok(ig.offer('W1AW>APRS,WIDE1*:>after').ok, 'gates again once the pass is over');
  assert.strictEqual(sent.length, 1);
});

console.log(`\nAPRS iGate: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
