// Tap-to-pair under Cloud Tunnel exposure — composition of three
// commits that all touch this path (verify they don't conflict):
//   23654d0  allowlist /api/pair-request through the tunnel catch-all
//   e29c4c5  retry: stored-result + re-attach
//   b31246d  (orthogonal: getLocalIPs adapter filter — separate test)
//
// The security model: with the tunnel exposed, cloudflared forwards
// tunnel traffic from LOOPBACK, so the handler's _isPrivateLanAddress
// gate blocks loopback (= tunnel/internet) but allows a genuine
// same-LAN phone. That gate must run BEFORE the stored-result lookup,
// or a tunnel attacker could collect another device's credentials.
// Run: node test/pair-request-tunnel-gate-test.js

'use strict';

const https = require('https');
const { RemoteServer } = require('../lib/remote-server');

let passed = 0, failed = 0;
function check(cond, label) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ FAIL: ' + label); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function request(port, path, method, bodyObj, extraHeaders) {
  return new Promise((resolve) => {
    const body = bodyObj ? JSON.stringify(bodyObj) : '';
    const req = https.request({
      host: '127.0.0.1', port, path, method,
      headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, extraHeaders || {}),
      rejectUnauthorized: false,
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        let json = null; try { json = JSON.parse(data); } catch {}
        resolve({ status: res.statusCode, ctype: res.headers['content-type'] || '', json, text: data });
      });
    });
    req.on('error', () => resolve({ status: -1 }));
    req.end(body);
  });
}
const pairReq = (port, requestId) =>
  request(port, '/api/pair-request', 'POST', { deviceName: 'P', devicePlatform: 'ios-test', requestId });

(async () => {
  console.log('=== _isPrivateLanAddress (the security pivot) ===');
  const P = RemoteServer._isPrivateLanAddress;
  check(P('192.168.1.50') === true, '192.168/16 is LAN');
  check(P('10.0.0.5') === true, '10/8 is LAN');
  check(P('172.16.0.1') === true && P('172.31.255.254') === true, '172.16/12 is LAN');
  check(P('172.15.0.1') === false && P('172.32.0.1') === false, '172.15 / 172.32 are NOT LAN');
  check(P('127.0.0.1') === false, 'LOOPBACK is NOT LAN (cloudflared forwards tunnel traffic from here)');
  check(P('100.94.1.2') === false, 'Tailscale 100.64/10 is NOT treated as plain LAN here');

  console.log('\n=== _isTrustedPeerAddress (LAN + tailnet) ===');
  // LZ3AW item 11: pairing over Tailscale from away was refused with "only
  // works from your home network" whenever the Cloud Tunnel was on, because
  // the gate asked the LAN-only question. Tap-to-pair needs no mDNS — the
  // phone already reached the host — and the desktop Approve is still the
  // trust decision.
  const T = RemoteServer._isTrustedPeerAddress;
  check(T('192.168.1.50') === true, 'LAN peer is trusted');
  check(T('100.94.1.2') === true, 'TAILNET peer is trusted (the fix)');
  check(T('100.64.0.1') === true && T('100.127.255.254') === true, 'both ends of 100.64/10');
  check(T('100.63.255.255') === false && T('100.128.0.1') === false, 'neighbours of 100.64/10 are NOT tailnet');
  check(T('127.0.0.1') === false, 'LOOPBACK still untrusted — that is where tunnel traffic arrives');
  check(T('8.8.8.8') === false, 'public IPv4 still untrusted');
  check(T('::ffff:100.94.1.2') === true, 'IPv6-mapped tailnet address unwrapped');
  check(P('::ffff:192.168.1.9') === true, 'IPv6-mapped IPv4 LAN address unwrapped');
  check(P('8.8.8.8') === false && P('garbage') === false, 'public IP / junk are NOT LAN');

  console.log('\n=== tunnel-exposed composition ===');
  const rs = new RemoteServer();
  rs._serverVersion = 'test';
  const popups = [];
  rs.on('pair-request', (p) => popups.push(p));
  rs.start(17340, null, { requireToken: true, tunnelExposed: true });
  await sleep(500);
  const port = rs._port;
  const realIsLan = RemoteServer._isPrivateLanAddress;

  // 1. The shadow regression (23654d0): pair-request reaches the
  //    HANDLER (typed 403 JSON), not the catch-all (generic 503 HTML).
  {
    const r = await pairReq(port, 'tg-loopback-1' + 'a'.repeat(10));
    check(r.status === 403 && r.json && r.json.error === 'pair_request_tunnel_blocked',
      'loopback (=tunnel) source gets the typed pair_request_tunnel_blocked');
    check(!/text\/html/.test(r.ctype), '…and NOT the generic 503 HTML stub (handler ran, allowlist works)');
    check(popups.length === 0, 'blocked request raised no Approve popup');
  }

  // 2. The catch-all stub gates a NON-allowlisted path — but only for
  //    requests that came via the tunnel (CF edge headers), NOT direct/
  //    loopback ones. (2026-06-13: serving the stub to LAN/loopback was
  //    the web-UI regression; see test/tunnel-webui-gate-test.js.)
  {
    const viaTunnel = await request(port, '/api/ptt/toggle', 'GET', null, { 'cf-ray': '8a-EWR' });
    check(viaTunnel.status === 503 && /text\/html/.test(viaTunnel.ctype),
      'non-allowlisted path over the tunnel (CF headers) gets the 503 stub');
    const direct = await request(port, '/api/ptt/toggle', 'GET');
    check(!(direct.status === 503 && /text\/html/.test(direct.ctype)),
      'non-allowlisted path direct/loopback is NOT stubbed (web-UI fix)');
  }

  // 3. Genuine same-LAN phone is ALLOWED even while the tunnel is up
  //    (simulate the LAN source by overriding the pivot — the real
  //    socket is loopback in-process).
  {
    RemoteServer._isPrivateLanAddress = () => true;
    const rid = 'tg-lan-ok-' + 'b'.repeat(12);
    const inflight = pairReq(port, rid);
    await sleep(300);
    check(popups.length === 1 && popups[0].requestId === rid,
      'LAN source raises the Approve popup while tunnel is exposed');
    const dev = rs.approvePairRequest(rid);
    const res = await inflight;
    check(res.status === 200 && res.json && res.json.deviceToken === dev.token,
      'Approve delivers credentials to the LAN phone under tunnel exposure');
    RemoteServer._isPrivateLanAddress = realIsLan;
  }

  // 4. SECURITY: the gate runs before the stored-result lookup. After a
  //    LAN device's approval is stored, a loopback (tunnel) retry of the
  //    SAME requestId must be blocked — never leak the credentials.
  {
    RemoteServer._isPrivateLanAddress = () => true;
    const rid = 'tg-steal-' + 'c'.repeat(14);
    const inflight = pairReq(port, rid);
    await sleep(300);
    const dev = rs.approvePairRequest(rid); // stores the result
    await inflight;
    RemoteServer._isPrivateLanAddress = realIsLan; // back to real: loopback = not LAN

    const attacker = await pairReq(port, rid); // tunnel attacker, same id
    check(attacker.status === 403 && attacker.json && attacker.json.error === 'pair_request_tunnel_blocked',
      'tunnel retry of an approved requestId is blocked by the gate (stored result NOT leaked)');
    check(!(attacker.json && attacker.json.deviceToken), 'no deviceToken in the blocked response');

    // Prove it was the GATE, not consumption: a LAN retry still collects it.
    RemoteServer._isPrivateLanAddress = () => true;
    const legit = await pairReq(port, rid);
    check(legit.status === 200 && legit.json && legit.json.deviceToken === dev.token,
      'the stored result was still intact — the attacker was gated, not served');
    RemoteServer._isPrivateLanAddress = realIsLan;
  }

  // 5. A TAILNET phone pairs while the tunnel is exposed (item 11). Steered
  //    through the LAN pivot's sibling: the real socket is loopback in-process.
  {
    const realTailnet = RemoteServer._isTailnetAddress;
    RemoteServer._isTailnetAddress = (ip) => ip === '127.0.0.1' || ip === '::ffff:127.0.0.1' || realTailnet(ip);
    const rid = 'tg-tailnet-' + 'd'.repeat(12);
    const inflight = pairReq(port, rid);
    await sleep(300);
    check(popups.some((x) => x.requestId === rid),
      'tailnet source raises the Approve popup while the tunnel is exposed');
    const dev = rs.approvePairRequest(rid);
    const res = await inflight;
    check(res.status === 200 && res.json && res.json.deviceToken === dev.token,
      'Approve delivers credentials to the tailnet phone');
    RemoteServer._isTailnetAddress = realTailnet;

    // ...and with it restored, loopback is refused again — the tunnel path
    // did not become trusted along the way.
    const after = await pairReq(port, 'tg-after-' + 'e'.repeat(14));
    check(after.status === 403 && after.json && after.json.error === 'pair_request_tunnel_blocked',
      'loopback is still blocked after the tailnet case');
  }

  rs.stop();
  await sleep(100);
  console.log('\n' + '='.repeat(50));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
