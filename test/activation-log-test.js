// Activation logging regressions (Casey 2026-06-16):
//   1. ADIF <NAME> was written empty even though the operator name showed in
//      the activator log row, so "Past activations" and ADIF Master showed a
//      blank Name column. Root cause was in the renderer (sync QRZ-cache race),
//      but the data layer must still faithfully WRITE and READ NAME — these
//      tests lock that round-trip down through the real writer/parser.
//   2. Every callsign showed the "PREV" (worked-before) badge. The filter
//      compared SIG_INFO (the other station's park, empty on normal activation
//      QSOs) instead of MY_SIG_INFO (the park being activated). parseWorkedQsos
//      now captures myRef, and isPriorActivationWork() decides the badge.
//
// Run: node test/activation-log-test.js

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildAdifRecord } = require('../lib/adif-writer');
const {
  parseWorkedQsos,
  parseAllRawQsos,
  isPriorActivationWork,
} = require('../lib/adif');

let passed = 0, failed = 0;
function check(cond, label) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ FAIL: ' + label); }
}
function eq(actual, expected, label) {
  check(JSON.stringify(actual) === JSON.stringify(expected),
    `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

// Write records to a temp ADIF file and hand back the path.
let _tmpSeq = 0;
function writeTempAdif(records) {
  const file = path.join(os.tmpdir(), `potacat-act-test-${process.pid}-${_tmpSeq++}.adi`);
  const body = records.map((r) => buildAdifRecord(r)).join('\n');
  fs.writeFileSync(file, `ADIF test\n<EOH>\n\n${body}\n`);
  return file;
}
const _cleanup = [];
function tempAdif(records) { const f = writeTempAdif(records); _cleanup.push(f); return f; }

// ───────────────────────────────────────────────────────────────────────────
console.log('=== buildAdifRecord: NAME field (bug 1, write side) ===');

{
  const rec = buildAdifRecord({
    callsign: 'W1AW', frequency: '14074', mode: 'FT8',
    qsoDate: '20260616', timeOn: '130000', name: 'Hiram',
    mySig: 'POTA', mySigInfo: 'US-1234',
  });
  check(rec.includes('<NAME:5>Hiram'), 'NAME written with correct length prefix');
}
{
  // Empty / missing name must be omitted entirely (no zero-length tag), so
  // ADIF Master shows a clean blank rather than a malformed field.
  const rec = buildAdifRecord({ callsign: 'W1AW', frequency: '14074', mode: 'FT8', name: '' });
  check(!/<NAME:/i.test(rec), 'empty name omits the NAME tag');
  const rec2 = buildAdifRecord({ callsign: 'W1AW', frequency: '14074', mode: 'FT8' });
  check(!/<NAME:/i.test(rec2), 'missing name omits the NAME tag');
}
{
  // Names with spaces (first + last) keep the right byte length.
  const rec = buildAdifRecord({ callsign: 'K3SBP', frequency: '7074', mode: 'FT8', name: 'Casey K' });
  check(rec.includes('<NAME:7>Casey K'), 'multi-word name length is correct');
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n=== Past-activations round-trip: parseAllRawQsos reads NAME (bug 1, read side) ===');

{
  // This is the exact path getPastActivations() uses: parseAllRawQsos -> q.NAME.
  const file = tempAdif([
    { callsign: 'W1AW', frequency: '14074', mode: 'FT8', qsoDate: '20260616', timeOn: '130000', name: 'Hiram', mySig: 'POTA', mySigInfo: 'US-1234' },
    { callsign: 'N0CALL', frequency: '14075', mode: 'FT8', qsoDate: '20260616', timeOn: '130100', mySig: 'POTA', mySigInfo: 'US-1234' },
  ]);
  const qsos = parseAllRawQsos(file);
  eq(qsos.length, 2, 'parsed both records');
  const w1aw = qsos.find((q) => q.CALL === 'W1AW');
  eq(w1aw.NAME, 'Hiram', 'NAME survives write -> read');
  const noName = qsos.find((q) => q.CALL === 'N0CALL');
  check(!noName.NAME, 'record logged without a name reads back empty (not garbage)');
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n=== parseWorkedQsos: myRef from MY_SIG_INFO / MY_POTA_REF (bug 2, data) ===');

{
  const file = tempAdif([
    // Ordinary activation QSO: MY_SIG_INFO set, SIG_INFO empty.
    { callsign: 'W1AW', frequency: '14074', mode: 'FT8', qsoDate: '20260616', mySig: 'POTA', mySigInfo: 'US-1234', band: '20M' },
  ]);
  const map = parseWorkedQsos(file);
  const e = map.get('W1AW')[0];
  eq(e.myRef, 'US-1234', 'myRef captured from MY_SIG_INFO');
  eq(e.ref, '', 'ref (SIG_INFO) stays empty for a non-P2P activation QSO');
}
{
  // P2P: both my park (MY_SIG_INFO) and their park (SIG_INFO) present.
  const file = tempAdif([
    { callsign: 'K4ABC', frequency: '14074', mode: 'FT8', qsoDate: '20260616', mySig: 'POTA', mySigInfo: 'US-1234', sig: 'POTA', sigInfo: 'US-5678', band: '20M' },
  ]);
  const e = parseWorkedQsos(file).get('K4ABC')[0];
  eq(e.myRef, 'US-1234', 'P2P: myRef is my park');
  eq(e.ref, 'US-5678', 'P2P: ref is their park');
}
{
  // MY_POTA_REF fallback when MY_SIG_INFO is absent.
  const file = tempAdif([
    { callsign: 'W1AW', frequency: '14074', mode: 'FT8', qsoDate: '20260616', myPotaRef: 'US-9999', mySig: 'POTA' },
  ]);
  // buildAdifRecord derives MY_POTA_REF; MY_SIG_INFO is omitted (no mySigInfo).
  const e = parseWorkedQsos(file).get('W1AW')[0];
  eq(e.myRef, 'US-9999', 'myRef falls back to MY_POTA_REF');
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n=== isPriorActivationWork: the PREV badge decision (bug 2, logic) ===');

const TODAY = '20260616';
const REFS = ['US-1234'];

check(isPriorActivationWork([{ date: TODAY, myRef: 'US-1234' }], REFS, TODAY) === false,
  'fresh contact (today, at my park) -> NOT prior (no PREV)');
check(isPriorActivationWork([{ date: '20250101', myRef: 'US-1234' }], REFS, TODAY) === true,
  'same park, earlier day -> prior (PREV)');
check(isPriorActivationWork([{ date: TODAY, myRef: 'US-5678' }], REFS, TODAY) === true,
  'today but a DIFFERENT park -> prior (PREV)');
check(isPriorActivationWork([{ date: TODAY, myRef: '' }], REFS, TODAY) === true,
  'worked while hunting (no myRef) -> prior (PREV)');
check(isPriorActivationWork([], REFS, TODAY) === false,
  'never worked -> NOT prior');
check(isPriorActivationWork(undefined, REFS, TODAY) === false,
  'no entries (undefined) -> NOT prior');
check(isPriorActivationWork([{ date: TODAY, myRef: 'us-1234' }], REFS, TODAY) === false,
  'case-insensitive myRef match');
check(isPriorActivationWork([{ date: TODAY, myRef: 'US-1234' }], ['us-1234'], TODAY) === false,
  'case-insensitive currentRefs match');

// n-fer: activating two parks at once — a contact at EITHER counts as this activation.
check(isPriorActivationWork([{ date: TODAY, myRef: 'US-5678' }], ['US-1234', 'US-5678'], TODAY) === false,
  'multi-park activation: contact at the second ref is NOT prior');

// A call with BOTH a this-activation entry and a genuine prior entry must
// still flag PREV (any prior entry wins).
check(isPriorActivationWork(
  [{ date: TODAY, myRef: 'US-1234' }, { date: '20240101', myRef: 'US-1234' }], REFS, TODAY) === true,
  'has a prior entry alongside todays -> PREV');

// ───────────────────────────────────────────────────────────────────────────
console.log('\n=== End-to-end: log file -> parseWorkedQsos -> isPriorActivationWork ===');

{
  // Simulate a real log: one fresh QSO from today's activation at US-1234, and
  // one genuinely-prior QSO with a different station from last year.
  const file = tempAdif([
    { callsign: 'W1AW', frequency: '14074', mode: 'FT8', qsoDate: TODAY, mySig: 'POTA', mySigInfo: 'US-1234', band: '20M' },
    { callsign: 'K4ABC', frequency: '14074', mode: 'FT8', qsoDate: '20250601', mySig: 'POTA', mySigInfo: 'US-1234', band: '20M' },
  ]);
  const map = parseWorkedQsos(file);
  check(isPriorActivationWork(map.get('W1AW'), REFS, TODAY) === false,
    'W1AW worked only in this activation -> no PREV');
  check(isPriorActivationWork(map.get('K4ABC'), REFS, TODAY) === true,
    'K4ABC worked a year ago -> PREV');
}

// ───────────────────────────────────────────────────────────────────────────
for (const f of _cleanup) { try { fs.unlinkSync(f); } catch {} }

console.log('\n' + '='.repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
