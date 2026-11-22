'use strict';
// #190: the PTT row on ECHOCAT Web's VFO tab shows while the radio's mode is
// unknown (no readback yet, an FT-891 that never answered MD0;), the same as
// the main PTT. It stays hidden in CW and data modes on purpose.
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const { showVfoPttRow } = require('../lib/vfo-ptt-row');

let passed = 0;
function t(name, fn) { fn(); passed++; console.log('  ok', name); }
const read = (p) => readSrc(path.join(__dirname, '..', p));

t('mode unknown: the row shows', () => {
  assert.strictEqual(showVfoPttRow(''), true);
  assert.strictEqual(showVfoPttRow(null), true);
  assert.strictEqual(showVfoPttRow(undefined), true);
  assert.strictEqual(showVfoPttRow('   '), true);
});

t('voice modes: the row shows', () => {
  for (const m of ['USB', 'lsb', 'SSB', 'FM', 'AM', 'FREEDV-RADEV1']) assert.strictEqual(showVfoPttRow(m), true, m);
});

t('data and CW modes: the row stays hidden', () => {
  for (const m of ['DIGU', 'DIGL', 'FT8', 'FT4', 'PKTUSB', 'CW', 'CW-R', 'RTTY']) assert.strictEqual(showVfoPttRow(m), false, m);
});

t('ECHOCAT Web uses the shared rule, inlined by remote-server', () => {
  const js = read('renderer/remote.js');
  assert.ok(js.includes("vfPttRow.classList.toggle('hidden', !VfoPttRow.showVfoPttRow(currentMode));"));
  assert.ok(read('renderer/remote.html').includes('<!-- vfo-ptt-row-js -->'));
  assert.ok(read('lib/remote-server.js').includes("['vfo-ptt-row-js', 'vfo-ptt-row.js']"));
});

console.log(`vfo-ptt-row: ${passed} passed`);
