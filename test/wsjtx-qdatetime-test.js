// test/wsjtx-qdatetime-test.js — ik4idf (Logger32 over UDP): QSOs arrived
// dated 30/12/1899 after the DST change. POTACAT's QSO Logged datagram is a
// valid UTC QDateTime (as WSJT-X sends); an invalid date would have gone out
// as Julian day 0, which a Delphi logger shows as 30/12/1899. Guarded.
'use strict';
const assert = require('assert');
const { encodeQsoLogged, encodeLoggedAdif, BinaryReader, parseQsoLogged, MSG, QSO_LOGGED_COMMENT_MAX, qsoLoggedComment } = require('../lib/wsjtx');

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
// The comment is capped at 50 UTF-8 bytes (#754: an accented park name is
// under 50 characters and over 50 bytes); the ADIF record keeps it whole.
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
t('the cap is 50', () => assert.strictEqual(QSO_LOGGED_COMMENT_MAX, 50));
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
// #754: Logger32 counts bytes. The cap is 50 UTF-8 bytes, cut between
// characters, so what goes out is valid UTF-8 and never longer than 50 bytes.
console.log('\nWSJT-X QSO Logged comment cap in UTF-8 bytes (#754):');
const bytes = (s) => Buffer.byteLength(s, 'utf8');
// The comments field as it sits in the datagram: a length, then the bytes.
function wireComment(comments) {
  const buf = encodeQsoLogged('POTACAT', qsoWith(comments));
  const r = new BinaryReader(buf);
  r.readUInt32BE(); r.readUInt32BE(); r.readUInt32BE(); r.readUtf8();   // magic, schema, type, id
  r.readQDateTime();                                                    // dateTimeOff
  for (let i = 0; i < 2; i++) r.readUtf8();                             // dxCall, dxGrid
  r.readUInt64BE();                                                     // txFrequency
  for (let i = 0; i < 4; i++) r.readUtf8();                             // mode, sent, received, txPower
  const len = buf.readUInt32BE(r.offset);
  return buf.subarray(r.offset + 4, r.offset + 4 + len);
}
function sentOk(comments) {
  const raw = wireComment(comments);
  assert.ok(raw.length <= 50, raw.length + ' bytes on the wire');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(raw);   // throws on a cut character
  assert.ok(!/\ufffd/.test(text), 'no replacement character');
  return text;
}
t('an accented park name under 50 characters and over 50 bytes is cut to 50 bytes', () => {
  const park = '[POTA CA-0456 CA-QC Parc national de la Jacques-Cartier, Qu\u00e9bec]';
  const short = '[POTA ES-0123 Parque Do\u00f1ana M\u00e1laga \u00c5land K\u00f6ln \u00e9t]';
  assert.ok(short.length < 50 && bytes(short) > 50, short.length + ' chars, ' + bytes(short) + ' bytes');
  const out = sentOk(short);
  assert.ok(bytes(out) <= 50);
  assert.ok(short.startsWith(out), 'a prefix of the comment, whole characters only');
  assert.ok(bytes(out) >= 48, 'no more is dropped than the cut needs');
  assert.ok(park.startsWith(sentOk(park)));
});
t('the fields after an accented comment still arrive', () => {
  const c = '[POTA SE-0001 ' + '\u00e5'.repeat(30) + ']';       // 45 characters, 75 bytes
  assert.ok(c.length < 50 && bytes(c) > 50);
  const q = decodeQsoLogged(encodeQsoLogged('POTACAT', qsoWith(c)));
  assert.strictEqual(bytes(q.comments), 50);
  assert.strictEqual(q.name, 'Test');
  assert.strictEqual(q.dateTimeOn.toISOString(), ON.toISOString());
  assert.strictEqual(q.myGrid, 'FM19');
});
t('exactly 50 bytes is untouched, ASCII or accented', () => {
  const a = 'A'.repeat(50);
  const b = 'A'.repeat(48) + '\u00e9';
  const c = 'A'.repeat(46) + '\u{1D11E}';
  for (const s of [a, b, c]) {
    assert.strictEqual(bytes(s), 50);
    assert.strictEqual(qsoLoggedComment(s), s);
    assert.strictEqual(sentOk(s), s);
  }
});
t('51 ASCII bytes becomes 50', () => {
  assert.strictEqual(sentOk('A'.repeat(51)), 'A'.repeat(50));
});
t('a 2-byte character straddling byte 50 is dropped whole', () => {
  assert.strictEqual(sentOk('A'.repeat(49) + '\u00f1' + 'tail'), 'A'.repeat(49));
});
t('a 3-byte character straddling byte 50 is dropped whole', () => {
  assert.strictEqual(sentOk('A'.repeat(49) + '\u20ac' + 'tail'), 'A'.repeat(49));
  assert.strictEqual(sentOk('A'.repeat(48) + '\u20ac' + 'tail'), 'A'.repeat(48));
});
t('a 4-byte character straddling byte 50 is dropped whole', () => {
  for (const n of [47, 48, 49]) {
    assert.strictEqual(sentOk('A'.repeat(n) + '\u{1D11E}' + 'tail'), 'A'.repeat(n));
  }
});
t('empty and missing comments are safe', () => {
  for (const v of ['', undefined, null]) {
    assert.strictEqual(qsoLoggedComment(v), '');
    assert.strictEqual(sentOk(v), '');
  }
  assert.strictEqual(qsoLoggedComment(12345), '12345');
});
t('the cap does not change the QSO it was given', () => {
  const c = '[POTA SE-0001 ' + '\u00e5'.repeat(30) + ']';
  const qso = qsoWith(c);
  encodeQsoLogged('POTACAT', qso);
  assert.strictEqual(qso.comments, c);
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
