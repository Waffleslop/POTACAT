#!/usr/bin/env node
'use strict';
// #525 (K3SBP, Flex 8600, 1.14.4): a spot click from the phone cancelled
// Auto-SSTV, which retuned the radio but left the SSTV window it had opened,
// so the decoder kept running ("Decoder alive" every 5 min) and the phone
// showed "SSTV listening" on 7.039 CW. Cancelling now closes the window when
// Auto-SSTV opened it and nobody took it over; the window's closed handler
// stops the decoder and pushes sstv-decoder-state {running:false}.
//
// Run: node test/auto-sstv-cancel-525-test.js

const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');

const main = readSrc(path.join(__dirname, '..', 'main.js'));
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + '\n    ' + (e.stack || e.message)); }
}

function body(startMarker, len) {
  const i = main.indexOf(startMarker);
  assert.ok(i >= 0, 'found ' + startMarker);
  return main.slice(i, i + len);
}

test('Auto-SSTV remembers whether it opened the SSTV window, before opening it', () => {
  const i = main.indexOf('autoSstvOpenedPopout = !(sstvPopoutWin && !sstvPopoutWin.isDestroyed());');
  assert.ok(i > 0);
  const j = main.indexOf('openSstvPopout({ auto: true })', i);
  assert.ok(j > i && j - i < 1500, 'set just before the auto open');
});

test('cancelAutoSstv closes the window it opened, after retuning, and forgets the flag', () => {
  const fn = body('function cancelAutoSstv() {', 5000);
  const end = fn.indexOf('\nfunction ');
  const f = end > 0 ? fn.slice(0, end) : fn;
  const sstvPart = f.slice(f.indexOf("'[Auto-SSTV] Cancelled"));
  assert.ok(/const closeSstvWindow = autoSstvOpenedPopout && sstvPopoutWin && !sstvPopoutWin\.isDestroyed\(\);/.test(sstvPart));
  assert.ok(/autoSstvOpenedPopout = false;/.test(sstvPart));
  assert.ok(/if \(closeSstvWindow\) \{\s*try \{ sstvPopoutWin\.close\(\); \} catch \{\}/.test(sstvPart));
  assert.ok(f.indexOf('cat.tune(autoSstvPrevFreq') < f.indexOf('sstvPopoutWin.close()'), 'retune first');
});

test('closing the SSTV window stops the decoder (what makes running:false)', () => {
  const fn = body("sstvPopoutWin.on('closed', () => {", 1200);
  assert.ok(/stopSstv\(\);/.test(fn));
});

test('the operator taking the window over keeps it open on cancel', () => {
  const open = body('openSstvPopout = function(opts) {', 1500);
  assert.ok(/if \(!\(opts && opts\.auto\)\) autoSstvOpenedPopout = false;/.test(open), 'opened again by desk or phone');
  const enc = body("ipcMain.on('sstv-encode', (_e, data) => {", 300);
  assert.ok(/autoSstvOpenedPopout = false;/.test(enc), 'a send from the window');
  const photo = body("remoteServer.on('sstv-photo', ({ image, mode, guest, freqKhz }) => {", 300);
  assert.ok(/autoSstvOpenedPopout = false;/.test(photo), 'a picture from the phone');
});

test('the SSTV window tuning as it opens still does not cancel Auto-SSTV', () => {
  const fn = body('function isIdleRxSelfAction(sender) {', 1200);
  assert.ok(/sender === sstvPopoutWin\.webContents/.test(fn));
});

console.log(`\nAuto-SSTV cancel (#525): ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
