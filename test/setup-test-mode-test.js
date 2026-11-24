#!/usr/bin/env node
'use strict';
// GitHub #755: the Station Setup transmit test keys in the DATA mode FT8 uses.
// An FTdx-101D on rigctld with DTR PTT keyed for FT8 (DATA) and never for the
// test (USB): the SSB menu's PTT and audio source differ from the DATA ones.
// Run: node test/setup-test-mode-test.js
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const { planTestMode, modeNote, DATA_REASON } = require('../lib/setup-test-mode');
const { planTestFrequency, rfOf, isLowerSideband } = require('../lib/setup-test-freq');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
}

const BOTH = ['DIGU', 'DIGL'];
const base = { mode: 'USB', family: 'hamlib', jack: 'data', useDataMode: true, dataModes: BOTH };

test('a sound-card radio in USB tests in DIGU, LSB in DIGL (the sideband kept)', () => {
  assert.deepStrictEqual(planTestMode(base), { dataMode: 'DIGU', why: 'switch' });
  assert.deepStrictEqual(planTestMode({ ...base, mode: 'LSB' }), { dataMode: 'DIGL', why: 'switch' });
  assert.deepStrictEqual(planTestMode({ ...base, mode: 'usb' }), { dataMode: 'DIGU', why: 'switch' });
});

test('every PTT method on every sound-card family: serial, Icom CI-V, rigctld (own and external), flrig, Commander', () => {
  for (const family of ['serial', 'icom', 'hamlib', 'rigctld', 'flrig', 'commander', 'generic']) {
    assert.strictEqual(planTestMode({ ...base, family }).dataMode, 'DIGU', family);
  }
});

test('network-audio radios keep testing as before: Flex, TCI, Icom LAN, SCU-LAN10, K4, no CAT', () => {
  for (const family of ['flex', 'tci', 'icom-network', 'yaesu-lan', 'k4', 'none', undefined]) {
    assert.deepStrictEqual(planTestMode({ ...base, family }), { dataMode: null, why: 'network-audio' }, String(family));
  }
});

test('never switches where FT8 itself would not: mic jack, plain-USB setting, no data mode', () => {
  assert.strictEqual(planTestMode({ ...base, jack: 'mic' }).why, 'mic-jack');
  assert.strictEqual(planTestMode({ ...base, useDataMode: false }).why, 'plain-usb');
  assert.strictEqual(planTestMode({ ...base, dataModes: [] }).why, 'no-data-mode');
  assert.strictEqual(planTestMode({ ...base, dataModes: undefined }).why, 'no-data-mode');
  assert.strictEqual(planTestMode({ ...base, mode: 'LSB', dataModes: ['DIGU'] }).why, 'no-data-mode', 'QMX: one DIGI mode, upper only');
});

test('the voice test never switches; nor does a radio already in DATA, or in FM, AM or an unknown mode', () => {
  assert.deepStrictEqual(planTestMode({ ...base, voice: true }), { dataMode: null, why: 'voice' });
  for (const mode of ['DIGU', 'PKTUSB', 'DATA-U', 'USB-D', 'DIGL', 'PKTLSB']) {
    assert.strictEqual(planTestMode({ ...base, mode }).why, 'in-data', mode);
  }
  assert.strictEqual(planTestMode({ ...base, inData: true }).why, 'in-data', 'an Icom reads USB with its DATA flag on');
  for (const mode of ['FM', 'AM', '', 'RTTY']) assert.strictEqual(planTestMode({ ...base, mode }).why, 'mode', mode);
  assert.deepStrictEqual(planTestMode(), { dataMode: null, why: 'mode' });
});

test('the operator reads one plain line, with a check-the-radio ending when the mode was not confirmed', () => {
  const ok = modeNote({ from: 'USB', restored: true });
  assert.strictEqual(ok, 'For the test POTACAT switched the radio from USB to its DATA mode, the one FT8 uses, and put it back to USB.');
  const late = modeNote({ from: 'lsb', restored: false });
  assert.ok(/from LSB to its DATA mode/.test(late) && /has not confirmed LSB yet\. Check the mode on the radio\.$/.test(late));
  assert.ok(!/[\u{1F300}-\u{1FAFF}]/u.test(ok + late + DATA_REASON), 'no emoji');
});

test('the frequency plan knows a DIGL tone sits below the dial', () => {
  assert.strictEqual(rfOf(7200000, 'DIGL'), 7199000);
  assert.strictEqual(rfOf(7200000, 'PKTLSB'), 7199000);
  assert.strictEqual(rfOf(7200000, 'LSB-D'), 7199000);
  assert.strictEqual(rfOf(7074000, 'DIGU'), 7075000);
  assert.ok(isLowerSideband('LSB') && isLowerSideband('DATA-L') && !isLowerSideband('USB') && !isLowerSideband('DIGU'));
  // A data emission is judged as one: a US General at 14.250 MHz moves to the data segment and back.
  const p = planTestFrequency({ freqHz: 14250000, mode: 'DIGU', licenseClass: 'us_general' });
  assert.strictEqual(p.action, 'move');
  assert.strictEqual(p.emission, 'DATA');
  assert.strictEqual(planTestFrequency({ freqHz: 14250000, mode: 'USB', licenseClass: 'us_general' }).action, 'here');
});

test('main: the test plans its mode, plans the frequency with it, forces DATA on the key-down only then, and reports the restore', () => {
  const main = readSrc(path.join(__dirname, '..', 'main.js')).replace(/\r\n/g, '\n');
  const f = main.slice(main.indexOf('async function _runStationSetupTxTest('), main.indexOf('function getIcomNetworkDataModSpec('));
  const planAt = f.indexOf('SetupTestMode.planTestMode(');
  assert.ok(planAt > 0 && planAt > f.indexOf("if (/^CW/.test(modeNow))"), 'after the CW refusal');
  assert.ok(planAt < f.indexOf('SetupTestFreq.planTestFrequency('), 'before the frequency plan');
  assert.ok(/planTestFrequency\(\{ freqHz: _currentFreqHz, mode: testMode,/.test(f), 'the frequency is judged in the mode that keys');
  assert.ok(/const dataSwap = testModePlan\.dataMode \? \{ forceDataMode: true, dataReason: SetupTestMode\.DATA_REASON \} : \{\};/.test(f));
  assert.ok(/startJtcatTune\(\{ toneHz: STATION_SETUP_TEST_TONE_HZ, emission: plan\.emission, noDataSwap: voice, \.\.\.dataSwap \}\);/.test(f));
  // The mode is confirmed back before any move back to the operator's frequency.
  const wait = f.indexOf('modeNote = SetupTestMode.modeNote(');
  assert.ok(wait > 0 && wait < f.indexOf('if (movedFromHz) {\n    tuneRadio(movedFromHz / 1000'), 'mode back before the frequency');
  assert.strictEqual((f.match(/, modeNote \}\);/g) || []).length, 3, 'every keyed result carries the note');
  // startJtcatTune passes it to the key-down; nothing else asks for it.
  const tune = main.slice(main.indexOf('function startJtcatTune('), main.indexOf('function stopJtcatTune('));
  assert.ok(/forceDataMode: !!opts\.forceDataMode, dataReason: opts\.dataReason, txKind: 'tune'/.test(tune));
  const callers = main.match(/startJtcatTune\(\{[^}]*\}\)/g) || [];
  for (const c of callers) {
    if (/forceDataMode|dataSwap/.test(c)) assert.ok(c.includes('STATION_SETUP_TEST_TONE_HZ'), 'only the setup test forces DATA on a tune: ' + c);
  }
});

console.log(`\nSetup test mode: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
