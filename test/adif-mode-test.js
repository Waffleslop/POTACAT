#!/usr/bin/env node
'use strict';
// ADIF MODE/SUBMODE both ways (lib/adif-mode.js, #381 step 1).
//
// Writing: FT4, FT8 and FT2 are written exactly as before (MODE=FT4 etc.);
// JS8 and JTTY stay MFSK + SUBMODE. Reading: every reader that shows, counts,
// filters or matches a mode sees JS8 / JTTY by name, an old MODE=FT4 record
// reads FT4, and an MFSK/FT4 or MFSK/FT2 record (what WSJT-X writes, and
// what POTACAT will write after the later flip) already reads FT4 / FT2.
//
// Run: node test/adif-mode-test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readSrc } = require('./_src');

const AdifMode = require('../lib/adif-mode');
const { adifModeSubmode, adifAppMode, recordMode } = AdifMode;
const writer = require('../lib/adif-writer');
const { parseWorkedQsos, parseAdifFile, parseAllQsos, normalizeMode } = require('../lib/adif');
const { sameContact } = require('../lib/qso-match');
const { buildContestHistory } = require('../lib/contest-history');
const { modeEditFields, applyQsoEdit } = require('../lib/qso-edit');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e).split('\n')[0]); }
}
const root = path.join(__dirname, '..');
const R = (f) => readSrc(path.join(root, f)).replace(/\r\n/g, '\n');

console.log('lib/adif-mode.js');

// --- Write side ---
const write = (mode, submode) => {
  const f = writer.buildAdifFields({ callsign: 'K1ABC', frequency: '14080', mode, submode, qsoDate: '20261114', timeOn: '1200' });
  return [f.MODE, f.SUBMODE || ''];
};
test('FT4 is still written as MODE=FT4 with no SUBMODE (the flip waits for phone + Cloud)', () => {
  assert.deepStrictEqual(write('FT4'), ['FT4', '']);
});
test('FT8 is unchanged', () => { assert.deepStrictEqual(write('FT8'), ['FT8', '']); });
test('FT2 is unchanged', () => { assert.deepStrictEqual(write('FT2'), ['FT2', '']); });
test('JS8 and JTTY are still MFSK + SUBMODE; PSK31 is PSK/PSK31', () => {
  assert.deepStrictEqual(write('JS8', 'NORMAL'), ['MFSK', 'JS8']);
  assert.deepStrictEqual(write('JTTY'), ['MFSK', 'JTTY']);
  assert.deepStrictEqual(write('PSK31'), ['PSK', 'PSK31']);
});
test('adif-writer re-exports the one adifModeSubmode', () => {
  assert.strictEqual(writer.adifModeSubmode, adifModeSubmode);
});
test('a QSO read back from a record writes the record\'s own pair (adifMode)', () => {
  const pair = (adifMode, submode, mode) => {
    const f = writer.buildAdifFields({ callsign: 'K1ABC', mode, adifMode, submode, qsoDate: '20261114', timeOn: '1200' });
    return [f.MODE, f.SUBMODE || ''];
  };
  assert.deepStrictEqual(pair('MFSK', 'JS8', 'JS8'), ['MFSK', 'JS8']);
  assert.deepStrictEqual(pair('MFSK', 'FT4', 'FT4'), ['MFSK', 'FT4'], 'a WSJT-X MFSK/FT4 record stays MFSK/FT4');
  assert.deepStrictEqual(pair('MFSK', 'FT2', 'FT2'), ['MFSK', 'FT2']);
  assert.deepStrictEqual(pair('FT4', '', 'FT4'), ['FT4', ''], 'an old MODE=FT4 record stays as it is');
  assert.deepStrictEqual(pair('DIGITALVOICE', 'FREEDV', 'FREEDV'), ['DIGITALVOICE', 'FREEDV']);
  assert.deepStrictEqual(pair('JS8', '', 'JS8'), ['MFSK', 'JS8'], 'a bare MODE=JS8 is repaired');
});

// --- Read side ---
test('adifAppMode: the family gives way to its SUBMODE', () => {
  assert.strictEqual(adifAppMode('MFSK', 'JS8'), 'JS8');
  assert.strictEqual(adifAppMode('MFSK', 'JTTY'), 'JTTY');
  assert.strictEqual(adifAppMode('MFSK', 'FT4'), 'FT4');
  assert.strictEqual(adifAppMode('MFSK', 'FT2'), 'FT2');
  assert.strictEqual(adifAppMode('PSK', 'PSK31'), 'PSK31');
  assert.strictEqual(adifAppMode('DIGITALVOICE', 'FREEDV'), 'FREEDV');
  assert.strictEqual(adifAppMode('FT4', ''), 'FT4', 'old MODE=FT4 unchanged');
  assert.strictEqual(adifAppMode('FT8'), 'FT8');
  assert.strictEqual(adifAppMode('USB', 'X'), 'USB', 'a SUBMODE under a non-family MODE is not the mode');
  assert.strictEqual(adifAppMode('MFSK', ''), 'MFSK');
  assert.strictEqual(adifAppMode('', ''), '');
  assert.strictEqual(recordMode({ MODE: 'mfsk', SUBMODE: 'js8' }), 'JS8');
});
test('normalizeMode (spots, worked) reads the submode and folds USB to SSB', () => {
  assert.strictEqual(normalizeMode('MFSK', 'JS8'), 'JS8');
  assert.strictEqual(normalizeMode('MFSK', 'FT2'), 'FT2');
  assert.strictEqual(normalizeMode('USB'), 'SSB');
});

// One log file with every form, read by each lib/adif.js reader.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adif-mode-'));
const logPath = path.join(dir, 'log.adi');
const rec = (call, mode, sub, extra = '') => {
  const f = (k, v) => (v ? `<${k}:${v.length}>${v}` : '');
  return f('CALL', call) + f('QSO_DATE', '20261025') + f('TIME_ON', '120000') + f('BAND', '20M')
    + f('FREQ', '14.080000') + f('MODE', mode) + f('SUBMODE', sub) + extra + ' <EOR>\n';
};
fs.writeFileSync(logPath, 'test\n<EOH>\n'
  + rec('K1OLD', 'FT4', '') + rec('K1NEW', 'MFSK', 'FT4') + rec('K1FT2', 'MFSK', 'FT2')
  + rec('K1JS8', 'MFSK', 'JS8', '<QSL_RCVD:1>Y') + rec('K1TTY', 'MFSK', 'JTTY') + rec('K1FT8', 'FT8', ''));
const want = { K1OLD: 'FT4', K1NEW: 'FT4', K1FT2: 'FT2', K1JS8: 'JS8', K1TTY: 'JTTY', K1FT8: 'FT8' };

test('parseWorkedQsos (worked-before): every form reads by name', () => {
  const m = parseWorkedQsos(logPath);
  for (const [call, mode] of Object.entries(want)) assert.strictEqual(m.get(call)[0].mode, mode, call);
});
test('parseAdifFile (DXCC tracker / awards): JS8 reads JS8, not MFSK', () => {
  const q = parseAdifFile(logPath, { confirmedOnly: false });
  const by = Object.fromEntries(q.map((x) => [x.call, x.mode]));
  for (const [call, mode] of Object.entries(want)) assert.strictEqual(by[call], mode, call);
});
test('parseAllQsos (recent QSOs): every form reads by name', () => {
  const by = Object.fromEntries(parseAllQsos(logPath).map((x) => [x.call, x.mode]));
  for (const [call, mode] of Object.entries(want)) assert.strictEqual(by[call], mode, call);
});
fs.rmSync(dir, { recursive: true, force: true });

test('worked-before / dupes match across MODE=FT4 and MFSK/FT4 (and FT2, JS8)', () => {
  const base = { CALL: 'K1ABC', QSO_DATE: '20261025', TIME_ON: '120000', FREQ: '14.080000' };
  assert.ok(sameContact({ ...base, MODE: 'FT4' }, { ...base, MODE: 'MFSK', SUBMODE: 'FT4' }));
  assert.ok(sameContact({ ...base, MODE: 'FT2' }, { ...base, MODE: 'MFSK', SUBMODE: 'FT2' }));
  assert.ok(sameContact({ ...base, MODE: 'JS8' }, { ...base, MODE: 'MFSK', SUBMODE: 'JS8' }));
  assert.ok(!sameContact({ ...base, MODE: 'FT8' }, { ...base, MODE: 'MFSK', SUBMODE: 'FT4' }));
  const worked = parseWorkedQsosFrom([['K1ABC', 'FT4', ''], ['K1ABC', 'MFSK', 'FT4']]);
  assert.deepStrictEqual(worked.get('K1ABC').map((e) => e.mode), ['FT4', 'FT4']);
});
function parseWorkedQsosFrom(rows) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'adif-mode-w-'));
  const p = path.join(d, 'w.adi');
  fs.writeFileSync(p, '<EOH>\n' + rows.map(([c, m, s]) => rec(c, m, s)).join(''));
  try { return parseWorkedQsos(p); } finally { fs.rmSync(d, { recursive: true, force: true }); }
}

test('contest history counts JS8 / FT4 / FT2 by name', () => {
  const contest = [{ id: 'digi-test', whenComputed: 'fixed:10-25', durationHours: 24, bands: [], modes: ['JS8', 'FT4', 'FT2'] }];
  const q = (MODE, SUBMODE) => ({ CALL: 'K1ABC', QSO_DATE: '20261025', TIME_ON: '120000', BAND: '20M', MODE, SUBMODE });
  const h = buildContestHistory(contest, [q('MFSK', 'JS8'), q('MFSK', 'FT4'), q('FT4'), q('MFSK', 'FT2')], { generatedAt: 1 });
  const y = h && h.contests['digi-test'] && h.contests['digi-test']['2026'];
  assert.ok(y, 'contest tallied');
  assert.deepStrictEqual(y.modes, { JS8: 1, FT4: 2, FT2: 1 });
});

// --- Mode edits ---
test('a Mode edit equal to the mode the record is changes nothing (MFSK/JS8, MFSK/FT4, FT4)', () => {
  assert.deepStrictEqual(modeEditFields({ MODE: 'MFSK', SUBMODE: 'JS8' }, 'JS8').fields, {});
  assert.deepStrictEqual(modeEditFields({ MODE: 'MFSK', SUBMODE: 'FT4' }, 'ft4').fields, {});
  assert.deepStrictEqual(modeEditFields({ MODE: 'FT4' }, 'FT4').fields, {});
  assert.deepStrictEqual(modeEditFields({ MODE: 'DIGITALVOICE', SUBMODE: 'FREEDV' }, 'FREEDV').fields, {});
});
test('a Mode edit writes MODE + SUBMODE by the writer\'s rule', () => {
  assert.deepStrictEqual(modeEditFields({ MODE: 'FT8' }, 'JS8').fields, { MODE: 'MFSK', SUBMODE: 'JS8' });
  assert.deepStrictEqual(modeEditFields({ MODE: 'MFSK', SUBMODE: 'JS8' }, 'FT8').fields, { MODE: 'FT8', SUBMODE: null });
  assert.deepStrictEqual(modeEditFields({ MODE: 'CW' }, 'PSK31').fields, { MODE: 'PSK', SUBMODE: 'PSK31' });
  assert.deepStrictEqual(modeEditFields({ MODE: 'FT8' }, 'FT4').fields, { MODE: 'FT4', SUBMODE: null });
});
test('applyQsoEdit: an edited MFSK/JS8 record keeps MFSK + SUBMODE', () => {
  const r = { CALL: 'K1ABC', MODE: 'MFSK', SUBMODE: 'JS8' };
  const out = applyQsoEdit(r, { MODE: 'JS8', COMMENT: 'hi' });
  assert.deepStrictEqual([r.MODE, r.SUBMODE, r.COMMENT], ['MFSK', 'JS8', 'hi']);
  assert.ok(!('MODE' in out.fields));
  const r2 = { CALL: 'K1ABC', MODE: 'MFSK', SUBMODE: 'JS8' };
  const out2 = applyQsoEdit(r2, { MODE: 'FT8' });
  assert.deepStrictEqual([r2.MODE, 'SUBMODE' in r2], ['FT8', false]);
  assert.deepStrictEqual(out2.fields, { MODE: 'FT8', SUBMODE: '' });
});

// --- Glue (main.js, pages) ---
const main = R('main.js');
test('rawQsoToQsoData carries the record\'s pair (SUBMODE is no longer dropped)', () => {
  const i = main.indexOf('function rawQsoToQsoData(raw)');
  const fn = main.slice(i, main.indexOf('\n}\n', i));
  assert.ok(/mode: adifAppMode\(raw\.MODE, raw\.SUBMODE\)/.test(fn));
  assert.ok(/adifMode: raw\.MODE/.test(fn) && /submode: raw\.SUBMODE/.test(fn));
});
test('main.js readers use adifAppMode, never a bare rec.MODE', () => {
  assert.ok(!/mode: (rec|raw|q)\.MODE \|\| ''/.test(main), 'a reader still copies MODE without SUBMODE');
  assert.ok(/mode: adifAppMode\(q\.MODE, q\.SUBMODE\),\s+adifMode: q\.MODE/.test(main), 'Past Activations');
  assert.ok(/const ms = adifModeSubmode\(qso\.mode, ''\);/.test(main), 'legacy event export');
  assert.ok(/modeEditFields\(q, MODE\)/.test(main), 'activator-log Mode edit');
});
test('the Logbook loads lib/adif-mode.js before qso-popout.js and reads modes through it', () => {
  const html = R('renderer/qso-popout.html');
  const a = html.indexOf('<script src="../lib/adif-mode.js"></script>');
  assert.ok(a > 0 && a < html.indexOf('<script src="qso-popout.js"></script>'));
  const js = R('renderer/qso-popout.js');
  assert.ok(/get: \(q\) => qsoMode\(q\)/.test(js), 'Mode column');
  assert.ok(!/q\.MODE \|\| ''\)\.toUpperCase\(\) === filterMode/.test(js), 'Mode filter');
  // The filter rule itself.
  const body = (name) => { const i = js.indexOf('function ' + name + '('); return js.slice(i, js.indexOf('\n}\n', i) + 2); };
  const f = new Function('AdifMode', body('qsoMode') + body('qsoModeMatches') + 'return { qsoMode, qsoModeMatches };')(AdifMode);
  assert.strictEqual(f.qsoMode({ MODE: 'MFSK', SUBMODE: 'JS8' }), 'JS8');
  assert.ok(f.qsoModeMatches({ MODE: 'MFSK', SUBMODE: 'FT4' }, 'FT4'));
  assert.ok(f.qsoModeMatches({ MODE: 'FT4' }, 'FT4'));
  assert.ok(f.qsoModeMatches({ MODE: 'MFSK', SUBMODE: 'FT2' }, 'FT2'));
  assert.ok(f.qsoModeMatches({ MODE: 'PSK', SUBMODE: 'PSK63' }, 'PSK'));
  assert.ok(f.qsoModeMatches({ MODE: 'DIGI' }, 'DIGI'));
  assert.ok(!f.qsoModeMatches({ MODE: 'FT8' }, 'FT4'));
});
test('ECHOCAT Web inlines lib/adif-mode.js and writes its exports through it', () => {
  assert.ok(R('renderer/remote.html').includes('<!-- adif-mode-js -->'));
  assert.ok(R('lib/remote-server.js').includes("['adif-mode-js', 'adif-mode.js']"));
  const web = R('renderer/remote.js');
  assert.ok(!/af\('MODE', c\.mode\)/.test(web), 'an export still writes a raw MODE');
  assert.strictEqual((web.match(/afMode\(/g) || []).length, 4, 'afMode defined once, used by the three exports');
  assert.ok(/const mode = esc\(AdifMode\.recordMode\(q\)\);/.test(web), 'Logbook row shows the mode by name');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
