#!/usr/bin/env node
'use strict';
// #988: which QSO a Logbook edit or delete means (lib/qso-identity.js).
// A record is named by idx + identity; the identity wins over the index, and
// no single match is a refusal, never a write to another record.
// Run: node test/qso-identity-test.js
const assert = require('assert');
const QsoIdentity = require('../lib/qso-identity');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
}

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const rec = (call, date, extra) => Object.assign({ CALL: call, QSO_DATE: date, TIME_ON: '120000', BAND: '20M', MODE: 'SSB' }, extra || {});

test('of() picks the uuid and the five key fields, nothing else', () => {
  const id = QsoIdentity.of({ idx: 3, CALL: 'K1ABC', QSO_DATE: '20261120', TIME_ON: '1200', BAND: '20m', MODE: 'SSB', COMMENT: 'x', APP_POTACAT_UUID: U1, _cqz: 5 });
  assert.deepStrictEqual(id, { APP_POTACAT_UUID: U1, CALL: 'K1ABC', QSO_DATE: '20261120', TIME_ON: '1200', BAND: '20m', MODE: 'SSB' });
  assert.deepStrictEqual(QsoIdentity.of({ CALL: 'K1ABC', BAND: '' }), { CALL: 'K1ABC' }, 'empty fields are left out');
});

test('both uuids: the uuid alone decides', () => {
  assert.ok(QsoIdentity.matches(rec('K1ABC', '20261120', { APP_POTACAT_UUID: U1 }), { APP_POTACAT_UUID: U1, CALL: 'OTHER' }));
  assert.ok(!QsoIdentity.matches(rec('K1ABC', '20261120', { APP_POTACAT_UUID: U1 }), QsoIdentity.of(rec('K1ABC', '20261120', { APP_POTACAT_UUID: U2 }))));
});

test('no uuid on either side: CALL, QSO_DATE, TIME_ON, BAND, MODE, case- and HHMM-blind', () => {
  const r = rec('K1ABC', '20261120');
  assert.ok(QsoIdentity.matches(r, { CALL: 'k1abc ', QSO_DATE: '2026-11-20', TIME_ON: '1200', BAND: '20m', MODE: 'ssb' }));
  assert.ok(!QsoIdentity.matches(r, QsoIdentity.of(rec('K1ABC', '20261121'))));
  assert.ok(!QsoIdentity.matches(r, QsoIdentity.of(rec('K1ABC', '20261120', { BAND: '40M' }))));
  assert.ok(!QsoIdentity.matches(r, QsoIdentity.of(rec('K1ABC', '20261120', { MODE: 'CW' }))));
  assert.ok(!QsoIdentity.matches(r, QsoIdentity.of(rec('K1ABC', '20261120', { TIME_ON: '120100' }))));
});

test('a record that got its uuid on its first edit still matches the uuid-less identity the page holds', () => {
  const inFile = rec('K1ABC', '20261120', { APP_POTACAT_UUID: U1 });
  assert.ok(QsoIdentity.matches(inFile, QsoIdentity.of(rec('K1ABC', '20261120'))));
});

test("the phone's guard fields (expectCall / expectTime) are an identity", () => {
  assert.deepStrictEqual(QsoIdentity.fromRequest({ idx: 4, expectCall: 'K1ABC', expectTime: '1200' }), { CALL: 'K1ABC', TIME_ON: '1200' });
  assert.strictEqual(QsoIdentity.fromRequest({ idx: 4 }), null, 'an older client sends none');
  const id = { CALL: 'K1ABC' };
  assert.strictEqual(QsoIdentity.fromRequest({ idx: 4, identity: id, expectCall: 'X' }), id, 'identity wins');
  assert.ok(QsoIdentity.matches(rec('K1ABC', '20261120'), { CALL: 'K1ABC', TIME_ON: '1200' }));
});

test('locate: the record at idx when it matches', () => {
  const log = [rec('AA1A', '20261120'), rec('BB2B', '20261121'), rec('CC3C', '20261122')];
  assert.deepStrictEqual(QsoIdentity.locate(log, 1, QsoIdentity.of(log[1])), { index: 1 });
});

test('locate: a stale idx is followed to the one record that matches', () => {
  const log = [rec('AA1A', '20261120'), rec('BB2B', '20261121'), rec('CC3C', '20261122')];
  assert.deepStrictEqual(QsoIdentity.locate(log, 0, QsoIdentity.of(log[2])), { index: 2, moved: true });
  assert.deepStrictEqual(QsoIdentity.locate(log, 9, QsoIdentity.of(log[2])), { index: 2, moved: true });
});

test('locate: refuses when nothing matches, or more than one record does and idx is not one of them', () => {
  const log = [rec('AA1A', '20261120'), rec('BB2B', '20261121'), rec('BB2B', '20261121')];
  const gone = QsoIdentity.locate(log, 0, QsoIdentity.of(rec('ZZ9Z', '20261120')));
  assert.strictEqual(gone.reason, 'not-found');
  assert.strictEqual(gone.error, QsoIdentity.NOT_FOUND);
  assert.strictEqual(QsoIdentity.locate(log, 0, { CALL: 'BB2B' }).reason, 'ambiguous');
  assert.deepStrictEqual(QsoIdentity.locate(log, 2, { CALL: 'BB2B' }), { index: 2 }, 'idx breaks the tie when it matches');
});

test('locate: no identity keeps the index-only behaviour (older clients)', () => {
  const log = [rec('AA1A', '20261120'), rec('BB2B', '20261121')];
  assert.deepStrictEqual(QsoIdentity.locate(log, 1, null), { index: 1, legacy: true });
  assert.deepStrictEqual(QsoIdentity.locate(log, 1, {}), { index: 1, legacy: true });
  assert.strictEqual(QsoIdentity.locate(log, 5, undefined).reason, 'invalid-index');
  assert.strictEqual(QsoIdentity.locate(log, -1, null).reason, 'invalid-index');
});

test('the refusal text is plain and says nothing was changed', () => {
  for (const t of [QsoIdentity.NOT_FOUND, QsoIdentity.AMBIGUOUS]) {
    assert.ok(/^Nothing was changed/.test(t));
    assert.ok(!/[\u{1F300}-\u{1FAFF}]/u.test(t), 'no emoji');
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
