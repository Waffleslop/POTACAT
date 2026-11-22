'use strict';
// #716: while the FreeDV engine runs, every surface shows the FreeDV mode
// (RADE), not the radio's carrier mode (DIGU / PKTUSB / USB-D). One rule in
// lib/freedv-display-mode.js, used by the main window, the VFO window,
// ECHOCAT and ECHOCAT Web.
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const { freedvDisplayMode, freedvBadge } = require('../lib/freedv-display-mode');

let passed = 0;
function t(name, fn) { fn(); passed++; console.log('  ok', name); }
const read = (p) => readSrc(path.join(__dirname, '..', p));

t('engine off: the radio mode unchanged', () => {
  for (const m of ['DIGU', 'USB', 'PKTUSB', 'CW', '']) assert.strictEqual(freedvDisplayMode(m, null), m);
});
t('engine on: every FreeDV sideband shows the codec', () => {
  for (const m of ['USB', 'LSB', 'DIGU', 'DIGL', 'PKTUSB', 'PKTLSB', 'USB-D', 'LSB-D']) {
    assert.strictEqual(freedvDisplayMode(m, 'RADEV1'), 'FREEDV-RADEV1', m);
  }
  assert.strictEqual(freedvDisplayMode('digu', '700e'), 'FREEDV-700E');
});
t('engine on but the radio left the sideband: the radio mode', () => {
  for (const m of ['CW', 'FM', 'AM', 'RTTY']) assert.strictEqual(freedvDisplayMode(m, 'RADEV1'), m);
  assert.strictEqual(freedvDisplayMode('', 'RADEV1'), '');
});
t('badge: RADE for RADE, FreeDV for the classic codecs, else the mode', () => {
  assert.strictEqual(freedvBadge('FREEDV-RADEV1'), 'RADE');
  assert.strictEqual(freedvBadge('freedv-700e'), 'FreeDV');
  assert.strictEqual(freedvBadge('FREEDV'), 'FreeDV');
  assert.strictEqual(freedvBadge('DIGU'), 'DIGU');
  assert.strictEqual(freedvBadge(''), '');
});

// --- every surface uses it ---
const main = read('main.js');
const body = (name) => {
  const i = main.indexOf('function ' + name + '(');
  assert.ok(i >= 0, name + ' exists');
  return main.slice(i, main.indexOf('\n}\n', i));
};
t('main window (sendCatMode) uses the helper', () => {
  assert.ok(/FreedvDisplayMode\.freedvDisplayMode\(/.test(body('sendCatMode')));
});
t('VFO window (sendVfoState) sends the display mode, not the raw radio mode', () => {
  const b = body('sendVfoState');
  assert.ok(/FreedvDisplayMode\.freedvDisplayMode\(/.test(b));
  assert.ok(!/\bmode: _currentMode \|\| ''/.test(b), 'raw _currentMode is not the VFO mode');
});
t('ECHOCAT (broadcastRemoteRadioStatus) uses the helper, not a USB/LSB-only map', () => {
  const b = body('broadcastRemoteRadioStatus');
  assert.ok(/FreedvDisplayMode\.freedvDisplayMode\(/.test(b));
  assert.ok(!/modeVal === 'USB' \|\| modeVal === 'LSB'/.test(b));
});
t('VFO window and ECHOCAT Web badges use the shared label', () => {
  const vfo = read('renderer/vfo-popout.html');
  assert.ok(vfo.includes('<script src="../lib/freedv-display-mode.js"></script>'));
  assert.ok(/FreedvDisplayMode\.freedvBadge\(/.test(vfo));
  const remote = read('renderer/remote.js');
  assert.ok((remote.match(/FreedvDisplayMode\.freedvBadge\(/g) || []).length >= 2);
  assert.ok(read('renderer/remote.html').includes('<!-- freedv-display-mode-js -->'));
  assert.ok(read('lib/remote-server.js').includes("['freedv-display-mode-js', 'freedv-display-mode.js']"));
});

console.log(`freedv-display-mode: ${passed} passed`);
