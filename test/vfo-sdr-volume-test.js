#!/usr/bin/env node
'use strict';
// GitHub #118 (df1vb, 1.13.8/1.13.9): the SDR's volume became the VOL knob,
// which lives in the meter block, off by default. The SDR card's own Volume
// slider must stand in whenever an SDR plays and VOL is not on screen.
// Run: node test/vfo-sdr-volume-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'vfo-popout.html'), 'utf8');
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
console.log('VFO window SDR volume');

test('the SDR status never hides the Volume row for good', () => {
  assert.ok(!/getElementById\('kiwi-volume-row'\)\.style\.display = 'none'/.test(html));
  const h = html.slice(html.indexOf('window.api.onKiwiStatus('), html.indexOf('window.api.onKiwiStatus(') + 2000);
  assert.ok(/syncSdrVolumeRow\(\)/.test(h));
});

// Run the real function against fake elements.
const src = html.slice(html.indexOf('function syncSdrVolumeRow()'));
const fnSrc = src.slice(0, src.indexOf('\n}\n') + 2);
function run(connected, volShown) {
  const row = { style: { display: '' } };
  const block = { classList: { contains: () => volShown } };
  const document = { getElementById: (id) => (id === 'kiwi-volume-row' ? row : id === 'widget-smeter' ? block : null) };
  // eslint-disable-next-line no-new-func
  new Function('document', 'kiwiConnected', fnSrc + '\nsyncSdrVolumeRow();')(document, connected);
  return row.style.display;
}
test('SDR playing, meter block hidden (the default): the Volume row shows', () => assert.strictEqual(run(true, false), 'flex'));
test('SDR playing, VOL on screen: one knob, the row stays hidden', () => assert.strictEqual(run(true, true), 'none'));
test('no SDR: hidden', () => assert.strictEqual(run(false, false), 'none'));
test('the meter block re-decides the row', () => {
  const m = html.slice(html.indexOf('function applyMeterRows()'), html.indexOf('function syncSdrVolumeRow()'));
  assert.ok(/syncSdrVolumeRow\(\);/.test(m));
});
test('both sliders move the same value', () => {
  assert.ok(/getElementById\('kiwi-volume'\);\s*const kl/.test(html), 'VOL mirrors into the SDR slider');
  const k = html.slice(html.indexOf("const slider = document.getElementById('kiwi-volume');"));
  assert.ok(/monitorVolume = pct \/ 100;/.test(k.slice(0, 1500)) && /getElementById\('vol-slider'\)/.test(k.slice(0, 1500)));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
