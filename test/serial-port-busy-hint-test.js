#!/usr/bin/env node
'use strict';
// N4IN (FTDX101MP, 2026-10-20): "com port not being recognized as either the
// enhanced COM port or Standard COM port Yaesu uses, COM3 or COM4" — on a PC
// where ACLog drives the same radio. A port another program holds fails to
// open with "Access denied" (Windows) / "Resource busy" (Linux, macOS); the
// log showed only the raw error. The controller now says what it means, once
// per distinct message, next to the existing "port does not exist" hint.
// Run: node test/serial-port-busy-hint-test.js
const assert = require('assert');
const { EventEmitter } = require('events');
const { RigController } = require('../lib/rig-controller');
const { RIG_MODELS } = require('../lib/rig-models');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
console.log('Serial port busy hint');

function make() {
  const transport = new EventEmitter();
  transport._target = { type: 'serial', path: 'COM3' };
  transport.write = () => true;
  const codec = new EventEmitter();
  codec.onData = () => {};
  codec.setTransmit = () => {};
  const ctl = new RigController(RIG_MODELS['FTDX101D/MP'], transport, codec);
  const lines = [];
  ctl._debug = true; // _log() emits only in debug, which main.js turns on for the CAT panel
  ctl.on('log', (m) => lines.push(String(m)));
  ctl._target = transport._target;
  return { transport, lines };
}

test('"Access denied" on open names the cause and the two fixes, once per message', () => {
  const { transport, lines } = make();
  transport.emit('error', new Error('Opening COM3: Access denied'));
  const hint = lines.find((l) => /COM3 is open in another program/.test(l));
  assert.ok(hint, lines.join('\n'));
  assert.ok(/ACLog/.test(hint) && /virtual COM splitter/.test(hint));
  transport.emit('error', new Error('Opening COM3: Access denied'));
  assert.strictEqual(lines.filter((l) => /is open in another program/.test(l)).length, 1, 'said once');
});

test('"Resource busy" (Linux/macOS) gets the same hint; a missing port does not', () => {
  const a = make();
  a.transport.emit('error', new Error('Error: Resource busy, cannot open /dev/ttyUSB0'));
  assert.ok(a.lines.some((l) => /is open in another program/.test(l)));
  const b = make();
  b.transport.emit('error', new Error('Opening COM9: File not found'));
  assert.ok(!b.lines.some((l) => /is open in another program/.test(l)), 'ENOENT is the other hint');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
