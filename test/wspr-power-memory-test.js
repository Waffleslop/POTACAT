'use strict';
const { readSrc } = require('./_src');
// WSPR pre-beacon power memory — lib/wspr-power-memory.js.
//
// Regression guard for K3SBP 2026-09-10: the WSPR beacon capped an 8600M at
// rfpower=1% and the disarm path (by design, then) never put it back. The
// Flex remembers that across restarts, Flex Direct shows no SmartSDR slider,
// and the wattmeter of the day mis-read dBm as watts — weeks of unanswered
// FT8 CQs at 1 W with nothing on screen saying so. These tests pin the
// decisions: what gets remembered, when it is restored, and when the marker
// is cleared (only by a readback, never by a command sent). Since #521 the
// memory works per frame and both ways (a beacon level above the radio's is
// put back too).

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { markerUsable, rememberPreBeaconPower, decideRestore, decideReconcile, markerBeaconW } = require('../lib/wspr-power-memory');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
}

// Since #521 the marker is written before each frame that changes the power
// (not once at arm) and carries the level the frame set (beaconW).
console.log('rememberPreBeaconPower');
t('the radio\'s level is remembered with the beacon level, the rig id and a timestamp', () => {
  const r = rememberPreBeaconPower({ current: 80, prior: null, rigId: 'r1', beaconW: 5, now: 123 });
  assert.deepStrictEqual(r.marker, { watts: 80, beaconW: 5, rigId: 'r1', at: 123 });
  assert.strictEqual(r.restoreWatts, 80);
  assert.strictEqual(r.changed, true);
});
t('a radio BELOW the beacon level is remembered too (#521: a 2 W radio, a 5 W beacon, never put back)', () => {
  const r = rememberPreBeaconPower({ current: 2, prior: null, rigId: 'r1', beaconW: 5, now: 1 });
  assert.strictEqual(r.restoreWatts, 2);
  assert.strictEqual(r.marker.watts, 2);
});
t('a radio still at the beacon level (a restore that never landed) KEEPS the prior marker', () => {
  const prior = { watts: 80, beaconW: 5, rigId: 'r1', at: 1 };
  const r = rememberPreBeaconPower({ current: 5, prior, rigId: 'r1', beaconW: 5 });
  assert.strictEqual(r.marker, prior);
  assert.strictEqual(r.restoreWatts, 80);
  assert.strictEqual(r.changed, false);
});
t('unknown power (0) keeps a usable prior, and with none there is nothing to restore', () => {
  const prior = { watts: 80, beaconW: 5, rigId: 'r1', at: 1 };
  assert.strictEqual(rememberPreBeaconPower({ current: 0, prior, rigId: 'r1', beaconW: 5 }).restoreWatts, 80);
  const r = rememberPreBeaconPower({ current: 0, prior: null, rigId: 'r1', beaconW: 5 });
  assert.strictEqual(r.restoreWatts, 0);
  assert.strictEqual(r.changed, false);
});
t('a level the operator set since (not the beacon level) replaces a stale marker', () => {
  const r = rememberPreBeaconPower({ current: 20, prior: { watts: 80, beaconW: 5, rigId: 'r1', at: 1 }, rigId: 'r1', beaconW: 5, now: 5 });
  assert.strictEqual(r.marker.watts, 20);
  assert.strictEqual(r.changed, true);
});
t('a prior marker from another rig is not offered as the restore level', () => {
  const r = rememberPreBeaconPower({ current: 0, prior: { watts: 80, rigId: 'other', at: 1 }, rigId: 'r1', beaconW: 5 });
  assert.strictEqual(r.restoreWatts, 0);
});
t('a marker from before #521 (no beaconW) counts its beacon level as the old 1 W cap', () => {
  assert.strictEqual(markerBeaconW({ watts: 80 }), 1);
  const r = rememberPreBeaconPower({ current: 1, prior: { watts: 80, rigId: 'r1' }, rigId: 'r1', beaconW: 5 });
  assert.strictEqual(r.restoreWatts, 80);
  assert.strictEqual(r.marker.beaconW, 5);
});
t('markers without a rig id (single-rig installs) are trusted', () => {
  assert.strictEqual(markerUsable({ watts: 50 }, 'r1'), true);
  assert.strictEqual(markerUsable({ watts: 50, rigId: 'r1' }, null), true);
  assert.strictEqual(markerUsable({ watts: 0, rigId: 'r1' }, 'r1'), false);
});

console.log('decideRestore');
t('no marker = none', () => {
  assert.strictEqual(decideRestore({ marker: null, rigId: 'r1' }).action, 'none');
  assert.strictEqual(decideRestore({ marker: { watts: 0 }, rigId: 'r1' }).action, 'none');
});
t('a marker for another rig is forgotten, not applied to this radio', () => {
  assert.strictEqual(decideRestore({ marker: { watts: 80, rigId: 'other' }, rigId: 'r1' }).action, 'forget-rig-mismatch');
});
t('mid-WSPR-frame the restore DEFERS (the level exists for exactly that frame)', () => {
  assert.strictEqual(decideRestore({ marker: { watts: 80, rigId: 'r1' }, rigId: 'r1', txActiveWspr: true }).action, 'defer');
});
t('immediate (frame end / engine stop / app quit) restores even if the engine still says TX', () => {
  const d = decideRestore({ marker: { watts: 80, rigId: 'r1' }, rigId: 'r1', txActiveWspr: true, immediate: true });
  assert.strictEqual(d.action, 'command');
  assert.strictEqual(d.watts, 80);
});
t('a level below the beacon\'s is restored too', () => {
  const d = decideRestore({ marker: { watts: 2, beaconW: 5, rigId: 'r1' }, rigId: 'r1', immediate: true });
  assert.deepStrictEqual(d, { action: 'command', watts: 2 });
});
t('gives up after maxAttempts so a radio that rejects the level cannot loop forever', () => {
  assert.strictEqual(decideRestore({ marker: { watts: 80 }, attempts: 3, maxAttempts: 3 }).action, 'give-up');
  assert.strictEqual(decideRestore({ marker: { watts: 80 }, attempts: 2, maxAttempts: 3 }).action, 'command');
});

console.log('decideReconcile (every power readback)');
const MK = { watts: 80, beaconW: 5, rigId: 'r1' };
t('no marker = skip', () => {
  assert.strictEqual(decideReconcile({ marker: null, watts: 1 }), 'skip');
});
t('while a beacon frame is on the air its level is the frame doing its job: skip', () => {
  assert.strictEqual(decideReconcile({ marker: MK, frameActive: true, watts: 5 }), 'skip');
});
t('while a deferred restore is pending, or just after a power command: skip', () => {
  assert.strictEqual(decideReconcile({ marker: MK, retryPending: true, watts: 5 }), 'skip');
  assert.strictEqual(decideReconcile({ marker: MK, recentCommand: true, watts: 5 }), 'skip');
});
t('a readback at the remembered level is the confirmation that clears the marker', () => {
  assert.strictEqual(decideReconcile({ marker: MK, watts: 80 }), 'forget');
  assert.strictEqual(decideReconcile({ marker: { watts: 2, beaconW: 5 }, watts: 2 }), 'forget');
});
t('a readback at some other level is the operator\'s: forget, never fight it', () => {
  assert.strictEqual(decideReconcile({ marker: MK, watts: 20 }), 'forget');
});
t('a readback still at the beacon level between frames = a restore that never landed: restore', () => {
  assert.strictEqual(decideReconcile({ marker: MK, watts: 5 }), 'restore');
  assert.strictEqual(decideReconcile({ marker: { watts: 2, beaconW: 5 }, watts: 5 }), 'restore');
});
t('a marker from before #521 keeps its old rule: above the 1 W cap forgets, at or below restores', () => {
  assert.strictEqual(decideReconcile({ marker: { watts: 80 }, watts: 20 }), 'forget');
  assert.strictEqual(decideReconcile({ marker: { watts: 80 }, watts: 1 }), 'restore');
  assert.strictEqual(decideReconcile({ marker: { watts: 80 }, watts: 0.5 }), 'restore');
});
t('a garbage readback is ignored', () => {
  assert.strictEqual(decideReconcile({ marker: MK, watts: NaN }), 'skip');
  assert.strictEqual(decideReconcile({ marker: MK, watts: -1 }), 'skip');
});

console.log('main.js wiring (source-text guards)');
const main = readSrc(path.join(__dirname, '..', 'main.js'));
t('wsprPreCapPower is a GLOBAL_KEY (it describes this machine\'s radio, not a profile)', () => {
  assert.ok(/^\s*'wsprPreCapPower',/m.test(main), 'missing from GLOBAL_KEYS');
});
t('arming changes nothing on the radio; each frame remembers BEFORE it sets, and tx-end restores (#521)', () => {
  const arm = main.slice(main.indexOf('function setWsprBeacon('), main.indexOf('function applyWsprBeaconControl('));
  assert.ok(!arm.includes('wsprRememberPreCapPower(') && !arm.includes('wsprSetFramePower('), 'arm must not touch the power');
  const set = main.slice(main.indexOf('function wsprSetFramePower()'), main.indexOf('function wsprBeaconWatts()'));
  const rem = set.indexOf('wsprRememberPreCapPower(plan.watts)');
  const cmd = set.indexOf('wsprCommandTxPower(plan.watts)');
  assert.ok(rem > 0 && cmd > rem, 'remember must precede the command');
  const end = main.indexOf('const wsprFrameSetPower = !!(_wsprFrameRf && _wsprFrameRf.commanded);');
  const restore = main.indexOf("if (wsprFrameSetPower && settings.wsprPreCapPower) wsprRestorePreCapPower('frame done', { immediate: true });", end);
  const rel = main.indexOf('handleRemotePtt(false);', end);
  assert.ok(end > 0 && rel > end && restore > rel && restore - end < 3000, 'tx-end must restore, after the PTT release');
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
  assert.ok(main.includes('jtcatNoteTxPowerForMode(modeForTx, data.message, data.freq'));
  assert.ok(main.includes("mode === 'WSPR'"), 'WSPR itself must not warn about its own cap');
});
t('the beacon\'s power goes through gatedSetTxPower / gatedSmartSdrTxPower (rigctld takes a fraction: a bare 1 was full power, WZ1H)', () => {
  const fn = main.indexOf('function wsprCommandTxPower(watts)');
  const body = main.slice(fn, main.indexOf('\n}\n', fn));
  assert.ok(body.includes('gatedSmartSdrTxPower(watts)'));
  assert.ok(body.includes('gatedSetTxPower(watts, { rigType: detectRigType() })'));
  assert.ok(!/cat\.setTxPower\(/.test(body), 'raw cat.setTxPower is L RFPOWER <watts> on rigctld');
  assert.ok(!main.includes('function wsprForcePowerCap('), 'the 1 W cap is gone');
});

console.log(`\nWSPR power memory: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
