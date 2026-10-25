#!/usr/bin/env node
'use strict';
// A logged frequency read in any unit, and the repair for records saved with
// MHz typed into the kHz box (NA4DQ 2026-10-24). Cases mirror potacat-app
// __tests__/logFreq.test.ts (5e2431c) so the phone and desktop agree.
// Run: node test/log-freq-test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseLogFreq, hamBandOfKhz, repairMhzTypedAsKhz } = require('../lib/log-freq');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
const ok = (raw) => { const r = parseLogFreq(raw); assert.strictEqual(r.kind, 'ok', raw + ' should parse'); return r; };

test('reads kHz as typed', () => {
  assert.deepStrictEqual(ok('14285'), { kind: 'ok', khz: 14285, band: '20m', text: '14285' });
  assert.strictEqual(ok('7074.5').khz, 7074.5);
  assert.strictEqual(ok('144200').band, '2m');
});

test('reads MHz typed into the kHz box (NA4DQ)', () => {
  assert.deepStrictEqual(ok('14.285'), { kind: 'ok', khz: 14285, band: '20m', text: '14285' });
  assert.strictEqual(ok('7.185').khz, 7185);
  assert.strictEqual(ok('1.840').band, '160m');
  assert.strictEqual(ok('146.52').band, '2m');
  assert.strictEqual(ok('432.1').band, '70cm');
});

test('takes a decimal comma or a thousands comma', () => {
  assert.strictEqual(ok('14,285').khz, 14285);
  assert.strictEqual(ok('14285,5').khz, 14285.5);
  assert.strictEqual(ok('14,285.5').khz, 14285.5);
  assert.strictEqual(ok(' 7.074 MHz ').khz, 7074);
});

test('reads Hz and the LF/MF bands in kHz', () => {
  assert.strictEqual(ok('14285000').khz, 14285);
  assert.strictEqual(ok('474.2').band, '630m');
  assert.strictEqual(ok('136').band, '2200m');
  assert.strictEqual(ok('5258.5').band, '60m');
});

test('refuses what lands in no band, allows empty', () => {
  assert.strictEqual(parseLogFreq('').kind, 'empty');
  assert.strictEqual(parseLogFreq('   ').kind, 'empty');
  assert.strictEqual(parseLogFreq(undefined).kind, 'empty');
  for (const bad of ['14.4', '15000', '0', 'abc', '14.285.5', '1296', '-14285']) {
    assert.strictEqual(parseLogFreq(bad).kind, 'bad', bad);
  }
  assert.strictEqual(parseLogFreq(14285).kind, 'ok', 'a number, not only a string');
});

test('hamBandOfKhz', () => {
  assert.strictEqual(hamBandOfKhz(14.285), null);
  assert.strictEqual(hamBandOfKhz(50313), '6m');
});

test('repair: a sub-1 MHz FREQ with no BAND that lands in a band x1000', () => {
  assert.deepStrictEqual(repairMhzTypedAsKhz({ FREQ: '0.014285', BAND: '' }), { freqMhz: '14.285', band: '20m' });
  assert.deepStrictEqual(repairMhzTypedAsKhz({ FREQ: '0.007185' }), { freqMhz: '7.185', band: '40m' });
  assert.strictEqual(repairMhzTypedAsKhz({ FREQ: '0.1365' }), null, '2200 m is real');
  assert.strictEqual(repairMhzTypedAsKhz({ FREQ: '0.4742' }), null, '630 m is real');
  assert.strictEqual(repairMhzTypedAsKhz({ FREQ: '0.014285', BAND: '20m' }), null, 'a band means the record was read');
  assert.strictEqual(repairMhzTypedAsKhz({ FREQ: '14.285' }), null);
  assert.strictEqual(repairMhzTypedAsKhz({ FREQ: '0.0144' }), null, '14.4 MHz is in no band, left alone');
  assert.strictEqual(repairMhzTypedAsKhz({ FREQ: '' }), null);
});

test('repair through mutateLog rewrites FREQ/BAND and journals an update', () => {
  const QsoLog = require('../lib/qso-log');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logfreq-'));
  const p = path.join(dir, 'log.adi');
  const uuid = '11111111-2222-4333-8444-555555555555';
  fs.writeFileSync(p, '<ADIF_VER:5>3.1.4 <EOH>\n'
    + `<CALL:5>K1ABC <QSO_DATE:8>20261024 <TIME_ON:4>1800 <MODE:3>SSB <FREQ:8>0.014285 <APP_POTACAT_UUID:36>${uuid} <APP_POTACAT_VERSION:1>1 <EOR>\n`
    + '<CALL:5>W9XYZ <QSO_DATE:8>20261024 <TIME_ON:4>1801 <MODE:3>SSB <FREQ:6>14.285 <BAND:3>20m <EOR>\n');
  const changes = [];
  QsoLog.mutateLog(p, (qsos) => {
    let n = 0;
    for (const q of qsos) { const r = repairMhzTypedAsKhz(q); if (r) { q.FREQ = r.freqMhz; q.BAND = r.band; n++; } }
    return n ? qsos : false;
  }, { sink: (c) => changes.push(...c) });
  const after = QsoLog.readLog(p);
  const k = after.find((q) => q.CALL === 'K1ABC');
  assert.strictEqual(k.FREQ, '14.285');
  assert.strictEqual(k.BAND.toLowerCase(), '20m');
  assert.ok(changes.some((c) => c.action === 'update'), 'the Cloud copy heals');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('wiring: logContact reads the typed frequency; log-qso hands it over raw; the repair runs at log load', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8').replace(/\r\n/g, '\n');
  const lc = main.slice(main.indexOf('async function logContact('), main.indexOf('const records = QsoExpand.expandContact(e,'));
  assert.ok(/LogFreq\.parseLogFreq\(e\.frequency\)/.test(lc) && /e\.frequency = '';\n\s*e\.band = '';/.test(lc), 'a value in no band is saved blank');
  assert.ok(/f\.kind === 'bad' && !\(Number\(e\.frequency\) >= 1000\)/.test(lc), 'only a sub-1 MHz value is blanked; a microwave kHz value is kept');
  assert.ok(/const rawFreq = data\.freqKhz == null \? '' : String\(data\.freqKhz\)\.trim\(\);/.test(main));
  assert.ok(!/const freqKhz = parseFloat\(data\.freqKhz\) \|\| 0;/.test(main), 'log-qso no longer parseFloats the box');
  assert.ok(/repairQsoLogFieldNames\(qsoLogPath\(\)\);\n\s*repairQsoLogMhzFreqs\(qsoLogPath\(\)\);/.test(main));
  assert.ok(/\.pre-freq-repair-/.test(main), 'the original is kept');
});

console.log(`\nLog frequency: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
