#!/usr/bin/env node
'use strict';
// On air 2026-11-18 (FLEX-8600M, 30 m APRS): with Idle Mode on (SSTV, 90 min)
// nothing held it off while "Listen on my radio" ran, so 90 minutes after the
// switch went on it would have retuned the radio away from the APRS frequency.
// APRS listening is someone using the radio, like a JTCAT session or a
// connected ECHOCAT device: the countdown starts again, Idle Mode never starts
// and never moves the radio.
// Run: node test/idle-radio-use-test.js
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

const IdleRadioUse = require('../lib/idle-radio-use');

test('APRS listening holds the radio while starting, listening and paused under Winlink', () => {
  for (const state of ['starting', 'listening', 'paused']) {
    assert.strictEqual(IdleRadioUse.aprsListenHoldsRadio({ on: true, state }), true, state);
  }
  assert.strictEqual(IdleRadioUse.aprsListenHoldsRadio({ on: true, state: 'refused' }), false, 'refused');
  assert.strictEqual(IdleRadioUse.aprsListenHoldsRadio({ on: false, state: 'off' }), false, 'off');
  assert.strictEqual(IdleRadioUse.aprsListenHoldsRadio({ on: false, state: 'listening' }), false, 'switch off');
  assert.strictEqual(IdleRadioUse.aprsListenHoldsRadio(null), false, 'no state');
});

test('who is using the radio: JTCAT, then APRS, then a watching ECHOCAT device', () => {
  const u = IdleRadioUse.radioInUse;
  assert.strictEqual(u({}), '');
  assert.strictEqual(u({ jtcatDecoding: true }), 'jtcat');
  assert.strictEqual(u({ aprsListening: true }), 'aprs');
  assert.strictEqual(u({ jtcatDecoding: true, aprsListening: true }), 'jtcat');
  assert.strictEqual(u({ remoteWatching: true }), 'remote');
  // A running idle session is left alone by a device that connects to watch it.
  assert.strictEqual(u({ remoteWatching: true, idleActive: true }), '');
  // APRS listening counts whether or not an idle session runs.
  assert.strictEqual(u({ aprsListening: true, idleActive: true }), 'aprs');
});

test('Idle Mode never starts while APRS listens or JTCAT decodes', () => {
  const b = IdleRadioUse.idleStartBlocker;
  assert.strictEqual(b({}), '');
  assert.strictEqual(b({ aprsListening: true }), 'aprs');
  assert.strictEqual(b({ jtcatDecoding: true }), 'jtcat');
  assert.ok(/APRS/.test(IdleRadioUse.deferLine('aprs')));
  assert.ok(/JTCAT/.test(IdleRadioUse.deferLine('jtcat')));
});

test('an idle session never retunes the radio while APRS listens', () => {
  assert.strictEqual(IdleRadioUse.idleMayRetune({ aprsListening: true }), false);
  assert.strictEqual(IdleRadioUse.idleMayRetune({ aprsListening: false }), true);
});

const main = readSrc(path.join(__dirname, '..', 'main.js'));
const start = main.indexOf('function startAutoSstvTimer(');
const tick = main.slice(start, main.indexOf('function stopAutoSstvTimer(', start));
const trig = main.slice(main.indexOf('function triggerAutoSstv('), main.indexOf('function triggerAutoSstv(') + 1500);

test('main.js: the idle tick asks lib/idle-radio-use.js and restarts the countdown for APRS', () => {
  assert.ok(/require\('\.\/lib\/idle-radio-use'\)/.test(main), 'required');
  assert.ok(/IdleRadioUse\.radioInUse\(/.test(tick), 'tick asks radioInUse');
  assert.ok(/aprsListening: aprsListenHoldsRadio\(\)/.test(tick), 'tick passes APRS listening');
  assert.ok(tick.indexOf('IdleRadioUse.radioInUse(') < tick.indexOf('const idle = Date.now() - lastActivityTime'), 'before the idle test');
});

test('main.js: triggerAutoSstv defers on APRS listening before any mode branch', () => {
  assert.ok(/IdleRadioUse\.idleStartBlocker\(/.test(trig), 'asks idleStartBlocker');
  assert.ok(/aprsListening: aprsListenHoldsRadio\(\)/.test(trig), 'passes APRS listening');
  assert.ok(trig.indexOf('idleStartBlocker(') < trig.indexOf("settings.idleRxMode || 'sstv'"), 'before the mode branches');
});

test('main.js: the sunrise/sunset band switches (SSTV and JTTY) ask idleMayRetune', () => {
  const may = tick.indexOf('const mayRetune = IdleRadioUse.idleMayRetune(');
  assert.ok(may > 0, 'asks idleMayRetune');
  const jtty = tick.indexOf('autoIdleJttyFollowSun()');
  const sw = tick.indexOf('const newBand = getSstvAutoFreq();');
  assert.ok(jtty > may && sw > may, 'asked before both switches');
  assert.ok(/if \(mayRetune && autoSstvActive && autoIdleJtcatActive/.test(tick), 'JTTY follow-sun guarded');
  assert.ok(/if \(mayRetune && autoSstvActive && !autoIdleJtcatActive/.test(tick), 'SSTV band switch guarded');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
