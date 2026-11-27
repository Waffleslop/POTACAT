'use strict';
// #1117: a configured CW Key Port keys the paddle; the CAT port's DTR does not.
// Run: node test/cw-key-port-route-test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { keyPortCanKey, morseTextMs, keyPortBusyHint } = require('../lib/cw-key-port-route');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error(`FAIL ${name}\n  ${e.message}`); process.exitCode = 1; }
}

const QMX_IF05 = '/dev/serial/by-id/usb-QRP_Labs_QMX_Transceiver-if05';

test('no key port: the CAT port route stands', () => {
  assert.strictEqual(keyPortCanKey({ platform: 'linux', cwKeyPort: '' }), false);
});
test('Linux key port whose driver rejected TIOCMSET: pyserial keys it', () => {
  assert.strictEqual(keyPortCanKey({ platform: 'linux', cwKeyPort: QMX_IF05, ioctlLatched: true, pythonPath: QMX_IF05 }), true);
});
test('key port still opening counts as able', () => {
  assert.strictEqual(keyPortCanKey({ platform: 'linux', cwKeyPort: QMX_IF05, ioctlLatched: false, pythonPath: null }), true);
  assert.strictEqual(keyPortCanKey({ platform: 'win32', cwKeyPort: 'COM9' }), true);
});
test('Windows driver that rejected the ioctl cannot key', () => {
  assert.strictEqual(keyPortCanKey({ platform: 'win32', cwKeyPort: 'COM9', ioctlLatched: true, pythonPath: 'COM9' }), false);
});
test('macOS behaves like Linux', () => {
  assert.strictEqual(keyPortCanKey({ platform: 'darwin', cwKeyPort: '/dev/cu.usbmodem2', ioctlLatched: true, pythonPath: '/dev/cu.usbmodem2' }), true);
});

const MORSE = { P: '.--.', A: '.-', R: '.-.', I: '..', S: '...', E: '.' };
test('PARIS plus a word gap is 50 units (1.2 s at 20 wpm)', () => {
  assert.strictEqual(morseTextMs('PARIS ', 20, MORSE), 50 * 60);
});
test('E is 1 unit plus element and character gaps', () => {
  assert.strictEqual(morseTextMs('E', 20, MORSE), 4 * 60);
});
test('unknown characters and empty text cost nothing; wpm is clamped', () => {
  assert.strictEqual(morseTextMs('#', 20, MORSE), 0);
  assert.strictEqual(morseTextMs('', 20, MORSE), 0);
  assert.strictEqual(morseTextMs('E', 0, MORSE), 4 * 60);   // 0 -> default 20
  assert.strictEqual(morseTextMs('E', 1000, MORSE), 4 * 20); // capped at 60 wpm
});

test('busy hint names ModemManager on Linux only', () => {
  const err = "serial.serialutil.SerialException: [Errno 16] could not open port " + QMX_IF05 + ": [Errno 16] Device or resource busy";
  assert.match(keyPortBusyHint({ platform: 'linux', stderr: err }), /ModemManager.*systemctl disable --now ModemManager/);
  assert.strictEqual(keyPortBusyHint({ platform: 'darwin', stderr: err }), '');
  assert.strictEqual(keyPortBusyHint({ platform: 'linux', stderr: 'ModuleNotFoundError: No module named serial' }), '');
});

// Wiring guards in main.js: the rules above are what the router uses.
const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
test('paddle router skips CAT-port DTR when the key port can key', () => {
  assert.match(main, /paddleMethod === 'dtr' && !\(cwKeyPort && cwKeyPort\.isOpen\) && !_keyPortKeysPaddle\(\)/);
});
test('a CAT-port pin-unsupported never switches the paddle off while the key port can key', () => {
  const at = main.indexOf("transport.on('pin-unsupported'");
  assert.ok(at > 0);
  const body = main.slice(at, at + 2500);
  assert.ok(body.indexOf('_keyPortKeysPaddle()') > 0 && body.indexOf('_keyPortKeysPaddle()') < body.indexOf("_setCwPaddleAvailability(false, 'tiocmset-unsupported')"),
    'the key-port check must come before the availability drop');
});
test('key-port keying counts as POTACAT keying in the unsolicited-TX check', () => {
  const at = main.indexOf('function txNoteRadioPtt(');
  const body = main.slice(at, at + 1500);
  assert.match(body, /_cwOwnKeyingNow\(\)/);
});
test('keyboard paddle keys from every POTACAT window, not only the main one', () => {
  assert.match(main, /function keyboardPaddleInput\(/);
  const at = main.indexOf("app.on('browser-window-created'");
  assert.match(main.slice(at, at + 1500), /keyboardPaddleInput\(w, input\)/);
});

console.log(`cw-key-port-route: ${passed} passed`);
