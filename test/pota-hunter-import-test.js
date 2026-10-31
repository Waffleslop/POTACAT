#!/usr/bin/env node
'use strict';
// Importing the operator's POTA.app hunter log (2026-10-27). pota.app knows the
// park for contacts the local log holds without one, and contacts the local log
// never got: a matching QSO gains the park reference(s), a missing one is
// added, a 2-fer (one pota.app row per park) is one contact, the log is backed
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

// One plan covering every outcome, shared by the tests below.
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
  return { qsos, entries, plan: H.planHunterImport(qsos, entries, { myCalls: ['N0ME'] }) };
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
test('a local QSO is matched once, closest first', () => {
  const plan = H.planHunterImport([local()], [
    entry({ qsoDateTime: '2026-05-01T14:22:00', reference: 'US-1111' }),
    entry({ qsoDateTime: '2026-05-01T14:25:00', reference: 'US-2222' }),
  ]);
  assert.deepStrictEqual(plan.updates.map((u) => u.refs), [['US-1111']]);
  assert.deepStrictEqual(plan.adds.map((a) => a.record.POTA_REF), ['US-2222']);
});
test('review CSV: summary counts first, then one row per decision', () => {
  const { qsos, entries, plan } = scenario();
  H.applyHunterPlan(qsos, plan);
  const lines = H.planToCsv(plan, { downloaded: entries.length, reported: 9 }).trim().split('\r\n');
  assert.ok(lines[0].startsWith('action,call,qso_date,time_on,'));
  assert.deepStrictEqual(lines.slice(1, 8), [
    'SUMMARY,mode,,,,,,,,,,,import',
    'SUMMARY,entries downloaded,,,,,,,,,,,8',
    'SUMMARY,entries pota.app reports,,,,,,,,,,,9',
    'SUMMARY,updated,,,,,,,,,,,3',
    'SUMMARY,added,,,,,,,,,,,3',
    'SUMMARY,unchanged,,,,,,,,,,,1',
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
      plan = H.planHunterImport(qsos, [entry(), entry({ station_callsign: 'W5NEW', reference: 'US-5555' })]);
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
  assert.ok(ui.includes('window.api.potaHunterImport({ dryRun })'));
  assert.ok(ui.includes("hunterImportBtn.addEventListener('click', () => runHunterImport(false));"));
  assert.ok(ui.includes("hunterPreviewBtn.addEventListener('click', () => runHunterImport(true));"));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
