// test/wsjtx-qdatetime-test.js — ik4idf (Logger32 over UDP): QSOs arrived
// dated 30/12/1899 after the DST change. POTACAT's QSO Logged datagram is a
// valid UTC QDateTime (as WSJT-X sends); an invalid date would have gone out
// as Julian day 0, which a Delphi logger shows as 30/12/1899. Guarded.
'use strict';
const assert = require('assert');
const { encodeQsoLogged } = require('../lib/wsjtx');

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
console.log('\nWSJT-X QDateTime: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
