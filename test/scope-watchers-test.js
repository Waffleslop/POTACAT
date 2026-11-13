#!/usr/bin/env node
'use strict';
// #358: the shack's band scope counts each remote device watching it. One
// device leaving its scope view (or disconnecting) used to clear a shared
// "a remote device is watching" switch and stop the scope for every other
// device. Now:
//   - lib/scope-watchers.js: one entry per device; the scope runs while any
//     device watches; the digital view (Flex) the same way
//   - real RemoteServer + two RemoteClients over loopback WSS: one leaves,
//     the other still gets frames; both leave, the scope stops; a device
//     whose connection drops without saying goodbye is removed
//   - main.js: every scope listener inside onRemoteServer, the flags follow
//     the watchers
// Run: node test/scope-watchers-test.js
const assert = require('assert');
const path = require('path');
const { X509Certificate } = require('crypto');
const { createScopeWatchers } = require('../lib/scope-watchers');
const { readSrc } = require('./_src');

let passed = 0, failed = 0;
function check(cond, label) {
  if (cond) { passed++; console.log('  ok  ' + label); }
  else { failed++; console.log('  FAIL ' + label); }
}
function unit(label, fn) {
  try { fn(); check(true, label); } catch (e) { check(false, label + '\n       ' + (e && e.message)); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── the pure counter ──────────────────────────────────────────────────
console.log('lib/scope-watchers.js');
unit('two devices: one leaving keeps the scope; the last leaving stops it', () => {
  const w = createScopeWatchers();
  assert.deepStrictEqual(w.summary(), { wants: false, digital: false, guest: false, count: 0 });
  assert.strictEqual(w.subscribe('c1', { on: true }).wants, true);
  assert.strictEqual(w.subscribe('c2', { on: true }).count, 2);
  const s = w.subscribe('c1', { on: false });
  assert.strictEqual(s.wants, true, 'c2 still watching');
  assert.strictEqual(s.count, 1);
  assert.strictEqual(w.subscribe('c2', { on: false }).wants, false, 'the last one out stops it');
});
unit('a device saying on twice is still one device; off from a device never on changes nothing', () => {
  const w = createScopeWatchers();
  w.subscribe('c1', { on: true }); w.subscribe('c1', { on: true });
  assert.strictEqual(w.count(), 1);
  assert.strictEqual(w.subscribe('c9', { on: false }).wants, true, 'a stranger cannot switch it off');
});
unit('a device whose connection is gone is removed, goodbye said or not', () => {
  const w = createScopeWatchers();
  w.subscribe('c1', { on: true }); w.subscribe('c2', { on: true });
  assert.strictEqual(w.remove('c1').wants, true);
  assert.strictEqual(w.has('c1'), false);
  assert.strictEqual(w.remove('c2').wants, false);
  assert.strictEqual(w.remove('c2').wants, false, 'removing twice is harmless');
});
unit('clear: every device gone at once', () => {
  const w = createScopeWatchers();
  w.subscribe('c1', { on: true, guest: true }); w.setDigital('c1', true); w.subscribe('c2', { on: true });
  assert.deepStrictEqual(w.clear(), { wants: false, digital: false, guest: false, count: 0 });
});
unit('digital view: counted while that device watches, ends with its view or its connection', () => {
  const w = createScopeWatchers();
  assert.strictEqual(w.setDigital('c1', true).digital, false, 'asked before subscribing: not yet');
  assert.strictEqual(w.subscribe('c1', { on: true }).digital, true, 'now it watches');
  w.subscribe('c2', { on: true });
  assert.strictEqual(w.subscribe('c2', { on: false }).digital, true, 'another device leaving keeps c1\'s view');
  assert.strictEqual(w.subscribe('c1', { on: false }).digital, false, 'its scope view closed');
  w.subscribe('c1', { on: true });
  assert.strictEqual(w.summary().digital, false, 'a new view starts without the old ask');
  w.setDigital('c1', true); w.subscribe('c3', { on: true });
  assert.strictEqual(w.remove('c1').digital, false, 'its connection gone');
  assert.strictEqual(w.summary().wants, true, 'c3 still watching');
});
unit('guest: true while any watching device holds a Guest Pass', () => {
  const w = createScopeWatchers();
  w.subscribe('owner', { on: true });
  assert.strictEqual(w.subscribe('guest', { on: true, guest: true }).guest, true);
  assert.strictEqual(w.remove('guest').guest, false);
});

// ── the real server: two devices ──────────────────────────────────────
(async () => {
  require('./ws-stub-if-missing');
  const { RemoteServer } = require('../lib/remote-server');
  const { RemoteClient } = require('../lib/remote-client');
  console.log('\nRemoteServer, two devices');
  const PORT = 17421;
  const TOKEN = 'scope-watchers-token';
  const rs = new RemoteServer();
  rs.setMultiClient(true);
  // main.js in miniature: the same counter, the same events, a "helper" that
  // sends frames while anyone watches.
  const w = createScopeWatchers();
  let running = false;
  const events = [];
  const apply = (s) => { running = s.wants; };
  rs.on('scope-subscribe', ({ on, guest, clientId }) => { events.push(['sub', on, clientId]); apply(w.subscribe(clientId, { on, guest })); });
  rs.on('scope-client-gone', ({ clientId }) => { events.push(['gone', clientId]); apply(w.remove(clientId)); });
  rs.on('client-disconnected', () => { events.push(['all-gone']); apply(w.clear()); });
  let seq = 0;
  const helper = setInterval(() => { if (running) rs.broadcastScopeFrame({ bins: [1, 2, 3, 4], seq: ++seq, gapMs: 20 }); }, 25);

  rs.start(PORT, TOKEN, { requireToken: true, certDir: require('os').tmpdir() });
  await sleep(600);
  const fp = new X509Certificate(rs._tlsCertPem).fingerprint256;
  const mk = (name) => {
    const rc = new RemoteClient({ id: name, name, lanHost: `wss://127.0.0.1:${PORT}`, fingerprint: fp, deviceToken: TOKEN },
      { clientVersion: 'test', clientPlatform: name === 'phone' ? 'ios' : 'desktop-test' });
    rc.on('log', () => {}); rc.on('error', () => {});
    rc.frames = 0;
    rc.on('message', (m) => { if (m && m.type === 'scope-frame') rc.frames++; });
    return rc;
  };
  const connect = async (rc) => { await new Promise((r) => { rc.once('connected', r); rc.connect(); setTimeout(r, 6000); }); await sleep(150); };

  const phone = mk('phone'); await connect(phone);
  const laptop = mk('laptop'); await connect(laptop);
  check(rs._openClients().length === 2, 'both devices connected');

  phone.sendRaw({ type: 'scope-subscribe', on: true });
  laptop.sendRaw({ type: 'scope-subscribe', on: true });
  await sleep(200);
  const ids = events.filter((e) => e[0] === 'sub').map((e) => e[2]);
  check(ids.length === 2 && ids[0] && ids[1] && ids[0] !== ids[1], 'each subscribe carries its own device id (' + ids.join(', ') + ')');
  check(running && w.count() === 2, 'two watching, the scope runs');

  // The phone leaves its scope view; the laptop must keep getting frames.
  phone.sendRaw({ type: 'scope-subscribe', on: false });
  await sleep(150);
  check(running, 'one device left: the scope still runs');
  const before = laptop.frames;
  await sleep(400);
  check(laptop.frames > before, 'the other device still gets frames (' + (laptop.frames - before) + ' in 400 ms)');

  // The phone comes back, then its connection drops without a goodbye.
  phone.sendRaw({ type: 'scope-subscribe', on: true });
  await sleep(150);
  check(w.count() === 2, 'the phone watches again');
  const phoneWs = [...rs._clients].find((c) => c._clientPlatform === 'ios');
  check(!!phoneWs, 'found the phone\'s socket on the server');
  if (phoneWs) phoneWs.terminate();   // no scope-subscribe off, no close frame
  await sleep(400);
  check(events.some((e) => e[0] === 'gone'), 'the server says the phone\'s connection is gone');
  check(w.count() === 1 && running, 'the phone is removed; the laptop keeps the scope');
  const before2 = laptop.frames;
  await sleep(300);
  check(laptop.frames > before2, 'frames keep reaching the laptop');

  // The last device leaves its view: the scope stops.
  laptop.sendRaw({ type: 'scope-subscribe', on: false });
  await sleep(150);
  check(!running && w.count() === 0, 'both left: the scope stops');

  clearInterval(helper);
  try { phone.close(); } catch {}
  try { laptop.close(); } catch {}
  rs.stop();
  await sleep(200);

  // ── main.js wiring ───────────────────────────────────────────────────
  console.log('\nmain.js');
  const main = readSrc(path.join(__dirname, '..', 'main.js')).replace(/\r\n/g, '\n');
  const rsSrc = readSrc(path.join(__dirname, '..', 'lib', 'remote-server.js')).replace(/\r\n/g, '\n');
  check(/remoteServer\.on\('scope-subscribe', \(\{ on, guest, clientId \}\) => \{[\s\S]{0,300}scopeWatchers\.subscribe\(clientId, \{ on, guest \}\)/.test(main), 'scope-subscribe counts the device');
  check(/remoteServer\.on\('scope-client-gone'[\s\S]{0,400}scopeWatchers\.remove\(clientId\)[\s\S]{0,400}stopYaesuScope\(/.test(main), 'a device gone is removed; the scope stops after the last');
  check(/remoteServer\.on\('scope-digital-view', \(\{ on, clientId \} = \{\}\) => \{[\s\S]{0,200}scopeWatchers\.setDigital\(clientId, on\)/.test(main), 'the digital view is per device');
  const sets = main.split('\n').filter((l) => /^\s*(?!let )\S.*\byaesuScopeRemote(Wants|Digital) = /.test(l) || /^\s*yaesuScopeRemote(Wants|Digital) = /.test(l));
  check(sets.length === 2 && sets.every((l) => /= sum\.(wants|digital);/.test(l)), 'no shared on/off switch: the flags are set only from the watchers (' + sets.length + ' places)');
  // The listeners sit in the same hook as the other scope listeners (remote-server-rewire-test checks they are hooks).
  const sub = main.indexOf("remoteServer.on('scope-subscribe'");
  const gone = main.indexOf("remoteServer.on('scope-client-gone'");
  check(sub > 0 && gone > sub && gone - sub < 2000, 'scope-client-gone sits beside scope-subscribe');
  check(/_onClientGone\(ws\) \{[\s\S]{0,700}this\.emit\('scope-client-gone', \{ clientId: this\._scopeClientId\(ws\) \}\)/.test(rsSrc), 'remote-server says when a watching device\'s connection is gone');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
