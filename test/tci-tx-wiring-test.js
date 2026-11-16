// SPDX-License-Identifier: Apache-2.0
'use strict';
// TCI transmit wiring in main.js: JTCAT's overs go through every existing
// guard and the radio arbiter before lib/tci-tx.js keys; ECHOCAT voice has
// its own gate; the log, the WSPR beacon and the drive cap never mistake a
// drive percent for watts. Based on PR #632 by w5lee.
// Run: node test/tci-tx-wiring-test.js

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { readSrc } = require('./_src');
const AmpDrive = require('../lib/amp-drive-limit');

const ROOT = path.join(__dirname, '..');
const MAIN = readSrc(path.join(ROOT, 'main.js'));

function fnBody(src, header) {
  const at = src.indexOf(header);
  assert.ok(at !== -1, 'missing: ' + header);
  const open = src.indexOf('{', at + header.length - 1);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1);
  }
  throw new Error('unbalanced: ' + header);
}
const txStart = MAIN.slice(MAIN.indexOf("ft8Engine.on('tx-start', (data) => {"), MAIN.indexOf("ft8Engine.on('tx-end', () => {\n"));

test('JTCAT over: every existing guard, the arbiter and the late-start cut come first', () => {
  const at = (s) => { const i = txStart.indexOf(s); assert.ok(i > 0, 'missing in tx-start: ' + s); return i; };
  const route = at('if (tciDirectTx && !tciRigJtcatTx(data, modeForTx)) return;');
  for (const before of ["radioOwner === 'mercury'", 'JtcatRxSource.jtcatTxRefusalForSource', 'if (_swrTripped) {', "ownTxPrivilegeRefused('DATA')", 'jtcatTxWatchdogTripped(', "acquireRadio('jtcat');", 'Ft8Engine.sliceLateStartBuffer(']) {
    assert.ok(at(before) < route, before + ' before the TCI route');
  }
  assert.ok(route < at('jtcatNoteTxSent(data.message);'), 'a refused over is not counted as sent');
  assert.match(txStart, /if \(!tciDirectTx\) handleRemotePtt\(true,/, 'no PTT line for a TCI over');
  assert.match(txStart, /if \(!tciDirectTx && !fakeItShiftForTx\(data\)\)/);
  assert.match(txStart, /if \(tciDirectTx\) \{[\s\S]*?\} else if \(smartSdrDirectTxOk\) \{/, 'no sound-card route either');
  assert.match(txStart, /armJtcatTxFailsafe\(tciDirectTx \? 'TCI'/, 'the JTCAT failsafe still arms');
  assert.match(txStart, /const dialLive = !!\(\(cat && cat\.connected\) \|\| \(smartSdr && smartSdr\.canTune && smartSdr\.connected\) \|\| tciRigLinked\(\)\);/, 'wrong-band guard sees a TCI dial');
  assert.ok(!/setLateStartTx\([^)]*tci/i.test(MAIN), 'late-start TX stays on for TCI (docs/JTCAT.md)');
});

test('tciRigJtcatTx: arbiter, Fake It, gate, silence, settle', () => {
  const b = fnBody(MAIN, 'function tciRigJtcatTx(data, mode) {');
  assert.match(b, /if \(radioOwner !== 'jtcat'\) return refuse/);
  assert.match(b, /if \(data\.dialShiftHz\) return refuse/);
  assert.match(b, /const why = tciTxGate\('digital'\);/);
  assert.match(b, /if \(!\(outputPeak >= 0\.01\)\) return refuse/);
  assert.match(b, /500 - \(data\.offsetMs \|\| 0\)/);
  assert.match(b, /if \(engine && engine\._txActive\) engine\.txComplete\(\);/, 'the engine hears the over end');
  assert.match(b, /setTimeout\(\(\) => jtcatRefuseTx\(why\), 0\)/, 'a refusal unwinds the engine');
});

test('the POTACAT gate: SWR, Guest Pass, CW, the SDR, and voice privileges', () => {
  const g = fnBody(MAIN, 'function tciTxGate(kind, emission) {');
  for (const want of ['_swrTripped', "passEnforcement.getState() !== 'idle'", '_cwTxLockoutUntilMs', 'listenSdr.live && listenSdr.auto', 'ownTxPrivilegeRefused(', 'jtcatAnyTxActive()', "radioOwner !== 'none'", 'return tciRig.txRefusal(kind);']) {
    assert.ok(g.includes(want), want);
  }
});

test('ECHOCAT voice: the TCI branch answers first, refusals release the phone', () => {
  const ptt = MAIN.slice(MAIN.indexOf("remoteServer.on('ptt', ({ state }) => {"));
  const head = ptt.slice(0, 3000);
  assert.match(head, /noteRemoteTxPress\(!!state\);[\s\S]*?if \(tciRigTarget\(\)\) \{\s*const why = tciRigVoicePtt\(!!state\);/, 'after the press diagnostic, before the FT8 guard');
  assert.ok(head.indexOf('tciRigVoicePtt') < head.indexOf('state === false && ft8Engine && ft8Engine._txActive'));
  assert.match(head, /remoteServer\.forcePttRelease\(why\);/);
  const chunk = MAIN.slice(MAIN.indexOf("ipcMain.on('dax-tx-chunk', (_e, buf) => {"));
  assert.match(chunk.slice(0, 400), /if \(tciRigTarget\(\) && settings\.audioSource === 'tci'\) \{ tciRigVoiceChunk\(buf\); return; \}/);
  for (const stop of ["tciRig.stopVoiceTx('ECHOCAT disconnected')", "tciRig.stopVoiceTx('ECHOCAT audio window closed')", "tciRig.stopVoiceTx('ECHOCAT audio stopped')"]) {
    assert.ok(MAIN.includes(stop), stop);
  }
  assert.match(MAIN, /\(settings\.audioSource === 'tci' && !!tciRigTarget\(\)\) \|\|/, 'the bridge sends the mic as chunks');
});

test('the SWR guard stops a TCI over', () => {
  const m = fnBody(MAIN, 'function tciRigTxMeter(kind, value) {');
  assert.match(m, /if \(verdict === 'over' && \+\+_swrGuardHits >= 3\) \{\s*tciRig\.stopAllTx\('SWR guard tripped'\);\s*tripSwrGuard\(value\);/);
});

test('a drive percent is never logged or capped as watts', () => {
  const save = MAIN.slice(MAIN.indexOf('async function saveQsoRecord('));
  assert.match(save.slice(0, 20000), /const w = tciRigTarget\(\)\s*\? \(tciMeasuredWattsForLog\(\) \|\| LogTxPower\.operatorDefaultPower\(ops\) \|\| 0\)\s*: LogTxPower\.txPowerForLog\(\{ knownW: _currentTxPower, defaultW: LogTxPower\.operatorDefaultPower\(ops\) \}\);/, 'a CAT rig logs as before; a TCI rig logs measured watts');
  const caps = fnBody(MAIN, 'function getRigCapabilities(rigType) {');
  assert.match(caps, /if \(ampLimitW > 0 && caps\.powerUnit === '%'\) \{[\s\S]*?caps\.maxPower = Math\.max\(1, tciDriveCapPct\(\) \|\| 100\);/);
  assert.match(fnBody(MAIN, 'function tciDriveCapPct() {'), /return AmpDrive\.currentFlexPctLimit\(\);/);
  // The cap in percent never lands above the watts asked for (rounded down; 100 W assumed when unknown).
  assert.equal(AmpDrive.flexPctLimit(2, 5), 40);
  assert.equal(AmpDrive.flexPctLimit(2, 0), 2);
  const beacon = fnBody(MAIN, 'function setWsprBeacon(on, opts = {}) {');
  assert.match(beacon, /if \(tciRigTarget\(\)\) \{[\s\S]*?tellPopout\(false\);\s*return;\s*\}/, 'the watts-capped beacon is off on TCI');
});

test('a TCI rig shows drive in percent; Thetis has no drive control', () => {
  const caps = fnBody(MAIN, 'function tciRigCaps() {');
  assert.match(caps, /txpower: !\(rig && rig\.isThetis\), powerUnit: '%'/);
  assert.match(fnBody(MAIN, 'function jtcatPopoutRigPowerPayload() {'), /powerUnit: caps\.powerUnit === '%' \? '%' : 'W'/);
  const view = require('../lib/rig-power-view');
  assert.equal(view.powerView({ watts: 40, known: true, capable: true, settable: true, powerUnit: '%' }).label, '40%');
  assert.equal(view.powerView({ watts: 40, known: true, capable: true, settable: true }).label, '40W');
});
