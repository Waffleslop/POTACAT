// VFO tune-echo: the desktop must push the tuned frequency to the client the
// instant a `tune` arrives, not wait for the next CAT poll (500ms rigctld /
// 1000ms serial). Regression for N3VD/W7RTA: the native mobile readout only
// moved once spinning stopped, because status was poll-driven while the web
// client updated its own readout locally. The fix reuses the existing
// _postTuneFreqTarget substitution in broadcastRadioStatus.
// Run: node test/remote-tune-echo-test.js
'use strict';

const assert = require('assert');
const { RemoteServer } = require('../lib/remote-server');

let passed = 0, failed = 0;
function check(cond, label) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ FAIL: ' + label); }
}

// A server with a stubbed, authenticated client socket and a prior full status
// snapshot (as the CAT poll would have left it). No network, no timers.
function makeServer(priorFreqHz) {
  const sent = [];
  const s = new RemoteServer();
  const ws = { readyState: 1, _authenticated: true, send: (str) => sent.push(JSON.parse(str)) };
  s._client = ws;                                  // WebSocket.OPEN === 1
  s._radioStatus = { freq: priorFreqHz, mode: 'USB' };
  return { s, ws, sent };
}

console.log('tune echoes the requested freq immediately:');
{
  const { s, sent } = makeServer(14264000);
  s._handleMessage(s._client, { type: 'tune', freqKhz: '14265' }, {});
  const statuses = sent.filter(m => m.type === 'status');
  check(statuses.length === 1, 'tune triggers exactly one immediate status push');
  check(statuses[0] && statuses[0].freq === 14265000, 'pushed status carries the target freq (14265000 Hz), not the stale poll value');
  check(s._postTuneFreqTarget === 14265000, 'optimistic-echo pin stays armed until the rig confirms');
}

console.log('pin releases once the rig-reported freq matches:');
{
  const { s } = makeServer(14264000);
  s._handleMessage(s._client, { type: 'tune', freqKhz: '14265' }, {});
  // Next CAT poll reports the confirmed frequency (within 25 Hz).
  s.broadcastRadioStatus({ freq: 14265000 });
  check(s._postTuneFreqTarget === 0, 'pin clears when the rig-reported freq reaches the target');
}

console.log('rapid second tune is rate-limited (protects the rig/CAT bus):');
{
  const { s, sent } = makeServer(14264000);
  s._handleMessage(s._client, { type: 'tune', freqKhz: '14265' }, {});
  const after1 = sent.filter(m => m.type === 'status').length;
  s._handleMessage(s._client, { type: 'tune', freqKhz: '14266' }, {}); // <500ms later
  const after2 = sent.filter(m => m.type === 'status').length;
  check(after1 === 1 && after2 === 1, 'a second tune within 500ms does not push an extra status');
}

console.log('a locked VFO neither tunes nor echoes:');
{
  const { s, sent } = makeServer(14264000);
  s._vfoLocked = true;
  s._handleMessage(s._client, { type: 'tune', freqKhz: '14265' }, {});
  check(!sent.some(m => m.type === 'status'), 'no status echo when the VFO is locked');
  check(sent.some(m => m.type === 'tune-blocked'), 'client is told the VFO is locked');
}

console.log(`\n${passed} passed, ${failed} failed`);
assert.strictEqual(failed, 0, 'remote tune-echo tests failed');
