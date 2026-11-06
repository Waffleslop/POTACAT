#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
// The 1.13.10 regression (GitHub #111 df1vb IC-7100, nocodegeneralwitha7300
// IC-7300): the external-tuner carrier "restored" a never-read power as
// 100 W, and the leftover marker turned the operator's knob back to 100 W.
// Run: node test/power-restore-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const R = require('../lib/power-restore');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
}

const T0 = 1_000_000;
const marker = (o = {}) => ({ watts: 50, testWatts: 10, rigId: 'r1', at: T0, reason: 'external-atu', ...o });
const st = (o = {}) => ({ now: T0 + 5000, activeRigId: 'r1', carrierRunning: false, attempts: 0, ...o });

test('a power that was never read is never restored (no 100 W guess)', () => {
  assert.strictEqual(R.restoreTarget(0), null);
  assert.strictEqual(R.restoreTarget(undefined), null);
  assert.strictEqual(R.restoreTarget(NaN), null);
  assert.strictEqual(R.restoreTarget(35), 35);
});

test('the radio still at the tune power after the carrier: put it back', () => {
  assert.deepStrictEqual(R.decideReconcile(marker(), 10, st()), { action: 'restore', why: 'still-at-test-power' });
  assert.strictEqual(R.decideReconcile(marker(), 10.4, st()).action, 'restore');
});

test('the radio above the tune power: restored, forget it', () => {
  assert.strictEqual(R.decideReconcile(marker(), 50, st()).action, 'clear');
});

test('the operator turned the knob to another low power: forget it, never undo it', () => {
  // nocodegeneralwitha7300: knob down to 5 W for FT8, put back to 100 %.
  assert.deepStrictEqual(R.decideReconcile(marker(), 5, st()), { action: 'clear', why: 'operator' });
  assert.strictEqual(R.decideReconcile(marker(), 1, st()).action, 'clear');
});

test('an external-tuner marker past its window is forgotten, whatever the power reads', () => {
  const late = st({ now: T0 + R.EXT_ATU_WINDOW_MS + 1 });
  assert.deepStrictEqual(R.decideReconcile(marker(), 10, late), { action: 'clear', why: 'expired' });
  // the Station Setup test marker keeps its crash-repair role
  assert.strictEqual(R.decideReconcile(marker({ reason: 'setup-test' }), 10, late).action, 'restore');
});

test('nothing while the carrier runs, on another rig, or inside the retry gap', () => {
  assert.strictEqual(R.decideReconcile(marker(), 10, st({ carrierRunning: true })).action, 'none');
  assert.strictEqual(R.decideReconcile(marker(), 10, st({ activeRigId: 'r2' })).action, 'none');
  assert.strictEqual(R.decideReconcile(marker({ lastAttemptAt: T0 + 1000 }), 10, st()).action, 'none');
  assert.strictEqual(R.decideReconcile(marker(), 10, st({ attempts: 3 })).action, 'none');
  assert.strictEqual(R.decideReconcile(null, 10, st()).action, 'none');
});

const main = readSrc(path.join(__dirname, '..', 'main.js'));
test('main: the tune never falls back to the Default power, and marks a restore only when the power was read', () => {
  const t = main.slice(main.indexOf('runExternalAtuTune = async function () {'), main.indexOf("ipcMain.on('external-atu-cancel'"));
  assert.ok(!/settings\.defaultPower \|\| 100/.test(t), 'no 100 W fallback');
  assert.ok(/const restorePower = PowerRestore\.restoreTarget\(_currentTxPower\);/.test(t));
  assert.ok(/const lowering = restorePower != null && restorePower > watts \+ 0\.5;/.test(t));
});

test('main: the reconcile follows the rules, and an operator power change forgets the marker', () => {
  const r = main.slice(main.indexOf('function stationSetupReconcilePower(watts) {'), main.indexOf('// --- "Share my working setup"'));
  assert.ok(/PowerRestore\.decideReconcile\(m, watts,/.test(r));
  const sp = main.slice(main.indexOf("case 'set-tx-power': {"), main.indexOf("case 'set-filter-width': {"));
  assert.ok(/if \(source !== 'setup' && settings\.setupTxPowerRestore\) \{/.test(sp), 'an operator change clears it');
});

console.log(`\nPower restore: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
