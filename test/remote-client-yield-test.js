#!/usr/bin/env node
'use strict';
/**
 * W0EGR 2026-10-30: a headless shack PC, an office PC driving it, and ECHOCAT
 * on a phone. "When the button is clicked in Echocat it switches for a second
 * and then goes back to the remote potacat on the office computer." The
 * kicked desktop reconnected at once and took the rig straight back. A
 * kicked RemoteClient now yields: no reconnect until connect() is called.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { RemoteClient } = require('../lib/remote-client');

const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
const src = fs.readFileSync(path.join(ROOT, 'lib/remote-client.js'), 'utf8');
const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');

console.log('A kicked desktop yields');
check('"kicked" sets the yield, and the socket-close handler does not reconnect while yielded', () => {
  assert.ok(/case 'kicked': \{\s+this\._yielded = true;/.test(src));
  assert.ok(/if \(this\._yielded\) \{ this\.emit\('log', '\[RemoteClient\] yielded the rig to another device — not reconnecting until asked'\); return; \}\s+if \(!this\._closed\) this\._scheduleReconnect\(\);/.test(src));
});
check('connect() re-arms: pressing Connect takes the rig back', () => {
  assert.ok(/this\._closed = false; \/\/ re-arming\s+this\._yielded = false;/.test(src));
});
check('a fresh client is not yielded; a kicked one stops scheduling', () => {
  const c = new RemoteClient({ url: 'wss://127.0.0.1:1', token: 'x' });
  assert.strictEqual(c._yielded, false);
  let scheduled = 0;
  c._scheduleReconnect = () => { scheduled++; };
  c._yielded = true;
  // The close path, as the handler runs it:
  c.emit('disconnected', { code: 1000, reason: '', wasAuthed: true });
  if (!c._yielded && !c._closed) c._scheduleReconnect();
  assert.strictEqual(scheduled, 0);
  c._yielded = false;
  if (!c._yielded && !c._closed) c._scheduleReconnect();
  assert.strictEqual(scheduled, 1);
});
check('main.js says so in the log and names the way back', () => {
  assert.ok(/another device took the rig[\s\S]{0,120}press Connect in Remote Radios to take it back/.test(main));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
