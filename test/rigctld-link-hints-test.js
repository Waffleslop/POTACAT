// What the log says when rigctld is reachable but the radio is not (WX4MWA,
// TS-2000, 1.13.3 logs answered 2026-11-03):
//  - a spawned rigctld that accepts POTACAT and drops it every few seconds
//    with no reply from the radio is named (port held by another program, or
//    the baud), not left as "USB/serial dropped?";
//  - "rigctld Network" refused on its port says nothing listens there and
//    that the Port is not the Hamlib model number (he had typed 2014).
// Run: node test/rigctld-link-hints-test.js
'use strict';
const { readSrc } = require('./_src');

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const main = readSrc(path.join(__dirname, '..', 'main.js')).replace(/\r\n/g, '\n');
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
}

// The spawned-rigctld branch of connectCat, lifted and run against a fake
// controller so the counting rule is exercised, not only matched.
function liftWatch() {
  const at = main.indexOf('const rigctldWatch = {');
  const end = main.indexOf("    cat.on('frequency', catFrequencyHandler);", at);
  assert.ok(at > 0 && end > at, 'the watch sits in the rigctld branch');
  const src = main.slice(at, end);
  const logs = [];
  const cat = new EventEmitter();
  // eslint-disable-next-line no-new-func
  const run = new Function('cat', 'sendCatLog', 'sendCatStatus', 'rigctldStderr', 'target', src);
  run(cat, (m) => logs.push(m), () => {}, '', { serialPort: 'COM6', baudRate: 57600 });
  return { cat, logs };
}
const said = (logs) => logs.filter((l) => /keeps dropping POTACAT/.test(l));

test('two quick drops with no reply from the radio are named once, with the port and baud', () => {
  const { cat, logs } = liftWatch();
  for (let i = 0; i < 4; i++) { cat.emit('status', { connected: true }); cat.emit('status', { connected: false }); }
  assert.strictEqual(said(logs).length, 1, logs.join('\n'));
  assert.ok(/COM6 at 57600 baud/.test(said(logs)[0]) && /another program has the port open/.test(said(logs)[0]));
});

test('a radio that answered is a real dropped link, never this message', () => {
  const { cat, logs } = liftWatch();
  for (let i = 0; i < 4; i++) {
    cat.emit('status', { connected: true });
    cat.emit('frequency', 14074000);
    cat.emit('status', { connected: false });
  }
  assert.strictEqual(said(logs).length, 0);
});

test('one drop alone says nothing', () => {
  const { cat, logs } = liftWatch();
  cat.emit('status', { connected: true });
  cat.emit('status', { connected: false });
  assert.strictEqual(said(logs).length, 0);
});

test('rigctld Network: a refused port says nothing listens there, once', () => {
  assert.ok(/transport\.on\('error', \(err\) => \{\n\s*if \(refusedSaid \|\| !\/ECONNREFUSED\//.test(main));
  assert.ok(/the Port is not the Hamlib model number/.test(main));
  assert.ok(/choose "Other Rig \(Hamlib\)" instead/.test(main));
  const html = readSrc(path.join(__dirname, '..', 'renderer', 'index.html'));
  assert.ok(html.includes('value="rigctldnet"> rigctld Network') && html.includes('value="hamlib"> Other Rig (Hamlib)'), 'the labels the hint names');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
