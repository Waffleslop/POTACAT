#!/usr/bin/env node
'use strict';
// SSTV help and reports (Casey 2026-09-30: pictures saying "UR P4"/"UR P5"
// confuse newcomers). lib/sstv-help.js, the reply bar's report box, the
// {RPT} placeholder, and the calling-frequency sidebands.
// Run: node test/sstv-help-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const H = require('../lib/sstv-help');
const T = require('../lib/sstv-templates');

const ROOT = path.join(__dirname, '..');
const R = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

console.log('SSTV help');

test('a report is RSV (R 1-5, S 1-9, V 1-5) or the P scale (P1-P5)', () => {
  assert.deepStrictEqual(H.parseReport('595'), { kind: 'rsv', value: '595' });
  assert.deepStrictEqual(H.parseReport(' p4 '), { kind: 'p', value: 'P4' });
  for (const bad of ['599', '695', '505', 'P0', 'P6', '59', '5955', '', null]) assert.strictEqual(H.parseReport(bad), null, String(bad));
});

test('on a picture: "RSV 595" or "P5"; explained in words', () => {
  assert.strictEqual(H.reportText('595'), 'RSV 595');
  assert.strictEqual(H.reportText('P5'), 'P5');
  assert.strictEqual(H.reportText('nope'), '');
  assert.strictEqual(H.explainReport('P4'), 'P4: very good, a little noise.');
  assert.ok(/strength 7 of 9, picture 3 of 5/.test(H.explainReport('573')));
});

test('the P scale reads the way the SSTV community defines it (CQSSTV)', () => {
  assert.deepStrictEqual(H.P_SCALE.map((x) => x.p), [5, 4, 3, 2, 1]);
  assert.ok(/perfect/i.test(H.P_SCALE[0].words) && /barely visible/i.test(H.P_SCALE[4].words));
});

test('the help covers where, modes, the contact, reports, ID and the radio, in plain text', () => {
  const ids = H.SECTIONS.map((s) => s.id);
  for (const id of ['where', 'modes', 'contact', 'reports', 'id', 'radio']) assert.ok(ids.includes(id), id);
  const all = JSON.stringify(H.SECTIONS);
  assert.ok(/UR P5/.test(all) && /595/.test(all));
  assert.ok(!/<[a-z]/i.test(all), 'no markup: every surface renders it itself');
});

test('reply templates print the report the way it was given: {RPT}', () => {
  const lines = T.STARTERS.filter((s) => s.reply).flatMap((s) => s.texts.map((t) => t.text));
  assert.ok(lines.some((l) => /\{RPT\}/.test(l)));
  assert.ok(!lines.some((l) => /RSV \{RSV\}/.test(l)), '"UR RSV P5" never happens');
  assert.strictEqual(T.fillVars('UR {RPT}', { RPT: 'P5' }), 'UR P5');
  assert.strictEqual(T.fillVars('UR {RPT}', {}), 'UR ', 'a known placeholder with no value is blank');
});

test('the reply bar takes P5 as well as 595, explains it, and the help is one click away', () => {
  const html = R('renderer/sstv-popout.html'), js = R('renderer/sstv-popout.js');
  assert.ok(/<span>Report<\/span><input type="text" id="rb-rsv"/.test(html) && !/id="rb-rsv"[^>]*inputmode="numeric"/.test(html));
  assert.ok(/id="rb-help"/.test(html) && /id="sstv-help-btn"/.test(html) && /<script src="\.\.\/lib\/sstv-help\.js"><\/script>/.test(html));
  assert.ok(/RPT: \(window\.SstvHelp && window\.SstvHelp\.reportText\(/.test(js));
  assert.ok(/openSstvHelp\('reports'\)/.test(js));
  // cleanReport, run for real.
  const i = js.indexOf('function cleanReport('), src = js.slice(i, js.indexOf('\n}\n', i) + 2);
  const cleanReport = new Function(src + 'return cleanReport;')();
  assert.deepStrictEqual(['p5', '595', '5 9 5', 'P55', '59P5'].map(cleanReport), ['P5', '595', '595', 'P5', '595']);
});

test('every calling frequency in the list uses the sideband the reply bar and the app expect', () => {
  const html = R('renderer/sstv-popout.html'), js = R('renderer/sstv-popout.js');
  const i = js.indexOf('function getFreqMode('), src = js.slice(i, js.indexOf('\n}\n', i) + 2);
  const getFreqMode = new Function(src + 'return getFreqMode;')();
  const opts = [...html.matchAll(/<option value="(\d+)" data-mode="(USB|LSB)">/g)];
  assert.ok(opts.length >= 10);
  for (const [, khz, mode] of opts) assert.strictEqual(mode, getFreqMode(khz), khz + ' kHz is ' + mode + ' in the list');
  assert.ok(opts.some(([, k, m]) => k === '7171' && m === 'LSB'), '7.171 is LSB (North America)');
  const where = H.SECTIONS.find((s) => s.id === 'where').table.map((r) => r[0]);
  for (const w of where) { const [mhz, side] = w.split(' '); assert.strictEqual(side, getFreqMode(String(Math.round(Number(mhz) * 1000))), w); }
});

test('logging SSTV: 595 by default, P5 kept, and the log keeps SSTV and the heard frequency', () => {
  const lp = R('renderer/log-popout.js');
  const i = lp.indexOf('function defaultRstFor('), src = lp.slice(i, lp.indexOf('\n  }\n', i) + 4);
  const defaultRstFor = new Function('CW_DIGI_MODES', src + 'return defaultRstFor;')(new Set(['CW', 'FT8']));
  assert.deepStrictEqual(['SSTV', 'CW', 'SSB'].map(defaultRstFor), ['595', '599', '59']);
  // A prefill pins what it says the QSO was, or the rig's USB flips SSTV to SSB.
  assert.ok(/if \(p\.freqKhz\) freqUserEdited = true;\n\s+if \(p\.mode\) modeUserEdited = true;/.test(lp));
  assert.ok(/const next = p\.rstSent && !p\.rstRcvd \? rstRcvdInput : rstSentInput;/.test(lp), 'the cursor goes to the report still to type');
  assert.ok(/if \(p\.notes\) notesInput\.value = String\(p\.notes\);/.test(lp));
  assert.ok(/timeInput\.value = p\.timeOn\.slice\(0, 2\) \+ ':' \+ p\.timeOn\.slice\(2, 4\);[\s\S]{0,300}timeUserEdited = true;/.test(lp), 'a carried time is not overwritten by the live clock');
  const main = R('main.js');
  const at = main.indexOf("ipcMain.on('sstv-log-contact'");
  const h = main.slice(at, at + 1800);
  assert.ok(/mode: 'SSTV'/.test(h) && /Date\.now\(\) - Number\(heardAt\) < 60 \* 60 \* 1000/.test(h) && /notes: sstvMode \? 'SSTV '/.test(h));
  const js = R('renderer/sstv-popout.js');
  assert.ok(/heardAt: replySession\.heardAt, sstvMode: replySession\.mode/.test(js), 'the reply bar sends when and in what mode');
  assert.ok(/label: 'Log a contact with '/.test(js), 'a received picture can be logged without replying');
});

console.log(`\nSSTV help: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
