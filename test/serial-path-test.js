#!/usr/bin/env node
'use strict';
// KF0TDB (FT-991A, Windows), twice in two days: the port was saved as
// "COM Port 9", then "COM Port 10", typed into the box beside the port list,
// and every connect failed with "Opening COM Port 10: File not found".
// Run: node test/serial-path-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { normalizeSerialPath: n, normalizeSettingsSerialPaths } = require('../lib/serial-path');

const R = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n');
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
console.log('Serial port names');

test('what operators type becomes the Windows port name', () => {
  for (const [from, to] of [
    ['COM Port 10', 'COM10'], ['com 10', 'COM10'], ['10', 'COM10'], ['COM10', 'COM10'], [' com10 ', 'COM10'],
    ['Port 9', 'COM9'], ['#7', 'COM7'], ['COM09', 'COM9'],
    ['Silicon Labs Dual CP2105 USB to UART Bridge: Enhanced COM Port (COM10)', 'COM10'],
    ['COM10 - Silicon Labs', 'COM10'],
  ]) assert.strictEqual(n(from, 'win32'), to, from);
});

test('names that are not COM numbers pass through (virtual ports, device paths, other OSes)', () => {
  assert.strictEqual(n('\\\\.\\COM12', 'win32'), '\\\\.\\COM12');
  assert.strictEqual(n('Win4Icom', 'win32'), 'Win4Icom');
  assert.strictEqual(n('COM Port 10', 'linux'), 'COM Port 10');
  assert.strictEqual(n('/dev/ttyUSB0', 'linux'), '/dev/ttyUSB0');
  assert.strictEqual(n('/dev/cu.SLAB_USBtoUART', 'darwin'), '/dev/cu.SLAB_USBtoUART');
  assert.strictEqual(n(undefined, 'win32'), undefined);
});

test('every saved port is repaired, and each fix is reported', () => {
  const s = {
    catTarget: { type: 'serialcat', path: 'COM Port 10', baudRate: 4800 },
    cwKeyPort: 'com 11',
    rigs: [{ id: 'r1', name: "John's 991 A", catTarget: { type: 'serialcat', path: 'COM Port 10' } }, { id: 'r2', catTarget: { type: 'tcp', host: '127.0.0.1', port: 5002 } }],
  };
  const fixes = normalizeSettingsSerialPaths(s, 'win32');
  assert.strictEqual(s.catTarget.path, 'COM10');
  assert.strictEqual(s.cwKeyPort, 'COM11');
  assert.strictEqual(s.rigs[0].catTarget.path, 'COM10');
  assert.deepStrictEqual(s.rigs[1].catTarget, { type: 'tcp', host: '127.0.0.1', port: 5002 });
  assert.strictEqual(fixes.length, 3);
  assert.deepStrictEqual(normalizeSettingsSerialPaths(s, 'win32'), [], 'a second pass changes nothing');
});

test('main repairs saved settings at startup, on every save, and in Test Connection', () => {
  const main = R('main.js');
  assert.ok(/settings = loadSettings\(\);\n[\s\S]{0,300}normalizeSettingsSerialPaths\(settings\)/.test(main), 'not at startup');
  const save = main.slice(main.indexOf("ipcMain.handle('save-settings'"), main.indexOf("ipcMain.handle('save-settings'") + 600);
  assert.ok(/normalizeSettingsSerialPaths\(newSettings\)/.test(save), 'not on save');
  assert.strictEqual((main.match(/config\.portPath = normalizeSerialPath\(config\.portPath\)/g) || []).length, 2, 'not in both serial tests');
});

test('a port that is not found lists the ports that are', () => {
  const rc = R('lib/rig-controller.js');
  assert.ok(/File not found\|ENOENT\|No such file/.test(rc) && /Serial ports on this computer: /.test(rc));
});

console.log(`\nSerial port names: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
