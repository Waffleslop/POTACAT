#!/usr/bin/env node
'use strict';
// KG5EIU (IC-9700 over Icom Network, 1.12.0, 2026-10-22): his bug report was
// ~30 lines a second of RS-BA1 keepalives ("<- control type 0x0", "length
// mismatch: header=0 actual=21"), with every control line printed twice, and
// the actual repro was cut from the paste. main.js already filters those
// lines out, but RigController forwarded the transport's log a second time,
// unfiltered. A transport whose owner routes its log is not forwarded again.
// Run: node test/icom-network-log-routing-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { RigController } = require('../lib/rig-controller');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
const R = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n');

function controllerOver(routesOwnLog) {
  const transport = new EventEmitter();
  if (routesOwnLog) transport.routesOwnLog = true;
  const codec = new EventEmitter();
  const cat = new RigController({ caps: {}, cw: {} }, transport, codec);
  cat._debug = true;
  const lines = [];
  cat.on('log', (m) => lines.push(m));
  transport.emit('log', '[rsba1/civ] <- control type 0x0');
  return lines;
}

console.log('Icom Network log routing');

test('a transport that routes its own log is not forwarded again by the controller', () => {
  assert.deepStrictEqual(controllerOver(true), []);
});

test('other transports keep their log in the CAT log (serial DTR/RTS lines)', () => {
  assert.deepStrictEqual(controllerOver(false), ['[rsba1/civ] <- control type 0x0']);
});

test('the RS-BA1 transport declares it, and main still filters the keepalives (source guards)', () => {
  assert.ok(/this\.routesOwnLog = true;/.test(R('lib/rsba1-transport.js')));
  const main = R('main.js');
  assert.ok(/if \(\/<- control type 0x0\\b\/i\.test\(line\)\) return false;/.test(main), 'keepalive filter');
  assert.ok(/if \(\/length mismatch: header=0 actual=21\/i\.test\(line\)\) return false;/.test(main), 'length-mismatch filter');
  assert.ok(/if \(shouldShowIcomNetworkTransportLogInCat\(m\)\) sendCatLog\(m\);/.test(main), 'main routes it through the filter');
});

test('the bug report names the Icom Network port, never "host:undefined"', () => {
  assert.ok(/activeRig\.catTarget\.port \|\| activeRig\.catTarget\.controlPort/.test(R('renderer/app.js')));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
