// Tests for calloutTwin() — the macOS dial-in/callout device mapping.
//
// WB0MMC 2026-08-31: a K3 on an FTDI cable, configured on
// /dev/tty.usbserial-FTFPXFPU, logged "Resource busy, cannot open ..." every
// two seconds for the whole session. On macOS that node is the DIAL-IN
// device; /dev/cu.* is the one a radio is talked to on. SerialTransport now
// alternates to the twin after a failed open, so the wrong pick in the port
// picker costs one retry instead of the whole session.
'use strict';
const assert = require('assert');
const { calloutTwin } = require('../lib/transport');

let passed = 0;
function t(name, fn) {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

const yes = () => true;
const no = () => false;

console.log('calloutTwin()');

t('maps a macOS dial-in node to its callout twin', () => {
  assert.strictEqual(
    calloutTwin('/dev/tty.usbserial-FTFPXFPU', { platform: 'darwin', exists: yes }),
    '/dev/cu.usbserial-FTFPXFPU');
});

t('returns null when the twin does not exist', () => {
  assert.strictEqual(calloutTwin('/dev/tty.usbserial-FTFPXFPU', { platform: 'darwin', exists: no }), null);
});

t('is macOS-only — Linux /dev/ttyUSB0 is not a dial-in node', () => {
  assert.strictEqual(calloutTwin('/dev/ttyUSB0', { platform: 'linux', exists: yes }), null);
  // ...and even on macOS, only the tty. prefix maps (this is not a substring rule)
  assert.strictEqual(calloutTwin('/dev/ttyUSB0', { platform: 'darwin', exists: yes }), null);
});

t('leaves a callout path alone — no cu. -> cu. or ping-pong back to tty.', () => {
  assert.strictEqual(calloutTwin('/dev/cu.usbserial-FTFPXFPU', { platform: 'darwin', exists: yes }), null);
});

t('ignores Windows COM ports and junk', () => {
  assert.strictEqual(calloutTwin('COM3', { platform: 'win32', exists: yes }), null);
  assert.strictEqual(calloutTwin(undefined, { platform: 'darwin', exists: yes }), null);
  assert.strictEqual(calloutTwin(null, { platform: 'darwin', exists: yes }), null);
});

t('keeps the whole device name, dots included', () => {
  assert.strictEqual(
    calloutTwin('/dev/tty.SLAB_USBtoUART', { platform: 'darwin', exists: yes }),
    '/dev/cu.SLAB_USBtoUART');
  assert.strictEqual(
    calloutTwin('/dev/tty.usbmodem14201', { platform: 'darwin', exists: yes }),
    '/dev/cu.usbmodem14201');
});

t('asks about the callout path, not the configured one', () => {
  const asked = [];
  calloutTwin('/dev/tty.usbserial-A50285BI', {
    platform: 'darwin',
    exists: (p) => { asked.push(p); return true; },
  });
  assert.deepStrictEqual(asked, ['/dev/cu.usbserial-A50285BI']);
});

console.log(`\n${passed} passed`);
