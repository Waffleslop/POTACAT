#!/usr/bin/env node
'use strict';
// Halt TX stops the transmission, on every surface (droidbot2 2026-10-31:
// "Halt TX does NOT stop PTT ... once a message starts, there is no way to stop
// it").
//
// There were three halts doing three different things, and none of them could
// stop the tones: on the sound-card route the main window played the whole 13 s
// buffer whatever was pressed, so a radio keyed by its audio stayed on the air.
// Now every entry point goes to main.js jtcatHaltTxNow(), which also tells the
// main window to stop the buffer (jtcat-tx-abort). These assertions keep it so.
// Run: node test/halt-tx-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const MAIN = read('main.js');
const APP = read('renderer/app.js');
const PRELOAD = read('preload.js');
const POPOUT = read('renderer/jtcat-popout.js');
const POPOUT_PRELOAD = read('preload-jtcat-popout.js');
const REMOTE = read('renderer/remote.js');

function fnBody(src, header) {
  const i = src.indexOf(header);
  assert.ok(i >= 0, 'missing: ' + header);
  // The body opens at the first '{' after the parameter list closes (a
  // default like `opts = {}` must not be taken for it).
  const close = src.indexOf(') {', i);
  let depth = 0, j = close >= 0 && close - i < 200 ? close + 2 : src.indexOf('{', i);
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') { depth--; if (depth === 0) return src.slice(j, k + 1); }
  }
  throw new Error('unbalanced: ' + header);
}

const HALT = fnBody(MAIN, 'function jtcatHaltTxNow(');

test('the desktop Halt TX goes to the one halt', () => {
  assert.ok(/ipcMain\.on\('jtcat-halt-tx', \(\) => \{ jtcatHaltTxNow\(/.test(MAIN));
  assert.strictEqual((MAIN.match(/ipcMain\.on\('jtcat-halt-tx'/g) || []).length, 1, 'a second jtcat-halt-tx handler');
});

test('the phone and web Halt go to the one halt', () => {
  assert.ok(/remoteServer\.on\('jtcat-halt-tx', \(\) => jtcatHaltTxNow\(/.test(MAIN));
  assert.ok(/type: 'jtcat-halt-tx'/.test(REMOTE), 'the web page Halt no longer sends jtcat-halt-tx');
});

test('Guest Pass end uses the one halt', () => {
  assert.ok(/step\('JTCAT TX', \(\) => \{[^\n]*jtcatHaltTxNow\(/.test(MAIN));
});

test('a QSO cancelled mid-transmission stops the radio, keeping Run and Hunt', () => {
  const body = fnBody(MAIN, "ipcMain.on('jtcat-popout-cancel-qso'");
  assert.ok(/if \(wasTx\) jtcatHaltTxNow\([^)]*keepAuto: true/.test(body));
});

test('the JTCAT window Halt, PSK31 Stop and JTTY Stop all call jtcatHaltTx', () => {
  const halt = fnBody(POPOUT, "haltTxBtn.addEventListener('click'");
  assert.ok(/window\.api\.jtcatHaltTx\(\)/.test(halt), 'the Halt TX button only cancels the QSO');
  assert.ok(/pskStopBtn\.addEventListener\('click', function\(\) \{\s*window\.api\.jtcatHaltTx\(\)/.test(POPOUT));
  assert.ok(/jttyStopBtn\.addEventListener\('click', function\(\) \{ window\.api\.jtcatHaltTx\(\)/.test(POPOUT));
  assert.ok(/jtcatHaltTx: \(\) => ipcRenderer\.send\('jtcat-halt-tx'\)/.test(POPOUT_PRELOAD));
});

test('the halt stops the tones on every route', () => {
  assert.ok(/send\('jtcat-tx-abort'/.test(HALT), 'main window buffer not told to stop');
  assert.ok(/smartSdrAudio\.cancelTx\(\)/.test(HALT), 'Flex DAX stream not cancelled');
  assert.ok(/forceReleaseIcomNetworkTx\(/.test(HALT) && /_icomNetworkTransport\.cancelTx\(\)/.test(HALT), 'Icom network not cancelled');
  assert.ok(/stopJtcatTune\(\)/.test(HALT), 'tune tone not stopped');
  assert.ok(/clearJtcatTxFailsafe\(\)/.test(HALT));
});

test('the halt releases PTT on every route', () => {
  assert.ok(/handleRemotePtt\(false\)/.test(HALT));
  assert.ok(/gatedSetTransmit\(false\)/.test(HALT), 'no direct CAT un-key');
  assert.ok(/gatedSmartSdrTransmit\(false\)/.test(HALT), 'no direct Flex un-key');
  assert.ok(/releaseRadio\('jtcat'\)/.test(HALT));
  assert.ok(/broadcastJtcatTxStatus\(\{ state: 'rx' \}\)/.test(HALT), 'phones keep showing ON AIR');
});

test('the halt stands down every automatic transmitter unless told to keep them', () => {
  assert.ok(/if \(!opts\.keepAuto\) try \{ if \(jtcatFullAutoCq\) \{ stopFullAutoCq\(/.test(HALT), 'Run');
  assert.ok(/if \(!opts\.keepAuto\) try \{[^\n]*setJtcatHuntMode\('off'\)/.test(HALT), 'Hunt');
  assert.ok(/if \(!opts\.keepAuto\) try \{[^\n]*setWsprBeacon\(false/.test(HALT), 'WSPR beacon');
});

test('every engine is halted, multi-slice included', () => {
  assert.ok(/for \(const id of jtcatManager\.sliceIds\)/.test(HALT));
  assert.ok(/eng\._txEnabled = false/.test(HALT) && /eng\.txComplete\(\)/.test(HALT));
});

test('the failsafe cuts the tones too', () => {
  const fs_ = fnBody(MAIN, 'function armJtcatTxFailsafe(');
  assert.ok(/send\('jtcat-tx-abort', 'failsafe'\)/.test(fs_));
});

test('the main window exposes the abort and keeps a handle on the playing source', () => {
  assert.ok(/onJtcatTxAbort: \(cb\) => ipcRenderer\.on\('jtcat-tx-abort'/.test(PRELOAD));
  const play = fnBody(APP, 'async function playJtcatTxAudio(');
  assert.ok(/jtcatTxActiveSource = source;/.test(play));
  assert.ok(/jtcatTxAbortFinish = finishTx;/.test(play));
});

// Behaviour: run the real abort handler from renderer/app.js against a fake
// buffer source. It must stop the source, drop PTT through finishTx, and not
// throw when nothing is playing.
function loadAbortHandler() {
  const start = APP.indexOf('if (window.api.onJtcatTxAbort) window.api.onJtcatTxAbort(function(reason) {');
  assert.ok(start >= 0, 'abort handler missing');
  const body = fnBody(APP.slice(start), 'function(reason)');
  let handler = null;
  const logs = [];
  const ctx = {
    jtcatTxActiveSource: null, jtcatTxAbortFinish: null, jtcatTxPlaying: true,
    window: { api: { onJtcatTxAbort: (cb) => { handler = cb; }, jtcatLog: (l) => logs.push(l) } },
    stopJtcatTuneAudio: () => { ctx.tuneStopped = true; },
  };
  vm.createContext(ctx);
  vm.runInContext('window.api.onJtcatTxAbort(function(reason) ' + body + ');', ctx);
  return { ctx, run: (r) => vm.runInContext('void 0', ctx) || handler(r), logs };
}

test('abort stops a playing source and drops PTT once', () => {
  const { ctx, run, logs } = loadAbortHandler();
  const src = { stopped: false, disconnected: false, onended: () => {}, stop() { this.stopped = true; }, disconnect() { this.disconnected = true; } };
  let finished = 0;
  ctx.jtcatTxActiveSource = src;
  ctx.jtcatTxAbortFinish = () => { finished++; };
  run('Halt TX (JTCAT window)');
  assert.ok(src.stopped, 'source not stopped');
  assert.ok(src.disconnected, 'source not disconnected');
  assert.strictEqual(src.onended, null, 'onended left armed (double completion)');
  assert.strictEqual(finished, 1, 'PTT not dropped through finishTx');
  assert.strictEqual(ctx.jtcatTxPlaying, false);
  assert.ok(ctx.tuneStopped, 'tune tone left playing');
  assert.ok(logs.some(l => /Audio stopped mid-message \(Halt TX/.test(l)), 'no log line');
});

test('abort with nothing playing is harmless', () => {
  const { ctx, run } = loadAbortHandler();
  run('failsafe');
  assert.strictEqual(ctx.jtcatTxPlaying, false);
});

test('abort survives a source that was never started', () => {
  const { ctx, run } = loadAbortHandler();
  ctx.jtcatTxActiveSource = { stop() { throw new Error('InvalidStateError'); }, disconnect() {} };
  ctx.jtcatTxAbortFinish = () => {};
  run('halt');
  assert.strictEqual(ctx.jtcatTxActiveSource, null);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
