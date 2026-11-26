#!/usr/bin/env node
'use strict';
// #1051 wiring: every idle mode goes back through one path, an operator's own
// action wins, outside tuning is activity, Idle Mode is off for a new install
// and an existing install keeps its choice. The rules themselves are in
// lib/idle-radio-return.js (test/idle-radio-return-test.js); this checks that
// main.js and the welcome screen use them.
// Run: node test/idle-mode-1051-wiring-test.js

const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');

const root = path.join(__dirname, '..');
const main = readSrc(path.join(root, 'main.js'));
const app = readSrc(path.join(root, 'renderer', 'app.js'));
const html = readSrc(path.join(root, 'renderer', 'index.html'));

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

function fnBody(src, start) {
  const i = src.indexOf(start);
  assert.ok(i >= 0, 'found ' + start);
  const j = src.indexOf('\n}\n', i);
  return src.slice(i, j > 0 ? j : i + 8000);
}

// ── the default ──────────────────────────────────────────────────────────────

test('welcome screen: the Idle Mode box is not ticked in the HTML (new installs get it off)', () => {
  const m = html.match(/<input[^>]*id="welcome-enable-auto-sstv"[^>]*>/);
  assert.ok(m, 'the box exists');
  assert.ok(!/\bchecked\b/.test(m[0]), m[0]);
});

test('welcome screen reopened: ticked only when the saved setting is true (unset stays off, as it runs)', () => {
  assert.ok(/getElementById\('welcome-enable-auto-sstv'\)\.checked = s\.enableAutoSstv === true;/.test(app));
  assert.ok(!/welcome-enable-auto-sstv'\)\.checked = s\.enableAutoSstv !== false/.test(app));
});

test('a fresh install writes Idle Mode off; nothing at startup turns it on for anyone', () => {
  const fresh = main.match(/return \{ grid: 'FN20jb', catTarget: null,[^\n]*\};/);
  assert.ok(fresh, 'fresh-install defaults');
  assert.ok(/enableAutoSstv: false/.test(fresh[0]), fresh[0]);
  assert.ok(!/settings\.enableAutoSstv = true/.test(main), 'no migration flips anyone on');
  assert.ok(!/enableAutoSstv: true/.test(main));
});

test('the timer only runs on a saved true (an existing choice is kept either way)', () => {
  assert.ok(/function startAutoSstvTimer\(\) \{\s*stopAutoSstvTimer\(\);\s*if \(!settings\.enableAutoSstv\) return;/.test(main));
  assert.ok(/getElementById\('set-enable-auto-sstv'\)\.checked = s\.enableAutoSstv === true;/.test(app));
});

test('the Settings Summary names Idle Mode and its program, not "Auto-SSTV"', () => {
  assert.ok(!/s\.enableAutoSstv && 'Auto-SSTV'/.test(app));
  assert.ok(/s\.enableAutoSstv && \('Idle Mode /.test(app));
});

// ── one restore path ─────────────────────────────────────────────────────────

test('every idle mode that moves the radio saves its place first, through the one path', () => {
  const t = fnBody(main, 'function triggerAutoSstv() {');
  const begin = t.indexOf('idleRxBegin(');
  assert.ok(begin > 0, 'idleRxBegin in triggerAutoSstv');
  for (const marker of ["if (idleMode === 'js8')", "if (idleMode === 'wspr' || idleMode === 'psk31' || idleMode === 'jtty')", 'autoSstvPrevFreq = _currentFreqHz']) {
    const k = t.indexOf(marker);
    assert.ok(k > 0, marker);
  }
  // APRS idle keeps its own return (lib/aprs-radio-return.js); every other branch begins after APRS returns.
  assert.ok(begin > t.indexOf("if (idleMode === 'aprs')"), 'begin comes after the APRS branch');
  assert.ok(begin < t.indexOf("if (idleMode === 'js8')"), 'and before the first branch that tunes');
});

test('cancelAutoSstv puts the radio back through idleRxRestore in the SSTV, JTCAT and JS8 branches', () => {
  const c = fnBody(main, 'function cancelAutoSstv(');
  const n = (c.match(/idleRxRestore\(/g) || []).length;
  assert.ok(n >= 3, 'three branches, found ' + n);
  assert.ok(!/cat\.tune\(autoSstvPrevFreq/.test(c), 'the SSTV-only CAT retune is gone (it never reached a Flex Direct slice)');
  // SSTV: back on frequency before the window closes (#525 order).
  assert.ok(c.indexOf('idleRxRestore(') < c.indexOf('sstvPopoutWin.close()'));
});

test('an operator action ends idle without a snap back: spot click, ECHOCAT tune, PTT, the radio keyed, JTCAT start', () => {
  const m = fnBody(main, 'function markUserActive(opts) {');
  assert.ok(/cancelAutoSstv\(\{ operatorTook: opts && opts\.operatorTook \}\)/.test(m));
  const i = main.indexOf("ipcMain.on('tune', (_e, { frequency, mode, bearing, slicePort, origin, pickSideband }) => {");
  assert.ok(i > 0);
  assert.ok(/operatorTook:/.test(main.slice(i, i + 700)), 'the tune IPC');
  const r = main.indexOf("remoteServer.on('tune', ({ freqKhz, mode, bearing, channelId, pickSideband }) => {");
  assert.ok((main.slice(r, r + 1400).match(/operatorTook:/g) || []).length >= 2, 'the ECHOCAT tune and channel');
  assert.ok(/idleRxOperatorTook\('a transmit started'\)/.test(fnBody(main, 'function handleRemotePtt(state, opts = {}) {')), 'PTT');
  assert.ok(/idleRxOperatorTook\(/.test(fnBody(main, 'function txNoteRadioPtt(controller, on) {')), 'the radio keyed by hand');
  assert.ok(/cancelAutoSstv\(\{ operatorTook: 'JTCAT started' \}\)/.test(fnBody(main, 'function startJtcat(mode) {')), 'JTCAT start over SSTV idle');
  // APRS on idle: its own return is dropped, not run, under an operator's action.
  const c = fnBody(main, 'function cancelAutoSstv(');
  const a = c.indexOf('if (owned && operatorTook) {');
  assert.ok(a > 0 && /aprsReturn\.drop\(\);/.test(c.slice(a, a + 200)), 'APRS idle');
  assert.ok(a < c.indexOf("aprsListenStop('the radio was used')"), 'dropped before listening stops');
});

test('a dial readback feeds the watch: outside tuning during idle ends it, and before idle restarts the countdown', () => {
  assert.ok(/idleRxOnDial\(/.test(fnBody(main, 'function sendCatFrequency(hz) {')));
  assert.ok(/idleRxNoteActivity\(/.test(fnBody(main, 'function sendCatMode(mode) {')));
  const d = fnBody(main, 'function idleRxOnDial(');
  assert.ok(/idleReturn\.watch\(/.test(d));
  assert.ok(/idleReturn\.onReadback\(/.test(d));
  assert.ok(/lastActivityTime = Date\.now\(\)/.test(fnBody(main, 'function idleRxNoteActivity(')));
  // A poll paused for inactivity is resumed and the radio read once more before Idle Mode starts.
  const t = fnBody(main, 'function startAutoSstvTimer() {');
  const r = t.indexOf('cat.resumePolling();');
  assert.ok(r > 0 && r < t.indexOf('triggerAutoSstv();'), 'read the radio, then start on the next tick');
  assert.ok(/if \(autoSstvActive \|\| _idleRxCheckingRadio\) return;/.test(fnBody(main, 'function startIdlePauseTimer() {')), 'no pause during idle or the check');
});

test('the session\'s own tunes are noted as idle dials (tuneRadio while idle runs, the SSTV CAT tunes)', () => {
  const t = fnBody(main, 'function tuneRadio(freqKhz, mode, brng, { clearXit, origin, purpose } = {}) {');
  assert.ok(/idleReturn\.noteDial\(freqHz\)/.test(t));
  const s = fnBody(main, 'function startAutoSstvTimer() {');
  assert.ok(/idleReturn\.noteDial\(newBand\.freqKhz \* 1000\)/.test(s), 'the SSTV sunrise change');
});

test('quit during idle: the radio goes back while the CAT link is still open', () => {
  const g = fnBody(main, 'function gracefulCleanup(');
  const q = g.indexOf('idleRxEndAtQuit()');
  assert.ok(q > 0);
  assert.ok(q < g.indexOf('cat.disconnect()'));
});

test('the place is a machine key, written to disk before the radio moves', () => {
  assert.ok(/^\s*'idleRxReturn',/m.test(main));
});

// ── nothing transmits ────────────────────────────────────────────────────────

test('the band-change ATU tune never keys for the return, nor for a receive-only idle tune', () => {
  const { bandChangeAtu } = require('../lib/wspr/bandhop');
  assert.strictEqual(bandChangeAtu({ enableAtu: true, band: '20m', lastBand: '40m', restore: true, beaconTx: true }).action, 'skip');
  assert.strictEqual(bandChangeAtu({ enableAtu: true, band: '20m', lastBand: '40m', receiveOnly: true }).action, 'skip');
  assert.strictEqual(bandChangeAtu({ enableAtu: true, band: '20m', lastBand: '40m' }).action, 'tune', 'an operator tune is unchanged');
  const b = fnBody(main, 'function bandChangeAtuTune(');
  assert.ok(/restore: purpose === 'idle-restore'/.test(b));
  assert.ok(/receiveOnly: purpose === 'idle-rx'/.test(b));
});

test('the return never sends atu clear or EX040101', () => {
  const lib = readSrc(path.join(root, 'lib', 'idle-radio-return.js'));
  const gi = main.indexOf('const idleReturn = IdleRadioReturn.createIdleReturn(');
  assert.ok(gi > 0, 'the glue');
  const glue = main.slice(gi, main.indexOf('\n});\n', gi));
  for (const s of [lib, glue]) {
    assert.ok(!/atu clear/i.test(s));
    assert.ok(!/EX040101/.test(s));
  }
});

// ── review fixes (2026-11-25) ────────────────────────────────────────────────

test('tuneRadio: a tune from outside the session (logger, Winlink, scan) ends idle instead of becoming an idle dial', () => {
  const b = fnBody(main, 'function tuneRadio(');
  assert.ok(/IdleRadioReturn\.tuneDuringIdle\(\{ origin, purpose \}\)/.test(b), 'asks the lib');
  assert.ok(/whose === 'outside'\)\s*\{\s*markUserActive\(\{ operatorTook:/.test(b), 'outside: the operator took the radio');
  assert.ok(/whose === 'own'\)\s*\{\s*idleReturn\.noteDial\(freqHz\)/.test(b), 'own: an idle dial');
});

test('a mode chosen on ECHOCAT or in the VFO window ends idle with no return over it', () => {
  const ei = main.indexOf("remoteServer.on('set-mode'");
  assert.ok(/markUserActive\(\{ operatorTook: 'a mode chosen on ECHOCAT' \}\)[\s\S]*tuneRadio\(/.test(main.slice(ei, ei + 900)));
  const vi = main.indexOf("ipcMain.on('vfo-set-mode'");
  assert.ok(/markUserActive\(\{ operatorTook: 'a mode chosen in the VFO window' \}\)[\s\S]*tuneRadio\(/.test(main.slice(vi, vi + 900)));
});

test('the return goes to the radio idle used only (rigId), and its filter width never lands over a later tune', () => {
  assert.ok(/idleReturn\.end\(\{[^}]*rigId: settings\.activeRigId/.test(fnBody(main, 'function idleRxRestore(')));
  const gi = main.indexOf('const idleReturn = IdleRadioReturn.createIdleReturn(');
  const glue = main.slice(gi, main.indexOf('\n});\n', gi));
  assert.ok(/const returnTuneAt = _lastTuneTime;/.test(glue));
  assert.ok(/if \(_lastTuneTime !== returnTuneAt \|\| !IdleRadioReturn\.near\(_currentFreqHz, place\.freqHz\)\) return;/.test(glue));
});

test('the operator taking the radio after idle: the band-change ATU is judged from the band before idle', () => {
  assert.ok(/_idlePreAtuBand = _lastTuneBand;/.test(fnBody(main, 'function idleRxBegin(')));
  const c = fnBody(main, 'function cancelAutoSstv(');
  assert.ok(/idleReturn\.operatorTook\(operatorTook, _currentFreqHz\);[\s\S]{0,500}_lastTuneBand = _idlePreAtuBand;\s*_atuOwedTune = null;/.test(c));
});

test('a running scan holds Idle Mode off', () => {
  assert.ok(/if \(!autoSstvActive && scanStateNow\(\)\) lastActivityTime = Date\.now\(\);/.test(fnBody(main, 'function startAutoSstvTimer(')));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
