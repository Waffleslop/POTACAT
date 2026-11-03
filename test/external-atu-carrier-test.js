#!/usr/bin/env node
'use strict';
// RF-sense external tuner carrier (N8JMS FTDX10, 2026-10-26): the tune put the
// radio in CW and sent a CAT transmit — key up, so no RF. It is AM now.
// Run: node test/external-atu-carrier-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
console.log('External ATU carrier');
const fnStart = main.indexOf('runExternalAtuTune = async function');
const fn = main.slice(fnStart, main.indexOf("ipcMain.on('external-atu-cancel'", fnStart));
test('the carrier mode is AM', () => {
  assert.ok(/const EXTERNAL_ATU_CARRIER_MODE = 'AM';/.test(main));
  assert.ok(/setModeOnly\(carrierMode, _currentFreqHz\)/.test(fn));
});
test('CW is never the tune carrier', () => {
  assert.ok(!/setModeOnly\('CW'/.test(fn) && !/setMode\('CW'\)/.test(fn), 'no CW mode set in the tune');
});
test('mode and power are still restored', () => {
  assert.ok(/setModeOnly\(restoreMode, _currentFreqHz\)/.test(fn) && /gatedSetTxPower\(restorePower\)/.test(fn));
});

// GitHub #111 (df1vb): the tune power stayed after tuning. Runs the REAL
// tune function in a sandbox against a fake radio that ignores the first
// power restore (it is still in its TX tail), then answers.
async function runTune({ ignoreRestores, powerBefore = 100 }) {
  const vm = require('vm');
  const wfr = main.slice(main.indexOf('async function waitForPowerReadback('), main.indexOf('/**', main.indexOf('async function waitForPowerReadback(')));
  const log = [], powers = [];
  let restoresSeen = 0;
  const ctx = {
    console, Date, Promise, setTimeout, clearTimeout,
    settings: { activeRigId: 'r1', rigs: [{ id: 'r1', externalAtu: 'rf-sense', externalAtuWatts: 10, externalAtuSeconds: 1 }] },
    cat: { connected: true, setModeOnly() {} },
    _currentMode: 'USB', _currentTxPower: powerBefore, _currentFreqHz: 14074000,
    EXTERNAL_ATU_CARRIER_MODE: 'AM', _externalAtuActive: false, _externalAtuCancel: false,
    _setupPowerRestoreAttempt: 0, _lastPowerReadback: null, win: null,
    sendCatLog: (l) => log.push(l), saveSettings() {}, gatedSetTransmit() {},
    sleepMs: (ms) => new Promise((r) => setTimeout(r, ms)),
    gatedSetTxPower: (w) => {
      powers.push(w);
      if (w === 10) { setTimeout(() => { ctx._lastPowerReadback = { watts: 10, at: Date.now() }; }, 50); return; }
      restoresSeen++;
      if (restoresSeen > ignoreRestores) setTimeout(() => { ctx._lastPowerReadback = { watts: w, at: Date.now() }; }, 100);
    },
  };
  vm.createContext(ctx);
  vm.runInContext(wfr + '\nvar runExternalAtuTune;\n' + fn, ctx);
  await ctx.runExternalAtuTune();
  return { log, powers, ctx };
}
(async () => {
  const a = await runTune({ ignoreRestores: 1 });
  test('a radio that misses the first restore is sent it again, and confirms', () => {
    assert.deepStrictEqual(a.powers, [10, 100, 100]);
    assert.ok(a.log.some((l) => /radio confirms 100 W/.test(l)), a.log.join('\n'));
    assert.ok(!a.ctx.settings.setupTxPowerRestore, 'the restore marker is cleared by the readback');
  });
  const b = await runTune({ ignoreRestores: 99 });
  test('a radio that never confirms keeps the marker for the next power report to repair', () => {
    assert.deepStrictEqual(b.powers, [10, 100, 100, 100], 'three restore attempts, no more');
    const m = b.ctx.settings.setupTxPowerRestore;
    assert.ok(m && m.watts === 100 && m.testWatts === 10 && m.reason === 'external-atu');
    assert.ok(b.log.some((l) => /has not confirmed it/.test(l)));
  });
  test('the reconcile on the next power report leaves a running tune alone', () => {
    const rec = main.slice(main.indexOf('function stationSetupReconcilePower('), main.indexOf('function stationSetupReconcilePower(') + 600);
    assert.ok(/_stationSetupTxBusy \|\| _externalAtuActive\) return;/.test(rec));
  });
  // GitHub #111 again (df1vb IC-7100, after 1.13.9): the routine was assigned
  // inside connectRemote(), so with ECHOCAT off the ATU button ran the
  // `async () => false` stub, and each ECHOCAT restart added a cancel listener.
  test('the tune routine is assigned at module scope, never inside connectRemote()', () => {
    const cr = main.indexOf('\nfunction connectRemote()');
    assert.ok(cr > 0 && fnStart > 0);
    assert.ok(fnStart < cr, 'runExternalAtuTune must be assigned before (outside) connectRemote()');
    assert.ok(/^runExternalAtuTune = async function/m.test(main), 'assigned at column 0 (module scope)');
    assert.strictEqual(main.split("ipcMain.on('external-atu-cancel'").length - 1, 1, 'one cancel listener');
  });
  test('the tune\'s own AM flip never fires a rig preset', () => {
    const rp = main.slice(main.indexOf('function rigPresetOnMode('), main.indexOf('function rigPresetOnMode(') + 400);
    assert.ok(/\{\s*(\/\/[^\n]*\n\s*)*if \(_externalAtuActive\) return;/.test(rp), 'first statement returns while the tune runs');
  });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
