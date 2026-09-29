#!/usr/bin/env node
'use strict';
// SSTV live receive path around the decoder (Casey 2026-09-28: "I think our
// RX is broken"). Found by tracing capture -> engine -> gallery:
//  - The mobile app's SSTV screen sends sstv-stop when it closes; the desktop
//    decoder stopped while its window still said "Listening...", and a later
//    photo or TX encode never restarted it (and an encode sent while a
//    restarted worker was spawning was dropped without a word).
//  - Idle SSTV cancelled itself: the SSTV window's own tune as it opened
//    counted as the operator, and it always landed on 14.230, night or day.
//  - The engine dropped the worker's weak / stats / redecode flags, so every
//    image was "decoded, saving to gallery", and a quality-gate reject never
//    reached the bug-report log.
// Run: node test/sstv-live-path-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { SstvEngine } = require('../lib/sstv-engine');

let passed = 0, failed = 0;
const cases = [];
function test(name, fn) { cases.push([name, fn]); }
const R = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n');
const MAIN = R('main.js');

console.log('SSTV live path');

test('an encode asked for while a restarted worker is spawning is sent when it is ready', async () => {
  const eng = new SstvEngine();
  eng.start();
  const done = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no encode-complete within 20 s')), 20000);
    eng.on('encode-complete', (d) => { clearTimeout(t); resolve(d); });
  });
  const w = 320, h = 256;
  const img = new Uint8ClampedArray(w * h * 4).fill(128);
  eng.encode(img, w, h, 'robot36'); // the worker is not ready yet
  const d = await done;
  eng.stop();
  assert.ok(d.samples.length > 48000 * 30, 'a Robot 36 transmission came back');
});

test('the engine forwards weak / stats / redecode from the worker', () => {
  const eng = new SstvEngine();
  const seen = [];
  eng.on('rx-image', (d) => seen.push(d));
  eng._onWorkerMessage({ type: 'rx-image', imageData: new Uint8ClampedArray(4), width: 1, height: 1, mode: 'martin1', weak: true, stats: { sync: 41, spread: 3 }, redecode: true });
  assert.strictEqual(seen.length, 1);
  assert.deepStrictEqual([seen[0].weak, seen[0].redecode, seen[0].stats.sync], [true, true, 41]);
});

test('a phone photo or desktop TX restarts a stopped decoder', () => {
  const photo = MAIN.slice(MAIN.indexOf("remoteServer.on('sstv-photo'"), MAIN.indexOf("remoteServer.on('sstv-photo'") + 400);
  assert.ok(/\n    if \(startSstv\) startSstv\(\);/.test(photo), 'unconditional startSstv (it restarts a stopped engine)');
  assert.ok(!/if \(!sstvEngine && startSstv\) startSstv\(\)/.test(MAIN), 'the old existence-only test is gone');
  const enc = MAIN.slice(MAIN.indexOf("ipcMain.on('sstv-encode'"), MAIN.indexOf("ipcMain.on('sstv-encode'") + 300);
  assert.ok(/startSstv\(\);/.test(enc) && !/if \(!sstvEngine\) startSstv\(\)/.test(enc));
});

test('the ECHOCAT app closing SSTV does not stop the decoder the desktop window is using', () => {
  // Since the app's explicit Stop RX (sstv-decoder-state-desktop) the rule is
  // the pure decideSstvStop; a BARE stop (older apps' tab switch) with the
  // window open still keeps the decoder, and is logged.
  const { decideSstvStop } = require('../lib/sstv-decoder-state');
  for (const openedBy of ['app', 'desktop']) {
    assert.strictEqual(decideSstvStop({ windowOpen: true, openedBy, running: true }).action, 'keep-window', 'an open SSTV window keeps the decoder');
  }
  assert.strictEqual(decideSstvStop({ windowOpen: false, running: true }).log, '[SSTV] Decoder stopped by the ECHOCAT app', 'a stop is logged');
  const stop = MAIN.slice(MAIN.indexOf("remoteServer.on('sstv-stop'"), MAIN.indexOf("remoteServer.on('sstv-stop'") + 1500);
  assert.ok(/decideSstvStop\(\{/.test(stop) && /sendCatLog\(d\.log\)/.test(stop), 'main runs the decision and logs it');
  assert.ok(/engineRunning: !!\(sstvEngine && sstvEngine\.running\)/.test(MAIN), 'the feed gate asks whether the engine RUNS, not whether it exists');
  const pop = R('renderer/sstv-popout.js');
  assert.ok(/data\.state === 'stopped'[\s\S]{0,120}Decoder stopped/.test(pop), 'the SSTV window shows a stopped decoder');
});

test('idle SSTV: the SSTV window tunes as part of the session, to the band idle SSTV chose', () => {
  const fn = MAIN.slice(MAIN.indexOf('function isIdleRxSelfAction('), MAIN.indexOf('function isIdleRxSelfAction(') + 900);
  assert.ok(/autoSstvActive && !autoIdleJtcatActive && !autoIdleJs8Active/.test(fn), 'the SSTV window counts as the session itself');
  assert.ok(/sender === sstvPopoutWin\.webContents/.test(fn));
  assert.ok(/openSstvPopout\(\{ freqKhz: autoSstvBand\.freqKhz, mode: autoSstvBand\.mode \}\)/.test(MAIN), 'the day/night band is handed to the window');
  assert.ok(/webContents\.send\('sstv-refocus-qsy', target\)/.test(MAIN), 'an already-open window gets it too');
  const pop = R('renderer/sstv-popout.js');
  assert.ok(/q\.get\('freqKhz'\)\) selectAndTune/.test(pop), 'a new window tunes to it instead of its dropdown default');
});

test('a quality-gate reject reaches the bug-report log and ends the decode', () => {
  const fn = MAIN.slice(MAIN.indexOf("sstvEngine.on('rx-debug'"), MAIN.indexOf("sstvEngine.on('rx-debug'") + 900);
  assert.ok(/\/discarded\/i\.test\(data\.detail/.test(fn));
  assert.ok(/sendCatLog\(`\[SSTV\] \$\{data\.detail\}`\)/.test(fn));
  assert.ok(/_sstvDecode = null;/.test(fn));
});

(async () => {
  for (const [name, fn] of cases) {
    try { await fn(); passed++; console.log('  ok  ' + name); }
    catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
  }
  console.log(`\nSSTV live path: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
