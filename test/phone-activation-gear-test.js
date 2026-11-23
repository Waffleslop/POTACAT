#!/usr/bin/env node
'use strict';
// #975 (ECHOCAT handoff 2026-11-23): during an activation the phone sends its
// rig and antenna on every log-qso (myRig, myAntenna). The desktop keeps them:
// trimmed, at most 64 characters, the phone's rig over the desktop's own; with
// no rig from the phone, logContact still stamps the desktop's station rig.
// The log writes ADIF MY_ANTENNA beside MY_RIG and reads it back wherever
// MY_RIG is read, so a round trip keeps it.
// Run: node test/phone-activation-gear-test.js
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const { buildAdifFields } = require('../lib/adif-writer');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

const R = (f) => readSrc(path.join(__dirname, '..', f));
const main = R('main.js');
let LogGear = {};
try { LogGear = require('../lib/log-gear'); } catch { /* not built yet */ }

test('the phone\'s rig and antenna are kept, trimmed', () => {
  assert.strictEqual(typeof LogGear.gearText, 'function', 'lib/log-gear.js exports gearText');
  assert.strictEqual(LogGear.gearText('KX2'), 'KX2');
  assert.strictEqual(LogGear.gearText('  EFHW 49:1  '), 'EFHW 49:1');
  assert.strictEqual(LogGear.GEAR_MAX_CHARS, 64);
});

test('empty, blank, non-string and over-long values', () => {
  assert.strictEqual(typeof LogGear.gearText, 'function');
  for (const v of [undefined, null, '', '   ', 5, true, {}, ['KX2']]) assert.strictEqual(LogGear.gearText(v), '', JSON.stringify(v));
  const long = 'A'.repeat(100);
  assert.strictEqual(LogGear.gearText(long), 'A'.repeat(64), 'capped at 64');
  assert.strictEqual(LogGear.gearText('  ' + 'B'.repeat(70) + '  ').length, 64, 'trimmed, then capped');
  assert.strictEqual(LogGear.gearText('IC-705\n\tvertical'), 'IC-705 vertical', 'control characters become one space');
});

test('log-qso: myRig and myAntenna go onto the entry only when non-empty', () => {
  const h = main.slice(main.indexOf("remoteServer.on('log-qso',"));
  const body = h.slice(0, h.indexOf('await logContact(entry'));
  assert.ok(/const rig = LogGear\.gearText\(data\.myRig\);\s*\n\s*if \(rig\) entry\.myRig = rig;/.test(body), 'myRig through gearText');
  assert.ok(/const ant = LogGear\.gearText\(data\.myAntenna\);\s*\n\s*if \(ant\) entry\.myAntenna = ant;/.test(body), 'myAntenna through gearText');
  assert.ok(/const LogGear = require\('\.\/lib\/log-gear'\);/.test(main), 'main requires lib/log-gear');
});

test('no rig from the phone: logContact falls back to the desktop rig', () => {
  const lc = main.slice(main.indexOf('async function logContact('), main.indexOf('async function logContact(') + 2500);
  assert.ok(/const myRig = entry\.myRig \|\| \(opts\.origin === 'wsjtx-bridge' \|\| isRemoteMode\(\)\s*\n\s*\? '' : stationSetupRigById\(\)\?\.name\);/.test(lc));
  assert.ok(/\{ \.\.\.entry, myRig \}/.test(lc), 'myAntenna rides along on the entry');
});

test('MY_ANTENNA written beside MY_RIG, left out when empty', () => {
  const base = { callsign: 'K3SBP', frequency: '14285', mode: 'SSB', qsoDate: '20261123', timeOn: '1200' };
  const f = buildAdifFields({ ...base, myRig: 'KX2', myAntenna: 'EFHW' });
  assert.strictEqual(f.MY_RIG, 'KX2');
  assert.strictEqual(f.MY_ANTENNA, 'EFHW');
  assert.ok(!('MY_ANTENNA' in buildAdifFields({ ...base })));
  assert.ok(!('MY_ANTENNA' in buildAdifFields({ ...base, myAntenna: '' })));
  const keys = Object.keys(f);
  assert.strictEqual(keys.indexOf('MY_ANTENNA'), keys.indexOf('MY_RIG') + 1, 'next to MY_RIG');
});

test('MY_ANTENNA read back wherever MY_RIG is read', () => {
  assert.ok(/myRig: f\.MY_RIG \|\| '',\s*\n\s*myAntenna: f\.MY_ANTENNA \|\| '',/.test(main), 'WSJT-X bridge');
  assert.ok(/myRig: raw\.MY_RIG \|\| '',\s*\n\s*myAntenna: raw\.MY_ANTENNA \|\| '',/.test(main), 'rawQsoToQsoData (resend, Cloud pull forward)');
  assert.ok(/myRig: q\.MY_RIG \|\| '',\s*\n\s*myAntenna: q\.MY_ANTENNA \|\| '',/.test(main), 'Past Activations');
  const app = R('renderer/app.js');
  assert.ok(/myRig: c\.myRig \|\| '',\s*\n\s*myAntenna: c\.myAntenna \|\| '',/.test(app), 'Past Activations export');
  // Every main.js MY_RIG read has its MY_ANTENNA twin.
  const rigReads = (main.match(/myRig: \w+\.MY_RIG \|\| ''/g) || []).length;
  const antReads = (main.match(/myAntenna: \w+\.MY_ANTENNA \|\| ''/g) || []).length;
  assert.strictEqual(antReads, rigReads, 'one MY_ANTENNA read per MY_RIG read');
});

test('round trip: a record written and parsed back keeps both', () => {
  const { buildAdifRecord } = require('../lib/adif-writer');
  const { parseAllRawQsos } = require('../lib/adif');
  const fs = require('fs');
  const os = require('os');
  const rec = buildAdifRecord({ callsign: 'K3SBP', frequency: '14285', mode: 'SSB', qsoDate: '20261123', timeOn: '1200', myRig: 'KX2', myAntenna: 'EFHW 49:1' });
  const file = path.join(os.tmpdir(), 'potacat-gear-' + process.pid + '.adi');
  fs.writeFileSync(file, '<EOH>\n' + rec + '\n');
  try {
    const rows = parseAllRawQsos(file);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].MY_RIG, 'KX2');
    assert.strictEqual(rows[0].MY_ANTENNA, 'EFHW 49:1');
  } finally { fs.unlinkSync(file); }
});

test('the protocol doc names myRig and myAntenna on log-qso', () => {
  const row = R('docs/echocat-protocol.md').split('\n').find((l) => l.startsWith('| `log-qso` |')) || '';
  assert.ok(/`myRig`/.test(row) && /`myAntenna`/.test(row));
  assert.ok(/MY_ANTENNA/.test(row));
});

console.log(`\nPhone activation gear (#975): ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
