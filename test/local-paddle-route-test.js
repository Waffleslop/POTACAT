#!/usr/bin/env node
'use strict';
// "Vail adapter + POTACAT to key a QMX+? Typed text will TX. Macros will TX.
// Vail connected to iPhone running ECHOCAT will TX. No TX locally with
// POTACAT. Tried Keyboard and MIDI modes both." (Discord 2026-10-20)
//
// The desktop's own MIDI/keyboard keyer (connectKeyer → IambicKeyer) sent
// its key edges ONLY to SmartSDR; the ECHOCAT paddle went through the full
// router (Flex API, main-port DTR/RTS such as the QMX's, CW Key Port,
// WinKeyer). Now one router, paddleKeyRig, serves both.
// Run: node test/local-paddle-route-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8').replace(/\r\n/g, '\n');
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
console.log('Local paddle routes like the ECHOCAT paddle');

test('one router, built outside connectRemote so it exists with ECHOCAT off', () => {
  assert.ok(/^let paddleKeyRig = null;/m.test(main), 'module-level handle');
  assert.ok(/^function buildPaddleKeyRig\(\) \{\n  if \(paddleKeyRig\) return paddleKeyRig;/m.test(main), 'builder, idempotent');
  assert.ok(/paddleKeyRig = \(\{ down \}\) => \{\n\s*\/\/ A paddle keys the rig outside the controller's own PTT path/.test(main), 'the router body is the old ECHOCAT callback');
  assert.ok(main.indexOf('function buildPaddleKeyRig()') < main.indexOf('function connectRemote()'), 'defined at module scope, before connectRemote');
  assert.ok(/\n  remoteServer\.setCwKeyerOutput\(buildPaddleKeyRig\(\)\);/.test(main), 'ECHOCAT subscribes to the same router');
  assert.strictEqual((main.match(/remoteServer\.setCwKeyerOutput\(/g) || []).length, 1);
});

test('the desktop keyer (MIDI + keyboard modes) keys through the router', () => {
  const fn = main.slice(main.indexOf('function connectKeyer()'), main.indexOf('function disconnectKeyer()'));
  assert.ok(/keyer\.on\('key', \(\{ down \}\) => \{[\s\S]*?try \{ buildPaddleKeyRig\(\)\(\{ down \}\); \}/.test(fn));
  assert.ok(!/smartSdr\.cwKey\(down\)/.test(fn), 'no private SmartSDR-only path left in the local keyer');
  assert.ok(/win\.webContents\.send\('cw-key', \{ down \}\)/.test(fn), 'sidetone forward kept');
});

test('the router covers the non-Flex paths the local keyer never reached', () => {
  const r = main.slice(main.indexOf('paddleKeyRig = ({ down }) => {'), main.indexOf('  return paddleKeyRig;\n}'));
  assert.ok(/cat\.setCwKeyDtr\(down, cwKeyPins\)/.test(r), 'main-port DTR/RTS (QMX, Icom USB keying)');
  assert.ok(/cwKeyPort\.set\(pinState/.test(r), 'dedicated CW Key Port');
  assert.ok(/smartSdr\.cwKey\(down\)/.test(r), 'Flex');
  assert.ok(/cat\.noteTransmitting\(2000\)/.test(r), 'CAT-muted rigs are not declared down mid-over');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
