#!/usr/bin/env node
'use strict';
// boblk9tc (ECHOCAT Web, 2026-10-29): "When I get a partial decode it stays
// locked on receive, I am not able to get the send tab." Progress set the page
// to Receiving with SEND disabled, and only a finished picture cleared it. A
// decode that ended with no picture (lock lost, quality gate) never reached
// ECHOCAT, and the server kept handing the stale progress to new clients.
// Run: node test/sstv-rx-ended-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8').replace(/\r\n/g, '\n');

let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push([name, fn]); }
console.log('SSTV decode that ends with no picture');

test('the server clears its cached progress and tells every client', () => {
  const { RemoteServer } = require('../lib/remote-server');
  const sent = [];
  const fake = Object.create(RemoteServer.prototype);
  fake._sstvProgress = { progress: 0.4, line: 100, totalLines: 256, mode: 'decoding' };
  fake.hasClient = () => true;
  fake._sendToAll = (m) => sent.push(m);
  fake.broadcastSstvRxEnded({ reason: 'lock-lost' });
  assert.strictEqual(fake._sstvProgress, null, 'a client connecting later is not put back into Receiving');
  assert.deepStrictEqual(sent, [{ type: 'sstv-rx-ended', reason: 'lock-lost' }]);
});

test('the message is in the protocol', () => {
  const P = read('lib/echocat-protocol.js');
  assert.ok(/'sstv-rx-ended': \{ dir: Dir\.S2C, feature: 'sstv'/.test(P));
});

test('main ends it on lock-lost and on a quality-gate discard', () => {
  const main = read('main.js');
  const lock = main.slice(main.indexOf("sstvEngine.on('rx-lock-lost'"), main.indexOf("sstvEngine.on('rx-lock-lost'") + 600);
  assert.ok(/remoteServer\.broadcastSstvRxEnded\(\{ reason: 'lock-lost' \}\)/.test(lock));
  const dbg = main.slice(main.indexOf("sstvEngine.on('rx-debug'"), main.indexOf("sstvEngine.on('rx-debug'") + 1200);
  assert.ok(/discarded[\s\S]*remoteServer\.broadcastSstvRxEnded\(\{ reason: 'discarded' \}\)/.test(dbg));
});

// The web page: run its real end/stale functions against fake elements.
test('the web page leaves Receiving on sstv-rx-ended, and on 20 s of silence from an older shack', async () => {
  const web = read('renderer/remote.js');
  assert.ok(/case 'sstv-rx-ended':\s*sstvPhoneEndRx\(\);/.test(web));
  assert.ok(/sstvPhoneRxActive = true;\s*sstvPhoneArmRxStale\(\);/.test(web), 'progress arms the stale timer');
  const a = web.indexOf('var SSTV_RX_STALE_MS');
  const b = web.indexOf('  function sstvPhoneUpdateSendBtn()');
  const c = web.indexOf('\n  }\n', b) + 4;
  const src = web.slice(a, b) + web.slice(b, c);
  const btn = { style: {}, textContent: '' };
  const status = { style: {}, textContent: '' };
  const decode = { style: {}, textContent: '' };
  const ctx = new Function('sstvSendBtn', 'sstvPhoneStatus', 'sstvPhoneDecodeStatus', 'setTimeout', 'clearTimeout',
    'var sstvPhoneRxActive = false;\n' + src.replace('var SSTV_RX_STALE_MS = 20000;', 'var SSTV_RX_STALE_MS = 30;') +
    '\nreturn { start: function () { sstvPhoneRxActive = true; sstvPhoneArmRxStale(); sstvPhoneUpdateSendBtn(); }, end: sstvPhoneEndRx, active: function () { return sstvPhoneRxActive; } };')(btn, status, decode, setTimeout, clearTimeout);
  ctx.start();
  assert.strictEqual(btn.textContent, 'RX...');
  ctx.end();
  assert.strictEqual(ctx.active(), false);
  assert.strictEqual(btn.textContent, 'SEND');
  ctx.start();
  await new Promise((r) => setTimeout(r, 80));
  assert.strictEqual(ctx.active(), false, 'stale progress ends Receiving');
  assert.strictEqual(btn.textContent, 'SEND');
});

(async () => {
  for (const [name, fn] of queue) {
    try { await fn(); passed++; console.log('  ok  ' + name); }
    catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
