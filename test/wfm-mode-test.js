#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
// IC-7100 Wideband FM VFO preset saved as FM (kg6odijohn, 2026-10-31). The
// radio REPORTED CI-V mode 06 as WFM, but the codec had no entry to SET it,
// so a preset in WFM tuned in whatever mode the radio was in.
// Run: node test/wfm-mode-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { CivCodec } = require('../lib/codecs/civ-codec');
const { RigctldCodec } = require('../lib/codecs/rigctld-codec');
const { RIG_MODELS } = require('../lib/rig-models');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
const hex = (b) => Buffer.from(b).toString('hex').toUpperCase().match(/../g).join(' ');

test('IC-7100: WFM sets CI-V mode 06 with DATA off, and reads back as WFM', () => {
  const frames = [];
  const c = new CivCodec(RIG_MODELS['IC-7100'], (b) => frames.push(hex(b)));
  assert.ok(c.setMode('WFM', 88500000), 'WFM resolves');
  assert.ok(frames.some((f) => /^FE FE 88 E0 06 06 0[123] FD$/.test(f)), `mode frame: ${frames.join(' | ')}`);
  assert.ok(frames.some((f) => /^FE FE 88 E0 1A 06 00 00 FD$/.test(f)), 'DATA off');
  let mode = null;
  c.on('mode', (m) => { mode = m; });
  c.onData(Buffer.from([0xFE, 0xFE, 0xE0, 0x88, 0x04, 0x06, 0x01, 0xFD]));
  assert.strictEqual(mode, 'WFM');
});

test('rigctld passes WFM through as Hamlib\'s WFM token', () => {
  const c = new RigctldCodec(RIG_MODELS.G90, () => {});
  assert.strictEqual(c.resolveMode('WFM', 88500000), 'WFM');
});

test('the radios that have it say so; the VFO window shows WFM only there', () => {
  assert.strictEqual(RIG_MODELS['IC-7100'].wfm, true);
  assert.strictEqual(RIG_MODELS['IC-705'].wfm, true);
  assert.ok(!RIG_MODELS['IC-7300'].wfm, 'the IC-7300 has no WFM');
  const main = readSrc(path.join(__dirname, '..', 'main.js'));
  assert.ok(/wfm: vfoWfmAvailable\(\),/.test(main), 'sent with the VFO state');
  assert.ok(/RIG_MODELS\[rig\.model\] \|\| RIG_MODELS\[ct\.civModel\]/.test(main), 'from the Radio Model or the Icom model picker');
  const vfo = readSrc(path.join(__dirname, '..', 'renderer', 'vfo-popout.html'));
  assert.ok(/if \(typeof s\.wfm === 'boolean'\) vfoHasWfm = s\.wfm;/.test(vfo));
  assert.ok(/pickerModes\(\)\.forEach/.test(vfo), 'the picker uses the rig-scoped list');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
