// DX cluster login handshake — callsign-only nodes, DXSpider compat, and
// password-auth feeds (HamAlert telnet, G5HOW request). Run:
//   node test/dxcluster-login-test.js
'use strict';

const assert = require('assert');
const { DxClusterClient } = require('../lib/dxcluster');

let passed = 0, failed = 0;
function check(cond, label) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ FAIL: ' + label); }
}

// Build a client with the socket layer stubbed out: _write captures what
// would go over the wire; feed() pushes server lines through _onData.
function makeClient(target) {
  const c = new DxClusterClient();
  c._target = Object.assign({ host: 'x', port: 1, callsign: '', password: '' }, target);
  c._wantDisconnect = false;
  c.connected = true;
  c._socket = { write() {} };
  c.sent = [];
  c._write = (data) => { c.sent.push(data.replace(/\r\n$/, '')); };
  c._startKeepalive = () => {}; // no timers in tests
  c.feed = (line) => c._onData(Buffer.from(line + '\r\n'));
  return c;
}

console.log('callsign-only node (unchanged behavior):');
{
  const c = makeClient({ callsign: 'K3SBP' });
  c.feed('login:');
  check(c.sent.length === 1 && c.sent[0] === 'K3SBP', 'login: prompt → callsign sent');
  check(c._loggedIn === true, 'logged in immediately (no password configured)');
  let spot = null;
  c.on('spot', (s) => { spot = s; });
  c.feed('DX de W3LPL:     14025.0  JA1ABC       CW 15 dB              1234Z');
  check(!!spot && spot.callsign === 'JA1ABC', 'spot line parses after login');
}

console.log('DXSpider compat (password prompt, none configured):');
{
  const c = makeClient({ callsign: 'K3SBP' });
  c.feed('password:');
  check(c.sent.length === 1 && c.sent[0] === 'K3SBP', 'password: → callsign re-sent (compat)');
  check(c._loggedIn === false, 'not logged in yet');
  c.feed('K3SBP de W3LPL >');
  check(c.sent.length === 2 && c._loggedIn === true, '> prompt then finishes the handshake');
}

console.log('password-auth feed (HamAlert shape):');
{
  const c = makeClient({ callsign: 'gavinh', password: 'hunter2' });
  c.feed('HamAlert (telnet)');
  check(c.sent.length === 0, 'greeting alone sends nothing');
  c.feed('login:');
  check(c.sent.length === 1 && c.sent[0] === 'gavinh', 'login: → username sent (case preserved)');
  check(c._loggedIn === false, 'NOT logged in yet — waiting for password prompt');
  check(!!c._loginFallbackTimer, 'fallback timer armed while waiting');
  c.feed('password:');
  check(c.sent.length === 2 && c.sent[1] === 'hunter2', 'password: → password sent');
  check(c._loggedIn === true, 'logged in after password');
  check(c._loginFallbackTimer === null, 'fallback timer cleared');
  let spot = null;
  c.on('spot', (s) => { spot = s; });
  c.feed('DX de HamAlert:  18100.0  G5HOW        FT8 -9 dB             0806Z');
  check(!!spot && spot.callsign === 'G5HOW' && spot.spotter === 'HamAlert', 'HamAlert spot line parses');
  c.disconnect();
}

console.log('password configured but server never asks:');
{
  const c = makeClient({ callsign: 'K3SBP', password: 'oops' });
  c.feed('login:');
  check(c._loggedIn === false && !!c._loginFallbackTimer, 'waits with fallback armed');
  c._finishLogin(); // what the 8s fallback timer fires
  check(c._loggedIn === true, 'fallback completes the handshake');
  c._finishLogin();
  check(c._loggedIn === true, '_finishLogin is idempotent');
  c.disconnect();
  check(c._loginFallbackTimer === null && c._sentLogin === false, 'disconnect clears login state');
}

console.log('login prompt not answered twice:');
{
  const c = makeClient({ callsign: 'gavinh', password: 'hunter2' });
  c.feed('login:');
  c.feed('login:'); // e.g. echo or a second prompt line before password
  check(c.sent.length === 1, 'second login: prompt ignored (_sentLogin latch)');
  c.disconnect();
}

console.log(`\n${passed} passed, ${failed} failed`);
assert.strictEqual(failed, 0, 'dxcluster login tests failed');
