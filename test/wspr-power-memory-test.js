'use strict';
// WSPR pre-beacon power memory — lib/wspr-power-memory.js.
//
// Regression guard for K3SBP 2026-09-10: the WSPR beacon capped an 8600M at
// rfpower=1% and the disarm path (by design, then) never put it back. The
// Flex remembers that across restarts, Flex Direct shows no SmartSDR slider,
// and the wattmeter of the day mis-read dBm as watts — weeks of unanswered
// FT8 CQs at 1 W with nothing on screen saying so. These tests pin the
// decisions: what gets remembered, when it is restored, and when the marker
// is cleared (only by a readback above the cap, never by a command sent).

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { markerUsable, rememberPreCapPower, decideRestore, decideReconcile } = require('../lib/wspr-power-memory');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
}

const CAP = 1;

console.log('rememberPreCapPower');
t('a radio above the cap is remembered, with the rig id and a timestamp', () => {
  const r = rememberPreCapPower({ current: 80, prior: null, rigId: 'r1', cap: CAP, now: 123 });
  assert.deepStrictEqual(r.marker, { watts: 80, rigId: 'r1', at: 123 });
  assert.strictEqual(r.restoreWatts, 80);
  assert.strictEqual(r.changed, true);
});
t('re-arming while already at the cap KEEPS the prior marker instead of remembering 1 W', () => {
  const prior = { watts: 80, rigId: 'r1', at: 1 };
  const r = rememberPreCapPower({ current: 1, prior, rigId: 'r1', cap: CAP });
  assert.strictEqual(r.marker, prior);
  assert.strictEqual(r.restoreWatts, 80);
  assert.strictEqual(r.changed, false);
});
t('unknown power (0) with no prior = nothing to restore, nothing written', () => {
  const r = rememberPreCapPower({ current: 0, prior: null, rigId: 'r1', cap: CAP });
  assert.strictEqual(r.restoreWatts, 0);
  assert.strictEqual(r.changed, false);
});
t('a new level above the cap overwrites a stale marker', () => {
  const r = rememberPreCapPower({ current: 20, prior: { watts: 80, rigId: 'r1', at: 1 }, rigId: 'r1', cap: CAP, now: 5 });
  assert.strictEqual(r.marker.watts, 20);
  assert.strictEqual(r.changed, true);
});
t('a prior marker from another rig is not offered as the restore level', () => {
  const r = rememberPreCapPower({ current: 1, prior: { watts: 80, rigId: 'other', at: 1 }, rigId: 'r1', cap: CAP });
  assert.strictEqual(r.restoreWatts, 0);
});
t('markers without a rig id (single-rig installs) are trusted', () => {
  assert.strictEqual(markerUsable({ watts: 50 }, 'r1', CAP), true);
  assert.strictEqual(markerUsable({ watts: 50, rigId: 'r1' }, null, CAP), true);
  assert.strictEqual(markerUsable({ watts: 1, rigId: 'r1' }, 'r1', CAP), false);
});

console.log('decideRestore');
t('no marker = none', () => {
  assert.strictEqual(decideRestore({ marker: null, rigId: 'r1', cap: CAP }).action, 'none');
  assert.strictEqual(decideRestore({ marker: { watts: 1 }, rigId: 'r1', cap: CAP }).action, 'none');
});
t('a marker for another rig is forgotten, not applied to this radio', () => {
  assert.strictEqual(decideRestore({ marker: { watts: 80, rigId: 'other' }, rigId: 'r1', cap: CAP }).action, 'forget-rig-mismatch');
});
t('mid-WSPR-frame the restore DEFERS (the cap exists for exactly that frame)', () => {
  assert.strictEqual(decideRestore({ marker: { watts: 80, rigId: 'r1' }, rigId: 'r1', cap: CAP, txActiveWspr: true }).action, 'defer');
});
t('immediate (engine stop / app quit) restores even if the engine still says TX', () => {
  const d = decideRestore({ marker: { watts: 80, rigId: 'r1' }, rigId: 'r1', cap: CAP, txActiveWspr: true, immediate: true });
  assert.strictEqual(d.action, 'command');
  assert.strictEqual(d.watts, 80);
});
t('gives up after maxAttempts so a radio that rejects the level cannot loop forever', () => {
  assert.strictEqual(decideRestore({ marker: { watts: 80 }, cap: CAP, attempts: 3, maxAttempts: 3 }).action, 'give-up');
  assert.strictEqual(decideRestore({ marker: { watts: 80 }, cap: CAP, attempts: 2, maxAttempts: 3 }).action, 'command');
});

console.log('decideReconcile (every power readback)');
t('no marker = skip', () => {
  assert.strictEqual(decideReconcile({ marker: null, watts: 1, cap: CAP }), 'skip');
});
t('while the beacon is armed the 1 W readback is the cap doing its job — skip', () => {
  assert.strictEqual(decideReconcile({ marker: { watts: 80 }, armed: true, watts: 1, cap: CAP }), 'skip');
});
t('while a deferred restore is pending — skip (it will fire when the frame ends)', () => {
  assert.strictEqual(decideReconcile({ marker: { watts: 80 }, retryPending: true, watts: 1, cap: CAP }), 'skip');
});
t('a readback ABOVE the cap is the confirmation that clears the marker', () => {
  assert.strictEqual(decideReconcile({ marker: { watts: 80 }, watts: 80, cap: CAP }), 'forget');
  // ...including when the operator raised it by hand to something else
  assert.strictEqual(decideReconcile({ marker: { watts: 80 }, watts: 20, cap: CAP }), 'forget');
});
t('a readback still AT the cap with nobody beaconing = a restore that never landed (crash / quit / old build) — restore', () => {
  assert.strictEqual(decideReconcile({ marker: { watts: 80 }, watts: 1, cap: CAP }), 'restore');
  assert.strictEqual(decideReconcile({ marker: { watts: 80 }, watts: 0.5, cap: CAP }), 'restore');
});
t('a garbage readback is ignored', () => {
  assert.strictEqual(decideReconcile({ marker: { watts: 80 }, watts: NaN, cap: CAP }), 'skip');
  assert.strictEqual(decideReconcile({ marker: { watts: 80 }, watts: -1, cap: CAP }), 'skip');
});

console.log('main.js wiring (source-text guards)');
const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
t('wsprPreCapPower is a GLOBAL_KEY (it describes this machine\'s radio, not a profile)', () => {
  assert.ok(/^\s*'wsprPreCapPower',/m.test(main), 'missing from GLOBAL_KEYS');
});
t('the arm path remembers BEFORE it caps', () => {
  const arm = main.indexOf('const restoreWatts = wsprRememberPreCapPower();');
  const cap = main.indexOf('const capped = wsprForcePowerCap();');
  assert.ok(arm > 0 && cap > 0 && arm < cap, 'remember must precede wsprForcePowerCap in setWsprBeacon');
});
t('the disarm path restores instead of leaving the cap ("raise it in your radio" is gone)', () => {
  assert.ok(!main.includes('TX power left at the ~1 W cap — raise it in your radio for other modes'), 'old one-way disarm copy still present');
  assert.ok(main.includes("wsprRestorePreCapPower(why, { immediate: !!opts.immediate })"), 'disarm branch does not call wsprRestorePreCapPower');
});
t('engine stop and app quit both disarm-with-restore while the rig link is still up', () => {
  assert.ok(main.includes("setWsprBeacon(false, { immediate: true, why: 'stopped with JTCAT' })"), 'stopJtcat missing');
  const quit = main.indexOf("setWsprBeacon(false, { immediate: true, why: 'stopped at app quit' })");
  const catDisc = main.indexOf('function gracefulCleanup()');
  assert.ok(quit > catDisc, 'gracefulCleanup missing the disarm');
  const disconnect = main.indexOf('cat.disconnect();', catDisc);
  assert.ok(quit < disconnect, 'the quit-time restore must run BEFORE cat.disconnect()/disconnectSmartSdr()');
});
t('every power readback reconciles the marker (crash recovery lives in sendCatPower)', () => {
  const fn = main.indexOf('function sendCatPower(watts)');
  const end = main.indexOf('\n}\n', fn);
  assert.ok(main.slice(fn, end).includes('wsprReconcilePreCapPower(watts)'));
});
t('an explicit operator power set forgets the marker (never fight the operator)', () => {
  assert.ok((main.match(/if \(!wsprBeaconArmed\(\)\) wsprForgetPreCapPower\(\);/g) || []).length >= 2, 'both set-tx-power sites (rig-control + ECHOCAT set-txpower)');
});
t('the [TX] RF out line carries the commanded level beside the measured one', () => {
  assert.ok(main.includes('RF power set to ${_currentTxPower} W'));
});
t('every JTCAT tx-start logs the RF power and warns at the cap in a non-WSPR mode', () => {
  assert.ok(main.includes('jtcatNoteTxPowerForMode(modeForTx, data.message, data.freq)'));
  assert.ok(main.includes("mode === 'WSPR'"), 'WSPR itself must not warn about its own cap');
});

console.log(`\nWSPR power memory: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
