#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';
//
// lib/activation-program.js — which award program the operator is ACTIVATING
// under. Guards the fix for MY_SIG being hardcoded to 'POTA' in eleven places.
//
// Run:  node test/activation-program-test.js

const AP = require('../lib/activation-program');

let pass = 0;
let fail = 0;
const failures = [];

function assertEq(actual, expected, msg) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; return; }
  fail++;
  failures.push(msg);
  console.log(`  ✗ ${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}
function section(name) { console.log(`\n=== ${name} ===`); }

section('inferParkProgram — shapes it CAN tell apart');
assertEq(AP.inferParkProgram('US-0512'), 'POTA', 'a POTA park ref');
assertEq(AP.inferParkProgram('K-1234'), 'POTA', 'the legacy K- POTA form');
assertEq(AP.inferParkProgram('W4C/CM-001'), 'SOTA', 'a SOTA summit (slash)');
assertEq(AP.inferParkProgram('KFF-1234'), 'WWFF', 'a WWFF reference');
assertEq(AP.inferParkProgram('DLFF-0001'), 'WWFF', 'a non-US WWFF reference');
// B/ must be tested BEFORE the generic slash rule or a bunker reads as a summit.
assertEq(AP.inferParkProgram('B/US-1234'), 'WWBOTA', 'a WWBOTA bunker beats the generic slash rule');

section('inferParkProgram — unrecognised input falls back to POTA');
// This is the safety property the whole change rests on: today's code writes
// POTA unconditionally, so anything this cannot classify must keep doing that.
assertEq(AP.inferParkProgram(''), 'POTA', 'an empty ref');
assertEq(AP.inferParkProgram(null), 'POTA', 'a null ref does not throw');
assertEq(AP.inferParkProgram(undefined), 'POTA', 'an undefined ref does not throw');
assertEq(AP.inferParkProgram('1234'), 'POTA', 'a bare number');

section('inferParkProgram — the blind spot that dictates the design');
// LLOTA (LLCL-0001) and PARC (US-NC-2540) are structurally indistinguishable
// from a POTA ref, so no pattern can classify them. This is precisely why
// `program` is STORED on each entry and inference is only ever a seeder.
// If someone "simplifies" the design back to inferring at log time, these two
// assertions are what tells them the LLOTA and PARC activators just broke.
assertEq(AP.inferParkProgram('LLCL-0001'), 'POTA', 'LLOTA is indistinguishable from POTA by shape — store, never infer');
assertEq(AP.inferParkProgram('US-NC-2540'), 'POTA', 'PARC is likewise indistinguishable — store, never infer');

section('programOf — read-time fallback');
assertEq(AP.programOf({ ref: 'US-1', program: 'SOTA' }), 'SOTA', 'a stored program is honoured');
assertEq(AP.programOf({ ref: 'US-1' }), 'POTA', 'a missing program falls back to POTA');
assertEq(AP.programOf({ ref: 'US-1', program: '' }), 'POTA', 'an empty program falls back to POTA');
assertEq(AP.programOf({ ref: 'US-1', program: 'sota' }), 'SOTA', 'a lowercase stored program is upper-cased');
assertEq(AP.programOf(null), 'POTA', 'a null entry does not throw');

section('normalizeParkRefs — seeding and migration');
assertEq(AP.normalizeParkRefs([{ ref: 'W4C/CM-001', name: 'Cold Mtn' }]),
  [{ ref: 'W4C/CM-001', name: 'Cold Mtn', program: 'SOTA' }],
  'a ref saved before this existed gets its program seeded');
assertEq(AP.normalizeParkRefs([{ ref: 'LLCL-0001', name: '', program: 'LLOTA' }]),
  [{ ref: 'LLCL-0001', name: '', program: 'LLOTA' }],
  'an operator-supplied program survives, even one inference could never guess');
assertEq(AP.normalizeParkRefs([{ name: 'no ref' }, null, { ref: 'US-1' }]),
  [{ ref: 'US-1', name: '', program: 'POTA' }],
  'entries without a ref are dropped, nulls tolerated');
assertEq(AP.normalizeParkRefs(null), [], 'a missing array is an empty array, not a throw');

section('primaryProgram');
assertEq(AP.primaryProgram([{ ref: 'W4C/CM-001', program: 'SOTA' }, { ref: 'US-1', program: 'POTA' }]),
  'SOTA', 'the FIRST ref decides the primary program');
assertEq(AP.primaryProgram([]), 'POTA', 'no refs at all still yields POTA');
assertEq(AP.primaryProgram(undefined), 'POTA', 'undefined still yields POTA');

section('activationMyRefs — the double-count this exists to prevent');
// Before the fix a SOTA-primary operator had to type the summit into BOTH the
// primary field (logged POTA, wrong) and the X-Ref SOTA slot (logged SOTA,
// right) — their upload worked because of the second record. Once the primary
// reports SOTA those are the same record, and the cross-product would emit it
// twice with nothing downstream to catch it.
assertEq(
  AP.activationMyRefs([{ ref: 'W4C/CM-001', program: 'SOTA' }], [{ program: 'SOTA', ref: 'W4C/CM-001' }]),
  [{ sig: 'SOTA', ref: 'W4C/CM-001' }],
  'a cross-ref duplicating the primary collapses to one record');
assertEq(
  AP.activationMyRefs([{ ref: 'W4C/CM-001', program: 'SOTA' }], [{ program: 'SOTA', ref: 'w4c/cm-001' }]),
  [{ sig: 'SOTA', ref: 'W4C/CM-001' }],
  'the dedupe is case-insensitive, and the primary spelling wins');
assertEq(
  AP.activationMyRefs([{ ref: 'US-0512', program: 'POTA' }], [{ program: 'SOTA', ref: 'W4C/CM-001' }]),
  [{ sig: 'POTA', ref: 'US-0512' }, { sig: 'SOTA', ref: 'W4C/CM-001' }],
  'a genuine cross-program reference survives');
// Same reference under two programs is a real 2-fer (a summit inside a park),
// not a duplicate — it must NOT collapse.
assertEq(
  AP.activationMyRefs([{ ref: 'US-0512', program: 'POTA' }], [{ program: 'WWFF', ref: 'US-0512' }]),
  [{ sig: 'POTA', ref: 'US-0512' }, { sig: 'WWFF', ref: 'US-0512' }],
  'the same ref under two different programs is a 2-fer, not a duplicate');
assertEq(
  AP.activationMyRefs([{ ref: 'US-1' }, { ref: 'US-2' }], []),
  [{ sig: 'POTA', ref: 'US-1' }, { sig: 'POTA', ref: 'US-2' }],
  'n-fer primaries come through in order, defaulted to POTA');
assertEq(AP.activationMyRefs(null, null), [], 'both missing is empty, not a throw');
assertEq(
  AP.activationMyRefs([], [{ program: 'SOTA', ref: 'W4C/CM-001' }]),
  [{ sig: 'SOTA', ref: 'W4C/CM-001' }],
  'a cross-ref with no primary still produces a record');

console.log('\n' + '='.repeat(56));
console.log(`Results: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('All tests passed.');
