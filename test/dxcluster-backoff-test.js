// Cluster reconnect policy — the KD4D incident (2026-08-04).
//
// A DXSpider node that accepts the TCP connection and then refuses the login
// had POTACAT reconnecting every 10 s forever: ~8,600 connections a day per
// instance at one volunteer's node. TWO independent bugs zeroed the backoff:
//   1. sock.on('connect') reset it — and a refusing node fires 'connect' on
//      every attempt.
//   2. disconnect() reset it too, and connect() called disconnect() first —
//      so every automatic reconnect laundered its own failure count. Fixing
//      only (1) would have left the loop running at the 10 s floor.
// These tests drive the real client against a fake refusing node.
//
// Run: node test/dxcluster-backoff-test.js
'use strict';

const assert = require('assert');
const net = require('net');
const { DxClusterClient, looksLikeCallsign } = require('../lib/dxcluster');

let passed = 0, failed = 0;
function check(cond, label) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ FAIL: ' + label); }
}

// A node that accepts TCP, prints a login prompt, then refuses — exactly the
// shape that produced the storm.
function refusingNode(onConnection) {
  const server = net.createServer((sock) => {
    onConnection();
    sock.write('login: ');
    sock.once('data', () => {
      sock.write('Sorry, W1XYZ is not registered here.\r\n');
      setTimeout(() => { try { sock.destroy(); } catch {} }, 5);
    });
  });
  return server;
}

// Collect the delays the client WOULD wait, without waiting them. Replacing
// the scheduler keeps the test fast while still exercising the real
// _scheduleReconnect math and give-up latch.
function captureDelays(client) {
  const delays = [];
  const realSchedule = client._scheduleReconnect.bind(client);
  client._scheduleReconnect = function () {
    const before = client._reconnectAttempt;
    // Run the real logic, but intercept the timer.
    const realSetTimeout = global.setTimeout;
    global.setTimeout = (fn, ms) => { delays.push(ms); return realSetTimeout(() => {}, 0); };
    try { realSchedule(); } finally { global.setTimeout = realSetTimeout; }
    client._reconnectTimer = null; // we swallowed the timer; allow the next call
    return before;
  };
  return delays;
}

async function run() {
  console.log('refusing node — backoff actually grows:');
  {
    let connections = 0;
    const server = refusingNode(() => { connections++; });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    const c = new DxClusterClient();
    const delays = captureDelays(c);
    const logs = [];
    c.on('log', (m) => logs.push(m));

    // Drive 5 sessions the way the reconnect timer would, but immediately.
    for (let i = 0; i < 5; i++) {
      c.connect({ host: '127.0.0.1', port, callsign: 'W1XYZ' });
      await new Promise((r) => setTimeout(r, 120));
    }

    check(connections === 5, `node saw each attempt (${connections})`);
    check(delays.length >= 4, `backoff was scheduled between attempts (${delays.length})`);
    // The floor is 10 s ±20% jitter and each failed session doubles it, so
    // delay i is at least 0.8 × 10 s × 2^i. A ratio check between neighbours
    // can't tell growth from jitter (2 × 0.8 / 1.2 ≈ 1.33, while a pinned
    // floor can reach 1.2 / 0.8 = 1.5), so check each step's own floor: a
    // backoff stuck at 10 s fails from the second delay on.
    const growing = delays.every((d, i) => d >= 10000 * Math.pow(2, i) * 0.8);
    check(growing, `delays grow instead of pinning at the floor: ${delays.join(', ')}`);
    check(delays[0] >= 8000 && delays[0] <= 12000, `first retry near the 10 s floor (${delays[0]}ms)`);
    check(logs.some((l) => /refused the login/i.test(l)), 'the refusal is logged, not swallowed');

    c.disconnect();
    await new Promise((r) => server.close(r));
  }

  console.log('\ngive-up latch:');
  {
    let connections = 0;
    const server = refusingNode(() => { connections++; });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    const c = new DxClusterClient();
    captureDelays(c);
    let gaveUp = null;
    c.on('status', (s) => { if (s && s.gaveUp) gaveUp = s; });

    for (let i = 0; i < 6; i++) {
      if (c._gaveUp) break;
      c.connect({ host: '127.0.0.1', port, callsign: 'W1XYZ' });
      await new Promise((r) => setTimeout(r, 120));
    }

    check(c._gaveUp === true, 'client stopped after repeated refusals');
    check(connections <= 5, `no more than 5 connections were made (${connections})`);
    check(!!gaveUp && /gave up/i.test(gaveUp.error || ''), 'give-up is reported with a reason');
    check(!!gaveUp && /W1XYZ/.test(gaveUp.error || ''), 'the message names the callsign the node refused');

    // A give-up must be recoverable by the operator, not permanent.
    c.disconnect();
    check(c._gaveUp === false, 'disconnect() clears the latch so re-enabling retries');
    await new Promise((r) => server.close(r));
  }

  console.log('\nhealthy session resets the backoff:');
  {
    // A node that sends a real spot — the only thing that should clear the
    // retry history (not "socket opened", not "we sent our callsign").
    const server = net.createServer((sock) => {
      sock.write('login: ');
      sock.once('data', () => {
        sock.write('DX de W3LPL:     14025.0  JA1ABC       CW 15 dB              1234Z\r\n');
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    const c = new DxClusterClient();
    c._reconnectAttempt = 3;   // pretend we'd been failing
    c._failedSessions = 2;
    let spot = null;
    c.on('spot', (s) => { spot = s; });
    c.connect({ host: '127.0.0.1', port, callsign: 'W1XYZ' });
    await new Promise((r) => setTimeout(r, 150));

    check(!!spot && spot.callsign === 'JA1ABC', 'spot parsed from the healthy node');
    check(c._reconnectAttempt === 0, 'a delivered spot resets the backoff');
    check(c._failedSessions === 0, 'a delivered spot clears the failure count');
    c.disconnect();
    await new Promise((r) => server.close(r));
  }

  console.log('\nconnect() must not launder the failure count:');
  {
    const c = new DxClusterClient();
    c._reconnectAttempt = 4;
    c._failedSessions = 3;
    c._teardown();
    check(c._reconnectAttempt === 4 && c._failedSessions === 3,
      '_teardown() preserves the retry history (the second reset path)');
    c.disconnect();
    check(c._reconnectAttempt === 0 && c._failedSessions === 0,
      'disconnect() — an explicit operator action — does clear it');
  }

  console.log('\nno node configured:');
  {
    const c = new DxClusterClient();
    let status = null;
    c.on('status', (s) => { status = s; });
    c.connect({ callsign: 'W1XYZ' }); // no host
    check(!!status && /no cluster node/i.test(status.error || ''),
      'refuses to connect rather than defaulting onto someone\'s node');
    check(c._socket === null, 'no socket was opened');
  }

  console.log('\nrejection detection ignores spot text:');
  {
    const c = new DxClusterClient();
    c._target = { host: 'x', port: 1, callsign: 'W1XYZ' };
    c._wantDisconnect = false;
    c.connected = true;
    c._socket = { write() {}, destroy() { c._destroyed = true; } };
    c._loggedIn = true;
    // A spot whose COMMENT contains rejection-ish words must NOT be treated
    // as the node refusing us.
    c._processLine('DX de K1ABC:     14025.0  W1XYZ        not registered yet    1234Z');
    check(!c._destroyed, 'a spot line containing "not registered" is not a rejection');
    c._processLine('Sorry, you are not registered here.');
    check(c._destroyed === true, 'a genuine rejection line ends the session');
  }

  console.log('\ncallsign shape check:');
  {
    const good = ['W3LPL', 'KD4D', '2E0ABC', 'VE3XYZ', 'K3SBP', 'W1A', 'VE3/K3SBP', 'K3SBP/P', 'K3SBP-7'];
    const bad = ['POTACAT-DEMO-1', 'potacat-demo-2', '', 'DEMO', 'hello world', 'ABCDEF', '12345'];
    check(good.every(looksLikeCallsign), `real callsigns accepted: ${good.join(' ')}`);
    check(bad.every((b) => !looksLikeCallsign(b)), `non-callsigns rejected: ${bad.join(' ')}`);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  assert.strictEqual(failed, 0, 'dxcluster backoff tests failed');
}

run().catch((err) => { console.error(err); process.exit(1); });
