#!/usr/bin/env node
'use strict';
// PARC (Protected Area Radio Community) spot client — pure helpers. The live
// feed was EMPTY at integration time (young program), so these tests pin the
// tolerant-alias contract the normalizer promises. Run: node test/parc-test.js
const assert = require('assert');
const { _normalizeRecord: norm, _parcTimeToUnix: t2u, _parcFreqToKhz: f2k, _unwrapSpots: unwrap } = require('../lib/parc');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

test('time: ISO (bare = UTC), unix seconds, unix ms, junk', () => {
  assert.strictEqual(t2u('2026-08-17T12:00:00Z'), 1786968000);
  assert.strictEqual(t2u('2026-08-17T12:00:00'), 1786968000); // bare ISO treated UTC
  assert.strictEqual(t2u(1786968000), 1786968000);
  assert.strictEqual(t2u(1786968000000), 1786968000);
  assert.strictEqual(t2u('1786968000'), 1786968000);
  assert.strictEqual(t2u('yesterday-ish'), 0);
  assert.strictEqual(t2u(null), 0);
});

test('freq: MHz, kHz (HF + VHF), Hz all land in kHz', () => {
  assert.strictEqual(f2k(14.074), 14074);
  assert.strictEqual(f2k(14074), 14074);
  assert.strictEqual(f2k('14074.5'), 14074.5);
  assert.strictEqual(f2k(144174), 144174);      // 2m in kHz stays kHz
  assert.strictEqual(f2k(14074000), 14074);     // Hz
  assert.strictEqual(f2k(0), 0);
  assert.strictEqual(f2k('nope'), 0);
});

test('unwrap: {spots:[...]} envelope and bare array both work', () => {
  assert.deepStrictEqual(unwrap({ spots: [1, 2], count: 2 }), [1, 2]);
  assert.deepStrictEqual(unwrap([3]), [3]);
  assert.deepStrictEqual(unwrap({ nope: true }), []);
  assert.deepStrictEqual(unwrap(null), []);
});

test('normalize: parks-API-style snake_case record', () => {
  const n = norm({
    activator: 'n3fmc', frequency_khz: 14285, reference: 'us-nc-2540',
    park_name: 'Some State Park', mode: 'ssb', spotter: 'k3sbp',
    comments: 'QRT soon', spotted_at: '2026-08-17T12:00:00Z',
    latitude: 35.5, longitude: -82.5,
  });
  assert.strictEqual(n.activator, 'N3FMC');
  assert.strictEqual(n.frequency_khz, 14285);
  assert.strictEqual(n.reference, 'US-NC-2540');
  assert.strictEqual(n.reference_name, 'Some State Park');
  assert.strictEqual(n.mode, 'SSB');
  assert.strictEqual(n.spot_time, 1786968000);
  assert.strictEqual(n.latitude, 35.5);
});

test('normalize: alias variants (callsign/freq MHz/ref/created_at) accepted', () => {
  const n = norm({ callsign: 'W1AW', freq: 7.19, ref: 'US-ME-0001', created_at: 1786968000 });
  assert.strictEqual(n.activator, 'W1AW');
  assert.strictEqual(n.frequency_khz, 7190);
  assert.strictEqual(n.reference, 'US-ME-0001');
  assert.strictEqual(n.latitude, null);
});

test('normalize: skips no-call, no-freq, and (with warning) no-ref records', () => {
  assert.strictEqual(norm({ frequency: 14074, reference: 'X' }), null);
  assert.strictEqual(norm({ callsign: 'W1AW', reference: 'X' }), null);
  assert.strictEqual(norm({ callsign: 'W1AW', frequency: 14074 }), null); // schema-drift path
  assert.strictEqual(norm(null), null);
});

console.log(`\nPARC: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
