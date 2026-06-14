// Remote-desktop Phase 1 END-TO-END foundation test.
//
// Spins up a real shack RemoteServer + a real desktop-as-client RemoteClient
// in one process and drives the full path the desktop-to-desktop feature
// depends on: TLS dial with cert-fingerprint pin -> v1 hello -> token auth ->
// auth-ok -> receive spots (both the auth-ok push and a live broadcast) ->
// send a tune that lands on the shack. This is the regression net that proves
// "Phase 1 control actually works" before we build more on it.
//
// Hermetic: loopback WSS with the server's self-signed cert, no network, no
// real rig (the shack's inbound `tune` is captured via the server's event).
// Run: node test/remote-desktop-e2e-test.js
'use strict';

const { X509Certificate } = require('crypto');
const { RemoteServer } = require('../lib/remote-server');
const { RemoteClient } = require('../lib/remote-client');

let passed = 0, failed = 0;
function check(cond, label) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ FAIL: ' + label); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function waitFor(emitter, event, ms) {
  return new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; resolve(null); } }, ms);
    emitter.once(event, (payload) => { if (!done) { done = true; clearTimeout(t); resolve(payload === undefined ? {} : payload); } });
  });
}

(async () => {
  const PORT = 17361;
  const TOKEN = 'e2e-shared-token-abc123';
  const certDir = require('os').tmpdir(); // reuse the cached self-signed cert

  // ── Stand up the shack ────────────────────────────────────────────
  const rs = new RemoteServer();
  rs._serverVersion = '1.8.13-test';
  rs._rigModel = 'Flex 8600M';                 // rides the server hello
  const tuneSeen = [];
  rs.on('tune', (t) => tuneSeen.push(t));
  rs.start(PORT, TOKEN, { requireToken: true, certDir });
  await sleep(600);

  console.log('=== shack server ===');
  check(rs.running !== false && rs._port === PORT, 'RemoteServer listening with token auth');
  check(!!rs._tlsCertPem, 'server presents a TLS cert (WSS)');

  // The pin the client would have captured at pair time.
  const fingerprint = new X509Certificate(rs._tlsCertPem).fingerprint256;
  check(/^[0-9A-F:]+$/i.test(fingerprint), 'derived server cert fingerprint256 for pinning');

  // Seed spots so the auth-ok push carries them.
  rs.broadcastSpots([
    { callsign: 'K3SBP', frequency: '14074.0', mode: 'FT8', source: 'POTA', reference: 'US-0512' },
    { callsign: 'W1AW', frequency: '7035.0', mode: 'CW', source: 'POTA', reference: 'US-0001' },
  ]);

  // ── Dial from the desktop client ──────────────────────────────────
  const target = {
    id: 'shack-1',
    name: 'Test Shack',
    lanHost: `wss://127.0.0.1:${PORT}`, // LAN leg uses lanHost verbatim as the wss URL
    fingerprint,                         // cert pin captured at pair time
    deviceToken: TOKEN,                  // credential presented on auth
  };
  const rc = new RemoteClient(target, { clientVersion: '1.8.13-test', clientPlatform: 'desktop-test' });
  rc.on('log', () => {});       // swallow verbose logs
  rc.on('error', () => {});     // don't throw on transient socket errors

  const helloP = waitFor(rc, 'hello', 6000);
  const connectedP = waitFor(rc, 'connected', 6000);
  const firstSpotsP = waitFor(rc, 'spots', 6000);

  rc.connect();

  console.log('\n=== handshake + auth ===');
  const hello = await helloP;
  check(hello && hello.rigModel === 'Flex 8600M', 'client received server hello carrying rigModel');
  const connected = await connectedP;
  check(connected !== null, 'client reached auth-ok (connected) over pinned WSS + token');
  check(rc.state().authed === true, 'client state is authed');
  check(rc.state().leg === 'lan', 'connected via the LAN leg');

  console.log('\n=== spots flow (shack → client) ===');
  const firstSpots = await firstSpotsP;
  check(Array.isArray(firstSpots) && firstSpots.length === 2, 'auth-ok delivered the seeded spot list (2)');
  check(firstSpots && firstSpots[0].callsign === 'K3SBP', 'spot payload shape preserved end-to-end');

  // A live broadcast after connect must reach the client too.
  const liveSpotsP = waitFor(rc, 'spots', 4000);
  rs.broadcastSpots([{ callsign: 'N0CALL', frequency: '14250.0', mode: 'SSB', source: 'POTA', reference: 'US-9999' }]);
  const liveSpots = await liveSpotsP;
  check(Array.isArray(liveSpots) && liveSpots.length === 1 && liveSpots[0].callsign === 'N0CALL', 'live broadcastSpots reaches the connected client');

  console.log('\n=== control flow (client → shack) ===');
  rc.sendTune({ frequency: 14074000, mode: 'USB' });
  await sleep(400); // allow the frame to traverse the loopback WS
  check(tuneSeen.length === 1, 'shack received exactly one tune');
  check(tuneSeen[0] && Math.abs(tuneSeen[0].freqKhz - 14074) < 0.001, 'tune freqKhz decoded to 14074 kHz on the shack');
  check(tuneSeen[0] && tuneSeen[0].mode === 'USB', 'tune mode carried through');

  // Tune rate-limit (500ms) — a second immediate tune is dropped by the shack.
  rc.sendTune({ frequency: 7035000, mode: 'CW' });
  await sleep(300);
  check(tuneSeen.length === 1, 'shack rate-limits a second immediate tune (still 1)');

  console.log('\n=== auth rejection (wrong token) ===');
  const badTarget = { id: 's2', name: 'Bad', lanHost: `wss://127.0.0.1:${PORT}`, fingerprint, deviceToken: 'WRONG' };
  const rc2 = new RemoteClient(badTarget, {});
  rc2.on('log', () => {}); rc2.on('error', () => {});
  const authFailP = waitFor(rc2, 'auth-fail', 6000);
  const connP2 = waitFor(rc2, 'connected', 2500);
  rc2.connect();
  // A bad shared token isn't a known device → server arms the 10s auth
  // timeout then auth-fails; we just assert it never reaches 'connected'.
  const conn2 = await connP2;
  check(conn2 === null && rc2.state().authed === false, 'wrong token never authenticates');
  rc2.close();

  // ── Teardown ──────────────────────────────────────────────────────
  rc.close();
  await sleep(100);
  try { rs.stop(); } catch {}
  await sleep(150);

  console.log('\n' + '='.repeat(52));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL:', e && e.stack || e); process.exit(1); });
