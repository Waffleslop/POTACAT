#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
// The Guest Pass TX gate authorises what the radio will actually do
// (adversarial review of 1.13.9, findings 6 and 7; potacat-meta
// work/in-progress/guest-pass-authority-fixes.md parts B and C):
//   B. the EFFECTIVE transmit frequency — the other VFO in split, never the
//      dial; split on with the TX VFO unknown = refused
//   C. the power cap is enforced at key-down against the radio's own last
//      power report: over the cap = refused + 'power-over-cap' so main
//      re-clamps; no report, or a stale one = refused (the concept doc's
//      "no CAT-readable power → no TX", enforced at last)
// plus the main.js wiring: effectiveTxFreqHz() + the power state at every
// gate, the cap set at lease start and the owner's power put back at the end,
// rigPowerReadable a real answer.
// Run: node test/guest-pass-tx-gate-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { PassEnforcement } = require('../lib/pass-enforcement');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
}
const mainSrc = readSrc(path.join(__dirname, '..', 'main.js'));

function pass(over = {}) {
  const pe = new PassEnforcement({ revalidateMs: 0, rigPowerReadable: () => true, ...(over.opts || {}) });
  pe._state = 'active';
  pe._expiresAtMs = Date.now() + 3600000;
  pe._pass = { code: 'T1', guest_callsign: 'KD9TEC', privilege_class: 'us_technician', privilege_class_short: 'tech', max_power_w: 25, allowed_modes: [], ...(over.pass || {}) };
  return pe;
}
// A key-down with the radio's power known and under the cap, so the B tests
// isolate the frequency rule.
const POWER_OK = { currentWatts: 5, powerAgeMs: 0 };

console.log('B. the effective TX frequency');
test('split OFF: the dial is the TX frequency (unchanged behaviour)', () => {
  const pe = pass();
  assert.strictEqual(pe.interceptCatCommand({ type: 'tx_enable', freqHz: 28400000, split: false, mode: 'USB', ...POWER_OK }).allowed, true);
  assert.strictEqual(pe.interceptCatCommand({ type: 'tx_enable', freqHz: 14200000, split: false, mode: 'USB', ...POWER_OK }).reason, 'out_of_band');
});
test('split ON with the TX VFO unknown: refused, with the split words', () => {
  const pe = pass();
  for (const freqHz of [null, 0, undefined]) {
    const r = pe.interceptCatCommand({ type: 'tx_enable', freqHz, split: true, mode: 'USB', ...POWER_OK });
    assert.strictEqual(r.allowed, false, String(freqHz));
    assert.strictEqual(r.reason, 'tx_freq_unknown');
    assert.ok(/Split is on/.test(r.userVisible) && /Turn split off/.test(r.userVisible), r.userVisible);
  }
});
test('split ON, TX VFO out of the class: refused on the TX frequency (RX 28.400 would have passed)', () => {
  const pe = pass();
  const r = pe.interceptCatCommand({ type: 'tx_enable', freqHz: 14200000, split: true, mode: 'USB', ...POWER_OK });
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.reason, 'out_of_band');
  assert.ok(/14\.200/.test(r.userVisible), r.userVisible);
});
test('split ON, TX VFO inside the class: allowed', () => {
  const pe = pass();
  assert.strictEqual(pe.interceptCatCommand({ type: 'tx_enable', freqHz: 28450000, split: true, mode: 'USB', ...POWER_OK }).allowed, true);
});
test('a picture (sstv_tx) follows the same rule: split-unknown refused, TX frequency judged', () => {
  const pe = pass({ pass: { privilege_class: 'us_general', privilege_class_short: 'general' } });
  assert.strictEqual(pe.interceptCatCommand({ type: 'sstv_tx', freqHz: null, split: true }).reason, 'tx_freq_unknown');
  assert.strictEqual(pe.interceptCatCommand({ type: 'sstv_tx', freqHz: 14230000, split: true }).allowed, true);
  assert.strictEqual(pe.interceptCatCommand({ type: 'sstv_tx', freqHz: 14230000, split: false }).allowed, true);
  const tech = pass();
  assert.strictEqual(tech.interceptCatCommand({ type: 'sstv_tx', freqHz: 14230000, split: true }).reason, 'out_of_band', 'a Technician has no 20 m phone, split or not');
});
test('the split rule is read before the mode list, so a split-unknown never says "mode not allowed"', () => {
  const pe = pass({ pass: { allowed_modes: ['CW'] } });
  assert.strictEqual(pe.interceptCatCommand({ type: 'tx_enable', freqHz: null, split: true, mode: 'USB', ...POWER_OK }).reason, 'tx_freq_unknown');
});

console.log('\nmain.js wiring (B)');
test('effectiveTxFreqHz(): the other VFO in split, the dial otherwise, null when split is on and the TX VFO is unread', () => {
  const i = mainSrc.indexOf('function effectiveTxFreqHz() {');
  assert.ok(i > 0, 'defined');
  const body = mainSrc.slice(i, mainSrc.indexOf('\n}', i));
  assert.ok(/if \(!_currentSplit\) return _currentFreqHz;/.test(body));
  assert.ok(/return _currentFreqOther > 0 \? _currentFreqOther : null;/.test(body));
});
test('every TX gate hands the pass the effective TX frequency and the split flag — none the dial', () => {
  const gates = mainSrc.match(/interceptCatCommand\(\{ type: '(tx_enable|sstv_tx)'[^}]*\}\)/g) || [];
  assert.strictEqual(gates.length, 4, 'passTxAllowed, gatedSetTransmit, gatedSmartSdrTransmit, sstv-photo: ' + gates.length);
  for (const g of gates) {
    assert.ok(/freqHz: effectiveTxFreqHz\(\), split: _currentSplit/.test(g), g);
    assert.ok(!/freqHz: _currentFreqHz/.test(g), g);
  }
});

console.log('\nC. the power cap at key-down');
test('the radio reports under the cap, freshly: allowed', () => {
  const pe = pass();
  assert.strictEqual(pe.interceptCatCommand({ type: 'tx_enable', freqHz: 28400000, mode: 'USB', currentWatts: 25, powerAgeMs: 4000 }).allowed, true, 'at the cap');
  assert.strictEqual(pe.interceptCatCommand({ type: 'tx_enable', freqHz: 28400000, mode: 'USB', currentWatts: 5, powerAgeMs: 59000 }).allowed, true, 'inside the stale window');
});
test('the radio reports ABOVE the cap: refused, and power-over-cap tells main to re-clamp', () => {
  const pe = pass();
  const events = [];
  pe.on('power-over-cap', (e) => events.push(e));
  const r = pe.interceptCatCommand({ type: 'tx_enable', freqHz: 28400000, mode: 'USB', currentWatts: 100, powerAgeMs: 0 });
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.reason, 'over_power');
  assert.ok(/at 100 W/.test(r.userVisible) && /capped at 25 W/.test(r.userVisible), r.userVisible);
  assert.deepStrictEqual(events, [{ watts: 100, max: 25 }]);
  // …and the next press, after the re-clamp was read back, keys.
  assert.strictEqual(pe.interceptCatCommand({ type: 'tx_enable', freqHz: 28400000, mode: 'USB', currentWatts: 25, powerAgeMs: 0 }).allowed, true);
  assert.strictEqual(events.length, 1, 'no event for an allowed key-down');
});
test('no power report (0 / missing): refused with the no-power-CAT reason', () => {
  const pe = pass();
  for (const cmd of [{ currentWatts: 0, powerAgeMs: 0 }, {}, { currentWatts: undefined, powerAgeMs: 0 }, { currentWatts: 10 }]) {
    const r = pe.interceptCatCommand({ type: 'tx_enable', freqHz: 28400000, mode: 'USB', ...cmd });
    assert.strictEqual(r.allowed, false, JSON.stringify(cmd));
    assert.strictEqual(r.reason, 'tx_disabled_no_power_cat', JSON.stringify(cmd));
    assert.ok(/25 W cap/.test(r.userVisible), r.userVisible);
  }
});
test('a stale power report is no report: older than the window (60 s default) is refused', () => {
  const pe = pass();
  assert.strictEqual(pe.interceptCatCommand({ type: 'tx_enable', freqHz: 28400000, mode: 'USB', currentWatts: 5, powerAgeMs: 60001 }).reason, 'tx_disabled_no_power_cat');
  assert.strictEqual(pe.interceptCatCommand({ type: 'tx_enable', freqHz: 28400000, mode: 'USB', currentWatts: 5, powerAgeMs: Infinity }).reason, 'tx_disabled_no_power_cat');
  const strict = pass({ opts: { powerStaleMs: 5000 } });
  assert.strictEqual(strict.interceptCatCommand({ type: 'tx_enable', freqHz: 28400000, mode: 'USB', currentWatts: 5, powerAgeMs: 5001 }).reason, 'tx_disabled_no_power_cat');
  assert.strictEqual(strict.interceptCatCommand({ type: 'tx_enable', freqHz: 28400000, mode: 'USB', currentWatts: 5, powerAgeMs: 4999 }).allowed, true);
});
test('a pass with no cap does not need a power report (the readable rule still applies)', () => {
  const pe = pass({ pass: { max_power_w: null } });
  assert.strictEqual(pe.interceptCatCommand({ type: 'tx_enable', freqHz: 28400000, mode: 'USB' }).allowed, true);
  const unreadable = pass({ pass: { max_power_w: null }, opts: { rigPowerReadable: () => false } });
  assert.strictEqual(unreadable.interceptCatCommand({ type: 'tx_enable', freqHz: 28400000, mode: 'USB' }).reason, 'tx_disabled_no_power_cat');
});
test('a rig that cannot report power is refused before any power value is read', () => {
  const pe = pass({ opts: { rigPowerReadable: () => false } });
  const r = pe.interceptCatCommand({ type: 'tx_enable', freqHz: 28400000, mode: 'USB', currentWatts: 5, powerAgeMs: 0 });
  assert.strictEqual(r.reason, 'tx_disabled_no_power_cat');
  assert.ok(/does not expose TX power over CAT/.test(r.userVisible));
});
test('the order of the rules: callsign, split, band, mode, then power', () => {
  const noCall = pass({ pass: { guest_callsign: '' } });
  assert.strictEqual(noCall.interceptCatCommand({ type: 'tx_enable', freqHz: 14200000, split: true, mode: 'USB', currentWatts: 100, powerAgeMs: 0 }).reason, 'no_callsign');
  const pe = pass({ pass: { allowed_modes: ['CW'] } });
  assert.strictEqual(pe.interceptCatCommand({ type: 'tx_enable', freqHz: null, split: true, mode: 'USB', currentWatts: 100, powerAgeMs: 0 }).reason, 'tx_freq_unknown');
  assert.strictEqual(pe.interceptCatCommand({ type: 'tx_enable', freqHz: 14200000, mode: 'USB', currentWatts: 100, powerAgeMs: 0 }).reason, 'out_of_band');
  assert.strictEqual(pe.interceptCatCommand({ type: 'tx_enable', freqHz: 28400000, mode: 'USB', currentWatts: 100, powerAgeMs: 0 }).reason, 'mode_not_allowed');
  assert.strictEqual(pe.interceptCatCommand({ type: 'tx_enable', freqHz: 7040000, mode: 'CW', currentWatts: 100, powerAgeMs: 0 }).reason, 'over_power');
});

console.log('\nmain.js wiring (C)');
test('every tx_enable gate hands the pass the radio\'s reported power (passPowerState)', () => {
  const gates = mainSrc.match(/interceptCatCommand\(\{ type: 'tx_enable'[^}]*\}\)/g) || [];
  assert.strictEqual(gates.length, 3, 'passTxAllowed, gatedSetTransmit, gatedSmartSdrTransmit');
  for (const g of gates) assert.ok(/\.\.\.passPowerState\(\) \}\)$/.test(g), g);
  const i = mainSrc.indexOf('function passPowerState() {');
  const body = mainSrc.slice(i, mainSrc.indexOf('\n}', i));
  assert.ok(/const rb = _lastPowerReadback;/.test(body), 'the radio\'s own report, never _currentTxPower (optimistic)');
  assert.ok(/return \{ currentWatts: 0, powerAgeMs: Infinity \};/.test(body), 'no report = unknown');
  assert.ok(/flexLive \? 0 : Date\.now\(\) - rb\.at/.test(body), 'a Flex pushes on change: current while the link is up');
});
test('rigPowerReadable is a real answer, not a constant', () => {
  assert.ok(!/rigPowerReadable: \(\) => true/.test(mainSrc), 'the constant is gone');
  assert.ok(/rigPowerReadable: \(\) => passRigPowerReadable\(\),/.test(mainSrc));
  const i = mainSrc.indexOf('function passRigPowerReadable() {');
  const body = mainSrc.slice(i, mainSrc.indexOf('\n}', i));
  assert.ok(/if \(!caps\.txpower\) return false;/.test(body), 'the capability table');
  assert.ok(/if \(rigType === 'flex'\) return !!\(smartSdr && smartSdr\.connected\);/.test(body), 'a Flex needs the API link');
  assert.ok(/return !!\(cat && cat\.connected\);/.test(body), 'a CAT rig needs its link');
});
test('the cap is set at the radio when the lease begins and the owner\'s power comes back when it ends', () => {
  const b = mainSrc.slice(mainSrc.indexOf('function passLeaseBegin() {'), mainSrc.indexOf('function passLeaseEnd() {'));
  assert.ok(/passLease\.ownerPower = \(_lastPowerReadback && _lastPowerReadback\.watts > 0\) \? _lastPowerReadback\.watts : null;/.test(b), 'remembers the radio\'s report');
  assert.ok(/if \(cap > 0\) passApplyPowerCap\(cap, 'lease start'\);/.test(b), 'applies the cap');
  const e = mainSrc.slice(mainSrc.indexOf('function passLeaseEnd() {'), mainSrc.indexOf('function passLeaseReconnectReporters() {'));
  assert.ok(/if \(was && was\.ownerPower > 0 && was\.ownerPower !== _currentTxPower\) \{\s*\n\s*if \(setRadioTxPowerRaw\(was\.ownerPower\)\)/.test(e), 'restores raw (the gate is in ended)');
  assert.ok(/passEnforcement\.on\('power-over-cap', \(\{ watts, max \}\) => passApplyPowerCap\(max,/.test(mainSrc), 'a key-down above the cap re-clamps');
  const raw = mainSrc.slice(mainSrc.indexOf('function setRadioTxPowerRaw(watts) {'), mainSrc.indexOf('function passApplyPowerCap('));
  assert.ok(/if \(rigType === 'flex'\) \{\s*\n\s*if \(!smartSdr \|\| !smartSdr\.connected\) return false;/.test(raw), 'a Flex is set over the API or not at all');
  assert.ok(/else if \(rigType === 'rigctld'\) cat\.setTxPower\(w \/ 100\);/.test(raw), 'rigctld fraction, like gatedSetTxPower');
  assert.ok(!/interceptCatCommand/.test(raw), 'raw means raw');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
