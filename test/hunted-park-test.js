#!/usr/bin/env node
'use strict';
//
// Hunted-park resolver tests (lib/hunted-park.js).
//
// KB2UXB 2026-07-09: JTCAT/ECHOCAT FT8 QSOs with POTA activators logged with
// no park data — ever. The resolver matches the worked call against the live
// program spot list; these tables pin the matching rules (base-call compare,
// same-band preference, program priority, n-fer dedup, freshness, self-call
// exclusion) so the park can't silently vanish from FT8 logs again.
//
// Run: node test/hunted-park-test.js
//
const { findHuntedRefs, MAX_SPOT_AGE_MS } = require('../lib/hunted-park');

let pass = 0, fail = 0;
function eq(actual, expected, msg) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; }
  else { fail++; console.log(`  ✗ ${msg}\n      expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}
function section(n) { console.log('\n=== ' + n + ' ==='); }

const NOW = Date.parse('2026-07-09T16:00:00Z');
const fresh = '2026-07-09T15:50:00'; // 10 min old (POTA API style, no Z)
const stale = '2026-07-09T13:00:00'; // 3 h old
function spot(over) {
  return { source: 'pota', callsign: 'W1ABC', reference: 'US-1234', frequency: '14074', spotTime: fresh, ...over };
}
const OPTS = { freqKhz: 14074, myCall: 'K3SBP', now: NOW };

section('basic matching');
{
  const r = findHuntedRefs([spot()], 'W1ABC', OPTS);
  eq(r && r.sig, 'POTA', 'POTA spot matches by callsign');
  eq(r && r.primaryRef, 'US-1234', 'primary ref carried');
  eq(r && r.refField, 'potaRef', 'per-program ref field name');
}
eq(findHuntedRefs([spot()], 'N0CALL', OPTS), null, 'unrelated call → null');
eq(findHuntedRefs([], 'W1ABC', OPTS), null, 'empty spot list → null');
eq(findHuntedRefs([spot({ reference: '' })], 'W1ABC', OPTS), null, 'spot without a ref → null');
eq(findHuntedRefs([spot({ source: 'dxc' })], 'W1ABC', OPTS), null, 'DX-cluster spots are not program spots');
eq(findHuntedRefs([spot({ callsign: 'K3SBP' })], 'K3SBP', OPTS), null, 'never match our own call (self-spot)');

section('base-call comparison (portable activators)');
{
  const r = findHuntedRefs([spot({ callsign: 'W1ABC/P' })], 'W1ABC', OPTS);
  eq(r && r.primaryRef, 'US-1234', 'spot signed /P matches the bare worked call');
}
{
  const r = findHuntedRefs([spot()], 'W1ABC/P', OPTS);
  eq(r && r.primaryRef, 'US-1234', 'worked call decoded with /P matches the bare spot');
}

section('freshness');
eq(findHuntedRefs([spot({ spotTime: stale })], 'W1ABC', OPTS), null, `spots older than ${MAX_SPOT_AGE_MS / 60000} min are ignored`);
{
  const r = findHuntedRefs([spot({ spotTime: undefined })], 'W1ABC', OPTS);
  eq(r && r.primaryRef, 'US-1234', 'spot without a timestamp still matches (age unknown)');
}

section('same-band preference');
{
  // Activator spotted on 40 m SSB earlier and on 20 m FT8 now — the QSO is
  // on 20 m, so the 20 m spot's park wins the primary slot.
  const r = findHuntedRefs([
    spot({ frequency: '7237', reference: 'US-1111' }),
    spot({ frequency: '14074', reference: 'US-2222' }),
  ], 'W1ABC', OPTS);
  eq(r && r.primaryRef, 'US-2222', 'same-band spot outranks other-band spot');
  eq(r && r.refs.length, 2, 'the other-band park is still carried as an extra ref');
}
{
  // Only an other-band spot exists — still the right park (same activator).
  const r = findHuntedRefs([spot({ frequency: '7237' })], 'W1ABC', OPTS);
  eq(r && r.primaryRef, 'US-1234', 'other-band spot still matches when nothing better exists');
}

section('program priority + n-fer dedup');
{
  // Same site spotted cross-program: POTA outranks WWFF for the primary.
  const r = findHuntedRefs([
    spot({ source: 'wwff', reference: 'KFF-1234' }),
    spot({ reference: 'US-1234' }),
  ], 'W1ABC', OPTS);
  eq(r && r.sig, 'POTA', 'POTA outranks WWFF for the primary slot');
  eq(r && r.refs.map((x) => x.sig + ' ' + x.ref),
    ['POTA US-1234', 'WWFF KFF-1234'], 'cross-program refs preserved in priority order');
}
{
  // n-fer: two POTA refs, duplicate spots collapse.
  const r = findHuntedRefs([
    spot({ reference: 'US-1234' }),
    spot({ reference: 'US-5678' }),
    spot({ reference: 'US-1234', spotTime: '2026-07-09T15:55:00' }),
  ], 'W1ABC', OPTS);
  eq(r && r.refs.map((x) => x.ref).sort(), ['US-1234', 'US-5678'], 'n-fer refs deduped to distinct parks');
}
{
  const r = findHuntedRefs([spot({ source: 'sota', reference: 'W2/GC-001', frequency: '14062' })], 'W1ABC', OPTS);
  eq(r && r.sig + '/' + r.refField, 'SOTA/sotaRef', 'SOTA spots resolve with their own ref field');
}

console.log('\n' + '='.repeat(52));
console.log(`Results: ${pass} passed, ${fail} failed`);
if (fail > 0) { console.log('FAILURES PRESENT'); process.exit(1); }
console.log('All hunted-park tests passed.');
