#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
// #794: a CW station spotted on 7.0355 MHz was logged 7.036000 (POTACAT's log,
// N3FJP ACLog) and the log window showed 7036.0. The frequency travels to the
// hertz from the spot or the dial to the log and every export; a form box may
// SHOW 100 Hz, never save it. Existing records are not rewritten.
// Run: node test/log-freq-resolution-test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const LogFreqField = require('../lib/log-freq-field');
const LogFreq = require('../lib/log-freq');
const { buildAdifRecord, buildAdifFields, appendRawQsos } = require('../lib/adif-writer');
const { n3fjpCountry } = require('../lib/n3fjp-pull');
const wsjtx = require('../lib/wsjtx');
const QsoLog = require('../lib/qso-log');

const root = path.join(__dirname, '..');
const src = (p) => readSrc(path.join(root, p));
const app = src('renderer/app.js');
const main = src('main.js');
const logPopout = src('renderer/log-popout.js');
const qsoPopout = src('renderer/qso-popout.js');
const remote = src('renderer/remote.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
const box = (value = '') => ({ value, dataset: {} });
/** What logContact does with the form's text (main.js: LogFreq.parseLogFreq, then buildAdifFields). */
const loggedFreq = (text) => {
  const f = LogFreq.parseLogFreq(text);
  assert.strictEqual(f.kind, 'ok', text + ' should read');
  return buildAdifFields({ callsign: 'K3SBP', frequency: f.text, mode: 'CW', qsoDate: '20261120', timeOn: '1200', band: f.band }).FREQ;
};

// ── The box: shows 100 Hz, logs the hertz ───────────────────────────────────
test('a spot on 7.0355 MHz: the box shows 7035.5 and logs 7.035500', () => {
  const b = box();
  LogFreqField.fill(b, 7035.5);
  assert.strictEqual(b.value, '7035.5');
  assert.strictEqual(LogFreqField.value(b), '7035.5');
  assert.strictEqual(loggedFreq(LogFreqField.value(b)), '7.035500');
});
test('a 1 Hz dial on 7035512 Hz: the box shows 7035.5 and logs 7.035512', () => {
  const b = box();
  LogFreqField.fill(b, 7035512 / 1000);
  assert.strictEqual(b.value, '7035.5');
  assert.strictEqual(LogFreqField.value(b), '7035.512');
  assert.strictEqual(loggedFreq(LogFreqField.value(b)), '7.035512');
});
test('a box in MHz (Activation panel) shows 7.0355 and logs the hertz', () => {
  const b = box();
  LogFreqField.fill(b, 7035.512, 'mhz');
  assert.strictEqual(b.value, '7.0355');
  assert.strictEqual(loggedFreq(LogFreqField.value(b)), '7.035512');
});
test('what the operator types wins, in any unit', () => {
  const b = box();
  LogFreqField.fill(b, 7035.512);
  b.value = '7036.2';
  assert.strictEqual(LogFreqField.value(b), '7036.2');
  b.value = '14.285';
  assert.strictEqual(loggedFreq(LogFreqField.value(b)), '14.285000');
});
test('an empty fill clears the box and its exact value', () => {
  const b = box();
  LogFreqField.fill(b, 7035.512);
  LogFreqField.fill(b, 0);
  assert.strictEqual(b.value, '');
  assert.strictEqual(LogFreqField.value(b), '');
});
test('the spot sources keep the hertz: SOTA 7.0355 MHz is 7035.5 kHz, not 7036', () => {
  assert.strictEqual(LogFreqField.exactKhzText(7.0355 * 1000), '7035.5');
  assert.strictEqual(LogFreqField.exactKhzText(14.062 * 1000), '14062');
});

// ── The main log window follows the dial (runs app.js's own function) ───────
test('the main log window follows a 1 Hz dial: shows 7035.5, saves 7035.512', () => {
  const start = app.indexOf('const logFreqFollow = {');
  const end = app.indexOf("logFrequency.addEventListener('input'", start);
  const ctx = { logDialog: { open: true }, logFrequency: box('7000.0'), LogFreqField };
  vm.createContext(ctx);
  vm.runInContext(app.slice(start, end).replace('const logFreqFollow', 'var logFreqFollow') + '\nthis.f = logFreqFollowRadio;', ctx);
  ctx.f(7035512);
  assert.strictEqual(ctx.logFrequency.value, '7035.5');
  assert.strictEqual(LogFreqField.value(ctx.logFrequency), '7035.512');
});

// ── Every surface fills its box through the helper, never a rounded dial ────
test('VFO LOG button and Ctrl+L hand over the unrounded dial', () => {
  assert.ok(!/frequency: radioFreqKhz \? String\(radioFreqKhz\)/.test(app), 'VFO LOG used the whole-kHz dial');
  assert.ok(/frequency: radioFreqKhzExact \? String\(radioFreqKhzExact\)/.test(app));
  const q = app.slice(app.indexOf('function openQuickLog() {'), app.indexOf('// ── Sound-card PTT'));
  assert.ok(/freqKhz: radioFreqKhzExact \|\| radioFreqKhz \|\| null/.test(q));
});
test('main log window: filled and read through LogFreqField', () => {
  assert.ok(/LogFreqField\.fill\(logFrequency, parseFloat\(spot\.frequency\)\)/.test(app));
  assert.ok(/const frequency = LogFreqField\.value\(logFrequency\);/.test(app));
  assert.ok(!/logFrequency\.value = [^;]*toFixed\(1\)/.test(app));
});
test('banner quick log: the unrounded dial, read through LogFreqField', () => {
  assert.ok(/LogFreqField\.fill\(blFreq, radioFreqKhzExact \|\| radioFreqKhz, 'mhz'\)/.test(app));
  assert.ok(/const frequency = LogFreqField\.value\(blFreq\);/.test(app));
});
test('Activation panel: no whole-kHz rounding of the logged frequency', () => {
  assert.ok(!/typedKhz > 0 \? Math\.round\(typedKhz\)/.test(app));
  assert.ok(!/activatorFreqInput\.value = \(khz \/ 1000\)\.toFixed\(3\)/.test(app));
  assert.ok(!/activatorFreqInput\.value = \(radioFreqKhz \/ 1000\)\.toFixed\(3\)/.test(app));
  assert.ok(/LogFreqField\.value\(activatorFreqInput\)/.test(app));
});
test('past activations and their export keep the hertz', () => {
  assert.ok(!/String\(Math\.round\(parseFloat\(c\.freq\) \* 1000\)\)/.test(app));
  assert.ok(!/const freqKhz = Math\.round\(parseFloat\(newVal\) \* 1000\);/.test(app));
});
test('Log pop-out: CAT follow and prefill keep the hertz', () => {
  assert.ok(!/freqInput\.value = String\(Math\.round\(hz \/ 1000\)\)/.test(logPopout));
  assert.ok(!/freqInput\.value = String\(Math\.round\(p\.freqKhz\)\)/.test(logPopout));
  assert.ok(/LogFreqField\.fill\(freqInput, hz \/ 1000\)/.test(logPopout));
  assert.ok(/LogFreqField\.value\(freqInput\)/.test(logPopout));
  assert.ok(/log-freq-field\.js/.test(src('renderer/log-popout.html')));
});
test('Logbook + New QSO: the rig frequency to the hertz', () => {
  assert.ok(!/_currentRigFreqKhz = Math\.round\(hz \/ 1000\)/.test(qsoPopout));
  assert.ok(/LogFreqField\.value\(newQsoFreq\)/.test(qsoPopout));
  assert.ok(/log-freq-field\.js/.test(src('renderer/qso-popout.html')));
});
test('ECHOCAT Web log sheet and quick log: filled and read through LogFreqField', () => {
  assert.ok(!/logFreq\.value = String\(Math\.round\(currentFreqKhz \* 10\) \/ 10\)/.test(remote));
  assert.ok(!/ltFreq\.value = String\(Math\.round\(currentFreqKhz \* 10\) \/ 10\)/.test(remote));
  assert.ok(/LogFreqField\.value\(logFreq\)/.test(remote) && /LogFreqField\.value\(ltFreq\)/.test(remote));
  assert.ok(/<!-- log-freq-field-js -->/.test(src('renderer/remote.html')));
  assert.ok(/\['log-freq-field-js', 'log-freq-field\.js'\]/.test(src('lib/remote-server.js')));
});
test('main: SOTA, LLOTA and WWBOTA spots, the WSJT-X auto-log and Resend keep the hertz', () => {
  assert.ok(!/const freqKHz = Math\.round\(freqMHz \* 1000\); \/\/ SOTA/.test(main));
  assert.ok(!/Math\.round\(freqNum\) : Math\.round\(freqNum \* 1000\)/.test(main));
  assert.ok(!/frequency: String\(Math\.round\(freqMHz \* 1000\)\),/.test(main));
  assert.ok(!/frequency: \(freqMhz \* 1000\)\.toFixed\(1\), \/\/ MHz -> kHz/.test(main));
});

// ── Every export carries the full value ─────────────────────────────────────
const qso = { callsign: 'W1AW', frequency: '7035.512', mode: 'CW', qsoDate: '20261120', timeOn: '120000', band: '40m', rstSent: '599', rstRcvd: '599' };
test('ADIF FREQ (log file, QRZ, Club Log, Log4OM, HRD, DXKeeper, Wavelog) is 7.035512', () => {
  assert.ok(/<FREQ:8>7\.035512/i.test(buildAdifRecord(qso)));
});
test('N3FJP ADDADIFRECORD carries 7.035512', () => {
  assert.ok(/<FREQ:8>7\.035512/i.test(n3fjpCountry(buildAdifRecord(qso))));
});
test('WSJT-X type 5 (Logger32, HamRS, MacLoggerDX, GridTracker) carries 7035512 Hz', () => {
  const freqHz = Math.round((parseFloat(qso.frequency) || 0) * 1000); // main.js bridge sendQso
  assert.ok(/const freqHz = Math\.round\(\(parseFloat\(qsoData\.frequency\) \|\| 0\) \* 1000\);/.test(main));
  const buf = wsjtx.encodeQsoLogged('POTACAT', { dxCall: 'W1AW', txFrequency: freqHz, mode: 'CW' });
  const r = new wsjtx.BinaryReader(buf);
  r.readUInt32BE(); r.readUInt32BE(); r.readUInt32BE(); r.readUtf8(); // magic, schema, type, id
  assert.strictEqual(wsjtx.parseQsoLogged(r).txFrequency, 7035512);
});
test('Cloud journal and the log file: the new record is 7.035512, the old 7.036000 is untouched', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'potacat-794-'));
  const logPath = path.join(dir, 'log.adi');
  const old = { CALL: 'K1OLD', QSO_DATE: '20261101', TIME_ON: '1200', FREQ: '7.036000', BAND: '40m', MODE: 'CW', APP_POTACAT_UUID: '11111111-1111-4111-8111-111111111111', APP_POTACAT_VERSION: '1' };
  appendRawQsos(logPath, [old]);
  const journaled = [];
  QsoLog.mutateLog(logPath, (qsos) => [...qsos, buildAdifFields(qso)], { sink: (c) => journaled.push(...c) });
  assert.strictEqual(journaled.length, 1);
  assert.strictEqual(journaled[0].fields.FREQ, '7.035512');
  const back = QsoLog.readLog(logPath);
  assert.strictEqual(back[0].FREQ, '7.036000');
  assert.strictEqual(back[0].APP_POTACAT_VERSION, '1');
  assert.strictEqual(back[1].FREQ, '7.035512');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── Displays still round ────────────────────────────────────────────────────
test('displays round: FreqDots shows 7.035.51, the box shows 7035.5', () => {
  const FreqDots = require('../lib/freq-dots');
  assert.strictEqual(FreqDots.fromKhz(7035.512), '7.035.51');
  assert.strictEqual(LogFreqField.shownText(7035.512), '7035.5');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
