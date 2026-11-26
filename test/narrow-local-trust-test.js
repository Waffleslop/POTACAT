#!/usr/bin/env node
'use strict';
// Narrow local trust (K3SBP 2026-11-26). A connection from this PC used to be
// trusted as the owner with no token whenever it lacked Cloudflare's headers,
// so a local reverse proxy (ngrok, nginx, tailscale serve) pointed at the
// ECHOCAT port, or a tunnel hop that lost its headers, got owner control.
//   (a) A Host of potacat.com / *.potacat.com is tunnel traffic, headers or not.
//   (b) With the Cloud Tunnel on, a loopback connection needs a token unless it
//       is POTACAT's own page in a browser on this PC (Host localhost/127.x,
//       no proxy header, and on a WebSocket this server's Origin).
//   With the tunnel off, loopback keeps today's local trust.
// Pure checks on lib/echocat-web-gate.js and lib/ptt-api-gate.js, then a real
// RemoteServer over loopback WSS. Ports 17661-17663 are this file's own. Never
// 7300 (the operator's live POTACAT) and never start(0) (a falsy port is 7300).
// Run: node test/narrow-local-trust-test.js

const https = require('https');
const WebSocket = require('ws');
const WebGate = require('../lib/echocat-web-gate');
const { decidePttApi } = require('../lib/ptt-api-gate');
const { RemoteServer } = require('../lib/remote-server');

let passed = 0, failed = 0;
function check(cond, label) {
  if (cond) { passed++; console.log('  ok  ' + label); }
  else { failed++; console.log('  FAIL ' + label); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const certDir = require('os').tmpdir();

// ── pure ───────────────────────────────────────────────────────────────
console.log('isTunnelHostname / _isTunnelOrPublicRequest (a)');
check(WebGate.isTunnelHostname('k3sbp.potacat.com'), 'k3sbp.potacat.com is a tunnel name');
check(WebGate.isTunnelHostname('K3SBP.POTACAT.COM:443'), 'case and port do not matter');
check(WebGate.isTunnelHostname('potacat.com'), 'potacat.com itself');
check(!WebGate.isTunnelHostname('notpotacat.com'), 'notpotacat.com is not');
check(!WebGate.isTunnelHostname('potacat.com.evil.net'), 'potacat.com.evil.net is not');
check(!WebGate.isTunnelHostname('127.0.0.1:7300') && !WebGate.isTunnelHostname(''), 'loopback and empty Host are not');
check(RemoteServer._isTunnelOrPublicRequest({ host: 'k3sbp.potacat.com' }, '127.0.0.1') === true,
  'loopback + Host k3sbp.potacat.com without Cloudflare headers counts as tunnel');
check(RemoteServer._isTunnelOrPublicRequest({ host: '127.0.0.1:7300' }, '127.0.0.1') === false,
  'loopback + Host 127.0.0.1 is still direct');
check(RemoteServer._isTunnelOrPublicRequest({ host: '192.168.1.5:7300' }, '192.168.1.20') === false,
  'a LAN request is still direct');

console.log('loopbackNeedsToken (b)');
const own = { host: 'localhost:7300', origin: 'https://localhost:7300' };
const L = (headers, extra) => WebGate.loopbackNeedsToken(Object.assign({ tunnelExposed: true, remoteAddress: '127.0.0.1', headers, upgrade: true }, extra || {}));
check(L(own) === false, 'tunnel on: our page in a local browser (Host + Origin localhost) needs no token');
check(L({ host: '127.0.0.1:7300', origin: 'https://127.0.0.1:7300' }) === false, 'same for 127.0.0.1');
check(L({ host: '[::1]:7300', origin: 'https://[::1]:7300' }, { remoteAddress: '::1' }) === false, 'same for [::1]');
check(L({ host: 'localhost:7300' }) === true, 'tunnel on: a native socket (no Origin) needs a token');
check(L({ host: 'localhost:7300', origin: 'https://localhost:7300', 'x-forwarded-for': '203.0.113.9' }) === true,
  'tunnel on: X-Forwarded-For (a proxy) needs a token');
check(L({ host: 'localhost:7300', origin: 'https://localhost:7300', 'tailscale-user-login': 'a@b' }) === true,
  'tunnel on: a Tailscale identity header (tailscale serve) needs a token');
check(L({ host: 'shack.ngrok-free.app', origin: 'https://shack.ngrok-free.app' }) === true,
  'tunnel on: a proxy that keeps its public Host needs a token');
check(L({ host: 'localhost:7300' }, { upgrade: false }) === false,
  'tunnel on: a plain HTTP GET from this PC (page load, Stream Deck) is local');
check(L({ host: 'shack.ngrok-free.app' }, { upgrade: false }) === true, 'tunnel on: HTTP through a proxy Host is not');
check(L({ host: 'localhost:7300' }, { tunnelExposed: false }) === false, 'tunnel off: unchanged local trust');
check(L({ host: 'shack.ngrok-free.app' }, { tunnelExposed: false }) === false, 'tunnel off: unchanged, even a proxy Host');
check(L({ host: '192.168.1.5:7300' }, { remoteAddress: '192.168.1.20' }) === false, 'LAN source: not touched');
check(L({ host: '100.101.102.103:7300' }, { remoteAddress: '100.64.1.2' }) === false, 'Tailscale source: not touched');

console.log('decidePttApi tokenRequired');
check(decidePttApi({ action: 'on', https: true, tokenRequired: true, tokenSet: false }).status === 401, 'proxy + no password set: refused');
check(decidePttApi({ action: 'on', https: true, tokenRequired: true, tokenSet: true, tokenOk: false }).status === 401, 'proxy + wrong token: refused');
check(decidePttApi({ action: 'on', https: true, tokenRequired: true, tokenSet: true, tokenOk: true }).status === 200, 'proxy + right token: served');
check(decidePttApi({ action: 'on', https: true }).status === 200, 'local caller, no password: served as before');

// ── live server ───────────────────────────────────────────────────────
function wsTry(port, headers) {
  return new Promise((resolve) => {
    const out = { mode: null, seen: [], refused: null, ws: null };
    const ws = new WebSocket(`wss://127.0.0.1:${port}/`, { rejectUnauthorized: false, headers: headers || {} });
    out.ws = ws;
    ws.on('unexpected-response', (_req, res) => { out.refused = res.statusCode; resolve(out); });
    ws.on('error', () => resolve(out));
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', protocolVersion: 1, clientVersion: 'test', clientPlatform: 'web' })));
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      out.seen.push(m.type);
      if (m.type === 'auth-mode') out.mode = m.mode;
    });
    setTimeout(() => resolve(out), 900);
  });
}
function closeWs(o) { try { o.ws.close(); } catch {} }
function get(port, path, headers) {
  return new Promise((resolve) => {
    const req = https.request({ host: '127.0.0.1', port, path, method: 'GET', headers: headers || {}, rejectUnauthorized: false }, (res) => {
      let data = ''; res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', () => resolve({ status: -1, body: '' }));
    req.end();
  });
}
function startServer(port, token, opts) {
  const rs = new RemoteServer();
  rs._serverVersion = 'test';
  rs.on('log', () => {});
  rs.on('ptt', () => {});
  rs.start(port, token, Object.assign({ certDir, mdns: false, host: '127.0.0.1' }, opts));
  return rs;
}

(async () => {
  console.log('Cloud Tunnel on, no token required, ECHOCAT token set');
  {
    const port = 17661;
    const rs = startServer(port, 'tok-secret-1', { requireToken: false, tunnelExposed: true });
    rs.setAltHosts({ cloudHost: 'k3sbp.potacat.com' });
    await sleep(600);
    const self = `127.0.0.1:${port}`;

    let r = await wsTry(port, { host: 'k3sbp.potacat.com' });
    check(r.mode === 'token' && !r.seen.includes('auth-ok'), 'Host k3sbp.potacat.com without Cloudflare headers: token required, not signed in');
    closeWs(r);

    r = await wsTry(port);
    check(r.mode === 'token', 'native loopback socket (no Origin): auth-mode token');
    check(!r.seen.includes('auth-ok'), 'native loopback socket: its hello does not sign it in');
    check(rs._openClients().length === 0, 'native loopback socket: not a client');
    r.ws.send(JSON.stringify({ type: 'auth', token: 'wrong' }));
    await sleep(300);
    check(r.seen.includes('auth-fail'), 'native loopback socket: a wrong token is refused');
    closeWs(r);

    r = await wsTry(port);
    r.ws.send(JSON.stringify({ type: 'auth', token: 'tok-secret-1' }));
    await sleep(400);
    check(r.seen.includes('auth-ok'), 'native loopback socket with the ECHOCAT token: signed in (echocat-cli --token)');
    closeWs(r);
    await sleep(200);

    r = await wsTry(port, { origin: `https://${self}` });
    check(r.mode === 'none' && r.seen.includes('auth-ok'), 'our page in a local browser (Origin = this server): no token, signed in on hello');
    closeWs(r);
    await sleep(200);

    r = await wsTry(port, { origin: `https://${self}`, 'x-forwarded-for': '203.0.113.9' });
    check(r.mode === 'token' && !r.seen.includes('auth-ok'), 'same Origin through a proxy (X-Forwarded-For): token required');
    closeWs(r);

    r = await wsTry(port, { host: 'shack.ngrok-free.app', origin: 'https://shack.ngrok-free.app' });
    check(r.mode === 'token' && !r.seen.includes('auth-ok'), 'a proxy that keeps its own Host: token required');
    closeWs(r);

    r = await wsTry(port, { 'cf-ray': '1a1a-EWR', 'cf-connecting-ip': '203.0.113.7', host: 'k3sbp.potacat.com' });
    check(r.mode === 'token' && !r.seen.includes('auth-ok'), 'tunnel (Cloudflare headers): token, unchanged');
    closeWs(r);

    let g = await get(port, '/');
    check(g.status === 200 && /window\.__authMode="none"/.test(g.body), 'page opened at https://127.0.0.1 on this PC: served with __authMode none');
    g = await get(port, '/', { host: 'shack.ngrok-free.app' });
    check(g.status === 200 && /window\.__authMode="token"/.test(g.body), 'page through a proxy Host: served with __authMode token (the token screen)');
    g = await get(port, '/', { host: 'k3sbp.potacat.com' });
    check(!/window\.__authMode=/.test(g.body), 'page with Host k3sbp.potacat.com and no Cloudflare headers: the tunnel gate, not the app');
    g = await get(port, '/health');
    check(g.status === 200, '/health (the Cloud Tunnel origin probe path) still answers');

    g = await get(port, '/api/ptt/off', { host: 'shack.ngrok-free.app' });
    check(g.status === 401, '/api/ptt through a proxy Host without the token: refused');
    g = await get(port, '/api/ptt/off?token=tok-secret-1', { host: 'shack.ngrok-free.app' });
    check(g.status === 200, '/api/ptt through a proxy Host with the token: served');
    g = await get(port, '/api/ptt/off', { host: `localhost:${port}` });
    check(g.status === 200, '/api/ptt from a program on this PC (Stream Deck): served as before');

    rs.stop();
    await sleep(150);
  }

  console.log('Cloud Tunnel off, no token');
  {
    const port = 17662;
    const rs = startServer(port, null, { requireToken: false, tunnelExposed: false });
    await sleep(600);
    let r = await wsTry(port);
    check(r.mode === 'none' && r.seen.includes('auth-ok'), 'native loopback socket: local trust as before (none, signed in on hello)');
    closeWs(r);
    await sleep(200);
    r = await wsTry(port, { host: 'k3sbp.potacat.com' });
    check(r.refused === 403 && !r.seen.includes('auth-ok'), 'Host k3sbp.potacat.com with the tunnel off and no token: refused (fails closed)');
    closeWs(r);
    const g = await get(port, '/');
    check(g.status === 200 && /window\.__authMode="none"/.test(g.body), 'page on this PC: __authMode none as before');
    rs.stop();
    await sleep(150);
  }

  console.log('Cloud Tunnel off, require token on');
  {
    const port = 17663;
    const rs = startServer(port, 'tok-secret-3', { requireToken: true, tunnelExposed: false });
    await sleep(600);
    const r = await wsTry(port, { host: 'k3sbp.potacat.com' });
    check(r.mode === 'token' && !r.seen.includes('auth-ok'), 'Host k3sbp.potacat.com with the tunnel off: token required');
    closeWs(r);
    rs.stop();
    await sleep(150);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
