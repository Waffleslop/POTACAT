#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';
// WSPR band-hop schedule regression. Run: node test/wspr-bandhop-test.js

const assert = require('assert');
const B = require('../lib/wspr/bandhop');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fail++; console.log(`FAIL  ${name}\n      ${e.message}`); }
}

const BANDS = ['40m', '20m', '15m'];

check('round-robins one band per slot', () => {
  assert.strictEqual(B.bandForSlot(0, BANDS), '40m');
  assert.strictEqual(B.bandForSlot(1, BANDS), '20m');
  assert.strictEqual(B.bandForSlot(2, BANDS), '15m');
  assert.strictEqual(B.bandForSlot(3, BANDS), '40m'); // wraps
  assert.strictEqual(B.bandForSlot(7, BANDS), '20m');
});

check('dwell holds each band for N cycles', () => {
  assert.strictEqual(B.bandForSlot(0, BANDS, 2), '40m');
  assert.strictEqual(B.bandForSlot(1, BANDS, 2), '40m'); // dwell 2
  assert.strictEqual(B.bandForSlot(2, BANDS, 2), '20m');
  assert.strictEqual(B.bandForSlot(3, BANDS, 2), '20m');
  assert.strictEqual(B.bandForSlot(4, BANDS, 2), '15m');
});

check('nextBand returns the following slot band', () => {
  assert.strictEqual(B.nextBand(0, BANDS), '20m');
  assert.strictEqual(B.nextBand(2, BANDS), '40m'); // wraps
});

check('bandChangesNext is true on hop, false within dwell', () => {
  assert.strictEqual(B.bandChangesNext(0, BANDS, 1), true);   // 40m -> 20m
  assert.strictEqual(B.bandChangesNext(0, BANDS, 2), false);  // 40m -> 40m (dwell)
  assert.strictEqual(B.bandChangesNext(1, BANDS, 2), true);   // 40m -> 20m
});

check('single band never changes', () => {
  assert.strictEqual(B.bandForSlot(5, ['20m']), '20m');
  assert.strictEqual(B.bandChangesNext(5, ['20m'], 1), false);
});

check('empty / null bands -> null', () => {
  assert.strictEqual(B.bandForSlot(3, []), null);
  assert.strictEqual(B.bandForSlot(3, null), null);
  assert.strictEqual(B.nextBand(3, []), null);
});

check('deterministic across "restart" (same slot -> same band)', () => {
  for (let s = 0; s < 50; s++) assert.strictEqual(B.bandForSlot(s, BANDS), B.bandForSlot(s, BANDS));
});

check('negative slot indices are safe', () => {
  assert.strictEqual(typeof B.bandForSlot(-1, BANDS), 'string');
  assert.ok(BANDS.includes(B.bandForSlot(-7, BANDS)));
});

console.log(`\nWSPR band-hop: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
