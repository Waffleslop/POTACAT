#!/usr/bin/env node
'use strict';
// potacat-meta work/open/sstv-decoder-state-desktop.md (2026-09-28):
// the ECHOCAT app's explicit Stop RX ({type:'sstv-stop', reason:'user'}) was
// always ignored, because sstv-open opens the desktop SSTV window and a stop
// with the window open was dropped (e6326b3a). And the app could not see
// whether the decoder runs, so its own belief went stale when the window was
// closed at the desk. Now: an explicit stop closes a window the app opened,
// and S2C sstv-decoder-state reports the truth on every change and at connect.
// Run: node test/sstv-decoder-state-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { decideSstvStop, sstvDecoderState } = require('../lib/sstv-decoder-state');
const P = require('../lib/echocat-protocol');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
const R = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n');
const MAIN = R('main.js');
const RS = R('lib/remote-server.js');

console.log('SSTV decoder state');

test('stop decision table: reason x opener x window open', () => {
  const cases = [
    // reason, windowOpen, openedBy, running -> action
    ['user', true, 'app', true, 'stop-and-close'],
    ['user', true, 'desktop', true, 'keep-desktop'],
    ['user', true, null, true, 'keep-desktop'],        // opener unknown: never close the desk's window
    ['user', false, null, true, 'stop'],
    ['user', false, null, false, 'none'],
    [undefined, true, 'app', true, 'keep-window'],     // older app, tab switch: e6326b3a unchanged
    [undefined, true, 'desktop', true, 'keep-window'],
    [undefined, false, null, true, 'stop'],
    [undefined, false, null, false, 'none'],
    ['other', true, 'app', true, 'keep-window'],       // an unknown reason is not an explicit Stop RX
  ];
  for (const [reason, windowOpen, openedBy, running, want] of cases) {
    const got = decideSstvStop({ reason, windowOpen, openedBy, running }).action;
    assert.strictEqual(got, want, `reason=${reason} window=${windowOpen} openedBy=${openedBy} running=${running}: ${got}`);
  }
});

test('the log lines say what happened', () => {
  assert.strictEqual(decideSstvStop({ reason: 'user', windowOpen: true, openedBy: 'app', running: true }).log,
    '[SSTV] Decoder stopped by the ECHOCAT app (Stop RX)');
  assert.ok(/opened here at the desk/.test(decideSstvStop({ reason: 'user', windowOpen: true, openedBy: 'desktop', running: true }).log));
  assert.strictEqual(decideSstvStop({ windowOpen: false, running: false }).log, null);
});

test('state payload: openedBy only while a window is open', () => {
  assert.deepStrictEqual(sstvDecoderState({ running: true, windowOpen: true, openedBy: 'desktop' }), { running: true, windowOpen: true, openedBy: 'desktop' });
  assert.deepStrictEqual(sstvDecoderState({ running: false, windowOpen: false, openedBy: 'app' }), { running: false, windowOpen: false, openedBy: null });
  assert.deepStrictEqual(sstvDecoderState({ running: 1, windowOpen: true, openedBy: 'bogus' }), { running: true, windowOpen: true, openedBy: null });
});

test('protocol registry: sstv-stop takes a reason; sstv-decoder-state is S2C sstv', () => {
  const stop = P.MESSAGES['sstv-stop'];
  assert.ok(stop.fields && stop.fields.reason && stop.fields.reason.required === false, 'sstv-stop.reason optional string');
  const st = P.MESSAGES['sstv-decoder-state'];
  assert.ok(st, 'sstv-decoder-state missing');
  assert.strictEqual(st.dir, P.Dir.S2C);
  assert.strictEqual(st.feature, 'sstv');
  assert.strictEqual(st.fields.running.type, 'boolean');
  assert.strictEqual(st.fields.windowOpen.type, 'boolean');
  assert.strictEqual(st.fields.openedBy.required, false);
});

test('remote-server hands the reason to main', () => {
  const at = RS.indexOf("case 'sstv-stop':");
  assert.ok(/this\.emit\('sstv-stop', \{ reason: typeof msg\.reason === 'string' \? msg\.reason : undefined \}\)/.test(RS.slice(at, at + 400)),
    'the explicit Stop RX reason must reach main (a bare emit made every stop look like a tab switch)');
});

test('remote-server sends the state to the client', () => {
  const fn = RS.slice(RS.indexOf('broadcastSstvDecoderState('), RS.indexOf('broadcastSstvDecoderState(') + 500);
  assert.ok(/type: 'sstv-decoder-state'/.test(fn) && /running: !!state\.running/.test(fn) && /windowOpen: !!state\.windowOpen/.test(fn));
});

test('main: the stop handler runs the decision and always answers with the state', () => {
  const at = MAIN.indexOf("remoteServer.on('sstv-stop', ({ reason } = {})");
  assert.ok(at > 0, 'sstv-stop handler must read reason');
  const fn = MAIN.slice(at, at + 1500);
  assert.ok(/decideSstvStop\(\{/.test(fn));
  assert.ok(/d\.action === 'stop-and-close'[\s\S]{0,200}sstvPopoutWin\.close\(\)/.test(fn), 'stop-and-close closes the window');
  assert.ok(/pushSstvDecoderState\(\{ force: true \}\)/.test(fn), 'a declined Stop RX is answered with the truth');
});

test('main: who opened the window is recorded, kept while open, cleared on close', () => {
  assert.ok(/remoteServer\.on\('sstv-open'[\s\S]{0,200}openSstvPopout\(\{ openedBy: 'app' \}\)/.test(MAIN), 'sstv-open opens as app');
  const open = MAIN.slice(MAIN.indexOf('openSstvPopout = function(opts)'), MAIN.indexOf('openSstvPopout = function(opts)') + 4000);
  const reuse = open.indexOf('if (sstvPopoutWin && !sstvPopoutWin.isDestroyed()) {');
  const set = open.indexOf("sstvPopoutOpenedBy = (opts && opts.openedBy === 'app') ? 'app' : 'desktop';");
  assert.ok(reuse > 0 && set > reuse, 'an already-open window keeps its opener (set only when a new window is created)');
  assert.ok(/on\('closed', \(\) => \{\s*sstvPopoutWin = null;\s*sstvPopoutOpenedBy = null;/.test(open), 'cleared on close');
  assert.ok(/ipcMain\.on\('sstv-popout-open', \(\) => openSstvPopout\(\)\)/.test(MAIN), 'the desk menu opens as desktop');
});

test('main: the state is pushed on engine start/stop, window open/close and at connect', () => {
  assert.ok(/sstvEngine\.on\('status', \(\) => pushSstvDecoderState\(\)\)/.test(MAIN), 'engine status');
  const stopFn = MAIN.slice(MAIN.indexOf('function stopSstv()'), MAIN.indexOf('function stopSstv()') + 700);
  assert.ok(/pushSstvDecoderState\(\);/.test(stopFn), 'stopSstv');
  const conn = MAIN.slice(MAIN.indexOf("remoteServer.on('client-connected'"), MAIN.indexOf("remoteServer.on('client-connected'") + 3000);
  assert.ok(/pushSstvDecoderState\(\{ force: true \}\)/.test(conn), 'hydrated at connect');
  assert.ok(!/activity[\s\S]{0,40}sstvDecoder/.test(MAIN.slice(MAIN.indexOf('function computeActivityState'), MAIN.indexOf('function computeActivityState') + 3000)),
    'kept off activity-state');
});

test('a client disconnect never stops SSTV (the app relies on it)', () => {
  const at = MAIN.indexOf("remoteServer.on('client-disconnected'");
  assert.ok(at > 0);
  const fn = MAIN.slice(at, at + 4000).split(/\n  remoteServer\.on\(/)[0];
  assert.ok(!/stopSstv\(|sstvEngine\.stop\(/.test(fn), 'client-disconnected must not stop SSTV');
});

console.log(`\nSSTV decoder state: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
