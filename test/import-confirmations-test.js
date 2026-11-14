#!/usr/bin/env node
'use strict';
// Import Log merges QSL / LoTW confirmations into QSOs the log already holds (#461).
// Run: node test/import-confirmations-test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseAllRawQsos } = require('../lib/adif');
const QsoLog = require('../lib/qso-log');
const {
  isLotwReportRecord, fromLotwReport, confirmationPatch, planImportWithConfirmations, applyUpdates,
} = require('../lib/import-confirmations');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

// LoTW's detailed report (lotwreport.adi with qso_qsldetail=yes), as the
// operator downloads it from lotw.arrl.org. Calls are made up.
const LOTW_DETAILED = `ARRL Logbook of the World Status Report
Generated at 2026-11-13 14:02:11
for n0tst
Query:
    QSL ONLY: YES
 QSL RX SINCE: 2026-10-01 00:00:00 (user supplied value)

<PROGRAMID:4>LoTW
<APP_LoTW_LASTQSL:19>2026-11-12 03:22:10
<APP_LoTW_NUMREC:1>3

<eoh>

<APP_LoTW_OWNCALL:5>N0TST
<STATION_CALLSIGN:5>N0TST
<MY_DXCC:3>291
<MY_COUNTRY:24>UNITED STATES OF AMERICA
<APP_LoTW_MY_DXCC_ENTITY_STATUS:7>Current
<MY_GRIDSQUARE:4>FN20
<MY_STATE:2>PA // State
<MY_CNTY:10>PA,CHESTER // US County
<CALL:5>W9ZZX
<BAND:3>20M
<FREQ:8>14.07400
<MODE:3>FT8
<APP_LoTW_MODEGROUP:4>DATA
<QSO_DATE:8>20261101 // QSO Date
<TIME_ON:6>143015 // QSO Start Time
<APP_LoTW_QSO_TIMESTAMP:20>2026-11-01T14:30:15Z // QSO Date & Time; ISO-8601
<QSL_RCVD:1>Y
<QSLRDATE:8>20261105 // QSL Received Date
<APP_LoTW_RXQSL:19>2026-11-05 11:02:03 // QSL Record Matched
<DXCC:3>291
<COUNTRY:24>UNITED STATES OF AMERICA
<APP_LoTW_DXCC_ENTITY_STATUS:7>Current
<PFX:2>W9
<STATE:2>IL // US State
<CNTY:7>IL,COOK // US County
<CQZ:2>04
<ITUZ:2>08
<GRIDSQUARE:4>EN61
<eor>

<APP_LoTW_OWNCALL:5>N0TST
<STATION_CALLSIGN:5>N0TST
<CALL:6>KD2QQX
<BAND:3>40M
<MODE:3>SSB
<APP_LoTW_MODEGROUP:5>PHONE
<QSO_DATE:8>20261103
<TIME_ON:6>221500
<QSL_RCVD:1>Y
<QSLRDATE:8>20261110
<STATE:2>NJ
<GRIDSQUARE:4>FN20
<eor>

<APP_LoTW_OWNCALL:5>N0TST
<STATION_CALLSIGN:5>N0TST
<CALL:6>VE3QQZ
<BAND:3>17M
<FREQ:8>18.10000
<MODE:3>FT8
<QSO_DATE:8>20261104
<TIME_ON:6>010000
<QSL_RCVD:1>Y
<QSLRDATE:8>20261112
<eor>
`;

// The operator's POTACAT log, before the import. W9ZZX's start time is
// 40 s off LoTW's (the import matches within 3 minutes), KD2QQX was logged
// as LSB on 7.185, and K4QQY is not in LoTW's file at all.
const LOG = [
  { CALL: 'W9ZZX', QSO_DATE: '20261101', TIME_ON: '142935', FREQ: '14.0745', BAND: '20m', MODE: 'FT8',
    RST_SENT: '-08', RST_RCVD: '-12', STATE: 'IN', COMMENT: 'first FT8 of the day', LOTW_QSL_SENT: 'Y', LOTW_QSLSDATE: '20261102',
    APP_POTACAT_UUID: '11111111-1111-4111-8111-111111111111', APP_POTACAT_VERSION: '3' },
  { CALL: 'KD2QQX', QSO_DATE: '20261103', TIME_ON: '2215', FREQ: '7.185', BAND: '40m', MODE: 'LSB',
    QSL_RCVD: 'Y', QSL_RCVD_VIA: 'B', QSLRDATE: '20261108',
    APP_POTACAT_UUID: '22222222-2222-4222-8222-222222222222', APP_POTACAT_VERSION: '1' },
  { CALL: 'K4QQY', QSO_DATE: '20261102', TIME_ON: '1200', FREQ: '14.285', BAND: '20m', MODE: 'SSB',
    APP_POTACAT_UUID: '33333333-3333-4333-8333-333333333333', APP_POTACAT_VERSION: '1' },
];

function writeAdif(file, records) {
  const body = records.map((r) => Object.entries(r).map(([k, v]) => `<${k}:${String(v).length}>${v}`).join(' ') + ' <EOR>\n').join('');
  fs.writeFileSync(file, 'test log\n<EOH>\n' + body);
}

function tmpFile(name, text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'potacat-import-conf-'));
  const f = path.join(dir, name);
  fs.writeFileSync(f, text);
  return f;
}

const lotwRecords = () => parseAllRawQsos(tmpFile('lotwreport.adi', LOTW_DETAILED));

test('LoTW report records are recognised by their APP_LoTW_ fields', () => {
  const recs = lotwRecords();
  assert.strictEqual(recs.length, 3);
  assert.ok(recs.every(isLotwReportRecord));
  assert.ok(!isLotwReportRecord({ CALL: 'W9ZZX', QSL_RCVD: 'Y' }));
});

test('a LoTW confirmation moves to the LoTW fields, never the paper card fields', () => {
  const r = fromLotwReport(lotwRecords()[0]);
  assert.strictEqual(r.LOTW_QSL_RCVD, 'Y');
  assert.strictEqual(r.LOTW_QSLRDATE, '20261105');
  assert.strictEqual(r.LOTW_QSL_SENT, 'Y');
  assert.strictEqual(r.QSL_RCVD, undefined);
  assert.strictEqual(r.QSLRDATE, undefined);
  const plain = { CALL: 'W9ZZX', QSL_RCVD: 'Y' };
  assert.strictEqual(fromLotwReport(plain), plain, 'another logger\'s record is left as it is');
});

test('importing LoTW\'s detailed file merges confirmations into the QSOs already logged', () => {
  const logPath = tmpFile('log.adi', '');
  writeAdif(logPath, LOG);
  const incoming = lotwRecords().map(fromLotwReport);
  const journal = [];
  let plan;
  QsoLog.mutateLog(logPath, (log) => {
    plan = planImportWithConfirmations(log, incoming);
    if (!applyUpdates(plan.updates)) return false;
  }, { sink: (c) => journal.push(...c) });

  assert.strictEqual(plan.updates.length, 2, 'W9ZZX and KD2QQX updated');
  assert.strictEqual(plan.skipped, 0);
  assert.deepStrictEqual(plan.fresh.map((r) => r.CALL), ['VE3QQZ'], 'the QSO the log lacks is still imported');

  const after = QsoLog.readLog(logPath);
  const w9 = after.find((q) => q.CALL === 'W9ZZX');
  assert.strictEqual(w9.LOTW_QSL_RCVD, 'Y');
  assert.strictEqual(w9.LOTW_QSLRDATE, '20261105');
  assert.strictEqual(w9.QSL_RCVD, undefined, 'no paper card invented');
  assert.strictEqual(w9.STATE, 'IN', 'the state the operator typed is kept');
  assert.strictEqual(w9.CNTY, 'IL,COOK', 'empty location fields filled from LoTW, as Download confirmations does');
  assert.strictEqual(w9.GRIDSQUARE, 'EN61');
  for (const f of ['TIME_ON', 'FREQ', 'MODE', 'RST_SENT', 'RST_RCVD', 'COMMENT', 'LOTW_QSLSDATE']) {
    assert.strictEqual(w9[f], LOG[0][f], f + ' untouched');
  }
  assert.strictEqual(w9.APP_POTACAT_UUID, LOG[0].APP_POTACAT_UUID);
  assert.strictEqual(w9.APP_POTACAT_VERSION, '4', 'version bumped so the cloud takes the change');

  const kd = after.find((q) => q.CALL === 'KD2QQX');
  assert.strictEqual(kd.LOTW_QSL_RCVD, 'Y');
  assert.strictEqual(kd.LOTW_QSL_SENT, 'Y', 'a LoTW confirmation implies the upload');
  assert.strictEqual(kd.QSL_RCVD, 'Y', 'the paper card stays');
  assert.strictEqual(kd.QSL_RCVD_VIA, 'B');
  assert.strictEqual(kd.QSLRDATE, '20261108', 'the paper card date is not LoTW\'s');
  assert.strictEqual(kd.MODE, 'LSB');

  assert.deepStrictEqual(after.find((q) => q.CALL === 'K4QQY'), QsoLog.readLog(logPath).find((q) => q.CALL === 'K4QQY'));
  assert.strictEqual(after.find((q) => q.CALL === 'K4QQY').LOTW_QSL_RCVD, undefined);

  // Every change reached the cloud journal as an update of the same QSO.
  assert.deepStrictEqual(journal.map((c) => [c.action, c.fields.CALL]).sort(), [['update', 'KD2QQX'], ['update', 'W9ZZX']]);

  // The same file again changes nothing and counts as already there.
  const again = planImportWithConfirmations(QsoLog.readLog(logPath), lotwRecords().map(fromLotwReport).filter((r) => r.CALL !== 'VE3QQZ'));
  assert.strictEqual(again.updates.length, 0);
  assert.strictEqual(again.skipped, 2);
});

test('never downgrades: a Y in the log stays when the file says N', () => {
  const have = { CALL: 'W9ZZX', QSL_RCVD: 'Y', QSLRDATE: '20261001', LOTW_QSL_RCVD: 'Y', LOTW_QSLRDATE: '20261002' };
  assert.strictEqual(confirmationPatch(have, { CALL: 'W9ZZX', QSL_RCVD: 'N', LOTW_QSL_RCVD: 'N', QSLRDATE: '20261111' }), null);
  assert.strictEqual(confirmationPatch(have, { CALL: 'W9ZZX', QSL_RCVD: 'Y', QSLRDATE: '20261111' }), null, 'an existing date is not replaced');
});

test('another logger\'s export merges paper, LoTW and eQSL received fields only', () => {
  const have = { CALL: 'W9ZZX', QSL_RCVD: 'N', QSL_SENT: 'N', NAME: 'Pat' };
  const inc = { CALL: 'W9ZZX', QSL_RCVD: 'Y', QSL_RCVD_VIA: 'd', QSLRDATE: '20261020', EQSL_QSL_RCVD: 'Y', EQSL_QSLRDATE: '20261021',
    QSL_SENT: 'Y', NAME: 'Patricia', COMMENT: 'from the other logger' };
  assert.deepStrictEqual(confirmationPatch(have, inc), {
    QSL_RCVD: 'Y', QSL_RCVD_VIA: 'D', QSLRDATE: '20261020', EQSL_QSL_RCVD: 'Y', EQSL_QSLRDATE: '20261021',
  });
  assert.strictEqual(confirmationPatch(have, { CALL: 'W9ZZX', QSL_RCVD: 'R' }), null, 'only a confirmation is merged');
});

test('a duplicate inside the file is skipped, not merged into the new QSO', () => {
  const rec = { CALL: 'N9QQX', QSO_DATE: '20261101', TIME_ON: '1200', FREQ: '7.074', MODE: 'FT8' };
  const plan = planImportWithConfirmations([], [rec, { ...rec, LOTW_QSL_RCVD: 'Y' }]);
  assert.strictEqual(plan.fresh.length, 1);
  assert.strictEqual(plan.updates.length, 0);
  assert.strictEqual(plan.skipped, 1);
});

test('Import Log writes the merge through mutateLog and reports it', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const start = main.indexOf('function importQsoRecords(');
  const fn = main.slice(start, main.indexOf('\n}\n', start));
  assert.ok(/records\.map\(fromLotwReport\)/.test(fn));
  assert.ok(/QsoLog\.mutateLog\(logPath,[\s\S]*applyUpdates\(plan\.updates\)[\s\S]*sink: qsoLogSink/.test(fn));
  assert.ok(main.includes('already in your log updated with QSL or LoTW confirmations from this file.'));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
