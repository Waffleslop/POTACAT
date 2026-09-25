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
// MY_SIG is the program the operator is ACTIVATING under, and it used to be
// the literal 'POTA' in eleven places — so a SOTA, WWFF, LLOTA or WWBOTA
// activator got MY_SIG=POTA on every contact. Every fixture above hardcodes
// POTA, so before these cases nothing asserted a non-POTA program survives.
console.log('\nMY_SIG carries the activation program');
{
  // The regression guard that matters most: a POTA activation is unchanged.
  const pota = buildAdifRecord({ callsign: 'W1AW', mySig: 'POTA', mySigInfo: 'US-1234' });
  check(pota.includes('<MY_SIG:4>POTA'), 'POTA activation still writes MY_SIG=POTA');
  check(pota.includes('<MY_POTA_REF:7>US-1234'), 'POTA activation still derives MY_POTA_REF');

  const sota = buildAdifRecord({ callsign: 'W1AW', mySig: 'SOTA', mySigInfo: 'W4C/CM-001' });
  check(sota.includes('<MY_SIG:4>SOTA'), 'SOTA activation writes MY_SIG=SOTA');
  check(sota.includes('<MY_SIG_INFO:10>W4C/CM-001'), 'SOTA activation writes the summit as MY_SIG_INFO');
  check(sota.includes('<MY_SOTA_REF:10>W4C/CM-001'), 'SOTA activation derives MY_SOTA_REF from mySig');
  // The negative is the one that catches a regression to the hardcode: if
  // MY_SIG went back to POTA, MY_POTA_REF would reappear carrying a summit.
  check(!sota.includes('MY_POTA_REF:'), 'SOTA activation writes NO MY_POTA_REF');

  const wwff = buildAdifRecord({ callsign: 'W1AW', mySig: 'WWFF', mySigInfo: 'KFF-1234' });
  check(wwff.includes('<MY_WWFF_REF:8>KFF-1234'), 'WWFF activation derives MY_WWFF_REF');
  check(!wwff.includes('MY_POTA_REF:'), 'WWFF activation writes NO MY_POTA_REF');

  const llota = buildAdifRecord({ callsign: 'W1AW', mySig: 'LLOTA', mySigInfo: 'LLCL-0001' });
  check(llota.includes('<MY_LLOTA_REF:9>LLCL-0001'), 'LLOTA activation derives MY_LLOTA_REF');
  // LLOTA is the program no ref-shape inference can detect (LLCL-0001 looks
  // exactly like a POTA ref), which is why the program is stored per ref.
  check(!llota.includes('MY_POTA_REF:'), 'LLOTA activation writes NO MY_POTA_REF');

  // Known gap, asserted so it is recorded rather than rediscovered: there is
  // no MY_WWBOTA_REF field in buildAdifRecord. A WWBOTA primary survives as
  // MY_SIG/MY_SIG_INFO only. This change makes WWBOTA primaries reachable.
  const wwbota = buildAdifRecord({ callsign: 'W1AW', mySig: 'WWBOTA', mySigInfo: 'B/US-1234' });
  check(wwbota.includes('<MY_SIG:6>WWBOTA'), 'WWBOTA activation writes MY_SIG=WWBOTA');
  check(!wwbota.includes('MY_WWBOTA_REF'), 'WWBOTA has no dedicated MY_ ref field (known gap)');
}

console.log('\nMY_SIG round-trips through the log');
{
  // This is the exact path that closes the resume bug: getPastActivations
  // reads MY_SIG back out of the ADIF to compute each ref's `sig`, and
  // resumeActivation now carries that into activatorParkRefs[].program.
  const file = tempAdif([
    { callsign: 'W1AW', frequency: '14074', mode: 'FT8', qsoDate: TODAY, mySig: 'SOTA', mySigInfo: 'W4C/CM-001', band: '20M' },
  ]);
  const rows = parseAllRawQsos(file);
  check(rows.length === 1, 'one record parsed back');
  check((rows[0].MY_SIG || '') === 'SOTA', 'MY_SIG survives the write/read round-trip as SOTA');
  check((rows[0].MY_SIG_INFO || '') === 'W4C/CM-001', 'MY_SIG_INFO survives as the summit ref');
}

console.log('\nNo POTA hardcode remains in the log-building paths');
{
  // The whole bug was a literal written in eleven places. A source-text guard
  // is the only assertion that makes it impossible to land silently again —
  // and it is what enforces landing the renderer and main halves together:
  // half-landed, SSB logs the right program while FT8 and the phone log POTA.
  for (const rel of ['../renderer/app.js', '../main.js']) {
    const src = fs.readFileSync(path.join(__dirname, rel), 'utf-8');
    check(!/mySig:\s*'POTA'/.test(src),
      rel.replace('../', '') + " has no hardcoded mySig: 'POTA'");
    // The assignment spelling slipped past the pattern above for months (the
    // JTCAT extra-park record, found 2026-09-25 with N7VBN's log).
    check(!/\.mySig\s*=\s*'POTA'/.test(src),
      rel.replace('../', '') + " has no hardcoded .mySig = 'POTA'");
    // An activation record must never carry the operator's HOME grid: the
    // park's grid is filled in saveQsoRecord (lib/activation-station.js).
    check(!/mySigInfo:[^}\n]*myGridsquare:\s*settings\.grid/.test(src) && !/myGridsquare\s*=\s*settings\.grid/.test(src),
      rel.replace('../', '') + ' never stamps settings.grid (home) onto an activation record');
  }
}

// ── N7VBN 2026-09-22: the station side of activation records ──────────────
{
  const { activationStationFill } = require('../lib/activation-station');
  const { latLonToGrid } = require('../lib/grid');
  const { parkStatesFromLocation } = require('../lib/pota');
  const park = { reference: 'US-7637', latitude: '47.62', longitude: '-117.36', locationDesc: 'US-WA' };
  const ctx = { myCallsign: 'n7vbn', park, latLonToGrid, parkStates: parkStatesFromLocation };
  // A hunter contact made while activating (spot-log path): only MY_SIG/INFO.
  const fill = activationStationFill({ callsign: 'VA3UZ', mySig: 'POTA', mySigInfo: 'US-7637' }, ctx);
  check(fill.operator === 'N7VBN' && fill.stationCallsign === 'N7VBN', 'hunter-while-activating record gets OPERATOR + STATION_CALLSIGN');
  check(/^DN17/.test(fill.myGridsquare || ''), 'MY_GRIDSQUARE from the park position (' + fill.myGridsquare + ')');
  check(fill.myState === 'WA', 'MY_STATE from a single-state park');
  // Never overwrite what the logging path supplied (a grid typed in the Act screen).
  const kept = activationStationFill({ mySigInfo: 'US-7637', myGridsquare: 'DM45ee', operator: 'K3SBP' }, ctx);
  check(!('myGridsquare' in kept) && !('operator' in kept), 'fills blanks only');
  // A park in two states cannot say which side the activator was on.
  const twoStates = activationStationFill({ mySigInfo: 'US-1234' }, { ...ctx, park: { ...park, locationDesc: 'US-WA,US-ID' } });
  check(!('myState' in twoStates), 'no MY_STATE for a multi-state park');
  // Not an activation record: untouched.
  check(Object.keys(activationStationFill({ callsign: 'W1AW' }, ctx)).length === 0, 'hunter-only record is left alone');
  // Unknown park (SOTA summit etc.): callsigns still, no invented grid/state.
  const noPark = activationStationFill({ mySigInfo: 'W7W/SN-001' }, { ...ctx, park: null });
  check(noPark.operator === 'N7VBN' && !('myGridsquare' in noPark) && !('myState' in noPark), 'unknown park: callsigns only');

  // The writer: no FREQ "NaN", BAND from the frequency, MY_STATE written.
  const noFreq = buildAdifRecord({ callsign: 'KK7YFH', frequency: '', mode: 'SSB', qsoDate: '20260921', timeOn: '181813', mySig: 'POTA', mySigInfo: 'US-7637' });
  check(!/NaN/.test(noFreq) && !/<FREQ:/.test(noFreq), 'a missing frequency is left out, never written as NaN');
  const withFreq = buildAdifRecord({ callsign: 'KK7YFH', frequency: '14225', mode: 'SSB', qsoDate: '20260921', timeOn: '1828', myState: 'WA' });
  check(/<BAND:3>20m/.test(withFreq), 'BAND derived from FREQ when the caller gave none');
  check(/<MY_STATE:2>WA/.test(withFreq), 'MY_STATE written');

  // Wiring: every save and every activation export passes through the fill,
  // and the Act screen refuses a contact with no frequency.
  const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf-8');
  const save = main.slice(main.indexOf('async function saveQsoRecord('), main.indexOf('async function saveQsoRecord(') + 6000);
  check(/activationStationFillFor\(qsoData\)/.test(save), 'saveQsoRecord fills activation station fields');
  const exportCalls = main.match(/writeActivationAdifRaw\([^)]*\)/g) || [];
  check(exportCalls.length >= 3 && exportCalls.every(c => /fillActivationExport\(/.test(c)), 'every activation export is filled (' + exportCalls.length + ')');
  const app = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf-8');
  const act = app.slice(app.indexOf('async function activatorLogContact('), app.indexOf('async function activatorLogContact(') + 4000);
  check(/if \(!freqKhz\) \{[\s\S]{0,400}activatorFreqInput\.focus\(\);\s*return;/.test(act), 'Act screen asks for the frequency instead of logging none');
}
// ───────────────────────────────────────────────────────────────────────────
for (const f of _cleanup) { try { fs.unlinkSync(f); } catch {} }

console.log('\n' + '='.repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
