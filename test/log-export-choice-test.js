// Export ADIF from the Logbook: everything shown, a UTC time range, or the
// selected rows (#698). The time rule and the file name are pure
// (lib/log-export-choice.js); the file is still written by the one
// 'export-adif' handler. Read-only: an export never changes the log.
// Run: node test/log-export-choice-test.js
'use strict';
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const LE = require('../lib/log-export-choice');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); }
}
const root = path.join(__dirname, '..');
const src = (p) => readSrc(path.join(root, p));

const q = (date, time, call) => ({ CALL: call || 'K3SBP', QSO_DATE: date, TIME_ON: time });
const calls = (list) => list.map((r) => r.CALL).join(',');
const range = (fromDate, fromTime, toDate, toTime) => LE.parseRange({ fromDate, fromTime, toDate, toTime });

console.log('log export choice (#698)');

// --- The range ---
test('the issue example: 1 Dec 12:00 to 21:00 UTC, both ends included', () => {
  const r = range('2026-12-01', '12:00', '2026-12-01', '21:00');
  assert.strictEqual(r.ok, true);
  const log = [
    q('20261201', '1159', 'EARLY'),
    q('20261201', '1200', 'START'),
    q('20261201', '1530', 'MID'),
    q('20261201', '2100', 'END'),
    q('20261201', '2101', 'LATE'),
    q('20261130', '1500', 'DAYBEFORE'),
    q('20261202', '1500', 'DAYAFTER'),
  ];
  assert.strictEqual(calls(LE.filterByRange(log, r)), 'START,MID,END');
});

test('the end is inclusive to the minute: 21:00:59 is in, 21:01:00 is out', () => {
  const r = range('2026-12-01', '12:00', '2026-12-01', '21:00');
  assert.strictEqual(LE.inRange(q('20261201', '210059'), r), true);
  assert.strictEqual(LE.inRange(q('20261201', '210100'), r), false);
  assert.strictEqual(LE.inRange(q('20261201', '120000'), r), true);
  assert.strictEqual(LE.inRange(q('20261201', '115959'), r), false);
});

test('4-digit and 6-digit TIME_ON compare the same', () => {
  const r = range('2026-12-01', '09:05', '2026-12-01', '09:05');
  assert.strictEqual(LE.inRange(q('20261201', '0905'), r), true);
  assert.strictEqual(LE.inRange(q('20261201', '090530'), r), true);
  assert.strictEqual(LE.inRange(q('20261201', '0904'), r), false);
  assert.strictEqual(LE.inRange(q('20261201', '090600'), r), false);
  assert.strictEqual(LE.stampOf(q('20261201', '0905')), '202612010905');
  assert.strictEqual(LE.stampOf(q('20261201', '090530')), '202612010905');
  assert.strictEqual(LE.stampOf(q('2026-12-01', '09:05:30')), '202612010905', 'punctuation is ignored');
});

test('an empty time means the whole day (date-only still works)', () => {
  const r = range('2026-12-01', '', '2026-12-02', '');
  const log = [q('20261130', '2359', 'A'), q('20261201', '0000', 'B'), q('20261202', '235959', 'C'), q('20261203', '0000', 'D')];
  assert.strictEqual(calls(LE.filterByRange(log, r)), 'B,C');
  const mixed = range('2026-12-01', '12:00', '2026-12-02', '');
  assert.strictEqual(calls(LE.filterByRange([q('20261201', '1159', 'A'), q('20261201', '1200', 'B'), q('20261202', '2359', 'C')], mixed)), 'B,C');
});

test('a range that crosses midnight', () => {
  const r = range('2026-12-01', '22:00', '2026-12-02', '02:00');
  const log = [q('20261201', '2159', 'A'), q('20261201', '2200', 'B'), q('20261201', '2359', 'C'),
    q('20261202', '0000', 'D'), q('20261202', '0200', 'E'), q('20261202', '0201', 'F')];
  assert.strictEqual(calls(LE.filterByRange(log, r)), 'B,C,D,E');
});

test('a range that spans several days takes the middle days whole', () => {
  const r = range('2026-11-28', '18:00', '2026-12-01', '06:00');
  const log = [q('20261128', '1759', 'A'), q('20261128', '1800', 'B'), q('20261129', '0001', 'C'),
    q('20261130', '2359', 'D'), q('20261201', '0600', 'E'), q('20261201', '0601', 'F')];
  assert.strictEqual(calls(LE.filterByRange(log, r)), 'B,C,D,E');
});

test('open ends: only From, or only To', () => {
  const from = range('2026-12-01', '12:00', '', '');
  assert.strictEqual(from.ok, true);
  assert.strictEqual(calls(LE.filterByRange([q('20261201', '1159', 'A'), q('20261201', '1200', 'B'), q('20270101', '0000', 'C')], from)), 'B,C');
  const to = range('', '', '2026-12-01', '12:00');
  assert.strictEqual(to.ok, true);
  assert.strictEqual(calls(LE.filterByRange([q('20200101', '0000', 'A'), q('20261201', '1200', 'B'), q('20261201', '1201', 'C')], to)), 'A,B');
});

test('a QSO with no time is kept when its day is inside the range', () => {
  const r = range('2026-12-01', '12:00', '2026-12-02', '21:00');
  assert.strictEqual(LE.inRange(q('20261201', ''), r), true, 'first day: cannot be shown to be outside');
  assert.strictEqual(LE.inRange(q('20261202', undefined), r), true);
  assert.strictEqual(LE.inRange(q('20261130', ''), r), false);
  assert.strictEqual(LE.inRange(q('20261203', ''), r), false);
  assert.strictEqual(LE.inRange(q('20261201', '93'), r), true, 'a time too short to read counts as no time');
  assert.strictEqual(LE.stampOf(q('20261201', '')), '20261201');
});

test('a QSO with no date is never in a range; junk input does not throw', () => {
  const r = range('2026-12-01', '', '2026-12-01', '');
  assert.strictEqual(LE.inRange(q('', '1200'), r), false);
  assert.strictEqual(LE.inRange({}, r), false);
  assert.strictEqual(LE.inRange(null, r), false);
  assert.deepStrictEqual(LE.filterByRange(null, r), []);
  assert.deepStrictEqual(LE.filterByRange([q('20261201', '1200')], null), []);
  assert.deepStrictEqual(LE.filterByRange([q('20261201', '1200')], range('', '', '', '')), [], 'an invalid range exports nothing');
});

test('the range says what is wrong in plain words', () => {
  assert.strictEqual(range('', '', '', '').ok, false);
  assert.strictEqual(range('', '', '', '').error, 'Choose a From or a To date.');
  assert.strictEqual(range('', '12:00', '2026-12-01', '').error, 'Add a date for the From time.');
  assert.strictEqual(range('2026-12-01', '', '', '21:00').error, 'Add a date for the To time.');
  assert.strictEqual(range('2026-12-02', '', '2026-12-01', '').error, 'From is after To.');
  assert.strictEqual(range('2026-12-01', '21:00', '2026-12-01', '12:00').error, 'From is after To.');
  assert.strictEqual(range('2026-12-01', '12:00', '2026-12-01', '12:00').ok, true, 'one minute is a range');
  assert.strictEqual(range('not a date', '', '', '').ok, false);
});

test('filtering keeps the order and the very same records, and changes nothing', () => {
  const log = [q('20261201', '1500', 'B'), q('20261201', '1300', 'A'), q('20261205', '1300', 'X')];
  const frozen = JSON.stringify(log);
  const out = LE.filterByRange(log, range('2026-12-01', '', '2026-12-01', ''));
  assert.strictEqual(calls(out), 'B,A');
  assert.strictEqual(out[0], log[0], 'the records are passed on, not rebuilt');
  assert.strictEqual(JSON.stringify(log), frozen);
});

// --- The file name ---
test('the file name says what is in the file', () => {
  assert.strictEqual(LE.fileName({ what: 'shown' }), 'potacat_export.adi');
  assert.strictEqual(LE.fileName({ what: 'selected', count: 12 }), 'potacat_selected_12_qsos.adi');
  assert.strictEqual(LE.fileName({ what: 'selected', count: 1 }), 'potacat_selected_1_qso.adi');
  assert.strictEqual(LE.fileName({ what: 'range', range: range('2026-12-01', '12:00', '2026-12-01', '21:00') }),
    'potacat_2026-12-01_1200Z_to_2026-12-01_2100Z.adi');
  assert.strictEqual(LE.fileName({ what: 'range', range: range('2026-12-01', '', '2026-12-03', '') }),
    'potacat_2026-12-01_to_2026-12-03.adi');
  assert.strictEqual(LE.fileName({ what: 'range', range: range('2026-12-01', '12:00', '2026-12-02', '') }),
    'potacat_2026-12-01_1200Z_to_2026-12-02.adi');
  assert.strictEqual(LE.fileName({ what: 'range', range: range('2026-12-01', '12:00', '', '') }), 'potacat_from_2026-12-01_1200Z.adi');
  assert.strictEqual(LE.fileName({ what: 'range', range: range('', '', '2026-12-01', '') }), 'potacat_to_2026-12-01.adi');
  assert.strictEqual(LE.fileName({ what: 'range', range: range('', '', '', '') }), 'potacat_export.adi');
  assert.strictEqual(LE.fileName(null), 'potacat_export.adi');
});

test('main accepts only a plain POTACAT .adi name from the window', () => {
  assert.strictEqual(LE.safeFileName('potacat_2026-12-01_1200Z_to_2026-12-01_2100Z.adi'), 'potacat_2026-12-01_1200Z_to_2026-12-01_2100Z.adi');
  assert.strictEqual(LE.safeFileName('potacat_selected_12_qsos.adi'), 'potacat_selected_12_qsos.adi');
  for (const bad of ['..\\..\\evil.adi', '../potacat_x.adi', 'C:\\potacat_x.adi', 'potacat_x.exe', 'potacat_..adi/x.adi', 'potacat_a b.adi', '', null, undefined, 42, 'potacat_' + 'a'.repeat(200) + '.adi']) {
    assert.strictEqual(LE.safeFileName(bad), 'potacat_export.adi', String(bad));
  }
});

// --- The words ---
test('the choice labels count what each choice exports', () => {
  assert.strictEqual(LE.shownLabel(412, false), 'All 412 QSOs');
  assert.strictEqual(LE.shownLabel(37, true), 'The 37 QSOs shown');
  assert.strictEqual(LE.shownLabel(1, true), 'The 1 QSO shown');
  assert.strictEqual(LE.selectedLabel(12), 'The 12 selected QSOs');
  assert.strictEqual(LE.selectedLabel(1), 'The 1 selected QSO');
  assert.strictEqual(LE.exportLabel(37), 'Export 37 QSOs');
  assert.strictEqual(LE.exportLabel(1), 'Export 1 QSO');
  assert.strictEqual(LE.exportLabel(0), 'Export');
  assert.strictEqual(LE.rangeNote(37, 412, false), '37 QSOs in this range');
  assert.strictEqual(LE.rangeNote(1, 50, true), '1 QSO in this range, of the 50 shown');
  assert.strictEqual(LE.rangeNote(0, 412, false), 'No QSOs in this range');
});

test('which choice starts ticked: the selection when two or more rows are selected', () => {
  assert.strictEqual(LE.defaultWhat(0), 'shown');
  assert.strictEqual(LE.defaultWhat(1), 'shown', 'one click on a row is not a request to export one QSO');
  assert.strictEqual(LE.defaultWhat(2), 'selected');
});

// --- Wiring ---
const html = src('renderer/qso-popout.html');
const js = src('renderer/qso-popout.js');
const mainSrc = src('main.js');
function between(s, a, b) {
  const i = s.indexOf(a);
  assert.ok(i >= 0, 'missing: ' + a);
  const j = s.indexOf(b, i + a.length);
  assert.ok(j > i, 'missing: ' + b);
  return s.slice(i, j);
}

test('one Export ADIF button; it opens the choice in the Logbook window (no new window)', () => {
  assert.strictEqual(html.split('id="qso-export"').length - 1, 1, 'one export button');
  assert.ok(/<button class="qso-export-btn" id="qso-export">Export ADIF<\/button>/.test(html), 'the label is unchanged');
  assert.ok(html.indexOf('<script src="../lib/log-export-choice.js"></script>') > 0);
  assert.ok(html.indexOf('<script src="../lib/log-export-choice.js"></script>') < html.indexOf('<script src="qso-popout.js"></script>'));
  const dlg = between(html, 'id="export-overlay"', '<script');
  assert.ok(/role="dialog" aria-labelledby="export-title"/.test(dlg));
  assert.ok(/<span id="export-title">Export ADIF<\/span>/.test(dlg));
  for (const v of ['shown', 'range', 'selected']) {
    assert.ok(new RegExp('<input type="radio" name="export-what" value="' + v + '"').test(dlg), v);
  }
  assert.ok(/A time range \(UTC\)/.test(dlg), 'the range is labelled UTC');
  for (const id of ['export-from-date', 'export-to-date']) assert.ok(new RegExp('<input type="date" id="' + id + '"').test(dlg), id);
  for (const id of ['export-from-time', 'export-to-time']) assert.ok(new RegExp('<input type="time" id="' + id + '" step="60"').test(dlg), id);
  assert.ok(/Times are UTC\. Leave a time empty for the whole day\./.test(dlg));
  assert.ok(/id="export-selected-row" class="export-choice hidden"/.test(dlg), 'the selected choice is hidden until rows are selected');
  assert.ok(!/BrowserWindow|window\.open\(/.test(between(js, '// --- Export ADIF ---', '// --- Resend to Logbook ---')));
});

test('the window exports rows it already holds, through the one handler', () => {
  const block = between(js, '// --- Export ADIF ---', '// --- Resend to Logbook ---');
  assert.strictEqual(block.split('window.api.exportAdif(').length - 1, 1, 'one call to the writer');
  assert.ok(/window\.api\.exportAdif\(rows, \{ fileName: LogExportChoice\.fileName\(/.test(block));
  assert.ok(/LogExportChoice\.filterByRange\(filtered, /.test(block), 'the range is taken from the rows shown');
  assert.ok(/filtered\.filter\(\(q\) => selectedIdxs\.has\(q\.idx\)\)/.test(block), 'selected rows, in the order shown');
  assert.ok(/LogExportChoice\.parseRange\(/.test(block));
  assert.ok(!/QSO_DATE|TIME_ON/.test(block), 'no second copy of the time rule in the window');
  assert.ok(!/updateQso|deleteQso|importAdif|getAllQsos|localStorage/.test(block), 'an export changes nothing and remembers nothing');
  assert.ok(/exportAdif: \(qsos, opts\) => ipcRenderer\.invoke\('export-adif', qsos, opts\)/.test(src('preload-qso-popout.js')));
});

test('main names the file from a checked name and still writes with the ADIF writer', () => {
  const h = between(mainSrc, "ipcMain.handle('export-adif'", "ipcMain.handle('resend-qsos-to-logbook'");
  assert.ok(/async \(event, qsos, opts\) =>/.test(h));
  assert.ok(/defaultPath: path\.join\(adifExportDefaultDir\(\), LogExportChoice\.safeFileName\(opts && opts\.fileName\)\)/.test(h));
  assert.ok(/let content = ADIF_HEADER;/.test(h) && /parts\.push\(adifField\(key, value\)\)/.test(h), 'the same writer as before');
  assert.ok(!/mutateLog|logContact|appendFile/.test(h), 'exporting never writes the log');
  assert.ok(/const LogExportChoice = require\('\.\/lib\/log-export-choice'\);/.test(mainSrc));
});

test('the lib is read-only and dual-mode', () => {
  const lib = src('lib/log-export-choice.js');
  assert.ok(!/require\(|mutateLog|writeFile/.test(lib), 'no dependencies, no writes');
  assert.ok(/root\.LogExportChoice = factory\(\)/.test(lib));
});

test('selected rows keep the POTACAT blue tint in the Logbook', () => {
  assert.ok(/\.qso-table tbody tr\.selected \{ background: color-mix\(in srgb, var\(--accent-blue\) 20%, transparent\); \}/.test(html));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
