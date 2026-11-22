#!/usr/bin/env node
'use strict';
/**
 * #914: the pass's general transmit check (tx_enable) judges SSTV as phone,
 * as the pass's own sstv_tx check and the owner's check already do (US Part
 * 97.305: image goes where phone goes). WC5T on an Extra pass, Flex,
 * 2026-11-22: "[pass] TX blocked (Flex): Out of band: 14.230 MHz allows phone
 * modes only on extra privileges."
 *
 * Run: node test/guest-pass-sstv-phone-test.js
 */
const assert = require('assert');
const { PassEnforcement } = require('../lib/pass-enforcement');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

function livePass(cls, short, extra) {
  const pe = new PassEnforcement({ revalidateMs: 0, log: () => {} });
  pe._state = 'active';
  pe._pass = Object.assign({ code: 'TEST', guest_callsign: 'WC5T', privilege_class: cls, privilege_class_short: short, max_power_w: 100 }, extra || {});
  pe._expiresAtMs = Date.now() + 3600_000;
  pe._rigPowerReadable = () => true;
  return pe;
}
const key = (pe, hz, mode) => pe.interceptCatCommand({ type: 'tx_enable', freqHz: hz, mode, currentWatts: 50, powerAgeMs: 0 });

test('WC5T: SSTV on 14.230 MHz under an Extra pass is allowed', () => {
  const r = key(livePass('us_extra', 'extra'), 14230000, 'SSTV');
  assert.strictEqual(r.allowed, true, r.userVisible);
});
test('IMAGE and FAX are judged as phone too', () => {
  assert.strictEqual(key(livePass('us_extra', 'extra'), 14230000, 'IMAGE').allowed, true);
  assert.strictEqual(key(livePass('us_extra', 'extra'), 14230000, 'FAX').allowed, true);
});
test('SSTV in a CW/data-only segment is still refused (14.070, Extra)', () => {
  const r = key(livePass('us_extra', 'extra'), 14070000, 'SSTV');
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.reason, 'out_of_band');
});
test('SSTV where a General has no phone is still refused (14.160, General)', () => {
  const r = key(livePass('us_general', 'general'), 14160000, 'SSTV');
  assert.strictEqual(r.allowed, false);
  assert.ok(/phone modes only/.test(r.userVisible) || /outside/.test(r.userVisible), r.userVisible);
});
test('SSTV inside General phone is allowed (14.230, General)', () => {
  assert.strictEqual(key(livePass('us_general', 'general'), 14230000, 'SSTV').allowed, true);
});
test('a pass that allows PHONE allows SSTV', () => {
  assert.strictEqual(key(livePass('us_extra', 'extra', { allowed_modes: ['PHONE'] }), 14230000, 'SSTV').allowed, true);
});
test('a pass that allows SSTV allows SSTV', () => {
  assert.strictEqual(key(livePass('us_extra', 'extra', { allowed_modes: ['SSTV'] }), 14230000, 'SSTV').allowed, true);
});
test('a CW-only pass still refuses SSTV', () => {
  const r = key(livePass('us_extra', 'extra', { allowed_modes: ['CW'] }), 14230000, 'SSTV');
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.reason, 'mode_not_allowed');
});
test('plain USB phone is unchanged (14.230 Extra allowed, 14.070 refused)', () => {
  assert.strictEqual(key(livePass('us_extra', 'extra'), 14230000, 'USB').allowed, true);
  assert.strictEqual(key(livePass('us_extra', 'extra'), 14070000, 'USB').allowed, false);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
