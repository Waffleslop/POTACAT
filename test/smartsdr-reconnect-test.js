// SmartSDR reconnect state machine — fast retries → single give-up →
// background probe (storm-recovery, K3SBP 2026-07-06). No sockets: _doConnect
// is stubbed; we drive _scheduleReconnect directly the way a failed dial does.
// Run: node test/smartsdr-reconnect-test.js
'use strict';

const assert = require('assert');
const { SmartSdrClient } = require('../lib/smartsdr');

let passed = 0, failed = 0;
function check(cond, label) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ FAIL: ' + label); }
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  const c = new SmartSdrClient();
  c._host = '192.168.1.50';
  c._probeIntervalMs = 40; // shrink the 60 s probe for the test
  let dials = 0;
  c._doConnect = () => { dials++; c._scheduleReconnect(); }; // every dial fails
  let giveUps = 0;
  c.on('give-up', () => giveUps++);

  // Failures 1 and 2 arm the fast backoff timer (5 s/10 s — we won't wait
  // for them; just verify state).
  c._scheduleReconnect();
  check(c._connectFailures === 1 && !c._gaveUp && !!c._reconnectTimer, 'failure 1 → fast retry armed');
  clearTimeout(c._reconnectTimer); c._reconnectTimer = null; // simulate timer elapsed
  c._scheduleReconnect();
  check(c._connectFailures === 2 && !c._gaveUp, 'failure 2 → still fast path');
  clearTimeout(c._reconnectTimer); c._reconnectTimer = null;

  // Failure 3 → give-up emitted ONCE, probe armed instead of dead stop.
  c._scheduleReconnect();
  check(c._gaveUp === true && giveUps === 1, 'failure 3 → gave up, banner event fired once');
  check(!!c._probeTimer && !c._reconnectTimer, 'background probe armed after give-up');

  // Probe fires → dials again; dial fails → probe re-armed, NO second give-up.
  await sleep(60);
  check(dials === 1, 'probe dialed the radio');
  check(giveUps === 1, 'failed probe does not re-emit give-up (no banner spam)');
  check(!!c._probeTimer, 'probe re-armed after failure');

  // Second probe cycle keeps going (radio still off).
  await sleep(60);
  check(dials === 2 && giveUps === 1, 'probing continues indefinitely, quietly');

  // Radio comes back: successful connect resets state (mirrors the
  // sock.on(connect) handler). Then a later failure starts a FRESH cycle.
  c.connected = true; c._connectFailures = 0; c._gaveUp = false;
  clearTimeout(c._probeTimer); c._probeTimer = null;
  c.connected = false;
  c._scheduleReconnect();
  check(c._connectFailures === 1 && !c._gaveUp && !!c._reconnectTimer, 'post-recovery failure starts a fresh fast cycle');
  clearTimeout(c._reconnectTimer); c._reconnectTimer = null;

  // disconnect() clears the probe so an intentional teardown stays down.
  c._scheduleProbe();
  check(!!c._probeTimer, 'probe armed');
  c.disconnect();
  check(c._probeTimer === null, 'disconnect() clears the background probe');

  console.log(`\n${passed} passed, ${failed} failed`);
  assert.strictEqual(failed, 0, 'smartsdr reconnect tests failed');
})();
