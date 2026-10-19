'use strict';
// lib/qso-expand.js — the one definition of the records a logged contact
// becomes (logging parity audit 2026-10-19). Run: node test/qso-expand-test.js
const assert = require('assert');
const { expandContact, defaultRst, utcParts } = require('../lib/qso-expand');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
}

const QRZ = {
  K1A: { name: 'Al Ames', country: 'United States', state: 'MA', county: 'Middlesex', grid: 'FN42' },
  K1B: { name: 'Bea Brown', country: 'United States', state: 'NH', county: 'Grafton', grid: 'FN43' },
  K1C: { name: 'Cy Cole', country: 'United States', state: 'VT', county: 'Windsor', grid: 'FN33' },
};
const PARKS = {
  'US-0001': { states: ['ME'], grid: 'FN54' },
  'US-0002': { states: ['WI', 'MI'], grid: 'EN65' },
  'CA-0100': { states: ['ON'], grid: 'FN25' },
};
const ctx = (over = {}) => ({
  callInfo: (c) => QRZ[c] || null,
  parkInfo: (r) => PARKS[r] || null,
  now: Date.UTC(2026, 9, 19, 14, 5),
  ...over,
});
const base = { callsign: 'K1A', frequency: '14285', mode: 'SSB', band: '20m' };

test('a plain contact is one record, filled from QRZ, RST and time defaulted', () => {
  const r = expandContact(base, ctx());
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].name, 'Al Ames');
  assert.strictEqual(r[0].state, 'MA');
  assert.strictEqual(r[0].county, 'MA,Middlesex');
  assert.strictEqual(r[0].gridsquare, 'FN42');
  assert.strictEqual(r[0].rstSent, '59');
  assert.strictEqual(r[0].qsoDate, '20261019');
  assert.strictEqual(r[0].timeOn, '1405');
  assert.ok(!r[0].skipLogbookForward);
});

test('what the caller typed for callsign 1 wins over QRZ', () => {
  const r = expandContact({ ...base, name: 'Typed Name', state: 'RI' }, ctx());
  assert.strictEqual(r[0].name, 'Typed Name');
  assert.strictEqual(r[0].state, 'RI');
});

test('multi-op: one record per callsign, each with ITS OWN QRZ data (W9TEF)', () => {
  const r = expandContact({ ...base, callsign: 'K1A, K1B,k1c', name: 'Al typed' }, ctx());
  assert.deepStrictEqual(r.map((x) => x.callsign), ['K1A', 'K1B', 'K1C']);
  assert.deepStrictEqual(r.map((x) => x.name), ['Al typed', 'Bea Brown', 'Cy Cole']);
  assert.deepStrictEqual(r.map((x) => x.state), ['MA', 'NH', 'VT'], 'never callsign 1\'s location on the others');
  assert.ok(r.every((x) => !x.skipLogbookForward), 'every callsign is its own QSO: each is forwarded');
});

test('only the very first record re-spots; only it keeps the caller uuid', () => {
  const r = expandContact({ ...base, callsign: 'K1A,K1B', respot: true, respotComment: 'tnx', uuid: 'u-1' }, ctx());
  assert.strictEqual(r[0].respot, true);
  assert.strictEqual(r[0].uuid, 'u-1');
  assert.ok(!('respot' in r[1]) && !('respotComment' in r[1]) && !('uuid' in r[1]));
});

test('a park contact is logged at the park, never the QRZ home QTH (W9TEF)', () => {
  const r = expandContact({ ...base, sig: 'POTA', sigInfo: 'US-0001' }, ctx());
  assert.strictEqual(r[0].state, 'ME');
  assert.strictEqual(r[0].gridsquare, 'FN54');
  assert.strictEqual(r[0].county, '', 'no home county at a park');
  assert.strictEqual(r[0].potaRef, 'US-0001');
  assert.strictEqual(r[0].name, 'Al Ames', 'the name still comes from QRZ');
});

test('a multi-state park logs no state, unless the operator picked one', () => {
  assert.strictEqual(expandContact({ ...base, sig: 'POTA', sigInfo: 'US-0002' }, ctx())[0].state, '');
  assert.strictEqual(expandContact({ ...base, sig: 'POTA', sigInfo: 'US-0002', parkState: 'MI' }, ctx())[0].state, 'MI');
});

test('a park with no data logs no state rather than the home one; a heard grid wins', () => {
  const r = expandContact({ ...base, sig: 'SOTA', sigInfo: 'W1/HA-001', state: 'MA', gridsquare: 'FN44' }, ctx());
  assert.strictEqual(r[0].state, '');
  assert.strictEqual(r[0].gridsquare, '', 'a typed/QRZ grid is the home one');
  const h = expandContact({ ...base, sig: 'SOTA', sigInfo: 'W1/HA-001', gridsquare: 'FN44', gridHeard: true }, ctx());
  assert.strictEqual(h[0].gridsquare, 'FN44');
  assert.ok(!('gridHeard' in h[0]) && !('parkState' in h[0]), 'control fields never reach the record');
});

test('a hunted n-fer: one record per park, POTA_REF per record (web sheet bug), forwarded once', () => {
  const r = expandContact({ ...base, sig: 'POTA', sigInfo: 'US-0001,US-0002', potaRef: 'US-0001,US-0002', comment: 'nice [POTA US-0001]' }, ctx());
  assert.deepStrictEqual(r.map((x) => x.sigInfo), ['US-0001', 'US-0002']);
  assert.deepStrictEqual(r.map((x) => x.potaRef), ['US-0001', 'US-0002']);
  assert.deepStrictEqual(r.map((x) => !!x.skipLogbookForward), [false, true]);
  assert.deepStrictEqual(r.map((x) => x.comment), ['nice', 'nice'], 'the auto tag is re-added per record by saveQsoRecord');
});

test('form shape keeps a secondary program\'s refs; hunted[] gives each record only its own', () => {
  const form = expandContact({ ...base, sig: 'POTA', sigInfo: 'US-0001', wwffRef: 'KFF-1,KFF-2' }, ctx());
  assert.strictEqual(form[0].wwffRef, 'KFF-1,KFF-2');
  const own = expandContact({ ...base, potaRef: 'US-0001', hunted: [{ sig: 'POTA', ref: 'US-0001' }, { sig: 'WWFF', ref: 'KFF-1' }] }, ctx());
  assert.deepStrictEqual(own.map((x) => [x.sig, x.sigInfo, x.potaRef, x.wwffRef]),
    [['POTA', 'US-0001', 'US-0001', undefined], ['WWFF', 'KFF-1', undefined, 'KFF-1']]);
  assert.ok(!('hunted' in own[0]));
});

test('WWBOTA/GMA/PARC set SIG (WWBOTA was dropped by the dialog)', () => {
  for (const sig of ['WWBOTA', 'GMA', 'PARC']) {
    const r = expandContact({ ...base, sig, sigInfo: sig === 'WWBOTA' ? 'B/G-0001' : 'X-1' }, ctx());
    assert.strictEqual(r[0].sig, sig);
  }
});

test('activation: every record × my refs; extra copies never forwarded or re-spotted', () => {
  const my = [{ sig: 'POTA', ref: 'US-9000' }, { sig: 'POTA', ref: 'US-9001' }, { sig: 'WWFF', ref: 'KFF-9' }];
  const r = expandContact({ ...base, callsign: 'K1A,K1B', respot: true, myPotaRef: 'stale' }, ctx({ myRefs: my }));
  assert.strictEqual(r.length, 6);
  assert.deepStrictEqual(r.map((x) => x.callsign + '@' + x.mySigInfo),
    ['K1A@US-9000', 'K1A@US-9001', 'K1A@KFF-9', 'K1B@US-9000', 'K1B@US-9001', 'K1B@KFF-9']);
  assert.deepStrictEqual(r.map((x) => !!x.skipLogbookForward), [false, true, true, false, true, true],
    'JTCAT/WSJT-X used to forward every one of these');
  assert.deepStrictEqual(r.map((x) => !!x.respot), [true, false, false, false, false, false]);
  assert.ok(r.every((x) => !('myPotaRef' in x)), 'a stale MY_*_REF never leaks across my refs');
});

test('defaults: RST by mode, qsoAt is the one time contract', () => {
  assert.strictEqual(defaultRst('CW'), '599');
  assert.strictEqual(defaultRst('FT8'), '-00');
  assert.strictEqual(defaultRst('USB'), '59');
  const r = expandContact({ ...base, qsoAt: Date.UTC(2026, 0, 2, 3, 4) }, ctx());
  assert.deepStrictEqual([r[0].qsoDate, r[0].timeOn], ['20260102', '0304']);
  assert.ok(!('qsoAt' in r[0]));
  const typed = expandContact({ ...base, qsoDate: '20250101', timeOn: '0000', rstSent: '57' }, ctx());
  assert.deepStrictEqual([typed[0].qsoDate, typed[0].timeOn, typed[0].rstSent], ['20250101', '0000', '57']);
  assert.deepStrictEqual(utcParts('2026-10-19T23:59:00Z'), { qsoDate: '20261019', timeOn: '2359' });
});

test('no callsign = no records', () => {
  assert.deepStrictEqual(expandContact({ ...base, callsign: ' , ' }, ctx()), []);
});

console.log(`\nQSO expand: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
