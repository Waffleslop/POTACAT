#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';
//
// lib/wrl-packet.js — the N1MM ContactInfo packet POTACAT sends to World Radio
// League's Cat Control.
//
// The reported failure (W9TEF, 1.10.16 → 1.10.18, 2026-09-17..19): a QSO logged
// through the Log QSO pop-out never reached WRL —
//
//   [Logbook] Forwarding QSO to wrl at 127.0.0.1:12060: T3ST 7200kHz SSB
//   [Logbook] Forwarding failed: str.replace is not a function
//
// — while finding that same contact in the Logbook and clicking "Resend to
// Logbook" delivered it instantly. The asymmetry WAS the diagnosis: the resend
// path rebuilds the QSO from ADIF text (rawQsoToQsoData), where every field is
// a String, whereas the pop-out sends `txPower` as a Number. The old inline
// escXml called `.replace` on whatever it was handed and threw before a single
// byte went out. Nothing about the callsign mattered — T3ST and W9TEF failed
// identically, which is why a "bad callsign" theory did not survive testing.
//
// Run:  node test/wrl-packet-test.js

const assert = require('assert');
const dgram = require('dgram');
const fs = require('fs');
const path = require('path');
const { escXml, buildWrlContactInfo } = require('../lib/wrl-packet');

let pass = 0;
let fail = 0;
const failures = [];

function check(msg, fn) {
  try { fn(); pass++; } catch (err) {
    fail++;
    failures.push(msg);
    console.log(`  ✗ ${msg}\n      ${err.message}`);
  }
}
function section(name) { console.log(`\n=== ${name} ===`); }

/** Pull one element's text out of the packet. */
function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? m[1] : null;
}

const FIXED_ID = () => '11111111-2222-3333-4444-555555555555';

// Exactly the shape renderer/log-popout.js builds, including the field that
// broke: a Number.
function popoutQso(extra = {}) {
  return {
    callsign: 'T3ST',
    frequency: '7200.0',
    mode: 'SSB',
    band: '40M',
    qsoDate: '20260919',
    timeOn: '155643',
    rstSent: '59',
    rstRcvd: '59',
    txPower: 100,
    sig: '',
    sigInfo: '',
    potaRef: '',
    comment: '',
    ...extra,
  };
}

section('The reported failure');

check('a Number txPower builds instead of throwing', () => {
  const xml = buildWrlContactInfo(popoutQso(), { myCallsign: 'W9TEF', newId: FIXED_ID });
  assert.ok(xml.startsWith('<?xml'), 'packet was not built');
});

check('the numeric power still reaches the packet as text', () => {
  const xml = buildWrlContactInfo(popoutQso(), { myCallsign: 'W9TEF', newId: FIXED_ID });
  assert.strictEqual(tag(xml, 'tx_pwr'), '100');
});

check('pop-out (Number) and resend (String) produce identical packets', () => {
  // This equality is the whole bug: the two paths differed only in type, and
  // one of them silently dropped the QSO.
  const opts = { myCallsign: 'W9TEF', myGrid: 'EN60', newId: FIXED_ID };
  const fromPopout = buildWrlContactInfo(popoutQso({ uuid: 'abc' }), opts);
  const fromResend = buildWrlContactInfo(popoutQso({ uuid: 'abc', txPower: '100' }), opts);
  assert.strictEqual(fromPopout, fromResend);
});

check('every other field survives arriving as a non-string', () => {
  // Nothing upstream guarantees these are text either; the coercion is at the
  // transport so one careless caller cannot cost an operator a contact.
  const xml = buildWrlContactInfo(popoutQso({
    frequency: 7200.0,
    rstSent: 59,
    rstRcvd: 59,
    txPower: 5,
    gridsquare: 0,
    state: 0,
  }), { myCallsign: 'W9TEF', newId: FIXED_ID });
  assert.strictEqual(tag(xml, 'snt'), '59');
  assert.strictEqual(tag(xml, 'rcv'), '59');
  assert.strictEqual(tag(xml, 'rxfreq'), '720000');
  assert.strictEqual(tag(xml, 'tx_pwr'), '5');
});

section('escXml');

check('coerces a number rather than throwing', () => {
  assert.strictEqual(escXml(100), '100');
});
check('escapes the XML metacharacters', () => {
  assert.strictEqual(escXml('a & b < c > d "e"'), 'a &amp; b &lt; c &gt; d &quot;e&quot;');
});
check('empty and nullish values stay empty', () => {
  assert.strictEqual(escXml(''), '');
  assert.strictEqual(escXml(null), '');
  assert.strictEqual(escXml(undefined), '');
});
check('zero does not vanish', () => {
  // `if (!str) return ''` would have swallowed a legitimate 0.
  assert.strictEqual(escXml(0), '0');
});

section('Packet contract (regressions this block has already had)');

check('the QSO uuid rides as the contact ID, dashes stripped (N3VD dedup)', () => {
  const xml = buildWrlContactInfo(popoutQso({ uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }),
    { myCallsign: 'W9TEF', newId: FIXED_ID });
  assert.strictEqual(tag(xml, 'ID'), 'aaaaaaaabbbbccccddddeeeeeeeeeeee');
});

check('real seconds are kept in the timestamp (N3VD same-minute collapse)', () => {
  const xml = buildWrlContactInfo(popoutQso(), { myCallsign: 'W9TEF', newId: FIXED_ID });
  assert.strictEqual(tag(xml, 'timestamp'), '2026-09-19 15:56:43');
});

check('a 4-digit TIME_ON falls back to :00 seconds', () => {
  const xml = buildWrlContactInfo(popoutQso({ timeOn: '1556' }), { myCallsign: 'W9TEF', newId: FIXED_ID });
  assert.strictEqual(tag(xml, 'timestamp'), '2026-09-19 15:56:00');
});

check('the ADIF-style tags ride alongside the N1MM pair (W7DB)', () => {
  const xml = buildWrlContactInfo(popoutQso({
    sig: 'POTA', sigInfo: 'US-0512', potaRef: 'US-0512', state: 'IL', country: 'United States',
  }), { myCallsign: 'W9TEF', myGrid: 'EN60', newId: FIXED_ID });
  assert.strictEqual(tag(xml, 'sig'), 'POTA');
  assert.strictEqual(tag(xml, 'sig_info'), 'US-0512');
  assert.strictEqual(tag(xml, 'pota_ref'), 'US-0512');
  assert.strictEqual(tag(xml, 'state'), 'IL');
  assert.strictEqual(tag(xml, 'contestname'), 'POTA');
  assert.strictEqual(tag(xml, 'my_gridsquare'), 'EN60');
});

check('the park ref rides in the comment, which is the only field WRL keeps', () => {
  const xml = buildWrlContactInfo(popoutQso({ sig: 'POTA', sigInfo: 'US-0512', comment: 'thanks' }),
    { myCallsign: 'W9TEF', newId: FIXED_ID });
  assert.strictEqual(tag(xml, 'comment'), 'thanks [POTA US-0512]');
});

check('empty optional fields emit no element at all', () => {
  const xml = buildWrlContactInfo(popoutQso(), { myCallsign: 'W9TEF', newId: FIXED_ID });
  assert.ok(!xml.includes('<sota_ref>'), 'an empty sota_ref should not be emitted');
  assert.ok(!xml.includes('<state>'), 'an empty state should not be emitted');
});

check('station_callsign falls back to the operator callsign', () => {
  const xml = buildWrlContactInfo(popoutQso(), { myCallsign: 'W9TEF', newId: FIXED_ID });
  assert.strictEqual(tag(xml, 'station_callsign'), 'W9TEF');
  assert.strictEqual(tag(xml, 'mycall'), 'W9TEF');
});

section('Over the wire');

// A real UDP round trip — the failure was on the send path, so the test that
// matters is a listener actually receiving the bytes.
async function wireTest() {
  const server = dgram.createSocket('udp4');
  const received = new Promise((resolve) => server.once('message', (buf) => resolve(buf.toString('utf-8'))));
  await new Promise((resolve) => server.bind(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const xml = buildWrlContactInfo(popoutQso(), { myCallsign: 'W9TEF', newId: FIXED_ID });
  const message = Buffer.from(xml, 'utf-8');
  const client = dgram.createSocket('udp4');
  await new Promise((resolve, reject) => {
    client.send(message, 0, message.length, port, '127.0.0.1', (err) => {
      client.close();
      err ? reject(err) : resolve();
    });
  });

  const text = await Promise.race([
    received,
    new Promise((_, rej) => setTimeout(() => rej(new Error('no packet within 2s')), 2000)),
  ]);
  server.close();

  check('a pop-out QSO with numeric power arrives at the listener', () => {
    assert.strictEqual(tag(text, 'call'), 'T3ST');
    assert.strictEqual(tag(text, 'tx_pwr'), '100');
  });
}

section('The other transports had the same hazard');

// The WSJT-X binary encoder behind HamRS / Log4OM-binary / MacLoggerDX /
// Logger32 writes the same qsoData fields with Buffer.from(s, 'utf-8'), which
// throws on a Number just as escXml did. W9TEF happened to be on WRL; a
// HamRS user logging from the same pop-out would have lost the QSO too.
const { encodeQsoLogged } = require('../lib/wsjtx');

check('a numeric txPower encodes into the WSJT-X QSO_LOGGED datagram', () => {
  const buf = encodeQsoLogged('POTACAT', {
    dxCall: 'T3ST', dxGrid: 'EN60', txFrequency: 7200000, mode: 'SSB',
    reportSent: '59', reportReceived: '59', txPower: 100, comments: '',
  });
  assert.ok(Buffer.isBuffer(buf) && buf.length > 0, 'no datagram was produced');
  assert.ok(buf.includes(Buffer.from('100', 'utf-8')), 'the power did not reach the datagram');
});

check('a numeric frequency/report does not abort the datagram either', () => {
  const buf = encodeQsoLogged('POTACAT', {
    dxCall: 'T3ST', mode: 'SSB', reportSent: 59, reportReceived: 59, txPower: 5,
  });
  assert.ok(Buffer.isBuffer(buf) && buf.length > 0);
});

section('Source guards');

const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf-8');

check('main.js builds the WRL packet through lib/wrl-packet.js', () => {
  assert.ok(mainSrc.includes("require('./lib/wrl-packet')"), 'the module is not required');
  assert.ok(mainSrc.includes('buildWrlContactInfo(qsoData'), 'sendWrlUdp does not call the builder');
});

check('no second escXml has grown back in main.js', () => {
  assert.ok(!/function escXml\s*\(/.test(mainSrc),
    'main.js defines its own escXml again — the coercion lives in lib/wrl-packet.js');
});

check('saveQsoRecord normalizes a supplied txPower to a String', () => {
  assert.ok(mainSrc.includes('qsoData.txPower = String(qsoData.txPower);'),
    'a caller-supplied txPower is no longer coerced in saveQsoRecord');
});

const popoutSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'log-popout.js'), 'utf-8');
check('the Log QSO pop-out no longer emits a bare Number txPower', () => {
  assert.ok(!/txPower:\s*powerInput\.value\s*\?\s*Number\(/.test(popoutSrc),
    'log-popout.js still sends txPower as a Number');
});

wireTest().then(() => {
  console.log('\n' + '='.repeat(52));
  console.log(`Results: ${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log('\nFAILURES:');
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
  console.log('All tests passed.');
}).catch((err) => {
  console.error('\nWire test failed:', err.message);
  process.exit(1);
});
