#!/usr/bin/env node
'use strict';
// SSB-over-DATA leaves FM and AM alone on a radio with no FM or AM data form
// (GitHub #561). KS9B, Elecraft KX3 on 2 m FM, 1.14.5: every ECHOCAT voice
// over logged "FM -> DIGU (SSB-over-DATA: mic disabled)" and went out as USB
// data, garbage to FM listeners. An Icom still goes FM -> FM-D (KG5EIU
// IC-9700), USB still goes to DIGU, and forced callers keep their choice.
// Run: node test/ssb-over-data-fm-test.js
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const S = require('../lib/ptt-mode-swap');
const { getModel } = require('../lib/rig-models');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
}

// What main's key-down asks, for a model name and a CAT link type.
function pick(modelName, mode, { forced = false, rigType = 'serial' } = {}) {
  const m = modelName ? getModel(modelName, null) : null;
  const fmAmData = S.hasFmAmDataMode({ brand: m && m.brand, rigType });
  return S.pttDataModeFor({ mode, forced, fmAmData });
}

test('the models under test carry the brands the rule reads', () => {
  assert.strictEqual(getModel('KX2/KX3', null).brand, 'Elecraft');
  assert.strictEqual(getModel('IC-9700', null).brand, 'Icom');
  assert.strictEqual(getModel('FT-710', null).brand, 'Yaesu');
  assert.strictEqual(getModel('TS-2000', null).brand, 'Kenwood');
});

test('KX3 in FM with SSB-over-DATA: no swap, and the reason is FM/AM', () => {
  assert.deepStrictEqual(pick('KX2/KX3', 'FM'), { dataMode: null, skip: 'fm-am' });
});

test('KX3 in AM with SSB-over-DATA: no swap', () => {
  assert.deepStrictEqual(pick('KX2/KX3', 'AM'), { dataMode: null, skip: 'fm-am' });
});

test('KX3 in USB still goes to DIGU, LSB to DIGL', () => {
  assert.deepStrictEqual(pick('KX2/KX3', 'USB'), { dataMode: 'DIGU' });
  assert.deepStrictEqual(pick('KX2/KX3', 'usb'), { dataMode: 'DIGU' });
  assert.deepStrictEqual(pick('KX2/KX3', 'LSB'), { dataMode: 'DIGL' });
  assert.deepStrictEqual(pick('KX2/KX3', 'SSB'), { dataMode: 'DIGU' });
});

test('IC-9700 in FM still goes to DIGFM, AM to DIGAM (KG5EIU)', () => {
  assert.deepStrictEqual(pick('IC-9700', 'FM', { rigType: 'icom' }), { dataMode: 'DIGFM' });
  assert.deepStrictEqual(pick('IC-9700', 'AM', { rigType: 'icom' }), { dataMode: 'DIGAM' });
  assert.deepStrictEqual(pick('IC-9700', 'USB', { rigType: 'icom' }), { dataMode: 'DIGU' });
  // On rigctld the model still names the brand.
  assert.deepStrictEqual(pick('IC-9700', 'FM', { rigType: 'rigctld' }), { dataMode: 'DIGFM' });
});

test('an Icom CI-V link with no model picked counts as Icom; a named non-Icom model does not', () => {
  assert.deepStrictEqual(pick(null, 'FM', { rigType: 'icom' }), { dataMode: 'DIGFM' });
  assert.deepStrictEqual(pick(null, 'FM', { rigType: 'icom-network' }), { dataMode: 'DIGFM' });
  assert.deepStrictEqual(pick('KX2/KX3', 'FM', { rigType: 'rigctld' }), { dataMode: null, skip: 'fm-am' });
  assert.deepStrictEqual(pick(null, 'FM', { rigType: 'serial' }), { dataMode: null, skip: 'fm-am' });
});

test('Kenwood and Yaesu in FM: no swap either', () => {
  assert.deepStrictEqual(pick('TS-2000', 'FM'), { dataMode: null, skip: 'fm-am' });
  assert.deepStrictEqual(pick('FT-710', 'FM'), { dataMode: null, skip: 'fm-am' });
});

test('forceData is unchanged: an Icom FM -> DIGFM, any other radio FM -> DIGU as before', () => {
  assert.deepStrictEqual(pick('IC-9700', 'FM', { forced: true, rigType: 'icom' }), { dataMode: 'DIGFM' });
  assert.deepStrictEqual(pick('KX2/KX3', 'FM', { forced: true }), { dataMode: 'DIGU' });
  assert.deepStrictEqual(pick('KX2/KX3', 'AM', { forced: true }), { dataMode: 'DIGU' });
  assert.deepStrictEqual(pick('KX2/KX3', 'USB', { forced: true }), { dataMode: 'DIGU' });
});

test('modes with no data form (CW, RTTY, a DATA mode already) are never switched', () => {
  for (const m of ['CW', 'RTTY', 'DIGU', 'USB-D', '', null]) {
    assert.deepStrictEqual(pick('KX2/KX3', m), { dataMode: null }, String(m));
    assert.deepStrictEqual(pick('IC-9700', m, { rigType: 'icom' }), { dataMode: null }, String(m));
  }
});

test('the log line is plain and names the mode it keys in', () => {
  assert.strictEqual(S.fmAmSkipLog('FM'),
    '[PTT] SSB-over-DATA does not apply in FM or AM on this radio: keying in FM. The radio\'s own microphone may also be live.');
  assert.ok(/keying in AM\./.test(S.fmAmSkipLog('AM')));
});

// main.js glue: the key-down asks the module, logs the skip once, and keeps
// the Yaesu voice gate and the forced paths ahead of it.
const main = readSrc(path.join(__dirname, '..', 'main.js'));
const at = main.indexOf('if (state && (settings.ssbOverData || forceData)');
const blk = main.slice(at, main.indexOf('if (isFlexRig) {', at));

test('main: the swap gate still excludes Yaesu voice, Voice-in-DATA, noDataSwap and JTCAT', () => {
  assert.ok(at > 0, 'gate found');
  assert.ok(/!opts\.noDataSwap && !yaesuVoice && !voiceInData && audioActive && \(!ft8Engine \|\| forceData\)/.test(main.slice(at, at + 250)));
});

test('main: the data mode comes from PttModeSwap.pttDataModeFor, fed hasFmAmDataMode', () => {
  assert.ok(/PttModeSwap\.pttDataModeFor\(\{\s*mode: curMode, forced: forceData,\s*fmAmData: PttModeSwap\.hasFmAmDataMode\(/.test(blk));
  assert.ok(/const dataMode = _dataPick\.dataMode;/.test(blk));
  assert.ok(!/curMode === 'FM'\) \? 'DIGFM'/.test(blk), 'no brand ternary left in main');
});

test('main: the FM/AM skip changes no mode and logs once per session', () => {
  const s = blk.indexOf("_dataPick.skip === 'fm-am'");
  const e = blk.indexOf('} else if (_dataPick.dataMode)', s);
  assert.ok(s > 0 && e > s, 'skip branch before the switch branch');
  const branch = blk.slice(s, e);
  assert.ok(/if \(!_ssbOverDataFmAmWarned\) \{\s*_ssbOverDataFmAmWarned = true;\s*sendCatLog\(PttModeSwap\.fmAmSkipLog\(curMode\)\);/.test(branch));
  assert.ok(!/setModeOnly|cat\.tune|_ssbModeBeforePtt|_dataSwapSince/.test(branch), 'no mode change in the skip');
  assert.ok(/^let _ssbOverDataFmAmWarned = false;/m.test(main));
});

test('main: the Winlink hold plan still runs before the FM/AM rule', () => {
  assert.ok(blk.indexOf("if (_dataPlan === 'keep')") < blk.indexOf("_dataPick.skip === 'fm-am'"));
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
