#!/usr/bin/env node
'use strict';
/**
 * A Flex's controls read back from the radio (Casey 2026-10-28, via the phone
 * session): every rig-state field the phone and the VFO window show comes
 * from the radio's own status, against a real FLEX-8600 v4 capture
 * (test/fixtures/flex-pan/8600-status.txt).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const R = require('../lib/flex-readback');
const { SmartSdrClient } = require('../lib/smartsdr');

const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
const lines = fs.readFileSync(path.join(__dirname, 'fixtures/flex-pan/8600-status.txt'), 'utf8').split(/\r?\n/).filter(Boolean);
const kvOf = (re) => {
  const kv = {};
  for (const l of lines.filter((x) => re.test(x))) {
    for (const p of l.replace(/^.*?\|/, '').split(' ')) {
      const eq = p.indexOf('=');
      if (eq > 0) kv[p.slice(0, eq)] = p.slice(eq + 1);
    }
  }
  return kv;
};

console.log('The real 8600');
check('the slice: DSP, RIT, filter, AF, squelch, antenna', () => {
  const s = R.sliceReadback(kvOf(/\|slice 0 /));
  assert.deepStrictEqual(s, {
    nb: false, nbLevel: 50, nr: false, nrLevel: 50, anf: false, apf: false,
    nrl: false, nrlLevel: 100, nrs: false, nrsLevel: 50, nrf: false, rnn: false,
    rit: false, afGain: 0, filterWidth: 2700, squelch: 0, antennaPort: 1,
  });
});
check('the transmit block: compander, VOX, SSB monitor, mic', () => {
  assert.deepStrictEqual(R.transmitReadback(kvOf(/\|transmit /)), {
    comp: false, compLevel: 0, vox: true, voxLevel: 0, mon: false, monLevel: 19, micGain: 0,
  });
});
check('the ATU holds a match: in line', () => {
  assert.deepStrictEqual(R.atuReadback(kvOf(/^S[0-9A-F]+\|atu /)), { atuActive: true });
});

console.log('The rules');
check('a partial line states only what it carries; a filter needs both edges', () => {
  assert.deepStrictEqual(R.sliceReadback({ nb: '1' }), { nb: true });
  assert.deepStrictEqual(R.sliceReadback({ filter_lo: '100' }), {});
  assert.strictEqual(R.sliceReadback({ filter_lo: '-250', filter_hi: '250' }).filterWidth, 500, 'CW, centred');
});
check('squelch armed reads its level; RX_A is not an antenna port', () => {
  assert.strictEqual(R.sliceReadback({ squelch: '1', squelch_level: '35' }).squelch, 35);
  assert.strictEqual(R.sliceReadback({ rxant: 'ANT2' }).antennaPort, 2);
  assert.ok(!('antennaPort' in R.sliceReadback({ rxant: 'RX_A' })));
});
check('pan RF gain in dB and on the 0-100 slider', () => {
  assert.deepStrictEqual(R.panReadback({ rfgain: '8' }), { rfgainDb: 8, rfGain: 60 });
  assert.deepStrictEqual(R.panReadback({ rfgain: '-10' }), { rfgainDb: -10, rfGain: 0 });
});
check('ATU: bypassed or failed is out, mid-tune says nothing, disabled is out', () => {
  assert.deepStrictEqual(R.atuReadback({ status: 'TUNE_BYPASS' }), { atuActive: false });
  assert.deepStrictEqual(R.atuReadback({ status: 'TUNE_FAIL_BYPASS' }), { atuActive: false });
  assert.deepStrictEqual(R.atuReadback({ status: 'TUNE_IN_PROGRESS' }), {});
  assert.deepStrictEqual(R.atuReadback({ status: 'TUNE_SUCCESSFUL', atu_enabled: '0' }), { atuActive: false });
});

console.log('The Flex client');
check('every slice line goes out with its keys; pan RF gain rides pan-status', () => {
  const c = new SmartSdrClient();
  const sl = [], pan = [];
  c.on('slice-status', (e) => sl.push(e));
  c.on('pan-status', (e) => pan.push(e));
  c._handleLine('S1A2B|slice 0 nb=1 nb_level=40');
  c._handleLine('S1A2B|display pan 0x40000000 rfgain=8 pre=+8dB');
  assert.deepStrictEqual(sl[0], { index: 0, kv: { nb: '1', nb_level: '40' } });
  assert.strictEqual(pan[0].rfgain, '8');
});

console.log('main.js wiring');
const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
check('slice, transmit, pan and ATU each feed applyFlexReadback; a change broadcasts', () => {
  assert.ok(/smartSdr\.on\('slice-status'[\s\S]{0,400}applyFlexReadback\(FlexReadback\.sliceReadback\(_flexSliceKv\)\)/.test(main));
  assert.ok(/applyFlexReadback\(FlexReadback\.transmitReadback\(_flexTransmitKv\)\)/.test(main));
  assert.ok(/applyFlexReadback\(FlexReadback\.panReadback\(\{ rfgain \}\)\)/.test(main));
  assert.ok(/smartSdr\.on\('atu-status', \(kv\) => applyFlexReadback\(FlexReadback\.atuReadback\(kv\)\)\)/.test(main));
  const fn = main.slice(main.indexOf('function applyFlexReadback('), main.indexOf('function applyFlexReadback(') + 400);
  assert.ok(/if \(changed\) broadcastRigState\(\);/.test(fn));
});
check('every field the module can state has a row, and every row is in the rig state', () => {
  const rows = main.slice(main.indexOf('const FLEX_READBACK_FIELDS = {'), main.indexOf('function applyFlexReadback('));
  const all = { ...R.sliceReadback({ nb: '1', nb_level: '1', nr: '1', nr_level: '1', anf: '1', apf: '1', nrl: '1', nrl_level: '1', nrs: '1', nrs_level: '1', nrf: '1', nrf_level: '1', rnn: '1', rit_on: '1', audio_level: '1', filter_lo: '0', filter_hi: '1', squelch: '0', rxant: 'ANT1' }),
    ...R.transmitReadback({ compander: '1', compander_level: '1', vox_enable: '1', vox_level: '1', sb_monitor: '1', mon_gain_sb: '1', mic_level: '1' }),
    ...R.panReadback({ rfgain: '0' }), ...R.atuReadback({ status: 'TUNE_OK' }) };
  const bcast = main.slice(main.indexOf('function broadcastRigState('), main.indexOf('function broadcastRigState(') + 3000);
  for (const k of Object.keys(all)) {
    assert.ok(new RegExp('\\n  ' + k + ': \\[').test(rows.replace(/\r/g, '')), 'row ' + k);
    const stateKey = k === 'atuActive' ? 'atuActive' : k;
    assert.ok(new RegExp('\\b' + stateKey + ':').test(bcast), 'rig-state ' + k);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
