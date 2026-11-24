#!/usr/bin/env node
'use strict';
// FT4 and FT2 are written as MODE=MFSK SUBMODE=FT4 / FT2 (#381).
//
// ADIF 3.1.8 has FT4 (and, since 3.1.7, FT2) only as SUBMODEs of MFSK; TQSL
// refuses MODE=FT2. Every QSO POTACAT writes goes through adifModeSubmode
// (lib/adif-mode.js), so the log, the Cloud copy and every logger forward
// carry the pair. Inside the app the mode stays FT4 / FT2: display, filters,
// worked-before and dupes read both the new pair and old MODE=FT4 records.
// Old records stay on disk as they were; the LoTW batch and the Logbook ADIF
// export hand other programs a copy with the pair.
//
// Run: node test/adif-ft4-mfsk-test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readSrc } = require('./_src');

const { adifModeSubmode, adifAppMode, recordMode, adifExportRecord } = require('../lib/adif-mode');
const writer = require('../lib/adif-writer');
const { parseWorkedQsos, parseAllQsos, parseRecord, normalizeMode } = require('../lib/adif');
const { sameContact } = require('../lib/qso-match');
const LF = require('../lib/logbook-filter');
const QsoIdentity = require('../lib/qso-identity');
const { applyQsoEdit, modeEditFields } = require('../lib/qso-edit');
const { batchAdif } = require('../lib/lotw-split');
const { buildWrlContactInfo } = require('../lib/wrl-packet');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e).split('\n')[0]); }
}
const main = readSrc(path.join(__dirname, '..', 'main.js')).replace(/\r\n/g, '\n');

console.log('FT4 / FT2 as MFSK + SUBMODE (#381)');

const qso = (mode, extra = {}) => ({ callsign: 'K1ABC', frequency: '14080', mode, qsoDate: '20261124', timeOn: '1200', ...extra });

// --- The one writer rule ---
test('adifModeSubmode: FT4 and FT2 -> MFSK + SUBMODE, any case, a stray submode ignored', () => {
  assert.deepStrictEqual(adifModeSubmode('FT4', ''), { mode: 'MFSK', submode: 'FT4' });
  assert.deepStrictEqual(adifModeSubmode('ft4'), { mode: 'MFSK', submode: 'FT4' });
  assert.deepStrictEqual(adifModeSubmode('FT2', ''), { mode: 'MFSK', submode: 'FT2' });
  assert.deepStrictEqual(adifModeSubmode('FT4', 'NORMAL'), { mode: 'MFSK', submode: 'FT4' });
  assert.deepStrictEqual(adifModeSubmode('MFSK', 'FT4'), { mode: 'MFSK', submode: 'FT4' });
});
test('FT8 and voice/CW modes are not touched', () => {
  assert.deepStrictEqual(adifModeSubmode('FT8', ''), { mode: 'FT8', submode: '' });
  assert.deepStrictEqual(adifModeSubmode('SSB', ''), { mode: 'SSB', submode: '' });
  assert.deepStrictEqual(adifModeSubmode('CW', ''), { mode: 'CW', submode: '' });
});
test('the log record (buildAdifRecord) carries MODE=MFSK SUBMODE=FT4, never MODE=FT4', () => {
  const rec = writer.buildAdifRecord(qso('FT4'));
  assert.ok(rec.includes('<MODE:4>MFSK') && rec.includes('<SUBMODE:3>FT4'), rec);
  assert.ok(!rec.includes('<MODE:3>FT4'));
  const ft2 = writer.buildAdifRecord(qso('FT2'));
  assert.ok(ft2.includes('<MODE:4>MFSK') && ft2.includes('<SUBMODE:3>FT2'), ft2);
});
test('the Cloud copy and every logger forward use the same fields (buildAdifFields)', () => {
  const f = writer.buildAdifFields(qso('FT4'));
  assert.strictEqual(f.MODE, 'MFSK');
  assert.strictEqual(f.SUBMODE, 'FT4');
  assert.ok(/const adifFields = buildAdifFields\(qsoData\);/.test(main), 'saveQsoRecord builds the saved/synced record with buildAdifFields');
});
test('a WSJT-X logged QSO (MFSK/FT4) is stored as MFSK/FT4, no longer as MODE=FT4', () => {
  assert.ok(/const wsjtxMode = f\.SUBMODE \|\| f\.MODE \|\| '';/.test(main), 'main.js logged-adif handler');
  const f = parseRecord('<CALL:5>K1ABC<FREQ:9>14.080000<MODE:4>MFSK<SUBMODE:3>FT4<QSO_DATE:8>20261124<TIME_ON:6>120000');
  const out = writer.buildAdifFields(qso(f.SUBMODE || f.MODE || ''));
  assert.deepStrictEqual([out.MODE, out.SUBMODE], ['MFSK', 'FT4']);
});

// --- Readers: FT4 still shows and matches as FT4 ---
const newRec = { CALL: 'K1ABC', QSO_DATE: '20261124', TIME_ON: '120000', BAND: '20M', FREQ: '14.080000', ...(() => { const f = writer.buildAdifFields(qso('FT4')); return { MODE: f.MODE, SUBMODE: f.SUBMODE }; })() };
const oldRec = { CALL: 'K1ABC', QSO_DATE: '20261124', TIME_ON: '120000', BAND: '20M', FREQ: '14.080000', MODE: 'FT4' };
test('display (Logbook, ECHOCAT Web: recordMode / adifAppMode) shows FT4 for both forms', () => {
  assert.strictEqual(recordMode(newRec), 'FT4');
  assert.strictEqual(recordMode(oldRec), 'FT4');
  assert.strictEqual(normalizeMode(newRec.MODE, newRec.SUBMODE), 'FT4');
  assert.strictEqual(adifAppMode('MFSK', 'FT2'), 'FT2');
});
test('dupes: a new MFSK/FT4 QSO is the same contact as an old MODE=FT4 record', () => {
  assert.ok(sameContact(newRec, oldRec));
  assert.ok(!sameContact(newRec, { ...oldRec, MODE: 'FT8' }));
});
test('Logbook mode filter: FT4 finds both forms, FT8 finds neither', () => {
  assert.ok(LF.modeMatches(newRec, 'FT4') && LF.modeMatches(oldRec, 'FT4'));
  assert.ok(!LF.modeMatches(newRec, 'FT8'));
});
test('worked-before and Recent QSOs read a written FT4/FT2 QSO by name', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft4-mfsk-'));
  const p = path.join(dir, 'log.adi');
  try {
    fs.writeFileSync(p, writer.ADIF_HEADER
      + '\n' + writer.buildAdifRecord(qso('FT4', { callsign: 'K1NEW' })) + '\n'
      + '\n' + writer.buildAdifRecord(qso('FT2', { callsign: 'K1FT2' })) + '\n'
      + '\n<CALL:5>K1OLD<QSO_DATE:8>20261124<TIME_ON:6>120000<BAND:3>20M<MODE:3>FT4 <EOR>\n');
    const w = parseWorkedQsos(p);
    assert.strictEqual(w.get('K1NEW')[0].mode, 'FT4');
    assert.strictEqual(w.get('K1FT2')[0].mode, 'FT2');
    assert.strictEqual(w.get('K1OLD')[0].mode, 'FT4');
    const by = Object.fromEntries(parseAllQsos(p).map((x) => [x.call, x.mode]));
    assert.deepStrictEqual([by.K1NEW, by.K1FT2, by.K1OLD], ['FT4', 'FT2', 'FT4']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('a Logbook/phone edit names the record by its own MODE (QsoIdentity)', () => {
  assert.ok(QsoIdentity.matches(newRec, QsoIdentity.of(newRec)));
  assert.ok(QsoIdentity.matches(oldRec, QsoIdentity.of(oldRec)));
});
test('WRL (N1MM ContactInfo) still gets the mode name FT4', () => {
  const xml = buildWrlContactInfo({ ...qso(adifAppMode(newRec.MODE, newRec.SUBMODE)), band: '20M' }, { myCallsign: 'K3SBP', myGrid: 'FM19' });
  assert.ok(xml.includes('<mode>FT4</mode>'), xml);
});

// --- Old records stay as they are ---
test('editing another field of an old MODE=FT4 record leaves its MODE alone', () => {
  const r = { ...oldRec };
  applyQsoEdit(r, { COMMENT: 'tnx' });
  assert.deepStrictEqual([r.MODE, 'SUBMODE' in r, r.COMMENT], ['FT4', false, 'tnx']);
  assert.deepStrictEqual(modeEditFields(oldRec, 'FT4').fields, {}, 'saving the form with Mode FT4 changes nothing');
  assert.deepStrictEqual(modeEditFields(newRec, 'FT4').fields, {});
});
test('a Mode edit to FT4 or FT2 writes MFSK + SUBMODE', () => {
  assert.deepStrictEqual(modeEditFields({ MODE: 'FT8' }, 'FT2').fields, { MODE: 'MFSK', SUBMODE: 'FT2' });
});

// --- Copies for other programs ---
test('adifExportRecord: an old MODE=FT4 / FT2 record becomes an MFSK copy; the record is untouched', () => {
  const r = { CALL: 'K1ABC', MODE: 'FT4', BAND: '20M' };
  const out = adifExportRecord(r);
  assert.deepStrictEqual(out, { CALL: 'K1ABC', MODE: 'MFSK', SUBMODE: 'FT4', BAND: '20M' });
  assert.deepStrictEqual(Object.keys(out), ['CALL', 'MODE', 'SUBMODE', 'BAND'], 'SUBMODE right after MODE');
  assert.deepStrictEqual(r, { CALL: 'K1ABC', MODE: 'FT4', BAND: '20M' });
  assert.deepStrictEqual(adifExportRecord({ MODE: 'FT2', SUBMODE: '' }), { MODE: 'MFSK', SUBMODE: 'FT2' });
  assert.deepStrictEqual(adifExportRecord({ MODE: 'JS8' }), { MODE: 'MFSK', SUBMODE: 'JS8' });
});
test('adifExportRecord: records already right come back as the same object', () => {
  for (const r of [{ MODE: 'MFSK', SUBMODE: 'FT4' }, { MODE: 'FT8' }, { MODE: 'USB' }, { MODE: 'DIGITALVOICE', SUBMODE: 'FREEDV' }, { CALL: 'K1ABC' }]) {
    assert.strictEqual(adifExportRecord(r), r, JSON.stringify(r));
  }
  assert.strictEqual(adifExportRecord(null), null);
});
test('LoTW batch: an old MODE=FT2 record goes to TQSL as MFSK/FT2 (TQSL refuses MODE=FT2)', () => {
  const recs = [{ CALL: 'K1FT2', MODE: 'FT2' }, { CALL: 'K1FT4', MODE: 'FT4' }, { CALL: 'K1FT8', MODE: 'FT8' }, { CALL: 'K1NEW', MODE: 'MFSK', SUBMODE: 'FT4' }];
  const text = batchAdif(recs);
  assert.ok(text.includes('<CALL:5>K1FT2 <MODE:4>MFSK <SUBMODE:3>FT2'), text);
  assert.ok(text.includes('<CALL:5>K1FT4 <MODE:4>MFSK <SUBMODE:3>FT4'));
  assert.ok(text.includes('<CALL:5>K1FT8 <MODE:3>FT8 <EOR>'));
  assert.ok(text.includes('<CALL:5>K1NEW <MODE:4>MFSK <SUBMODE:3>FT4'));
  assert.ok(!/<MODE:3>FT[24]/.test(text));
  assert.deepStrictEqual(recs[0], { CALL: 'K1FT2', MODE: 'FT2' }, 'the log record is not rewritten');
});
test('Logbook ADIF export writes each record through adifExportRecord', () => {
  const i = main.indexOf("ipcMain.handle('export-adif'");
  assert.ok(i > 0);
  const body = main.slice(i, main.indexOf('\n  });', i));
  assert.ok(/Object\.entries\(adifExportRecord\(q\)\)/.test(body), 'export-adif');
  assert.ok(/const \{ adifAppMode, adifModeSubmode, adifExportRecord \} = require\('\.\/lib\/adif-mode'\);/.test(main));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
