#!/usr/bin/env node
'use strict';
// Worked-before policy (lib/worked-before.js) — the rework window and the
// program-activator exception (KQ4MHD 2026-08-17). Run: node test/worked-before-test.js
const assert = require('assert');
const { decideWorkedBefore, utcDateStamp, cutoffStamp } = require('../lib/worked-before');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

const TODAY = '20260817';
const BASE = { band: '20M', mode: 'FT8', todayUtc: TODAY };
const entry = (over) => ({ date: '20260601', ref: '', myRef: '', band: '20M', mode: 'FT8', ...over });

test('date helpers: stamp + cutoff cross month/year boundaries', () => {
  assert.strictEqual(utcDateStamp(new Date(Date.UTC(2026, 7, 17, 23, 59))), '20260817');
  assert.strictEqual(cutoffStamp('20260817', 14), '20260803');
  assert.strictEqual(cutoffStamp('20260101', 1), '20251231');
});

test('unworked call: nothing blocks', () => {
  const d = decideWorkedBefore([], BASE);
  assert.deepStrictEqual([d.worked, d.blocking, d.reason], [false, false, 'unworked']);
});

test('different band or mode never blocks (historical behavior preserved)', () => {
  const d = decideWorkedBefore([entry({ band: '40M' }), entry({ mode: 'FT4' })], BASE);
  assert.strictEqual(d.worked, true);
  assert.strictEqual(d.sameBandMode, false);
  assert.deepStrictEqual([d.blocking, d.reason], [false, 'other-band-mode']);
});

test('reworkDays absent/0 = all-time blocking (legacy default)', () => {
  const old = decideWorkedBefore([entry({ date: '20240101' })], BASE);
  assert.deepStrictEqual([old.blocking, old.reason], [true, 'blocking']);
  const zero = decideWorkedBefore([entry({ date: '20240101' })], { ...BASE, reworkDays: 0 });
  assert.strictEqual(zero.blocking, true);
});

test('rework window: old contact ages out, recent one still blocks', () => {
  const aged = decideWorkedBefore([entry({ date: '20260601' })], { ...BASE, reworkDays: 30 });
  assert.deepStrictEqual([aged.blocking, aged.reason], [false, 'aged-out']);
  assert.strictEqual(aged.sameBandMode, true); // toast still knows it's a same-band dupe
  const recent = decideWorkedBefore([entry({ date: '20260810' })], { ...BASE, reworkDays: 30 });
  assert.deepStrictEqual([recent.blocking, recent.reason], [true, 'recent']);
  // boundary: exactly N days ago is inside the window
  const edge = decideWorkedBefore([entry({ date: cutoffStamp(TODAY, 30) })], { ...BASE, reworkDays: 30 });
  assert.strictEqual(edge.blocking, true);
});

test('rework window: undated entry blocks conservatively', () => {
  const d = decideWorkedBefore([entry({ date: '' })], { ...BASE, reworkDays: 7 });
  assert.strictEqual(d.blocking, true);
});

test('activator exception: yesterday\'s contact does not block today\'s activation', () => {
  const d = decideWorkedBefore([entry({ date: '20260816', ref: 'US-1111' })],
    { ...BASE, activatorRefs: ['US-1111'] });
  assert.deepStrictEqual([d.blocking, d.reason], [false, 'new-park']);
});

test('activator exception: same park, same UTC day, same band+mode blocks', () => {
  const d = decideWorkedBefore([entry({ date: TODAY, ref: 'US-1111' })],
    { ...BASE, activatorRefs: ['US-1111'] });
  assert.deepStrictEqual([d.blocking, d.reason], [true, 'park-today']);
});

test('activator exception: different park today counts fresh (park change mid-day)', () => {
  const d = decideWorkedBefore([entry({ date: TODAY, ref: 'US-1111' })],
    { ...BASE, activatorRefs: ['US-2222'] });
  assert.deepStrictEqual([d.blocking, d.reason], [false, 'new-park']);
});

test('activator exception: same-day entry with no park recorded blocks (may have been this activation)', () => {
  const d = decideWorkedBefore([entry({ date: TODAY, ref: '' })],
    { ...BASE, activatorRefs: ['US-2222'] });
  assert.strictEqual(d.blocking, true);
});

test('activator exception: same day but different band is fine (POTA per-band credit)', () => {
  const d = decideWorkedBefore([entry({ date: TODAY, ref: 'US-1111', band: '40M' })],
    { ...BASE, activatorRefs: ['US-1111'] });
  assert.deepStrictEqual([d.blocking, d.reason], [false, 'other-band-mode']);
});

test('activator exception beats the rework window (months-old park contact never blocks a new activation)', () => {
  const d = decideWorkedBefore([entry({ date: '20260501', ref: 'US-1111' })],
    { ...BASE, reworkDays: 0, activatorRefs: ['US-1111'] });
  assert.strictEqual(d.blocking, false);
});

test('n-fer: blocking when today\'s logged park is ANY of the currently spotted refs', () => {
  const d = decideWorkedBefore([entry({ date: TODAY, ref: 'US-3333' })],
    { ...BASE, activatorRefs: ['US-1111', 'US-3333'] });
  assert.strictEqual(d.blocking, true);
});

console.log(`\nWorked-before: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
