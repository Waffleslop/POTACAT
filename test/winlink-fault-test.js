#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
// A throw from a Winlink session's sockets or child processes ends that
// session with the error on screen instead of POTACAT's crash dialog
// (artificialjump, packet Send/Receive, 2026-10-31).
// Run: node test/winlink-fault-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { isWinlinkSessionFault } = require('../lib/winlink-fault');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
const errAt = (frame) => { const e = new TypeError('Cannot read properties of undefined'); e.stack = `TypeError: Cannot read properties of undefined\n    at ${frame}\n    at Socket.emit (node:events:519:28)`; return e; };

test('a throw from Winlink code during a session ends the session', () => {
  assert.ok(isWinlinkSessionFault(errAt('Socket.<anonymous> (C:\\Program Files\\POTACAT\\resources\\app.asar\\lib\\modem-audio-server.js:88:12)'), { sessionActive: true }), 'Windows path');
  assert.ok(isWinlinkSessionFault(errAt('ChildProcess.<anonymous> (/opt/POTACAT/resources/app.asar/lib/direwolf-process.js:40:3)'), { sessionActive: true }), 'Linux path');
  assert.ok(isWinlinkSessionFault(errAt('Object.winlinkFeedRx (D:\\potacat\\main.js:10501:9)'), { sessionActive: true }), 'a winlink function in main.js');
  assert.ok(isWinlinkSessionFault(errAt('Socket.onLine (D:\\potacat\\main.js:10600:5) [spawnDirewolf]'), { sessionActive: true }));
});
test('no session: the crash dialog stays (never hide a real fault)', () => {
  assert.ok(!isWinlinkSessionFault(errAt('x (C:\\app\\lib\\winlink-pat.js:1:1)'), { sessionActive: false }));
});
test('a throw from anywhere else is not swallowed during a session', () => {
  assert.ok(!isWinlinkSessionFault(errAt('RigController._poll (C:\\app\\lib\\rig-controller.js:400:5)'), { sessionActive: true }));
  assert.ok(!isWinlinkSessionFault({ message: 'no stack' }, { sessionActive: true }));
  assert.ok(!isWinlinkSessionFault(null, { sessionActive: true }));
});
test('main.js ends the session in its uncaughtException handler, before the crash dialog', () => {
  const main = readSrc(path.join(__dirname, '..', 'main.js'));
  const at = main.indexOf('_lateExceptionHandlerActive = true;');
  const h = main.slice(at, main.indexOf("app.on('window-all-closed'", at));
  const guard = h.indexOf('isWinlinkSessionFault(err, { sessionActive: winlinkSessionActive() })');
  assert.ok(guard > 0, 'guard present');
  assert.ok(guard < h.indexOf('_fatalCrashDialog(err)'), 'before the dialog');
  assert.ok(/winlinkAbortSession\(`POTACAT hit an error in the Winlink session: \$\{msg\}`\)/.test(h), 'the session ends with the reason');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
