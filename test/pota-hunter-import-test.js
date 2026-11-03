#!/usr/bin/env node
'use strict';
// Importing the operator's POTA.app hunter log (2026-10-27). pota.app knows the
// park for contacts the local log holds without one, and contacts the local log
// never got: a matching QSO with no park gains the park reference(s), one with
// a different park is a CONFLICT and left alone, an activator's repeated row or
// a contact already in the log is a DUPLICATE, a missing one is added, a 2-fer (one pota.app row per park) is one contact, the log is backed
// up before the write, and a review CSV accounts for every row.
// Run: node test/pota-hunter-import-test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const H = require('../lib/pota-hunter-import');
const { mutateLog, readLog } = require('../lib/qso-log');
const { appendRawQsos } = require('../lib/adif-writer');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

// pota.app rows come from the activators' logs: station_callsign is the
// activator, worked_callsign is the operator.
const entry = (over) => ({
  qsoDateTime: '2026-05-01T14:20:00', station_callsign: 'K1ABC', operator_callsign: 'K1ABC',
  worked_callsign: 'N0ME', band: '20M', mode: 'SSB', reference: 'US-1234', name: 'Some Park', ...over,
});
const local = (over) => ({
  CALL: 'K1ABC', QSO_DATE: '20260501', TIME_ON: '142300', BAND: '20m', MODE: 'SSB', ...over,
});

// Adding contacts is opt-in (addMissing, off by default); tests of what an
// add looks like pass it.
const ADD = { addMissing: true };

// One plan covering every outcome, shared by the tests below (adding on).
function scenario() {
  const qsos = [
    local(), // matches, no park yet
    local({ CALL: 'W2XYZ', TIME_ON: '150000', SIG: 'POTA', SIG_INFO: 'US-0001', POTA_REF: 'US-0001' }), // already has it
    local({ CALL: 'W3SOT', TIME_ON: '160000', SIG: 'SOTA', SIG_INFO: 'W3/PT-001' }), // a summit: keeps SIG
    local({ CALL: 'W4FT', TIME_ON: '170000', MODE: 'FT8' }),
  ];
  const entries = [
    entry({ reference: 'US-1234' }),
    entry({ reference: 'US-5678' }),
    entry({ station_callsign: 'W2XYZ', qsoDateTime: '2026-05-01T15:05:00', reference: 'US-0001' }),
    entry({ station_callsign: 'W3SOT', qsoDateTime: '2026-05-01T16:00:00', reference: 'US-9999' }),
    entry({ station_callsign: 'W4FT', qsoDateTime: '2026-05-01T17:02:00', mode: 'DATA', reference: 'US-4444' }),
    entry({ station_callsign: 'W5NEW', qsoDateTime: '2026-05-02T01:00:00', band: '40M', mode: 'CW', reference: 'US-5555' }),
    entry({ station_callsign: 'W2XYZ', qsoDateTime: '2026-05-01T15:05:00', band: '40M', reference: 'US-0001' }), // wrong band
    entry({ qsoDateTime: '2026-05-01T18:00:00', reference: 'US-1234' }), // outside the window
  ];
  return { qsos, entries, plan: H.planHunterImport(qsos, entries, { myCalls: ['N0ME'], addMissing: true }) };
}

console.log('POTA.app hunter log import');
test('qsoDateTime is read as UTC in the forms pota.app may send', () => {
  assert.deepStrictEqual(H.parseQsoDateTime('2026-05-01T14:20:00'),
    { qsoDate: '20260501', timeOn: '142000', millis: Date.UTC(2026, 4, 1, 14, 20) });
  assert.strictEqual(H.parseQsoDateTime('2026-05-01 14:20').timeOn, '142000', 'space separator, no seconds');
  assert.strictEqual(H.parseQsoDateTime('2026-05-01T14:20:00.000Z').millis, Date.UTC(2026, 4, 1, 14, 20), 'fraction + Z');
  assert.strictEqual(H.parseQsoDateTime('May 1'), null);
});
test('a 2-fer (one row per park) is one contact with both refs', () => {
  const { contacts } = H.groupHunterEntries([entry(), entry({ reference: 'US-5678', name: 'Other Park' })]);
  assert.strictEqual(contacts.length, 1);
  assert.deepStrictEqual(contacts[0].refs, ['US-1234', 'US-5678']);
  assert.strictEqual(contacts[0].call, 'K1ABC', 'the activator is station_callsign');
  assert.strictEqual(contacts[0].myCall, 'N0ME');
});
test('the activator side is checked against the operator\'s calls, /P and all', () => {
  const swapped = H.groupHunterEntries([entry({ station_callsign: 'N0ME', worked_callsign: 'K1ABC' })], { myCalls: ['N0ME'] });
  assert.strictEqual(swapped.contacts[0].call, 'K1ABC');
  const portable = H.groupHunterEntries([entry({ station_callsign: 'N0ME/P', worked_callsign: 'K1ABC' })], { myCalls: ['N0ME'] });
  assert.strictEqual(portable.contacts[0].call, 'K1ABC');
});
test('rows with no park or an unreadable date are skipped with a reason', () => {
  const { contacts, skipped } = H.groupHunterEntries([entry({ reference: '' }), entry({ qsoDateTime: 'x' })]);
  assert.strictEqual(contacts.length, 0);
  assert.deepStrictEqual(skipped.map((s) => s.reason), ['no park reference', 'unreadable date/time "x"']);
});
test('plan: matched QSOs are updated, the rest added, parks already there left alone', () => {
  const { plan } = scenario();
  assert.deepStrictEqual(plan.updates.map((u) => u.contact.call), ['K1ABC', 'W3SOT', 'W4FT']);
  assert.deepStrictEqual(plan.adds.map((a) => a.contact.call), ['W2XYZ', 'K1ABC', 'W5NEW'], 'wrong band and out-of-window are adds');
  assert.deepStrictEqual(plan.unchanged.map((n) => n.contact.call), ['W2XYZ']);
  const k1 = plan.updates[0];
  assert.deepStrictEqual(k1.refs, ['US-1234', 'US-5678']);
  assert.strictEqual(k1.deltaMs, 3 * 60000, 'matched 3 minutes apart');
});
test('pota.app DATA matches a local FT8 (mode class, not mode)', () => {
  const { plan } = scenario();
  assert.deepStrictEqual(plan.updates.find((u) => u.contact.call === 'W4FT').refs, ['US-4444']);
});
test('apply: the park goes in SIG_INFO and POTA_REF; a summit keeps its SIG', () => {
  const { qsos, plan } = scenario();
  H.applyHunterPlan(qsos, plan);
  assert.strictEqual(qsos[0].SIG, 'POTA');
  assert.strictEqual(qsos[0].SIG_INFO, 'US-1234,US-5678');
  assert.strictEqual(qsos[0].POTA_REF, 'US-1234,US-5678');
  assert.strictEqual(qsos[2].SIG, 'SOTA');
  assert.strictEqual(qsos[2].SIG_INFO, 'W3/PT-001');
  assert.strictEqual(qsos[2].POTA_REF, 'US-9999');
  assert.strictEqual(qsos.length, 7, 'three records appended');
});
test('an added contact is a complete POTA record', () => {
  const { qsos, plan } = scenario();
  H.applyHunterPlan(qsos, plan);
  assert.deepStrictEqual(qsos.find((q) => q.CALL === 'W5NEW'), {
    CALL: 'W5NEW', QSO_DATE: '20260502', TIME_ON: '010000', BAND: '40m', MODE: 'CW',
    SIG: 'POTA', SIG_INFO: 'US-5555', POTA_REF: 'US-5555', STATION_CALLSIGN: 'N0ME',
  });
});
// Activator dupes (K3SBP review): an activator who logged the operator twice
// gives two pota.app rows for one contact. The second must not become a QSO.
test('a local QSO is matched once, closest first; the other row is a DUPLICATE, not an add', () => {
  const plan = H.planHunterImport([local()], [
    entry({ qsoDateTime: '2026-05-01T14:22:00', reference: 'US-1111' }),
    entry({ qsoDateTime: '2026-05-01T14:25:00', reference: 'US-2222' }),
  ]);
  assert.deepStrictEqual(plan.updates.map((u) => u.refs), [['US-1111']]);
  assert.strictEqual(plan.adds.length, 0, 'never added, even naming another park');
  assert.deepStrictEqual(plan.duplicates.map((d) => [d.kind, d.contact.refs.join()]), [['activator-dupe', 'US-2222']]);
});
test('activator logged me twice a minute apart: one update, one DUPLICATE, nothing appended', () => {
  const qsos = [local()];
  const plan = H.planHunterImport(qsos, [
    entry({ qsoDateTime: '2026-05-01T14:22:00' }),
    entry({ qsoDateTime: '2026-05-01T14:23:00' }),
  ]);
  assert.strictEqual(plan.updates.length, 1);
  assert.strictEqual(plan.duplicates.length, 1);
  assert.strictEqual(plan.duplicates[0].qso, qsos[0], 'names the QSO the other row matched');
  H.applyHunterPlan(qsos, plan);
  assert.strictEqual(qsos.length, 1);
});
test('activator dupe: also when the matched QSO already had the park, or conflicts', () => {
  const had = H.planHunterImport([local({ POTA_REF: 'US-1234' })],
    [entry({ qsoDateTime: '2026-05-01T14:22:00' }), entry({ qsoDateTime: '2026-05-01T14:30:00' })]);
  assert.deepStrictEqual([had.unchanged.length, had.duplicates.length, had.adds.length], [1, 1, 0]);
  const conflict = H.planHunterImport([local({ POTA_REF: 'US-1243' })],
    [entry({ qsoDateTime: '2026-05-01T14:22:00' }), entry({ qsoDateTime: '2026-05-01T14:30:00' })]);
  assert.deepStrictEqual([conflict.conflicts.length, conflict.duplicates.length, conflict.adds.length], [1, 1, 0]);
});
test('not a dupe: another band, another mode class, or outside the window of the matched QSO', () => {
  const plan = H.planHunterImport([local()], [
    entry({ qsoDateTime: '2026-05-01T14:22:00' }), // matches
    entry({ qsoDateTime: '2026-05-01T14:24:00', band: '40M' }),
    entry({ qsoDateTime: '2026-05-01T14:25:00', mode: 'CW' }),
    entry({ qsoDateTime: '2026-05-01T14:40:00' }), // 17 min after the local QSO
  ], ADD);
  assert.strictEqual(plan.updates.length, 1);
  assert.strictEqual(plan.duplicates.length, 0);
  assert.deepStrictEqual(plan.adds.map((a) => [a.record.BAND, a.record.MODE, a.record.TIME_ON]),
    [['40m', 'SSB', '142400'], ['20m', 'CW', '142500'], ['20m', 'SSB', '144000']]);
});
test('no local QSO: two rows a minute apart add one QSO, the second is a DUPLICATE (planImport)', () => {
  const plan = H.planHunterImport([], [
    entry({ qsoDateTime: '2026-05-01T14:22:00' }),
    entry({ qsoDateTime: '2026-05-01T14:23:00' }),
  ], ADD);
  assert.deepStrictEqual(plan.adds.map((a) => a.record.TIME_ON), ['142200'], 'the earlier row is kept');
  assert.deepStrictEqual(plan.duplicates.map((d) => d.kind), ['repeat']);
});
test('no local QSO: rows past planImport\'s 3 minutes are separate contacts', () => {
  const plan = H.planHunterImport([], [
    entry({ qsoDateTime: '2026-05-01T14:22:00' }),
    entry({ qsoDateTime: '2026-05-01T14:26:00' }),
  ], ADD);
  assert.strictEqual(plan.adds.length, 2);
  assert.strictEqual(plan.duplicates.length, 0);
});
test('every add has passed planImport against the log (the importQsoRecords check)', () => {
  const { qsos, plan } = scenario();
  const { planImport } = require('../lib/qso-match');
  const again = planImport(qsos, plan.adds.map((a) => a.record));
  assert.strictEqual(again.skipped, 0, 'nothing left for planImport to drop');
  assert.strictEqual(again.fresh.length, plan.adds.length);
  assert.ok(/planImport\(qsos \|\| \[\], candidates\.map/.test(read('lib', 'pota-hunter-import.js')),
    'the planner runs adds through planImport');
});
test('review CSV: DUPLICATE rows say why, and an activator dupe names the matched QSO', () => {
  const qsos = [local({ TIME_ON: '142300', APP_POTACAT_UUID: 'u-9' })];
  const dupe = H.planHunterImport(qsos,
    [entry({ qsoDateTime: '2026-05-01T14:22:00' }), entry({ qsoDateTime: '2026-05-01T14:24:00' })]);
  H.applyHunterPlan(qsos, dupe); // a real import: the matched QSO now holds the park
  const lines = H.planToCsv(dupe).trim().split('\r\n');
  assert.ok(lines.includes('SUMMARY,duplicates,,,,,,,,,,,1'));
  const row = lines.find((l) => l.startsWith('DUPLICATE,'));
  assert.ok(row.startsWith('DUPLICATE,K1ABC,20260501,142400,20m,SSB,US-1234,Some Park,142300,1.0,US-1234,u-9,'), row);
  assert.ok(row.includes('the activator logged this contact twice'), row);
  const repeat = H.planToCsv(H.planHunterImport([], [entry(), entry({ qsoDateTime: '2026-05-01T14:21:00' })]));
  assert.ok(repeat.includes('not added: repeats an earlier pota.app row'));
});
test('through mutateLog: an activator dupe is never written', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'potacat-hunter-dupe-'));
  try {
    const logPath = path.join(dir, 'log.adi');
    appendRawQsos(logPath, [local({ APP_POTACAT_UUID: '33333333-3333-4333-8333-333333333333', APP_POTACAT_VERSION: '1' })]);
    let plan;
    const { changes } = mutateLog(logPath, (qsos) => {
      plan = H.planHunterImport(qsos, [entry({ qsoDateTime: '2026-05-01T14:22:00' }), entry({ qsoDateTime: '2026-05-01T14:23:00' })]);
      return H.applyHunterPlan(qsos, plan);
    });
    assert.deepStrictEqual(changes.map((c) => c.action), ['update'], 'one update, no create');
    assert.strictEqual(readLog(logPath).length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test('main: duplicates are counted and reported', () => {
  const main = read('main.js');
  const start = main.indexOf("ipcMain.handle('pota-hunter-import'");
  const h = main.slice(start, main.indexOf('ipcMain.handle(', start + 10));
  assert.ok(h.includes('duplicates: plan.duplicates.length'));
  assert.ok(h.includes('duplicates not added: the activator logged the contact twice'));
});
// Park conflicts (K3SBP review): the import only ever FILLS an empty park.
// Appending pota.app's ref to a record logged with another park would invent
// a 2-fer (US-1243 + US-1234) and credit a park never worked.
test('conflict: a record logged with a different park is not changed', () => {
  const qsos = [local({ SIG: 'POTA', SIG_INFO: 'US-1243', POTA_REF: 'US-1243' })];
  const before = JSON.stringify(qsos);
  const plan = H.planHunterImport(qsos, [entry({ reference: 'US-1234' })]);
  assert.strictEqual(plan.updates.length, 0, 'no update');
  assert.strictEqual(plan.adds.length, 0, 'the contact matched: not an add');
  assert.strictEqual(plan.conflicts.length, 1);
  assert.deepStrictEqual(plan.conflicts[0].localRefs, ['US-1243']);
  assert.deepStrictEqual(plan.conflicts[0].contact.refs, ['US-1234']);
  H.applyHunterPlan(qsos, plan);
  assert.strictEqual(JSON.stringify(qsos), before, 'record byte-for-byte unchanged, never US-1243,US-1234');
});
test('conflict: a park only in SIG_INFO (no POTA_REF) counts as a park', () => {
  const qsos = [local({ SIG: 'POTA', SIG_INFO: 'US-1243' })];
  const plan = H.planHunterImport(qsos, [entry({ reference: 'US-1234' })]);
  assert.strictEqual(plan.conflicts.length, 1);
  H.applyHunterPlan(qsos, plan);
  assert.strictEqual(qsos[0].SIG_INFO, 'US-1243');
  assert.strictEqual(qsos[0].POTA_REF, undefined, 'POTA_REF not added');
});
test('conflict: a record holding one park of a pota.app 2-fer is not extended', () => {
  const qsos = [local({ SIG: 'POTA', SIG_INFO: 'US-1234', POTA_REF: 'US-1234' })];
  const plan = H.planHunterImport(qsos, [entry({ reference: 'US-1234' }), entry({ reference: 'US-5678' })]);
  assert.strictEqual(plan.conflicts.length, 1);
  assert.strictEqual(plan.updates.length, 0);
  H.applyHunterPlan(qsos, plan);
  assert.strictEqual(qsos[0].POTA_REF, 'US-1234');
});
test('no conflict: a record holding every pota.app park (in any order, or more) is unchanged', () => {
  const plan = H.planHunterImport(
    [local({ SIG: 'POTA', SIG_INFO: 'US-5678,US-1234', POTA_REF: 'US-5678,US-1234' })],
    [entry({ reference: 'US-1234' }), entry({ reference: 'US-5678' })]);
  assert.strictEqual(plan.unchanged.length, 1);
  assert.strictEqual(plan.conflicts.length, 0);
  const superset = H.planHunterImport([local({ POTA_REF: 'US-1234,US-9999' })], [entry({ reference: 'US-1234' })]);
  assert.strictEqual(superset.unchanged.length, 1, 'the local log knows more parks than pota.app: left alone');
});
test('a SOTA record with no park still gets the park filled (POTA_REF only)', () => {
  const qsos = [local({ SIG: 'SOTA', SIG_INFO: 'W3/PT-001' })];
  const plan = H.planHunterImport(qsos, [entry({ reference: 'US-1234' })]);
  assert.strictEqual(plan.updates.length, 1);
  assert.strictEqual(plan.conflicts.length, 0, 'a summit is not a park conflict');
});
test('fillParkRefs never writes to a record that already has a park', () => {
  const q = local({ POTA_REF: 'US-1243' });
  assert.deepStrictEqual(H.fillParkRefs(q, ['US-1234']), []);
  assert.strictEqual(q.POTA_REF, 'US-1243');
  assert.strictEqual(q.SIG_INFO, undefined);
  const empty = local();
  assert.deepStrictEqual(H.fillParkRefs(empty, ['US-1234', 'US-5678']), ['US-1234', 'US-5678']);
  assert.strictEqual(empty.SIG_INFO, 'US-1234,US-5678');
});
test('review CSV: a conflict row shows both parks and the record\'s own, unchanged', () => {
  const plan = H.planHunterImport(
    [local({ SIG: 'POTA', SIG_INFO: 'US-1243', POTA_REF: 'US-1243', APP_POTACAT_UUID: 'u-1' })],
    [entry({ reference: 'US-1234' })]);
  const lines = H.planToCsv(plan).trim().split('\r\n');
  assert.ok(lines.includes('SUMMARY,conflicts,,,,,,,,,,,1'));
  const line = lines.find((l) => l.startsWith('CONFLICT,'));
  const note = '"not changed: your log has US-1243, pota.app has US-1234"'; // quoted: it holds a comma
  assert.ok(line.endsWith(',' + note), line);
  const row = line.slice(0, -note.length - 1).split(',');
  assert.strictEqual(row[1], 'K1ABC');
  assert.strictEqual(row[6], 'US-1234', 'parks column: what pota.app has');
  assert.strictEqual(row[10], 'US-1243', 'local_parks_after: the record\'s park, unchanged');
  assert.strictEqual(row[11], 'u-1');
});
test('through mutateLog: a conflict-only import writes nothing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'potacat-hunter-conflict-'));
  try {
    const logPath = path.join(dir, 'log.adi');
    appendRawQsos(logPath, [local({ SIG: 'POTA', SIG_INFO: 'US-1243', POTA_REF: 'US-1243',
      APP_POTACAT_UUID: '22222222-2222-4222-8222-222222222222', APP_POTACAT_VERSION: '1' })]);
    const before = fs.readFileSync(logPath, 'utf8');
    let plan;
    const { changes } = mutateLog(logPath, (qsos) => {
      plan = H.planHunterImport(qsos, [entry({ reference: 'US-1234' })]);
      if (!plan.updates.length && !plan.adds.length) return false; // as main.js does
      return H.applyHunterPlan(qsos, plan);
    });
    assert.strictEqual(plan.conflicts.length, 1);
    assert.strictEqual(changes.length, 0, 'nothing journaled');
    assert.strictEqual(fs.readFileSync(logPath, 'utf8'), before, 'log file untouched');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test('main: conflicts are counted and reported, never applied', () => {
  const main = read('main.js');
  const start = main.indexOf("ipcMain.handle('pota-hunter-import'");
  const h = main.slice(start, main.indexOf('ipcMain.handle(', start + 10));
  assert.ok(h.includes('conflicts: plan.conflicts.length'), 'result carries the conflict count');
  assert.ok(h.includes('if (!plan.updates.length && !plan.adds.length) return false;'), 'conflicts alone never trigger a write');
  assert.ok(/QSOs have a park that differs from POTA\.app's/.test(h), 'the dialog tells the operator');
  assert.ok(!/addParkRefs/.test(read('lib', 'pota-hunter-import.js')), 'the append-a-park helper is gone');
});

// Modes on added records, and adding as an opt-in (K3SBP review). LoTW and QRZ
// reject a MODE ADIF doesn't define; added records come from the activator's
// log with no frequency or reports, so adding is the operator's choice.
const addOne = (over, opts = ADD) => H.planHunterImport([], [entry({ station_callsign: 'W9ADD', ...over })], opts);
test('adding is off by default: a missing contact is NOT_ADDED, nothing appended', () => {
  const qsos = [];
  const plan = H.planHunterImport(qsos, [entry({ station_callsign: 'W9ADD' })]);
  assert.strictEqual(plan.adds.length, 0);
  assert.deepStrictEqual(plan.notAdded.map((n) => n.contact.call), ['W9ADD']);
  H.applyHunterPlan(qsos, plan);
  assert.strictEqual(qsos.length, 0);
  const off = H.planHunterImport([], [entry({ station_callsign: 'W9ADD' })], { addMissing: 'yes' });
  assert.strictEqual(off.adds.length, 0, 'only addMissing === true adds');
});
test('adding off still fills parks, and dupes/skips are reported the same either way', () => {
  const entries = [entry({ qsoDateTime: '2026-05-01T14:22:00' }), entry({ qsoDateTime: '2026-05-01T14:23:00' }),
    entry({ station_callsign: 'W9DAT', mode: 'DATA' })];
  const off = H.planHunterImport([local()], entries);
  const on = H.planHunterImport([local()], entries, ADD);
  for (const p of [off, on]) {
    assert.strictEqual(p.updates.length, 1, 'the park is filled');
    assert.strictEqual(p.duplicates.length, 1);
    assert.strictEqual(p.skipped.length, 1);
  }
});
test('DATA with no local match is never added, even with adding on: SKIPPED', () => {
  const plan = addOne({ mode: 'DATA' });
  assert.strictEqual(plan.adds.length, 0);
  assert.strictEqual(plan.notAdded.length, 0);
  assert.deepStrictEqual(plan.skipped.map((s) => [s.contact.call, s.reason]),
    [['W9ADD', 'pota.app gives only DATA, not the digital mode: not added']]);
  assert.strictEqual(addOne({ mode: '' }).skipped[0].reason, 'pota.app gives no mode: not added');
});
test('DATA still matches a local FT8 to fill its park', () => {
  const plan = H.planHunterImport([local({ MODE: 'FT8' })], [entry({ mode: 'DATA' })], ADD);
  assert.strictEqual(plan.updates.length, 1);
  assert.strictEqual(plan.skipped.length, 0);
});
test('added modes are ADIF: FT4 -> MFSK/FT4, PSK31 -> PSK/PSK31, JS8 -> MFSK/JS8, FT8/CW/SSB as-is', () => {
  const ms = (mode) => { const r = addOne({ mode }).adds[0].record; return [r.MODE, r.SUBMODE]; };
  assert.deepStrictEqual(ms('FT4'), ['MFSK', 'FT4']);
  assert.deepStrictEqual(ms('ft4'), ['MFSK', 'FT4'], 'case-insensitive');
  assert.deepStrictEqual(ms('PSK31'), ['PSK', 'PSK31'], 'via adifModeSubmode');
  assert.deepStrictEqual(ms('JS8'), ['MFSK', 'JS8'], 'via adifModeSubmode');
  assert.deepStrictEqual(ms('FT8'), ['FT8', undefined]);
  assert.deepStrictEqual(ms('CW'), ['CW', undefined]);
  assert.deepStrictEqual(ms('SSB'), ['SSB', undefined]);
  assert.ok(/adifModeSubmode\(m\)/.test(read('lib', 'pota-hunter-import.js')), 'uses lib/adif-writer.js adifModeSubmode');
});
test('PHONE is added as SSB on HF and 6 m, FM on 2 m and up, and says it was inferred', () => {
  const phone = (band) => addOne({ mode: 'PHONE', band }).adds[0];
  assert.strictEqual(phone('20M').record.MODE, 'SSB');
  assert.strictEqual(phone('6M').record.MODE, 'SSB');
  assert.strictEqual(phone('2M').record.MODE, 'FM');
  assert.strictEqual(phone('70CM').record.MODE, 'FM');
  assert.strictEqual(phone('20M').modeInferred, true);
  assert.strictEqual(addOne({ mode: 'SSB' }).adds[0].modeInferred, false);
});
test('an added FT4 record is the same contact as a logged MFSK/FT4 one (planImport)', () => {
  const plan = H.planHunterImport([], [
    entry({ station_callsign: 'W9FT', mode: 'FT4', qsoDateTime: '2026-05-01T14:20:00' }),
    entry({ station_callsign: 'W9FT', mode: 'FT4', qsoDateTime: '2026-05-01T14:21:00' }),
  ], ADD);
  assert.strictEqual(plan.adds.length, 1);
  assert.deepStrictEqual(plan.duplicates.map((d) => d.kind), ['repeat']);
});
test('review CSV: NOT_ADDED, ADDED and SKIPPED rows say what the mode is or why', () => {
  const entries = [entry({ station_callsign: 'W9FT', mode: 'FT4' }), entry({ station_callsign: 'W9PH', mode: 'PHONE', band: '2M' }),
    entry({ station_callsign: 'W9DAT', mode: 'DATA' })];
  const off = H.planToCsv(H.planHunterImport([], entries)).trim().split('\r\n');
  assert.ok(off.includes('SUMMARY,not added (adding is off),,,,,,,,,,,2'));
  const ft4 = off.find((l) => l.startsWith('NOT_ADDED,W9FT,'));
  assert.ok(ft4.includes('would be logged as MFSK/FT4'), ft4);
  assert.ok(ft4.includes('tick ""Also add contacts missing from my log"" to add it'), ft4);
  assert.ok(off.find((l) => l.startsWith('NOT_ADDED,W9PH,')).includes('pota.app says PHONE: FM inferred from the band'));
  const skip = off.find((l) => l.startsWith('SKIPPED,W9DAT,'));
  assert.ok(skip.startsWith('SKIPPED,W9DAT,20260501,142000,20m,DATA,US-1234,'), skip);
  assert.ok(skip.endsWith(',"pota.app gives only DATA, not the digital mode: not added"'), skip); // quoted: has a comma
  const on = H.planToCsv(H.planHunterImport([], entries, ADD));
  assert.ok(/ADDED,W9FT,[^\r\n]*logged as MFSK\/FT4/.test(on));
  assert.ok(!on.includes('NOT_ADDED,'));
});
test('main + Settings: the add checkbox is off by default and reaches the planner', () => {
  const html = read('renderer', 'index.html');
  const box = (html.match(/<input[^>]*id="pota-hunter-import-add"[^>]*>/) || [])[0];
  assert.ok(box, 'the checkbox exists');
  assert.ok(!/\bchecked\b/.test(box), 'unchecked by default');
  const ui = read('renderer', 'pota-sync-ui.js');
  assert.ok(ui.includes('const addMissing = !!(hunterAddMissing && hunterAddMissing.checked);'));
  const main = read('main.js');
  const start = main.indexOf("ipcMain.handle('pota-hunter-import'");
  const h = main.slice(start, main.indexOf('ipcMain.handle(', start + 10));
  assert.ok(h.includes('const addMissing = !!(opts && opts.addMissing === true);'));
  assert.strictEqual((h.match(/\{ myCalls, addMissing \}/g) || []).length, 2, 'dry run and import plan the same way');
});

test('review CSV: summary counts first, then one row per decision', () => {
  const { qsos, entries, plan } = scenario();
  H.applyHunterPlan(qsos, plan);
  const lines = H.planToCsv(plan, { downloaded: entries.length, reported: 9 }).trim().split('\r\n');
  assert.ok(lines[0].startsWith('action,call,qso_date,time_on,'));
  assert.deepStrictEqual(lines.slice(1, 11), [
    'SUMMARY,mode,,,,,,,,,,,import',
    'SUMMARY,entries downloaded,,,,,,,,,,,8',
    'SUMMARY,entries pota.app reports,,,,,,,,,,,9',
    'SUMMARY,updated,,,,,,,,,,,3',
    'SUMMARY,added,,,,,,,,,,,3',
    'SUMMARY,not added (adding is off),,,,,,,,,,,0',
    'SUMMARY,unchanged,,,,,,,,,,,1',
    'SUMMARY,conflicts,,,,,,,,,,,0',
    'SUMMARY,duplicates,,,,,,,,,,,0',
    'SUMMARY,skipped,,,,,,,,,,,0',
  ]);
  const count = (a) => lines.filter((l) => l.startsWith(a + ',')).length;
  assert.deepStrictEqual([count('UPDATED'), count('ADDED'), count('UNCHANGED')], [3, 3, 1]);
});
test('dry run CSV says so, and its ADDED rows have no uuid yet', () => {
  const { plan } = scenario(); // planned, never applied
  const lines = H.planToCsv(plan, { dryRun: true }).trim().split('\r\n');
  assert.strictEqual(lines[1], 'SUMMARY,mode,,,,,,,,,,,dry run: nothing was changed');
  const added = lines.filter((l) => l.startsWith('ADDED,'));
  assert.strictEqual(added.length, 3);
  for (const l of added) assert.strictEqual(l.split(',')[11], '', 'qso_uuid column empty');
});
test('through mutateLog on a real file: journaled, versioned, uuid in the review', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'potacat-hunter-import-'));
  try {
    const logPath = path.join(dir, 'log.adi');
    appendRawQsos(logPath, [local({ APP_POTACAT_UUID: '11111111-1111-4111-8111-111111111111', APP_POTACAT_VERSION: '1' })]);
    let plan;
    const journaled = [];
    const { changes } = mutateLog(logPath, (qsos) => {
      plan = H.planHunterImport(qsos, [entry(), entry({ station_callsign: 'W5NEW', reference: 'US-5555' })], ADD);
      return H.applyHunterPlan(qsos, plan);
    }, { sink: (c) => journaled.push(...c) });
    assert.deepStrictEqual(changes.map((c) => c.action), ['update', 'create']);
    assert.strictEqual(journaled.length, 2);
    assert.strictEqual(changes[0].fields.APP_POTACAT_VERSION, '2');
    const after = readLog(logPath);
    assert.strictEqual(after[0].POTA_REF, 'US-1234');
    assert.ok(H.planToCsv(plan).includes(after[1].APP_POTACAT_UUID));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test('pota-sync: the logbook is read with the bare id token, page by page', () => {
  const src = read('lib', 'pota-sync.js');
  assert.ok(src.includes("const LOGBOOK_URL = 'https://api.pota.app/user/logbook';"));
  assert.ok(/\?hunterOnly=1&page=\$\{page\}&size=\$\{LOGBOOK_PAGE_SIZE\}/.test(src));
  assert.ok(src.includes("req.setHeader('Authorization', token);"), 'no "Bearer" prefix: pota.app sends the token as-is');
  assert.ok(/res\.status === 401 \|\| res\.status === 403\) \{\s*\(\{ token \} = await this\._getActiveToken\(\{ forceRefresh: true \}\)\)/.test(src),
    'a refused page retries once with a refreshed token');
});
test('main: backup, then one mutateQsoLog write, then the review CSV', () => {
  const main = read('main.js');
  const start = main.indexOf("ipcMain.handle('pota-hunter-import'");
  assert.ok(start > 0, 'the IPC handler exists');
  const h = main.slice(start, main.indexOf('ipcMain.handle(', start + 10));
  const backup = h.indexOf('fs.copyFileSync(logPath, backupPath)');
  const write = h.indexOf('mutateQsoLog(');
  const review = h.indexOf('PotaHunterImport.planToCsv(plan');
  assert.ok(backup > 0 && write > backup && review > write, 'backup before the write, review after');
  assert.ok(h.includes('.pre-pota-hunter-import-'), 'backup sits next to the log');
  assert.ok(h.includes('Hunter log entries downloaded:'), 'the dialog leads with the download count');
});
test('main: a dry run plans from a read of the log and never writes or backs up', () => {
  const main = read('main.js');
  const start = main.indexOf("ipcMain.handle('pota-hunter-import'");
  const h = main.slice(start, main.indexOf('ipcMain.handle(', start + 10));
  const dry = (h.match(/if \(dryRun\) \{([\s\S]*?)\} else \{/) || [])[1];
  assert.ok(dry, 'a dryRun branch ahead of the write');
  assert.ok(dry.includes('PotaHunterImport.planHunterImport(QsoLog.readLog(logPath), entries'), 'plans from a plain read');
  assert.ok(!/mutateQsoLog|copyFileSync|applyHunterPlan/.test(dry), 'no write, backup or apply in the dry run');
  assert.ok(h.indexOf('fs.copyFileSync(logPath, backupPath)') > h.indexOf('} else {'), 'the backup is on the import side');
  assert.ok(h.includes("hunter-import-${dryRun ? 'dry-run-' : ''}${stamp}.csv"), 'dry-run review files are named as such');
  assert.ok(h.includes("dryRun ? 'Hunter log dry run complete'"), 'the dialog says it was a dry run');
});
test('preload + Settings: Import and Preview reach the handler', () => {
  assert.ok(read('preload.js').includes("potaHunterImport: (opts) => ipcRenderer.invoke('pota-hunter-import', opts),"));
  const html = read('renderer', 'index.html');
  assert.ok(html.includes('id="pota-hunter-import"'));
  assert.ok(html.includes('id="pota-hunter-import-preview"'));
  const ui = read('renderer', 'pota-sync-ui.js');
  assert.ok(ui.includes('window.api.potaHunterImport({ dryRun, addMissing })'));
  assert.ok(ui.includes("hunterImportBtn.addEventListener('click', () => runHunterImport(false));"));
  assert.ok(ui.includes("hunterPreviewBtn.addEventListener('click', () => runHunterImport(true));"));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
