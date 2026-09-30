#!/usr/bin/env node
'use strict';
// SSTV and JTCAT cannot share the radio's audio input. Starting JTCAT has
// closed SSTV since 2026-05; opening SSTV now closes JTCAT too (K3SBP
// 2026-09-30: "I had FT8 opened, then opened SSTV. JTCAT pop out should have
// tore down"). Source guards on main.js, including a module-scope check on
// everything the helper calls (the gallery ReferenceError lesson).
// Run: node test/sstv-jtcat-handover-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8').replace(/\r\n/g, '\n');
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
const body = (start) => { const i = MAIN.indexOf(start); assert.ok(i >= 0, 'missing ' + start); return MAIN.slice(i, MAIN.indexOf('\n}\n', i)); };
const topLevel = (name) => new RegExp(`^(async )?function ${name}\\(|^(const|let|var) ${name}\\b`, 'm').test(MAIN);

console.log('SSTV / JTCAT handover');

test('starting JTCAT still closes SSTV', () => {
  assert.ok(/if \(sstvPopoutWin && !sstvPopoutWin\.isDestroyed\(\)\) \{\n\s+sendCatLog\('\[JTCAT\] Closing SSTV popout/.test(body('function startJtcat(')));
});

test('opening SSTV closes the FT8 and JS8 windows and stops an app-driven engine', () => {
  const b = body('function releaseJtcatForSstv(');
  assert.ok(/jtcatPopoutWin\.close\(\)/.test(b) && /js8PopoutWin\.close\(\)/.test(b));
  assert.ok(/stopJtcat\(\);\n\s+remoteJtcatQso = null;/.test(b) && /'jtcat-stop-for-remote'/.test(b), 'the main window releases its capture');
  assert.ok(/broadcastJtcatStatus\(\{ running: false \}\)/.test(b), 'the ECHOCAT app hears that FT8 stopped');
  assert.ok(/if \(!ft8Win && !js8Win && !ft8Engine\) return false;/.test(b), 'nothing running: nothing logged, nothing touched');
});

test('every name the helper uses is at module scope', () => {
  const b = body('function releaseJtcatForSstv(').replace(/\/\/.*$/gm, '').replace(/'(?:[^'\\]|\\.)*'/g, "''");
  for (const n of ['jtcatPopoutWin', 'js8PopoutWin', 'ft8Engine', 'remoteJtcatQso', 'win', 'remoteServer', 'stopJtcat', 'js8SetHeartbeat', 'sendCatLog']) {
    if (new RegExp('\\b' + n + '\\b').test(b)) assert.ok(topLevel(n), n + ' is not declared at module scope');
  }
});

test('an SSTV window you or the app open hands the radio over; auto-SSTV does not need to', () => {
  const i = MAIN.indexOf('openSstvPopout = function(opts)');
  const open = MAIN.slice(i, i + 2500);
  assert.ok(/if \(!\(opts && opts\.auto\)\) releaseJtcatForSstv\(\);/.test(open));
  assert.ok(open.indexOf('releaseJtcatForSstv()') < open.indexOf('new BrowserWindow('), 'before the window grabs the input');
  assert.ok(/openSstvPopout\(\{ freqKhz: autoSstvBand\.freqKhz, mode: autoSstvBand\.mode, auto: true \}\)/.test(MAIN));
  assert.ok(/function triggerAutoSstv\(\) \{\n\s+if \(autoSstvBlockedByJtcat\(\)\)/.test(MAIN), 'auto-SSTV waits while JTCAT decodes');
});

test('auto-SSTV at night listens on 7.171 LSB', () => {
  assert.ok(/\{ freqKhz: 7171, mode: 'LSB' \}/.test(body('function getSstvAutoFreq(')));
});

console.log(`\nSSTV / JTCAT handover: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
