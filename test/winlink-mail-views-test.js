#!/usr/bin/env node
'use strict';
/**
 * The radio stays on the gateway while a phone's Mail tab is open
 * (ECHOCAT's ask 2026-11-15, Casey on the Flex 8600):
 *   - lib/winlink-mail-views.js: each device's Mail tab counted by connection,
 *     like lib/scope-watchers.js; the desktop window and devices count alike
 *   - with lib/winlink-return.js: open holds the dial after a session; close
 *     or disconnect releases it; two devices; the window and a phone together
 *   - remote-server: C2S winlink-mail-view {open}, capability, Guest Pass
 *     refused, a closed socket counts as closed
 *   - main.js: every listener inside onRemoteServer; every return decision
 *     asks winlinkMailViewOpen()
 *
 * Run: node test/winlink-mail-views-test.js
 */
require('./ws-stub-if-missing');
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const V = require('../lib/winlink-mail-views');
const R = require('../lib/winlink-return');
const protocol = require('../lib/echocat-protocol');
const { RemoteServer } = require('../lib/remote-server');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
const main = readSrc(path.join(__dirname, '..', 'main.js'));
const server = readSrc(path.join(__dirname, '..', 'lib', 'remote-server.js'));
function fnBody(src, name) {
  const i = src.indexOf(`function ${name}(`);
  assert.ok(i >= 0, `${name} exists`);
  let depth = 0;
  const j = src.indexOf(') {', i) + 2;
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}' && --depth === 0) return src.slice(i, k + 1);
  }
  throw new Error(`${name}: unbalanced`);
}

console.log('lib/winlink-mail-views.js');
test('a device counted once; off from a stranger changes nothing; remove and clear', () => {
  const v = V.createMailViews();
  assert.strictEqual(v.any(), false);
  assert.strictEqual(v.set('c1', true), 1);
  assert.strictEqual(v.set('c1', true), 1, 'open twice is one device');
  assert.strictEqual(v.set('c9', false), 1, 'a stranger cannot close it');
  assert.strictEqual(v.has('c1'), true);
  assert.strictEqual(v.remove('c1'), 0);
  assert.strictEqual(v.remove('c1'), 0, 'twice is harmless');
  v.set('a', true); v.set('b', true);
  assert.strictEqual(v.clear(), 0);
  assert.strictEqual(v.any(), false);
});
test('the desktop window and devices count alike', () => {
  assert.strictEqual(V.viewOpen({ windowOpen: false, devices: 0 }), false);
  assert.strictEqual(V.viewOpen({ windowOpen: true, devices: 0 }), true);
  assert.strictEqual(V.viewOpen({ windowOpen: false, devices: 1 }), true);
  assert.strictEqual(V.viewOpen({}), false);
  assert.strictEqual(V.atViewClose({ windowOpen: false, devices: 0 }), 'return');
  assert.strictEqual(V.atViewClose({ windowOpen: false, devices: 1 }), 'keep');
  assert.strictEqual(V.atViewClose({ windowOpen: true, devices: 0 }), 'keep');
});
test('a device gone with its tab open: wait only when it alone held a pending return', () => {
  const pending = { freqHz: 14074000 };
  assert.strictEqual(V.atDeviceGone({ windowOpen: false, devices: 0, sessionActive: false, pending }), 'wait');
  assert.strictEqual(V.atDeviceGone({ windowOpen: false, devices: 1, sessionActive: false, pending }), 'none', 'another device holds it');
  assert.strictEqual(V.atDeviceGone({ windowOpen: true, devices: 0, sessionActive: false, pending }), 'none', 'the window holds it');
  assert.strictEqual(V.atDeviceGone({ windowOpen: false, devices: 0, sessionActive: true, pending }), 'none', 'the session decides at its end');
  assert.strictEqual(V.atDeviceGone({ windowOpen: false, devices: 0, sessionActive: false, pending: null }), 'none');
  assert.ok(V.GONE_GRACE_MS >= 10000 && V.GONE_GRACE_MS <= 120000, 'long enough for a reconnect, short enough to matter');
});

// A station: the return rules of lib/winlink-return.js driven by the views,
// the way main.js wires them.
function station() {
  const views = V.createMailViews();
  const st = { dial: 7074000, windowOpen: false, pending: null, leftAt: 0, tunes: [] };
  const open = () => V.viewOpen({ windowOpen: st.windowOpen, devices: views.count() });
  function restore() {
    const act = R.atClose({ pending: st.pending, sessionActive: false, leftAtHz: st.leftAt, nowHz: st.dial });
    if (act === 'return') { st.dial = st.pending.freqHz; st.tunes.push(st.dial); }
    if (act === 'return' || act === 'moved') { st.pending = null; st.leftAt = 0; }
    return act;
  }
  return {
    st, views,
    session(gatewayHz) {
      const returnTo = { freqHz: st.dial, from: 'at Connect' };
      st.dial = gatewayHz; st.tunes.push(gatewayHz);
      const act = R.atSessionEnd({ tuned: true, returnTo, windowOpen: open() });
      if (act === 'keep') { st.pending = { ...returnTo, moved: true }; st.leftAt = st.dial; }
      else if (act === 'return') { st.dial = returnTo.freqHz; st.tunes.push(st.dial); }
      return act;
    },
    deviceOpen(id) { views.set(id, true); },
    deviceLeaves(id) { views.remove(id); return V.atViewClose({ windowOpen: st.windowOpen, devices: views.count() }) === 'keep' ? 'keep' : restore(); },
    deviceGone(id) {
      views.remove(id);
      const act = V.atDeviceGone({ windowOpen: st.windowOpen, devices: views.count(), sessionActive: false, pending: st.pending });
      return act === 'wait' ? { act, graceEnds: () => (open() ? 'keep' : restore()) } : { act };
    },
    windowCloses() { st.windowOpen = false; return V.atViewClose({ windowOpen: false, devices: views.count() }) === 'keep' ? 'keep' : restore(); },
  };
}

console.log('the return, with phones');
test('no view open: a session from a phone goes back (as before)', () => {
  const s = station();
  assert.strictEqual(s.session(14105000), 'return');
  assert.strictEqual(s.st.dial, 7074000);
});
test('a phone with its Mail tab open holds the dial on the gateway; leaving it goes back', () => {
  const s = station();
  s.deviceOpen('c1');
  assert.strictEqual(s.session(14105000), 'keep');
  assert.strictEqual(s.st.dial, 14105000, 'stays on the gateway to look at the band');
  assert.strictEqual(s.deviceLeaves('c1'), 'return');
  assert.strictEqual(s.st.dial, 7074000);
});
test('a phone that disconnects with the tab open: the dial waits, then goes back', () => {
  const s = station();
  s.deviceOpen('c1');
  s.session(14105000);
  const g = s.deviceGone('c1');
  assert.strictEqual(g.act, 'wait');
  assert.strictEqual(s.st.dial, 14105000, 'not at once');
  assert.strictEqual(g.graceEnds(), 'return');
  assert.strictEqual(s.st.dial, 7074000);
});
test('a phone that disconnects and comes back within the grace keeps the dial', () => {
  const s = station();
  s.deviceOpen('c1');
  s.session(14105000);
  const g = s.deviceGone('c1');
  s.deviceOpen('c1b'); // the reconnect says open again after auth-ok
  assert.strictEqual(g.graceEnds(), 'keep');
  assert.strictEqual(s.st.dial, 14105000);
});
test('two phones: the first leaving keeps the dial, the last goes back', () => {
  const s = station();
  s.deviceOpen('c1'); s.deviceOpen('c2');
  assert.strictEqual(s.session(14105000), 'keep');
  assert.strictEqual(s.deviceLeaves('c1'), 'keep');
  assert.strictEqual(s.st.dial, 14105000);
  assert.strictEqual(s.deviceGone('c2').act, 'wait');
});
test('the desktop window and a phone: either one alone holds the dial', () => {
  const s = station();
  s.st.windowOpen = true; s.deviceOpen('c1');
  assert.strictEqual(s.session(14105000), 'keep');
  assert.strictEqual(s.windowCloses(), 'keep', 'the phone still has its Mail tab open');
  assert.strictEqual(s.st.dial, 14105000);
  assert.strictEqual(s.deviceLeaves('c1'), 'return');
  assert.strictEqual(s.st.dial, 7074000);
  const t = station();
  t.st.windowOpen = true; t.deviceOpen('c1');
  t.session(14105000);
  assert.strictEqual(t.deviceLeaves('c1'), 'keep', 'the window still open');
  assert.strictEqual(t.deviceGone('c1').act, 'none');
  assert.strictEqual(t.windowCloses(), 'return');
});

console.log('remote-server');
function rig(opts) {
  const rs = new RemoteServer();
  const sent = [];
  const events = [];
  const ws = { _authenticated: true, readyState: 1, _clientId: 'c7', send: (x) => sent.push(JSON.parse(x)) };
  if (opts && opts.guest) ws._passSession = { code: 'PASS1' };
  rs._client = ws;
  rs._clients.add(ws);
  rs.on('winlink-mail-view', (e) => events.push(e));
  return { rs, ws, sent, events, send: (m) => rs._handleMessage(ws, m, {}) };
}
test('registered C2S with open:boolean; validates', () => {
  const m = protocol.MESSAGES['winlink-mail-view'];
  assert.ok(m, 'registered');
  assert.strictEqual(m.dir, protocol.Dir.C2S);
  assert.deepStrictEqual(Object.keys(m.fields), ['open']);
  assert.ok(protocol.validate({ type: 'winlink-mail-view', open: true }, protocol.Dir.C2S).ok);
  assert.ok(!protocol.validate({ type: 'winlink-mail-view' }, protocol.Dir.C2S).ok, 'open is required');
});
test('the shack advertises capability winlink-mail-view', () => {
  assert.ok(/'winlink-mail-view',\n/.test(server));
});
test('open and close reach main with the connection id', () => {
  const r = rig();
  r.send({ type: 'winlink-mail-view', open: true });
  r.send({ type: 'winlink-mail-view', open: false });
  assert.deepStrictEqual(r.events, [{ open: true, clientId: 'c7' }, { open: false, clientId: 'c7' }]);
});
test('a closed socket counts as closed', () => {
  const r = rig();
  r.send({ type: 'winlink-mail-view', open: true });
  r.rs._onClientGone(r.ws);
  assert.deepStrictEqual(r.events[1], { open: false, gone: true, clientId: 'c7' });
  const q = rig();
  q.rs._onClientGone(q.ws);
  assert.strictEqual(q.events.length, 0, 'a device that never opened Mail says nothing');
});
test('a Guest Pass is refused and main hears nothing', () => {
  const r = rig({ guest: true });
  r.send({ type: 'winlink-mail-view', open: true });
  assert.strictEqual(r.events.length, 0);
  assert.ok(/refused$/.test(r.sent[0].type) && r.sent[0].reason === 'guest-pass', 'told it was refused');
});
test('winlink-qsy-restore carries the connection id to main', () => {
  const r = rig();
  const got = [];
  r.rs.on('winlink-request', (e) => got.push(e));
  r.send({ type: 'winlink-qsy-restore' });
  assert.strictEqual(got[0].clientId, 'c7');
});

console.log('main.js');
test('listeners inside onRemoteServer', () => {
  const i = main.indexOf("rs.on('winlink-mail-view'");
  assert.ok(i > 0);
  const block = main.lastIndexOf('onRemoteServer((rs) => {', i);
  assert.ok(block > 0 && i - block < 1500, 'inside the Winlink onRemoteServer block');
  assert.ok(!/remoteServer\.on\('winlink-mail-view'/.test(main));
});
test('every return decision asks whether any Mail view is open', () => {
  assert.ok(/windowOpen: winlinkMailViewOpen\(\) \|\| retryWill/.test(fnBody(main, 'winlinkEndSession')));
  assert.ok(/!winlinkMailViewOpen\(\)\) _winlinkRetry\.holdsReturn = true/.test(fnBody(main, 'winlinkEndSession')));
  assert.ok(/windowOpen: winlinkMailViewOpen\(\)/.test(fnBody(main, 'winlinkReturnOnStop')));
  assert.ok(/if \(winlinkMailViewOpen\(\) \|\|/.test(fnBody(main, 'winlinkRetryReturnDial')));
  assert.ok(/devices: _winlinkMailDevices\.count\(\)/.test(fnBody(main, 'winlinkMailViewOpen')));
});
test('leaving the Mail tab drops that device, then goes back only after the last view', () => {
  const h = fnBody(main, 'winlinkHandleRemote');
  assert.ok(/case 'winlink-qsy-restore':\n[^\n]*\n\s*_winlinkMailDevices\.remove\(clientId\);\n\s*winlinkMailViewClosed\('ECHOCAT device left its Mail tab'\);/.test(h));
  assert.ok(/winlinkMailViewClosed\('window closed'\)/.test(main), 'the desktop window too');
  assert.ok(/winlinkPreviewRestore\(why\)/.test(fnBody(main, 'winlinkMailViewClosed')));
});
test('a device gone waits GONE_GRACE_MS, and a reopen cancels the wait', () => {
  const g = fnBody(main, 'winlinkMailDeviceGone');
  assert.ok(/WinlinkMailViews\.atDeviceGone\(/.test(g));
  assert.ok(/setTimeout\([\s\S]*WinlinkMailViews\.GONE_GRACE_MS\)/.test(g));
  assert.ok(/if \(winlinkMailViewOpen\(\) \|\| winlinkSessionActive\(\)\) return;/.test(g));
  assert.ok(/clearTimeout\(_winlinkMailGoneTimer\)/.test(fnBody(main, 'winlinkMailViewSet')));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
