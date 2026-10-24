#!/usr/bin/env node
'use strict';
// A radio whose serial port is gone, and "None" meaning none (G90 owner,
// 2026-10-24). Run: node test/cat-port-presence-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const P = require('../lib/serial-port-presence');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

test('the port a target opens: rigctld and serial only', () => {
  assert.strictEqual(P.portOfTarget({ type: 'rigctld', serialPort: 'COM5' }), 'COM5');
  assert.strictEqual(P.portOfTarget({ type: 'serial', path: '/dev/ttyUSB0' }), '/dev/ttyUSB0');
  for (const t of [{ type: 'tcp', host: '127.0.0.1', port: 5002 }, { type: 'none' }, { type: 'icom-network' }, { type: 'rigctld-remote', host: 'x' }, null]) assert.strictEqual(P.portOfTarget(t), '');
});

test('only device paths are judged', () => {
  assert.ok(P.isDevicePort('COM5', 'win32') && P.isDevicePort('\\\\.\\COM12', 'win32'));
  assert.ok(!P.isDevicePort('192.168.1.5:4532', 'win32') && !P.isDevicePort('', 'win32'));
  assert.ok(P.isDevicePort('/dev/cu.usbserial-1', 'darwin') && !P.isDevicePort('COM5', 'linux'));
});

test('listed: case-insensitive on Windows, cu/tty twins on macOS', () => {
  assert.ok(P.portListed('com5', [{ path: 'COM3' }, { path: 'COM5' }], 'win32'));
  assert.ok(!P.portListed('COM5', [{ path: 'COM3' }], 'win32'));
  assert.ok(P.portListed('\\\\.\\COM12', ['COM12'], 'win32'));
  assert.ok(P.portListed('/dev/cu.usbserial-110', [{ path: '/dev/tty.usbserial-110' }], 'darwin'));
  assert.ok(!P.portListed('/dev/ttyUSB1', [{ path: '/dev/ttyUSB0' }], 'linux'));
});

test('wiring: connectCat waits for a missing port, a lost link checks it, None is remembered', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.ok(/if \(devPort && !\(await serialPortPresent\(devPort\)\)\) \{[\s\S]{0,200}startCatPortWatch\(devPort\);/.test(main), 'no spawn, no open: wait for the port');
  assert.ok(main.indexOf('const devPort = SerialPortPresence.portOfTarget(target);') < main.indexOf("if (target.type === 'rigctld') {\n    // Spawn rigctld process first") || /const devPort = SerialPortPresence\.portOfTarget\(target\);/.test(main), 'the gate sits before the transports');
  assert.ok(/catPortGoneCheck\(\)\.catch/.test(main), 'a link loss checks whether the port went');
  assert.ok(/if \(!target && settings\.catNone\) \{/.test(main), 'None is not overridden by the only-rig auto-activation');
  assert.ok(/settings\.catNone = !target;/.test(main) && /if \(has\('activeRigId'\)\) settings\.catNone = !newSettings\.activeRigId;/.test(main), 'both None choices set it, picking a rig clears it');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
