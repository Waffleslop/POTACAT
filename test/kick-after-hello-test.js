#!/usr/bin/env node
'use strict';
// A connection displaces no one until it says hello (K3SBP 2026-11-26,
// BUG-K3SBP-20261126-2CC49E): a local socket that connected with no token
// required and never introduced itself took the phone off the rig mid-FT8.
// Real RemoteServer over loopback WSS, raw `ws` sockets so each test decides
// when (and whether) to send hello:
//   - no token required, multi-client off: a socket that never says hello
//     does not displace the connected device, is not a client, has nothing it
//     sends before hello acted on (PTT), and is closed by the auth timer
//   - a socket that says hello does displace, as before; kicked names it
//     ("this computer" for a local one) and keeps the older fields
//   - token path unchanged: the paired device's name is byName
//   - over the Cloud Tunnel, byHost is cf-connecting-ip, not 127.0.0.1
// Ports 17491-17493 are this file's own. Never 7300 (the operator's live
// POTACAT) and never start(0) (a falsy port means 7300).
// Run: node test/kick-after-hello-test.js

const WebSocket = require('ws');
const { RemoteServer } = require('../lib/remote-server');

let passed = 0, failed = 0;
function check(cond, label) {
  if (cond) { passed++; console.log('  ok  ' + label); }
  else { failed++; console.log('  FAIL ' + label); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const certDir = require('os').tmpdir();

function open(port, headers) {
  const ws = new WebSocket(`wss://127.0.0.1:${port}`, { rejectUnauthorized: false, headers: headers || {} });
  const got = [];
  ws.closed = false;
  ws.on('message', (raw) => { try { got.push(JSON.parse(raw.toString('utf8'))); } catch {} });
  ws.on('close', () => { ws.closed = true; });
  ws.on('error', () => {});
  ws.got = got;
  ws.has = (type) => got.some(m => m.type === type);
  ws.first = (type) => got.find(m => m.type === type);
  return new Promise((resolve) => { ws.once('open', () => resolve(ws)); setTimeout(() => resolve(ws), 4000); });
}
function hello(ws, platform) {
  ws.send(JSON.stringify({ type: 'hello', protocolVersion: 1, clientVersion: 'test-1.0', clientPlatform: platform }));
}
function startServer(port, token, opts) {
  const rs = new RemoteServer();
  rs._serverVersion = 'test';
  rs.on('log', () => {});
  rs.start(port, token, Object.assign({ certDir, mdns: false, host: '127.0.0.1' }, opts));
  return rs;
}

(async () => {
  // ── no token required, multi-client off ──────────────────────────
  console.log('no token required (local trust), multi-client off');
  {
    const rs = startServer(17491, null, { requireToken: false });
    rs._authTimeoutMs = 1500; // the 10 s auth timer, shortened for the test
    const ptts = [];
    rs.on('ptt', (p) => ptts.push(p.state));
    await sleep(600);

    const phone = await open(17491);
    hello(phone, 'ios');
    await sleep(400);
    check(phone.has('auth-ok'), 'the phone that said hello is signed in');
    check(rs._openClients().length === 1, 'one client connected');

    // A local socket that never says hello (the 2026-11-26 report).
    const silent = await open(17491);
    await sleep(400);
    check(silent.first('auth-mode') && silent.first('auth-mode').mode === 'none', 'the silent socket is told auth-mode none, as before');
    check(!phone.has('kicked'), 'the silent socket does not displace the phone');
    check(!silent.has('auth-ok'), 'the silent socket is not signed in before its hello');
    check(rs._clients.size === 1 && rs._client && rs._client._clientPlatform === 'ios',
      'the silent socket is not counted as a client (the phone is still the client)');
    silent.send(JSON.stringify({ type: 'ptt', state: true }));
    await sleep(200);
    check(!ptts.includes(true), 'a PTT sent before hello is not acted on');
    await sleep(1400);
    check(silent.closed, 'the auth timer closes a socket that never says hello');
    check(silent.got.some(m => m.type === 'auth-fail'), 'it is told auth-fail before the close');
    check(!phone.has('kicked') && !phone.closed, 'the phone is still connected');
    check(rs._openClients().length === 1, 'still one client connected');

    // A local socket that says hello takes over, as before, and is named.
    const browser = await open(17491);
    hello(browser, 'web');
    await sleep(500);
    const k = phone.first('kicked');
    check(!!k, 'a local socket that says hello displaces the phone (multi-client off)');
    check(browser.has('auth-ok'), 'and is signed in');
    check(k && k.byName === 'this computer', 'kicked.byName is "this computer" (' + (k && k.byName) + ')');
    check(k && k.byPlatform === 'web' && k.byVersion === 'test-1.0', 'kicked keeps byPlatform and byVersion from the hello');
    check(k && /127\.0\.0\.1$/.test(k.byHost), 'kicked keeps byHost (the socket address) for a local socket (' + (k && k.byHost) + ')');
    check(k && k.reason === 'Another device took over this rig', 'kicked keeps its reason');

    phone.close(); browser.close(); rs.stop(); await sleep(300);
  }

  // ── token path unchanged ─────────────────────────────────────────
  console.log('\ntoken required');
  {
    const rs = startServer(17492, 'legacy-shared-token', { requireToken: true });
    rs.setPairedDevices([
      { id: 'd1', name: 'Casey\'s iPhone', token: 'tok-iphone-1111' },
      { id: 'd2', name: 'Casey\'s iPad', token: 'tok-ipad-2222' },
    ]);
    await sleep(600);
    const phone = await open(17492);
    hello(phone, 'ios');
    phone.send(JSON.stringify({ type: 'auth', token: 'tok-iphone-1111' }));
    await sleep(400);
    check(phone.has('auth-ok'), 'the paired phone signs in with its token');

    const silent = await open(17492);
    await sleep(300);
    check(silent.first('auth-mode') && silent.first('auth-mode').mode === 'token', 'a socket without a token is asked for one');
    check(!phone.has('kicked'), 'a socket that has not signed in displaces no one');
    silent.close();

    const ipad = await open(17492);
    hello(ipad, 'ios');
    ipad.send(JSON.stringify({ type: 'auth', token: 'tok-ipad-2222' }));
    await sleep(500);
    const k = phone.first('kicked');
    check(!!k, 'a second paired device displaces the first, as before');
    check(k && k.byName === 'Casey\'s iPad', 'kicked.byName is the paired device name (' + (k && k.byName) + ')');
    check(k && k.byPlatform === 'ios', 'kicked.byPlatform still sent');
    phone.close(); ipad.close(); rs.stop(); await sleep(300);
  }

  // ── over the Cloud Tunnel ────────────────────────────────────────
  console.log('\nover the Cloud Tunnel');
  {
    const rs = startServer(17493, null, { requireToken: false });
    rs.setPairedDevices([{ id: 'd2', name: 'Casey\'s iPad', token: 'tok-ipad-2222' }]);
    rs.setTunnelExposed(true);
    await sleep(600);
    const local = await open(17493);
    hello(local, 'desktop-test');
    await sleep(400);
    check(local.has('auth-ok'), 'a LAN-trust device is connected');

    const tunnel = await open(17493, { 'cf-ray': '8f00test-IAD', 'cf-connecting-ip': '203.0.113.7' });
    hello(tunnel, 'ios');
    await sleep(200);
    check(tunnel.first('auth-mode') && tunnel.first('auth-mode').mode === 'token', 'a tunnel visitor must present a token');
    check(!local.has('kicked'), 'it displaces no one before it signs in');
    tunnel.send(JSON.stringify({ type: 'auth', token: 'tok-ipad-2222' }));
    await sleep(500);
    const k = local.first('kicked');
    check(!!k, 'the paired tunnel device displaces the local one');
    check(k && k.byHost === '203.0.113.7', 'kicked.byHost is cf-connecting-ip, not the cloudflared socket (' + (k && k.byHost) + ')');
    check(k && k.byName === 'Casey\'s iPad', 'kicked.byName is the paired device name');
    local.close(); tunnel.close(); rs.stop(); await sleep(300);
  }

  console.log('\n' + '='.repeat(50));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
