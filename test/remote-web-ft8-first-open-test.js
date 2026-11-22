#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
/**
 * #249: ECHOCAT Web's FT8 tab, first open on a shack that had been idle,
 * showed an old session's decodes and a moving cycle bar, and nothing new.
 *
 * Cause: main.js fed the engine status (and decodes) to remote-server only
 * while a device was connected. The hydration cache froze at what the last
 * remote session saw ("FT8 running" + its last decodes). An idle-RX WSPR start
 * in the popout, or a stop, with nobody connected never reached it. The web
 * page hydrated "running", so opening the tab never sent jtcat-start, and the
 * engine kept decoding WSPR. Starting FT8 from the phone app was the only way
 * out.
 *
 * Rules: the status and decodes reach remote-server whether or not a client
 * is connected (it sends only when one is); every stop path tells the cache;
 * hydration sends the true status before the decode replay; the web tab
 * starts the engine on open exactly when the status says it is not running.
 *
 * Run: node test/remote-web-ft8-first-open-test.js
 */
const assert = require('assert');
const path = require('path');
const { RemoteServer } = require('../lib/remote-server');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
function fakeWs() {
  const sent = [];
  return { _authenticated: true, readyState: 1, send: (w) => { try { sent.push(JSON.parse(w)); } catch {} }, _sent: sent };
}

const MAIN = readSrc(path.join(__dirname, '..', 'main.js'));
const REMOTE = readSrc(path.join(__dirname, '..', 'renderer', 'remote.js'));
const body = (src, start) => { const i = src.indexOf(start); assert.ok(i >= 0, 'missing ' + start); return src.slice(i, src.indexOf('\n}\n', i)); };

console.log('ECHOCAT Web: FT8 on first open (#249)');

// ── remote-server: the cache follows the engine with NO client connected ─────

test('a stop with nobody connected clears the cached status and the old decodes', () => {
  const rs = new RemoteServer();
  rs.broadcastJtcatStatus({ state: 'running', mode: 'FT8' });
  rs.broadcastJtcatDecode({ time: '120000', mode: 'FT8', results: [{ text: 'CQ K3SBP FM19' }] });
  rs.broadcastJtcatStatus({ state: 'stopped' });
  const ws = fakeWs();
  rs._hydrateClient(ws);
  const st = ws._sent.find(m => m.type === 'jtcat-status');
  assert.ok(st && st.state === 'stopped', 'hydrates stopped, not the old running');
  assert.ok(!ws._sent.some(m => m.type === 'jtcat-decode-batch'), 'no stale decodes replayed');
});

test('an idle WSPR start with nobody connected hydrates as WSPR, not the old FT8', () => {
  const rs = new RemoteServer();
  rs.broadcastJtcatStatus({ state: 'running', mode: 'FT8' });
  rs.broadcastJtcatStatus({ state: 'stopped' });
  rs.broadcastJtcatStatus({ state: 'running', mode: 'WSPR' });
  const ws = fakeWs();
  rs._hydrateClient(ws);
  const st = ws._sent.find(m => m.type === 'jtcat-status');
  assert.strictEqual(st.mode, 'WSPR');
});

test('decodes heard while nobody was connected replay at connect, after the status', () => {
  const rs = new RemoteServer();
  rs.broadcastJtcatStatus({ state: 'running', mode: 'FT8' });
  for (let i = 0; i < 12; i++) rs.broadcastJtcatDecode({ time: String(120000 + i * 15), mode: 'FT8', results: [] });
  const ws = fakeWs();
  rs._hydrateClient(ws);
  const iStatus = ws._sent.findIndex(m => m.type === 'jtcat-status');
  const iBatch = ws._sent.findIndex(m => m.type === 'jtcat-decode-batch');
  assert.ok(iStatus >= 0 && iBatch > iStatus, 'status first, then the replay');
  assert.strictEqual(ws._sent[iBatch].entries.length, 10, 'the last ten cycles');
  assert.strictEqual(ws._sent[iBatch].entries[9].time, String(120000 + 11 * 15));
});

// ── main.js: nothing between the engine and the cache is gated on a client ───

test('the engine status listener feeds remote-server without a hasClient gate', () => {
  const sj = body(MAIN, 'function startJtcat(');
  const i = sj.indexOf("ft8Engine.on('status'");
  assert.ok(i >= 0);
  const listener = sj.slice(i, sj.indexOf('\n  });', i));
  assert.ok(/\n\s+if \(remoteServer\) \{\n\s+const idle = autoRxKind\(\);\n\s+remoteServer\.broadcastJtcatStatus\(idle && idle !== 'sstv' && idle !== 'js8' \? \{ \.\.\.data, idleRx: idle \} : data\);/.test(listener),
    'ungated broadcastJtcatStatus, with idleRx during an idle receive');
  assert.ok(!/hasClient\(\)\) remoteServer\.broadcastJtcatStatus/.test(listener), 'no hasClient gate');
});

test('the single-slice decode feeds remote-server without a hasClient gate', () => {
  const sj = body(MAIN, 'function startJtcat(');
  const i = sj.indexOf('remoteServer.broadcastJtcatDecode(');
  assert.ok(i >= 0);
  const before = sj.slice(sj.lastIndexOf('if (', i), i);
  assert.ok(/^if \(remoteServer\) \{/.test(before), 'guarded by remoteServer only, got: ' + before.split('\n')[0]);
});

test('the running status is re-emitted after the listeners attach', () => {
  const sj = body(MAIN, 'function startJtcat(');
  assert.ok(sj.lastIndexOf("ft8Engine.emit('status', { state: 'running'") > sj.indexOf("ft8Engine.on('status'"));
});

test('every stop tells the cache, client or not', () => {
  const b = body(MAIN, 'function stopJtcat(');
  assert.ok(/if \(remoteServer\) \{[\s\S]*?broadcastJtcatStatus\(\{ running: false \}\)[\s\S]*?\n  \}/.test(b));
});

// ── remote.js: the tab starts the engine on open exactly when it is stopped ──

test('the web FT8 tab starts the engine on open when stopped, or takes an idle receive', () => {
  assert.ok(/ft8Running = msg\.running === true \|\| msg\.state === 'running';/.test(REMOTE), 'running read from jtcat-status');
  assert.ok(/ft8IdleRx = ft8Running && msg\.idleRx \? String\(msg\.idleRx\) : null;/.test(REMOTE), 'idleRx read from jtcat-status');
  assert.ok(/if \(ft8Running && !ft8IdleRx\) ft8OwnMode = ft8Mode;/.test(REMOTE), 'an idle mode never becomes the tab\'s own');
  const i = REMOTE.indexOf("} else if (tab === 'ft8') {");
  assert.ok(i >= 0);
  const open = REMOTE.slice(i, i + 500);
  assert.ok(/if \(!ft8Running \|\| ft8IdleRx\) ft8TakeEngine\(\);/.test(open), 'tab open');
  const j = REMOTE.indexOf('function ft8TakeEngine(');
  assert.ok(j >= 0);
  const take = REMOTE.slice(j, REMOTE.indexOf('\n  }\n', j));
  assert.ok(/ft8Mode = ft8OwnMode;/.test(take) && /ft8Send\(\{ type: 'jtcat-start', mode: ft8Mode \}\);/.test(take));
});

test('a device taking an idle receive closes the idle window without takeover notices', () => {
  const i = MAIN.indexOf("remoteServer.on('jtcat-start'");
  assert.ok(i >= 0);
  const h = MAIN.slice(i, MAIN.indexOf('startJtcat(mode);', i));
  assert.ok(h.indexOf('const fromIdle = autoRxKind() && autoIdleJtcatActive;') >= 0, 'fromIdle');
  assert.ok(h.indexOf('const fromIdle') < h.indexOf('markUserActive();'), 'read before markUserActive cancels the idle receive');
  const idle = h.slice(h.indexOf('if (fromIdle'), h.indexOf('} else if (jtcatPopoutWin'));
  assert.ok(!/jtcat-owner|jtcat-takeover-notice/.test(idle));
});

test('the web page renders the hydration replay through the decode handler', () => {
  assert.ok(/case 'jtcat-decode-batch':\n\s+if \(msg\.entries\) \{\n\s+msg\.entries\.forEach\(e => ft8HandleDecode\(e\)\);/.test(REMOTE));
});

console.log(`\nECHOCAT Web FT8 first open: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
