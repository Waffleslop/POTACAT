#!/usr/bin/env node
'use strict';
// TX power from the phone (ECHOCAT #85, handoff 2026-11-22): a log-qso may
// carry txPower, a number in watts. A valid one is kept on the contact as the
// operator typed it; anything else (absent, 0, negative, NaN, a string, over
// 10 kW) leaves txPower unset, so saveQsoRecord fills it as it always has
// (the radio's power, then Default TX Power, then empty; lib/log-tx-power.js).
// log-ok records carry the saved power, and hello lists 'log-tx-power'.
// Run: node test/phone-tx-power-test.js
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const LogTxPower = require('../lib/log-tx-power');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

const R = (f) => readSrc(path.join(__dirname, '..', f));
const main = R('main.js');

test('a valid power from the device is kept, as a String', () => {
  assert.strictEqual(typeof LogTxPower.deviceTxPower, 'function', 'lib/log-tx-power.js exports deviceTxPower');
  assert.strictEqual(LogTxPower.deviceTxPower(5), '5');
  assert.strictEqual(LogTxPower.deviceTxPower(0.5), '0.5');
  assert.strictEqual(LogTxPower.deviceTxPower(100), '100');
  assert.strictEqual(LogTxPower.deviceTxPower(10000), '10000');
});

test('0, negative, NaN, a string, over 10000 and absent give null (the existing fill applies)', () => {
  assert.strictEqual(typeof LogTxPower.deviceTxPower, 'function');
  for (const v of [0, -5, NaN, Infinity, -Infinity, '5', '', 'abc', '5 W', 10000.5, 20000, undefined, null, true, {}, []]) {
    assert.strictEqual(LogTxPower.deviceTxPower(v), null, JSON.stringify(v) + ' (' + typeof v + ')');
  }
});

test('log-qso: the entry takes the phone\'s power through deviceTxPower, else leaves it unset', () => {
  const h = main.slice(main.indexOf("remoteServer.on('log-qso',"));
  const body = h.slice(0, h.indexOf('await logContact(entry'));
  assert.ok(body.length > 0, 'log-qso handler found');
  assert.ok(/const tp = LogTxPower\.deviceTxPower\(data\.txPower\);\s*\n\s*if \(tp\) entry\.txPower = tp;/.test(body),
    'log-qso sets entry.txPower only from LogTxPower.deviceTxPower(data.txPower)');
  assert.ok(!/txPower:\s/.test(body.slice(body.indexOf('const entry = {'), body.indexOf('};', body.indexOf('const entry = {')))),
    'the entry literal never sets txPower (absent stays absent so saveQsoRecord fills it)');
});

test('saveQsoRecord still fills only an empty power and keeps a supplied one', () => {
  const save = main.slice(main.indexOf('async function saveQsoRecord(qsoData, opts) {'));
  const fill = save.slice(save.indexOf('if (!qsoData.txPower) {'));
  assert.ok(/if \(!qsoData\.txPower\) \{[\s\S]{0,400}\} else \{\s*\n\s*qsoData\.txPower = String\(qsoData\.txPower\);/.test(fill));
});

test('log-ok records include txPower', () => {
  const m = main.match(/const LOG_OK_SAVED_FIELDS = \[([^\]]*)\];/);
  assert.ok(m, 'LOG_OK_SAVED_FIELDS found');
  assert.ok(/'txPower'/.test(m[1]), 'txPower is a saved field on log-ok records');
  const src = main.slice(main.indexOf('function logOkSavedFields'), main.indexOf('async function logContact'));
  const fields = new Function('return [' + m[1] + '];')();
  const logOkSavedFields = new Function('LOG_OK_SAVED_FIELDS', src + '; return logOkSavedFields;')(fields);
  assert.strictEqual(logOkSavedFields({ callsign: 'K3SBP', txPower: '5' }).txPower, '5');
  assert.ok(!('txPower' in logOkSavedFields({ callsign: 'K3SBP', txPower: '' })), 'an empty power is not sent');
});

test('hello lists the log-tx-power capability', () => {
  const rs = R('lib/remote-server.js');
  const i = rs.indexOf("capabilities: ['idle-mode'");
  assert.ok(i > 0, 'hello capabilities list found');
  const list = rs.slice(i, rs.indexOf('],', i));
  assert.ok(list.includes("'log-tx-power'"), "'log-tx-power' in the hello capabilities");
});

test('the protocol doc names txPower on log-qso and the capability', () => {
  const doc = R('docs/echocat-protocol.md');
  const row = doc.split('\n').find((l) => l.startsWith('| `log-qso` |')) || '';
  assert.ok(/`txPower`/.test(row), 'log-qso row documents txPower');
  assert.ok(/`log-tx-power`/.test(row), 'log-qso row names the capability');
  const ok = doc.split('\n').find((l) => l.startsWith('| `log-ok` |')) || '';
  assert.ok(/`txPower`/.test(ok), 'log-ok row says records carry txPower');
});

test('Guest Pass: a guest\'s log-qso still takes the guest path, and that path writes the guest\'s power', () => {
  const save = main.slice(main.indexOf('async function saveQsoRecord(qsoData, opts) {'));
  const guestAt = save.indexOf('return passGuestLogContact(qsoData, ctx, canReceive, origin);');
  assert.ok(guestAt > 0, 'saveQsoRecord sends a guest contact to passGuestLogContact');
  const g = main.slice(main.indexOf('function passGuestLogContact('));
  const gb = g.slice(0, g.indexOf('\n}\n'));
  assert.ok(/fields: buildAdifFields\(qsoData\)/.test(gb), 'the guest contact is written from qsoData (TX_PWR from txPower)');
  assert.ok(!/txPower/.test(gb), 'the guest path never overwrites the guest\'s own power');
  assert.ok(/\['TX_PWR', qso\.txPower\]/.test(R('lib/adif-writer.js')));
});

console.log(`\nPhone TX power: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
