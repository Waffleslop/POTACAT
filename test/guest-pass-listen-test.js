#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
// A Guest Pass restricts TRANSMIT, never listening (a shack owner's
// Technician who wants to hear a 20 m POTA QSO, 2026-10-24).
// Run: node test/guest-pass-listen-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { PassEnforcement } = require('../lib/pass-enforcement');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
function tech(allowedModes) {
  const pe = new PassEnforcement({ revalidateMs: 0, rigPowerReadable: () => true });
  pe._state = 'active';
  pe._expiresAtMs = Date.now() + 3600000;
  pe._pass = { code: 'T1', guest_callsign: 'KD9TEC', privilege_class: 'us_technician', privilege_class_short: 'tech', max_power_w: 100, allowed_modes: allowedModes || [] };
  return pe;
}

test('a Technician may TUNE anywhere: 20 m phone, 40 m phone, a 60 m channel', () => {
  const pe = tech();
  for (const [hz, mode] of [[14250000, 'USB'], [7200000, 'LSB'], [5357000, 'USB'], [3850000, 'LSB']]) {
    assert.strictEqual(pe.interceptCatCommand({ type: 'tune', freqHz: hz, mode }).allowed, true, `${hz} ${mode}`);
  }
});

test('…but may not TRANSMIT there: the key-down is refused with the out-of-band words', () => {
  const pe = tech();
  const r = pe.interceptCatCommand({ type: 'tx_enable', freqHz: 14250000, mode: 'USB' });
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.reason, 'out_of_band');
  assert.ok(/Out of band/.test(r.userVisible) && /tech/.test(r.userVisible), r.userVisible);
});

// The radio's power as it reports it, under the cap and fresh — the key-down
// also checks that (test/guest-pass-tx-gate-test.js).
const POWER_OK = { currentWatts: 50, powerAgeMs: 0 };

test('inside the class, TX is allowed: 10 m phone and 40 m CW for a Technician', () => {
  const pe = tech();
  assert.strictEqual(pe.interceptCatCommand({ type: 'tx_enable', freqHz: 28400000, mode: 'USB', ...POWER_OK }).allowed, true);
  assert.strictEqual(pe.interceptCatCommand({ type: 'tx_enable', freqHz: 7040000, mode: 'CW', ...POWER_OK }).allowed, true);
});

test('the pass\'s own mode list is a transmit rule too', () => {
  const pe = tech(['CW']);
  assert.strictEqual(pe.interceptCatCommand({ type: 'tune', freqHz: 28400000, mode: 'USB' }).allowed, true, 'listen in USB');
  const r = pe.interceptCatCommand({ type: 'tx_enable', freqHz: 28400000, mode: 'USB' });
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.reason, 'mode_not_allowed');
  assert.strictEqual(pe.interceptCatCommand({ type: 'tx_enable', freqHz: 7040000, mode: 'CW', ...POWER_OK }).allowed, true);
});

test('a TX gate with no dial known falls back to the power rules only', () => {
  const pe = tech();
  assert.strictEqual(pe.interceptCatCommand({ type: 'tx_enable', ...POWER_OK }).allowed, true);
  assert.strictEqual(pe.interceptCatCommand({ type: 'tx_enable' }).reason, 'tx_disabled_no_power_cat', 'and with no power report there is no TX');
});

test('wiring: both TX gates hand the live dial and mode to the pass, and a refusal reaches the guest\'s device', () => {
  const main = readSrc(path.join(__dirname, '..', 'main.js'));
  // The live dial, and what the key-down sends (emission) before the radio's
  // mode (test/guest-pass-emission-test.js: FT8 from a rig left in USB).
  // The frequency the radio will TRANSMIT on (effectiveTxFreqHz: the other VFO
  // in split), never the dial (test/guest-pass-tx-gate-test.js).
  const n = (main.match(/interceptCatCommand\(\{ type: 'tx_enable', freqHz: effectiveTxFreqHz\(\), split: _currentSplit, mode: emission \|\| _currentMode/g) || []).length;
  assert.strictEqual(n, 2, 'gatedSetTransmit and gatedSmartSdrTransmit');
  assert.strictEqual((main.match(/passTxBlocked\(res\);/g) || []).length, 3, 'both gates and passTxAllowed (CW text, the paddle) tell the device');
  assert.ok(/sendToPassSessions\(\{ type: 'tune-blocked', reason: res\.userVisible \}\)/.test(main), 'as a tune-blocked alert the app already shows');
  assert.ok(/const applied = !!state && !passTxJustBlocked\(\);/.test(main), 'ptt-applied says false for a refused press');
  const srv = readSrc(path.join(__dirname, '..', 'lib', 'remote-server.js'));
  assert.ok(/sendToPassSessions\(msg\) \{/.test(srv));
  assert.ok(/if \(rest\.hideOutOfBand\) rest\.hideOutOfBand = false;/.test(srv), 'a guest never inherits the owner\'s out-of-band hiding');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
