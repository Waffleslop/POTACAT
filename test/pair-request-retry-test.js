// Tap-to-pair retry semantics (K6RBJ, 2026-06-12). iOS retires idle
// sockets faster than a human clicks Approve (flaky LAN bridges drop
// the 60s long-poll too), so the approval used to be minted into a
// dead socket and ORPHANED — the phone showed "network error reaching
// the desktop" and never paired. Verifies the two retry layers:
//   1. resolved-before-retry → stored result handed back (single-use)
//   2. retry-while-pending  → fresh socket re-attached, no new popup,
//      no pair_request_busy for the SAME requestId
// Run: node test/pair-request-retry-test.js

'use strict';

const https = require('https');
const { RemoteServer } = require('../lib/remote-server');

let passed = 0, failed = 0;
function check(cond, label) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ FAIL: ' + label); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function postPairRequest(port, requestId, opts = {}) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ deviceName: 'TestPhone', devicePlatform: 'ios-test', requestId });
    const req = https.request({
      host: '127.0.0.1', port, path: '/api/pair-request', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      rejectUnauthorized: false,
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch {}
        resolve({ status: res.statusCode, json });
      });
      res.on('error', () => resolve({ status: -1, json: null }));
    });
    req.on('error', () => resolve({ status: -1, json: null }));
    req.end(body);
    if (opts.killAfterMs) {
      // Simulate iOS retiring the long-poll socket mid-wait.
      setTimeout(() => req.destroy(), opts.killAfterMs);
    }
    if (opts.collect) opts.collect(req);
  });
}

(async () => {
  console.log('=== tap-to-pair retry ===');
  const rs = new RemoteServer();
  rs._serverVersion = 'test';
  const popups = [];
  rs.on('pair-request', (p) => popups.push(p));
  rs.start(17330, null, { requireToken: true });
  await sleep(500);
  const port = rs._port;

  // ── 1. socket dies → operator approves → retry collects result ────
  {
    const r1 = 'R1-' + 'a'.repeat(20);
    const dead = postPairRequest(port, r1, { killAfterMs: 150 });
    await sleep(400);
    check(popups.length === 1 && popups[0].requestId === r1, 'pair request raised the popup');
    await dead; // socket gone, popup still pending
    const device = rs.approvePairRequest(r1);
    check(device && device.token, 'Approve still mints the device on a dead socket');
    const retry = await postPairRequest(port, r1);
    check(retry.status === 200 && retry.json && retry.json.deviceToken === device.token,
      'same-requestId retry collects the minted credentials');
    const again = postPairRequest(port, 'different-id-12345'); // held until denied below
    // No pending request now; this should create a fresh popup (not busy).
    await sleep(100);
    check(popups.length === 2, 'stored result is consumed — server back to normal afterwards');
    rs.denyPairRequest('different-id-12345'); await again;
  }

  // ── 2. retry while still pending re-attaches (no busy, no 2nd popup)
  {
    popups.length = 0;
    const r2 = 'R2-' + 'b'.repeat(20);
    const dead = postPairRequest(port, r2, { killAfterMs: 150 });
    await sleep(400);
    check(popups.length === 1, 'first POST raised the popup');
    await dead;
    const reattach = postPairRequest(port, r2); // same id, fresh socket
    await sleep(300);
    check(popups.length === 1, 'same-requestId retry does NOT raise a second popup');
    rs.approvePairRequest(r2);
    const result = await reattach;
    check(result.status === 200 && result.json && result.json.deviceToken,
      'approval lands on the re-attached socket');
  }

  // ── 3. different requestId while pending is still busy ────────────
  {
    popups.length = 0;
    const r3 = 'R3-' + 'c'.repeat(20);
    const first = postPairRequest(port, r3);
    await sleep(300);
    const other = await postPairRequest(port, 'intruder-id-9999');
    check(other.status === 503 && other.json && other.json.error === 'pair_request_busy',
      'a DIFFERENT requestId while pending still gets pair_request_busy');
    rs.denyPairRequest(r3);
    const denied = await first;
    check(denied.status === 403 && denied.json && denied.json.error === 'pair_denied',
      'deny resolves the held request');
  }

  // ── 4. denied outcome is also retrievable on retry ────────────────
  {
    const r4 = 'R4-' + 'd'.repeat(20);
    const dead = postPairRequest(port, r4, { killAfterMs: 150 });
    await sleep(400);
    await dead;
    rs.denyPairRequest(r4);
    const retry = await postPairRequest(port, r4);
    check(retry.status === 403 && retry.json && retry.json.error === 'pair_denied',
      'retry after a dead-socket Deny gets pair_denied (not a new popup)');
  }

  rs.stop();
  await sleep(100);
  console.log('\n' + '='.repeat(50));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
