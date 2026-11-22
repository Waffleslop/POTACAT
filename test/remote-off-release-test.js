#!/usr/bin/env node
'use strict';
// #746: with every audio window closed and ECHOCAT access turned off, POTACAT
// kept the radio's USB audio input busy; another app could not record from it
// until POTACAT quit. The bug report showed only the main window alive.
//
// FT8 or JS8 started from ECHOCAT is captured by the MAIN window
// (jtcat-start-for-remote). That capture was released only by the phone's
// Stop, or by the 60 s grace after the phone disconnects. Turning ECHOCAT off
// runs disconnectRemote(), which removes the server's listeners before it
// stops the server, so the grace never started: the engine kept running and
// the main window kept the radio's input open with no way to stop it.
//
// Run: node test/remote-off-release-test.js
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const Gate = require('../lib/jtcat-capture-gate');

const main = readSrc(path.join(__dirname, '..', 'main.js'));

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
}

test('a phone-started engine with no desktop window is stopped and its capture released', () => {
  assert.strictEqual(typeof Gate.remoteOffRelease, 'function', 'remoteOffRelease missing');
  assert.deepStrictEqual(Gate.remoteOffRelease({ engineRunning: true, desktopWindowOpen: false }),
    { stopEngine: true, releaseCapture: true });
});
test('no engine: the main window is still told to release any capture left behind', () => {
  assert.deepStrictEqual(Gate.remoteOffRelease({ engineRunning: false, desktopWindowOpen: false }),
    { stopEngine: false, releaseCapture: true });
});
test('the FT8 or JS8 window is open: the desktop owns the session, nothing is touched', () => {
  assert.deepStrictEqual(Gate.remoteOffRelease({ engineRunning: true, desktopWindowOpen: true }),
    { stopEngine: false, releaseCapture: false });
  assert.deepStrictEqual(Gate.remoteOffRelease({ engineRunning: false, desktopWindowOpen: true }),
    { stopEngine: false, releaseCapture: false });
});
test('no state given: release, never stop an engine that is not known to run', () => {
  assert.deepStrictEqual(Gate.remoteOffRelease(), { stopEngine: false, releaseCapture: true });
});

function fnBody(src, header) {
  const i = src.indexOf(header);
  assert.ok(i >= 0, 'missing: ' + header);
  const j = src.indexOf('\n}\n', i);
  return src.slice(i, j);
}

test('main.js: releasePhoneDrivenJtcat applies the rule and tells the main window', () => {
  const body = fnBody(main, 'function releasePhoneDrivenJtcat(');
  assert.ok(/JtcatCaptureGate\.remoteOffRelease\(/.test(body), 'rule not used');
  assert.ok(/jtcatPopoutWin/.test(body) && /js8PopoutWin/.test(body), 'desktop windows not checked');
  assert.ok(/stopJtcat\(\)/.test(body), 'engine not stopped');
  assert.ok(/send\('jtcat-stop-for-remote'\)/.test(body), 'main window not told to release');
});
test('main.js: ECHOCAT turned off (enableRemote off or access Off) releases the phone-driven capture', () => {
  const conn = fnBody(main, 'function connectRemote(');
  const off = conn.slice(conn.indexOf("remoteAccess === 'off'"), conn.indexOf('return;', conn.indexOf("remoteAccess === 'off'")));
  assert.ok(/releasePhoneDrivenJtcat\(\)/.test(off), 'access Off path does not release');
  assert.ok(/disconnectRemote\(\);\s*releasePhoneDrivenJtcat\(\);/.test(main), 'enableRemote off path does not release');
});
test('main.js: a plain restart of the server does not stop the phone session', () => {
  const body = fnBody(main, 'function disconnectRemote(');
  assert.ok(!/releasePhoneDrivenJtcat/.test(body), 'disconnectRemote also runs on every restart');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
