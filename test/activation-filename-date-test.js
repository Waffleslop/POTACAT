#!/usr/bin/env node
'use strict';
// POTA names an activation file CALL@PARK-YYYYMMDD.adi with the ACTIVATION's
// UTC date. All three export paths took the date from new Date(), so an
// export made the next morning was named for the wrong day (website session
// 2026-10-21). Run: node test/activation-filename-date-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { activationFileDate } = require('../lib/adif-writer');
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
console.log('Activation export filename date');

const nextMorning = new Date('2026-10-22T13:00:00Z');
test('uses the QSO date, not the export time', () => {
  assert.strictEqual(activationFileDate([{ qsoDate: '20261021', timeOn: '1830' }], nextMorning), '20261021');
});
test('an activation across 0000Z takes the first QSO, in any order', () => {
  assert.strictEqual(activationFileDate([{ qsoDate: '20261022', timeOn: '0010' }, { qsoDate: '20261021', timeOn: '235900' }], nextMorning), '20261021');
});
test('dashed dates are accepted', () => {
  assert.strictEqual(activationFileDate([{ qsoDate: '2026-10-20' }], nextMorning), '20261020');
});
test('no dated QSO falls back to now', () => {
  assert.strictEqual(activationFileDate([{ qsoDate: '' }], nextMorning), '20261022');
  assert.strictEqual(activationFileDate([], nextMorning), '20261022');
});
test('no activation export in main.js dates its file from new Date()', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  for (const ch of ["'export-activation-adif'", "'upload-activation-to-pota'", "'export-activation-adif-perpark'"]) {
    const start = main.indexOf('ipcMain.handle(' + ch);
    assert.ok(start > 0, ch + ' found');
    const body = main.slice(start, main.indexOf('ipcMain.handle(', start + 10));
    assert.ok(/activationFileDate\(qsos\)/.test(body), ch + ' uses activationFileDate');
    assert.ok(!/new Date\(\)/.test(body), ch + ' has no new Date()');
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
