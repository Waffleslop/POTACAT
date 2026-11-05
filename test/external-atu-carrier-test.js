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
  assert.ok(/setModeOnly\(restoreSetMode, _currentFreqHz\)/.test(fn) &&/gatedSetTxPower\(restorePower\)/.test(fn));
});

// GitHub #111 (df1vb): the tune power stayed after tuning. Runs the REAL
// tune function in a sandbox against a fake radio that ignores the first
// power restore (it is still in its TX tail), then answers.
// The fake radio also reports its mode: an Icom (dataFlag) keeps DATA as a
// separate flag, so FT8 reads back as USB with dataModeState.on.
async function runTune({ ignoreRestores, powerBefore = 100, modeBefore = 'USB', dataFlag = false, dataBefore = false, ignoreModeRestores = 0 }) {
  const vm = require('vm');
  const wfr = main.slice(main.indexOf('async function waitForPowerReadback('), main.indexOf('/**', main.indexOf('async function waitForPowerReadback(')));
  const wmr = main.slice(main.indexOf('async function waitForModeReadback('), main.indexOf('\n}\n', main.indexOf('async function waitForModeReadback(')) + 3);
  const log = [], powers = [], modes = [];
  let restoresSeen = 0, modeRestoresSeen = 0;
  const DATA_PARSE = { DIGU: ['USB', true], DIGL: ['LSB', true], DIGFM: ['FM', true], DIGAM: ['AM', true] };
  const codec = { dataModeState: dataFlag ? { on: dataBefore } : null };
  const ctx = {
    console, Date, Promise, setTimeout, clearTimeout,
    ExtAtuRestore: require('../lib/ext-atu-restore'),
    PowerRestore: require('../lib/power-restore'),
    _lastModeReadback: null,
    settings: { activeRigId: 'r1', rigs: [{ id: 'r1', externalAtu: 'rf-sense', externalAtuWatts: 10, externalAtuSeconds: 1 }] },
    cat: {
      connected: true, _codec: codec,
      setModeOnly(m) {
        modes.push(m);
        if (m !== 'AM') { modeRestoresSeen++; if (modeRestoresSeen <= ignoreModeRestores) return; }
        const [base, data] = dataFlag ? (DATA_PARSE[m] || [m, false]) : [m, false];
        setTimeout(() => {
          if (dataFlag) codec.dataModeState = { on: data };
          ctx._lastModeReadback = { mode: base, at: Date.now() };
        }, 60);
      },
    },
    _currentMode: modeBefore, _currentTxPower: powerBefore, _currentFreqHz: 14074000,
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
  vm.runInContext(wfr + '\n' + wmr + '\nvar runExternalAtuTune;\n' + fn, ctx);
  await ctx.runExternalAtuTune();
  return { log, powers, modes, ctx };
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
  // bobve (IC-7300 + LDG over Cloud, 2026-11-03): the radio stayed in AM.
  const c = await runTune({ ignoreRestores: 0, ignoreModeRestores: 1 });
  test('a lost mode restore is sent again until the radio reports the mode', () => {
    assert.deepStrictEqual(c.modes, ['AM', 'USB', 'USB']);
    assert.ok(c.log.some((l) => /sending the mode again \(2 of 3\)/.test(l)), c.log.join('\n'));
    assert.ok(c.log.some((l) => /mode USB confirmed/.test(l)), c.log.join('\n'));
  });
  const d = await runTune({ ignoreRestores: 0, dataFlag: true, dataBefore: true });
  test('an Icom in USB with DATA on is restored with DATA (DIGU), not plain USB', () => {
    assert.deepStrictEqual(d.modes, ['AM', 'DIGU']);
    assert.ok(d.log.some((l) => /mode USB \(DATA on\) confirmed/.test(l)), d.log.join('\n'));
  });
  const e = await runTune({ ignoreRestores: 0, dataFlag: true, dataBefore: false });
  test('plain USB on an Icom stays plain USB', () => assert.deepStrictEqual(e.modes, ['AM', 'USB']));
  // GitHub #111 / nocodegeneralwitha7300: a power the radio never reported
  // was "restored" as the Default power, 100 W, and kept as a marker.
  const n = await runTune({ ignoreRestores: 0, powerBefore: 0 });
  test('a power the radio never reported is not restored as 100 W: the tune power stays, no marker, and the log says why', () => {
    assert.deepStrictEqual(n.powers, [10], 'only the tune power was ever sent');
    assert.ok(!n.ctx.settings.setupTxPowerRestore, 'no restore marker');
    assert.ok(n.log.some((l) => /power left at 10 W: the radio never reported its power before the tune, so POTACAT does not guess one/.test(l)), n.log.join('\n'));
    assert.ok(n.log.some((l) => /power never reported by the radio → 10W/.test(l)), n.log.join('\n'));
  });
  const g = await runTune({ ignoreRestores: 0, ignoreModeRestores: 99 });
  test('a radio that never reports the mode gets three tries and the log says so', () => {
    assert.deepStrictEqual(g.modes, ['AM', 'USB', 'USB', 'USB']);
    assert.ok(g.log.some((l) => /has not confirmed it \(last report/.test(l)), g.log.join('\n'));
  });
  test('restore names: DATA flag on maps to the DATA name, otherwise unchanged', () => {
    const R = require('../lib/ext-atu-restore');
    assert.strictEqual(R.restoreModeName('USB', true), 'DIGU');
    assert.strictEqual(R.restoreModeName('LSB', true), 'DIGL');
    assert.strictEqual(R.restoreModeName('USB', false), 'USB');
    assert.strictEqual(R.restoreModeName('DATA-U', true), 'DATA-U');
    assert.ok(R.modeConfirmed('usb', 'USB', null, false));
    assert.ok(!R.modeConfirmed('USB', 'USB', { on: false }, true), 'USB without DATA is not a confirmed USB-D');
    assert.ok(!R.modeConfirmed('AM', 'USB', null, false));
  });
  test('the reconcile on the next power report leaves a running tune alone', () => {
    const rec = main.slice(main.indexOf('function stationSetupReconcilePower('), main.indexOf('function stationSetupReconcilePower(') + 900);
    assert.ok(/carrierRunning: !!\(_stationSetupTxTest \|\| _stationSetupTxBusy \|\| _externalAtuActive\)/.test(rec));
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
