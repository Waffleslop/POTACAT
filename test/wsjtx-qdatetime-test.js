// test/wsjtx-qdatetime-test.js — ik4idf (Logger32 over UDP): QSOs arrived
// dated 30/12/1899 after the DST change. POTACAT's QSO Logged datagram is a
// valid UTC QDateTime (as WSJT-X sends); an invalid date would have gone out
// as Julian day 0, which a Delphi logger shows as 30/12/1899. Guarded.
'use strict';
const assert = require('assert');
const { encodeQsoLogged, encodeLoggedAdif, BinaryReader, parseQsoLogged, MSG, QSO_LOGGED_COMMENT_MAX } = require('../lib/wsjtx');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
}
function firstDate(buf) {
  let o = 12; o += 4 + buf.readUInt32BE(o);
  return { jd: Number(buf.readBigInt64BE(o)), ms: buf.readUInt32BE(o + 8), spec: buf.readUInt8(o + 12) };
}
console.log('WSJT-X QDateTime:');
t('a QSO after the DST change is the same UTC instant, timespec UTC', () => {
  const d = firstDate(encodeQsoLogged('POTACAT', { dateTimeOff: new Date('2026-10-26T18:05:30Z') }));
  assert.strictEqual(d.spec, 1);
  assert.strictEqual(new Date((d.jd - 2440588) * 86400000 + d.ms).toISOString(), '2026-10-26T18:05:30.000Z');
});
t('an invalid date never goes out as Julian day 0', () => {
  const d = firstDate(encodeQsoLogged('POTACAT', { dateTimeOff: new Date(NaN) }));
  assert.ok(d.jd > 2460000, 'sent as now, not 1899');
});
// #520 (I3FIY, Logger32): a type 5 comments string longer than 50 characters
// made Logger32 lose the fields after it, so the QSO was dated 30/12/1899.
// The comment is capped at 50 characters; the ADIF record keeps it whole.
function decodeQsoLogged(buf) {
  const r = new BinaryReader(buf);
  r.readUInt32BE(); r.readUInt32BE();            // magic, schema
  const type = r.readUInt32BE();
  r.readUtf8();                                  // id
  assert.strictEqual(type, MSG.QSO_LOGGED);
  return parseQsoLogged(r);
}
const POTA63 = '[POTA US-12601 US-IL,US-WI Hackmatack National Wildlife Refuge]';
const ON = new Date('2026-11-10T14:02:00Z');
const OFF = new Date('2026-11-10T14:03:30Z');
function qsoWith(comments) {
  return {
    dateTimeOff: OFF, dateTimeOn: ON, dxCall: 'I3FIY', dxGrid: 'JN55', txFrequency: 14074000,
    mode: 'FT8', reportSent: '-10', reportReceived: '-12', txPower: '100', comments,
    name: 'Test', operatorCall: 'K3SBP', myCall: 'K3SBP', myGrid: 'FM19',
    exchangeSent: '', exchangeReceived: '',
  };
}
console.log('\nWSJT-X QSO Logged comment cap (#520):');
t('the cap is 50 characters', () => assert.strictEqual(QSO_LOGGED_COMMENT_MAX, 50));
t('a 63-character comment goes out as 50 characters', () => {
  assert.strictEqual(POTA63.length, 63);
  const q = decodeQsoLogged(encodeQsoLogged('POTACAT', qsoWith(POTA63)));
  assert.strictEqual(q.comments.length, 50);
  assert.strictEqual(q.comments, POTA63.slice(0, 50));
});
t('a 50-character comment is unchanged', () => {
  const c50 = POTA63.slice(0, 49) + 'X';
  assert.strictEqual(c50.length, 50);
  assert.strictEqual(decodeQsoLogged(encodeQsoLogged('POTACAT', qsoWith(c50))).comments, c50);
});
t('an empty or missing comment stays empty', () => {
  assert.strictEqual(decodeQsoLogged(encodeQsoLogged('POTACAT', qsoWith(''))).comments, '');
  assert.strictEqual(decodeQsoLogged(encodeQsoLogged('POTACAT', qsoWith(undefined))).comments, '');
});
t('the cut drops trailing whitespace', () => {
  const c = 'A'.repeat(49) + ' ' + 'B'.repeat(10);
  assert.strictEqual(decodeQsoLogged(encodeQsoLogged('POTACAT', qsoWith(c))).comments, 'A'.repeat(49));
});
t('the cut falls on a character boundary', () => {
  const c = 'A'.repeat(49) + '\u{1D11E}' + 'tail';  // a two-unit character at position 50
  const out = decodeQsoLogged(encodeQsoLogged('POTACAT', qsoWith(c))).comments;
  assert.strictEqual(out, 'A'.repeat(49) + '\u{1D11E}');
  assert.ok(!/�/.test(out), 'no broken surrogate');
});
t('dateTimeOn and every field after the comment round-trip', () => {
  const q = decodeQsoLogged(encodeQsoLogged('POTACAT', qsoWith(POTA63)));
  assert.strictEqual(q.dateTimeOff.toISOString(), OFF.toISOString());
  assert.strictEqual(q.dxCall, 'I3FIY');
  assert.strictEqual(q.txPower, '100');
  assert.strictEqual(q.name, 'Test');
  assert.strictEqual(q.dateTimeOn.toISOString(), ON.toISOString());
  assert.strictEqual(q.operatorCall, 'K3SBP');
  assert.strictEqual(q.myCall, 'K3SBP');
  assert.strictEqual(q.myGrid, 'FM19');
});
t('the LOGGED_ADIF record keeps the full comment', () => {
  const adif = '<COMMENT:63>' + POTA63 + ' <EOR>';
  const r = new BinaryReader(encodeLoggedAdif('POTACAT', adif));
  r.readUInt32BE(); r.readUInt32BE(); r.readUInt32BE(); r.readUtf8();
  assert.strictEqual(r.readUtf8(), adif);
});

console.log('\nWSJT-X QDateTime + comment cap: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
