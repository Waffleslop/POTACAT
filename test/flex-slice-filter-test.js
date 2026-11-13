// Flex slice filter edges on tune (#129, mikem: "unable to decode LSB",
// 17 m fine, 40 m not). tuneSlice set every non-CW slice to +100..+(100+w),
// the upper side of the carrier, so an LSB slice listened to the wrong
// sideband. Lower-sideband modes now sit below the carrier; AM and FM are
// centred; USB, DIGU and CW keep their old edges.
// Run: node test/flex-slice-filter-test.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { SmartSdrClient, sliceFilterEdges } = require('../lib/smartsdr');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); }
}

console.log('Flex slice filter edges');

test('LSB and DIGL sit below the carrier', () => {
  assert.deepStrictEqual(sliceFilterEdges('LSB', 2400), { lo: -2500, hi: -100 });
  assert.deepStrictEqual(sliceFilterEdges('digl', 3000), { lo: -3100, hi: -100 });
});

test('USB and DIGU keep the upper side', () => {
  assert.deepStrictEqual(sliceFilterEdges('USB', 2400), { lo: 100, hi: 2500 });
  assert.deepStrictEqual(sliceFilterEdges('DIGU', 3000), { lo: 100, hi: 3100 });
});

test('AM and FM are centred on the carrier', () => {
  assert.deepStrictEqual(sliceFilterEdges('AM', 6000), { lo: -3000, hi: 3000 });
  assert.deepStrictEqual(sliceFilterEdges('FM', 10000), { lo: -5000, hi: 5000 });
});

test('CW stays centred on the 600 Hz pitch', () => {
  assert.deepStrictEqual(sliceFilterEdges('CW', 500), { lo: 350, hi: 850 });
  assert.deepStrictEqual(sliceFilterEdges('CW', 2000), { lo: 0, hi: 1600 });
});

test('tuneSlice sends filt with the LSB edges', () => {
  const sent = [];
  const c = Object.create(SmartSdrClient.prototype);
  c._send = (s) => sent.push(s);
  c.tuneSlice(0, 7.188, 'LSB', 2400);
  assert.deepStrictEqual(sent, ['slice tune 0 7.188000', 'slice set 0 mode=LSB', 'filt 0 -2500 -100']);
});

test('filter-width change on an LSB slice keeps the lower side (dispatcher)', () => {
  const { RigDispatcher } = require('../lib/rig-dispatcher');
  const d = new RigDispatcher();
  const calls = [];
  d.setSmartSdr({ connected: true, setSliceFilter: (i, lo, hi) => calls.push([i, lo, hi]) });
  d._state.mode = 'LSB';
  d.dispatch('set-filter-width', { value: 2400 });
  assert.deepStrictEqual(calls, [[0, -2500, -100]]);
});

test('main.js filter-width paths use sliceFilterEdges, not +100..+w', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.ok(!/lo = 100;\s*hi = 100 \+ width;/.test(src), 'main.js still hard-codes the upper sideband');
  assert.ok((src.match(/sliceFilterEdges\(_currentMode, width\)/g) || []).length >= 2);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
