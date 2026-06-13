// Cloud Tunnel web-UI gate (regression, 2026-06-13). Turning on the
// Cloud Tunnel made the plain LAN/Tailscale web URL serve the
// "paired devices only" stub instead of the ECHOCAT web app — killing
// the free, no-app/no-subscription path. The stub must show ONLY for
// public visitors arriving over the tunnel; LAN, Tailscale, and local
// browsers get the real UI.
// Run: node test/tunnel-webui-gate-test.js

'use strict';

const https = require('https');
const WebSocket = require('ws');
const { RemoteServer } = require('../lib/remote-server');

let passed = 0, failed = 0;
function check(cond, label) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ FAIL: ' + label); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Unit: the discriminator ────────────────────────────────────────
console.log('=== _isTunnelOrPublicRequest ===');
const T = (h, ip) => RemoteServer._isTunnelOrPublicRequest(h, ip);
check(T({ 'cf-ray': '8a1b2c3d-EWR' }, '127.0.0.1') === true, 'Cloudflare cf-ray header → tunnel (even from loopback)');
check(T({ 'cf-connecting-ip': '203.0.113.9' }, '127.0.0.1') === true, 'cf-connecting-ip header → tunnel');
check(T({}, '192.168.1.50') === false, 'direct LAN 192.168 → not tunnel');
check(T({}, '10.0.0.9') === false, 'direct LAN 10/8 → not tunnel');
check(T({}, '172.20.1.1') === false, 'direct LAN 172.16/12 → not tunnel');
check(T({}, '100.94.0.7') === false, 'Tailscale CGNAT 100.64/10 → not tunnel (must be allowed!)');
check(T({}, '127.0.0.1') === false, 'loopback / local browser → not tunnel');
check(T({}, '::1') === false, 'IPv6 loopback → not tunnel');
check(T({}, '::ffff:192.168.1.5') === false, 'IPv6-mapped LAN → not tunnel');
check(T({}, 'fe80::1') === false, 'IPv6 link-local → not tunnel');
check(T({}, '169.254.5.5') === false, 'IPv4 link-local → not tunnel');
check(T({}, '8.8.8.8') === true, 'plain public IPv4 (direct port-forward) → tunnel/public');
check(T({}, '') === false, 'unknown source → treated as direct (token still gates actions)');
check(T(null, '192.168.1.1') === false, 'no headers object → falls through to source check');

// ── Integration: stub fires only for tunnel/public ─────────────────
(async () => {
  console.log('\n=== live gate (tunnel exposed) ===');
  const rs = new RemoteServer();
  rs._serverVersion = 'test';
  rs.start(17350, null, { requireToken: true, tunnelExposed: true });
  await sleep(500);
  const port = rs._port;

  const get = (extraHeaders) => new Promise((resolve) => {
    const req = https.request({
      host: '127.0.0.1', port, path: '/', method: 'GET',
      headers: extraHeaders || {}, rejectUnauthorized: false,
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', () => resolve({ status: -1, body: '' }));
    req.end();
  });
  const isStub = (r) => r.status === 503 && /accepts connections from paired/.test(r.body);

  // Direct LAN/local browser (loopback source, no CF headers): real UI.
  const direct = await get();
  check(!isStub(direct), 'direct request (loopback, no CF headers) does NOT get the stub');
  check(direct.status === 200, 'direct request is served the web UI (200)');

  // The injected __authMode must match what the WS will demand.
  // requireToken=true → 'token' even for the LAN browser.
  check(/window\.__authMode="token"/.test(direct.body),
    'requireToken: injected __authMode is "token" for the LAN browser');

  // Same connection but carrying Cloudflare edge headers = via tunnel.
  const tunneled = await get({ 'cf-ray': '8a1b2c3d4e5f-EWR', 'cf-connecting-ip': '203.0.113.42' });
  check(isStub(tunneled), 'request with Cloudflare edge headers gets the stub');

  // /health stays open over the tunnel (whitelist intact).
  const health = await new Promise((resolve) => {
    const req = https.request({ host: '127.0.0.1', port, path: '/health', method: 'GET',
      headers: { 'cf-ray': 'x-EWR' }, rejectUnauthorized: false }, (res) => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', () => resolve({ status: -1 })); req.end();
  });
  check(health.status === 200 && /ok/.test(health.body), '/health still open over the tunnel');

  rs.stop();
  await sleep(100);

  // ── Regression: tunnel ON, NO token required (the dead-shell bug) ──
  // 2026-06-13: with the Cloud Tunnel running 24/7 and no shared token,
  // the HTML injected __authMode="none" (pre-hiding the connect screen
  // and showing the main UI) while the WS sent auth-mode="token" and
  // withheld auth-ok — a live VFO shell with no spots/freq and no
  // reachable token entry. The three gates (HTTP stub, injected
  // __authMode, WS auth-mode) must agree, keyed on _isTunnelOrPublicRequest.
  console.log('\n=== tunnel exposed, no token (LAN free path must auto-auth) ===');
  const rs2 = new RemoteServer();
  rs2._serverVersion = 'test';
  rs2.start(17351, null, { requireToken: false, tunnelExposed: true });
  await sleep(500);
  const port2 = rs2._port;

  const get2 = (extraHeaders) => new Promise((resolve) => {
    const req = https.request({
      host: '127.0.0.1', port: port2, path: '/', method: 'GET',
      headers: extraHeaders || {}, rejectUnauthorized: false,
    }, (res) => {
      let data = ''; res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', () => resolve({ status: -1, body: '' }));
    req.end();
  });

  // LAN browser: real UI, and injected __authMode="none" so the
  // renderer auto-authenticates instead of stranding a dead shell.
  const lan = await get2();
  check(lan.status === 200 && !/accepts connections from paired/.test(lan.body),
    'LAN browser gets the real UI (not the stub) with tunnel on + no token');
  check(/window\.__authMode="none"/.test(lan.body),
    'LAN browser: injected __authMode is "none" (renderer auto-auths)');

  // The WS layer must agree: a loopback/LAN WS connection auto-auths,
  // a tunnel (cf-ray) WS connection is forced into token mode.
  const wsAuthMode = (extraHeaders) => new Promise((resolve) => {
    const seen = [];
    let mode = null;
    const ws = new WebSocket(`wss://127.0.0.1:${port2}/`, {
      rejectUnauthorized: false, headers: extraHeaders || {},
    });
    const done = (v) => { try { ws.close(); } catch {} resolve(v); };
    const t = setTimeout(() => done({ mode, seen }), 2500);
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      seen.push(m.type);
      if (m.type === 'auth-mode') mode = m.mode;
      if (m.type === 'auth-ok') { clearTimeout(t); done({ mode, seen }); }
    });
    ws.on('error', () => { clearTimeout(t); done({ mode, seen, error: true }); });
  });

  const lanWs = await wsAuthMode();
  check(lanWs.mode === 'none', 'LAN WS: auth-mode is "none" (tunnel on, no token)');
  check(lanWs.seen.includes('auth-ok'), 'LAN WS: auto-authenticated (received auth-ok)');

  const tunnelWs = await wsAuthMode({ 'cf-ray': '9z9z-EWR', 'cf-connecting-ip': '203.0.113.7' });
  check(tunnelWs.mode === 'token', 'tunnel WS (cf-ray): auth-mode is "token" (must authenticate)');
  check(!tunnelWs.seen.includes('auth-ok'), 'tunnel WS (cf-ray): NOT auto-authenticated');

  rs2.stop();
  await sleep(100);

  console.log('\n' + '='.repeat(50));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
