#!/usr/bin/env node
'use strict';
// 2026-10-01 Discord round:
//  KC1SSY  "Sometimes after contact doesn't gray out." The grey-out compared
//          the spot's raw mode with the logged mode, which is normalized
//          (USB/LSB -> SSB), so a spot reported as USB never grayed out.
//  N0KAH   "Extra names on VFO during hunting": the VFO listed every spot in
//          allSpots on the frequency, including ones the table had aged out.
//  N0KAH   "VFO doesn't show the activator on first open": the card was sent
//          only on a tune, before the window existed.
// Run: node test/vfo-and-greyout-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const R = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n');
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
console.log('VFO card and worked grey-out');

const app = R('renderer/app.js');
const web = R('renderer/remote.js');
const slice = (src, from, to) => src.slice(src.indexOf(from), src.indexOf(to, src.indexOf(from)));

function today() {
  const d = new Date();
  return d.getUTCFullYear() + String(d.getUTCMonth() + 1).padStart(2, '0') + String(d.getUTCDate()).padStart(2, '0');
}

// The worked log as lib/adif.js parseWorkedQsos builds it: modes normalized.
function workedLog() {
  return new Map([['K1ABC', [{ date: today(), ref: 'US-1234', band: '20M', mode: 'SSB' }]]]);
}

test('desktop: a USB spot grays out after an SSB QSO at that park', () => {
  const src = slice(app, 'function spotModeKey(spot) {', '/**\n * Worked this station') +
    slice(app, 'function isWorkedSpot(spot) {', '\nfunction isWorkedSpotStrict');
  // eslint-disable-next-line no-new-func
  const isWorkedSpot = new Function('workedQsos', src + '; return isWorkedSpot;')(workedLog());
  assert.strictEqual(isWorkedSpot({ callsign: 'K1ABC', reference: 'US-1234', band: '20m', mode: 'USB' }), true, 'USB spot');
  assert.strictEqual(isWorkedSpot({ callsign: 'K1ABC', reference: 'US-1234', band: '20m', mode: 'SSB' }), true, 'SSB spot');
  assert.strictEqual(isWorkedSpot({ callsign: 'K1ABC', reference: 'US-1234', band: '20m', mode: 'CW' }), false, 'CW is a new QSO');
  assert.strictEqual(isWorkedSpot({ callsign: 'K1ABC', reference: 'US-9999', band: '20m', mode: 'USB' }), false, 'another park is a new QSO');
});

test('ECHOCAT Web: the same, from its own copy', () => {
  const src = slice(web, '  function isWorkedSpot(s) {', '\n  function spotModeCategory') ;
  // eslint-disable-next-line no-new-func
  const isWorkedSpot = new Function('workedQsos', src + '; return isWorkedSpot;')(workedLog());
  assert.strictEqual(isWorkedSpot({ callsign: 'K1ABC', reference: 'US-1234', band: '20m', mode: 'USB' }), true, 'USB spot');
  assert.strictEqual(isWorkedSpot({ callsign: 'K1ABC', reference: 'US-1234', band: '20m', mode: 'CW' }), false, 'CW');
});

test('the strict variant normalizes too', () => {
  const body = slice(app, 'function isWorkedSpotStrict(spot) {', '\n}\n');
  assert.ok(/const spotMode = spotModeKey\(spot\);/.test(body));
});

test('the VFO lists only what the table shows on that frequency, tuned spot first, one line per call', () => {
  const body = slice(app, 'function notifyVfoTunedSpot(spot) {', '  // Build array of operator data.');
  assert.ok(/getFiltered\(\)\.filter\(s => s\.frequency === spot\.frequency\)/.test(body), 'not from the table\'s visible list');
  assert.ok(!/allSpots\.filter/.test(body), 'still lists every spot in allSpots');
  assert.ok(/const spots = \[spot\];/.test(body), 'the tuned spot is not first');
});

test('the VFO\'s multi-op lines carry the park and the spot source', () => {
  const vfo = R('renderer/vfo-popout.html');
  const multi = slice(vfo, '// 2-3 ops: one line per op', '} else {');
  assert.ok(/op-ml-ref/.test(multi) && /opSourceLabel\(op\.source\)/.test(multi));
});

test('a VFO opened after the tune gets the card: main replays it, the window re-sends it', () => {
  const main = R('main.js');
  assert.ok(/_lastVfoTunedSpot = spot \|\| null;/.test(main), 'main does not keep the last card');
  const load = slice(main, "vfoPopoutWin.webContents.on('did-finish-load', () => {", '    });');
  assert.ok(/vfo-tuned-spot', _lastVfoTunedSpot/.test(load), 'not replayed on load');
  assert.ok(/window\.api\.onVfoPopoutStatus\(\(open\) => \{[\s\S]{0,500}notifyVfoTunedSpot\(spot\)/.test(app), 'the main window does not re-send on open');
});

console.log(`\nVFO card and worked grey-out: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
