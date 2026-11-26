#!/usr/bin/env node
'use strict';
// lib/kicked-by.js: who took the rig, as the displaced device is told
// (docs/echocat-protocol.md "kicked"). Pure; the live server path is
// test/kick-after-hello-test.js.
// Run: node test/kicked-by-test.js

const K = require('../lib/kicked-by');

let passed = 0, failed = 0;
function check(cond, label) {
  if (cond) { passed++; console.log('  ok  ' + label); }
  else { failed++; console.log('  FAIL ' + label); }
}

const TUNNEL = { 'cf-ray': '8f00-IAD', 'cf-connecting-ip': '203.0.113.7' };

console.log('this computer');
check(K.isThisComputer({}, '127.0.0.1'), '127.0.0.1 without tunnel headers is this computer');
check(K.isThisComputer({}, '::1'), '::1 is this computer');
check(K.isThisComputer({}, '::ffff:127.0.0.1'), '::ffff:127.0.0.1 is this computer');
check(!K.isThisComputer(TUNNEL, '127.0.0.1'), 'loopback with Cloud Tunnel headers is a tunnel visitor, not this computer');
check(!K.isThisComputer({ 'cf-ray': 'x' }, '127.0.0.1'), 'cf-ray alone marks the tunnel');
check(!K.isThisComputer({}, '192.168.1.20'), 'a LAN address is not this computer');
check(!K.isThisComputer({}, '100.101.102.103'), 'a Tailscale address is not this computer');

console.log('\nbyHost');
check(K.peerHost(TUNNEL, '127.0.0.1') === '203.0.113.7', 'over the tunnel: cf-connecting-ip');
check(K.peerHost({ 'cf-connecting-ip': '203.0.113.7, 10.0.0.1' }, '127.0.0.1') === '203.0.113.7', 'the first address of a list');
check(K.peerHost({ 'cf-ray': 'x' }, '127.0.0.1') === '127.0.0.1', 'tunnel without cf-connecting-ip: the socket address');
check(K.peerHost({}, '::ffff:192.168.1.20') === '::ffff:192.168.1.20', 'otherwise the socket address, unchanged');
check(K.peerHost(null, undefined) === '', 'nothing known: empty');

console.log('\nbyName');
check(K.byName({ guestCall: 'w1aw', pairedName: 'iPad', thisComputer: true }) === 'W1AW', 'a guest: the callsign, upper case, first');
check(K.byName({ pairedName: 'Casey\'s iPad', thisComputer: true }) === 'Casey\'s iPad', 'a paired device: its name, before "this computer"');
check(K.byName({ thisComputer: true }) === 'this computer', 'a local connection: "this computer"');
check(K.byName({}) === '', 'nothing known: empty');
check(K.byName({ pairedName: '   ' }) === '', 'a blank name is no name');

console.log('\nthe message');
const a = K.kickedPayload({ platform: 'web', version: 'web', host: '127.0.0.1', thisComputer: true });
check(a.type === 'kicked' && a.reason === 'Another device took over this rig', 'type and reason as before');
check(a.byPlatform === 'web' && a.byVersion === 'web' && a.byHost === '127.0.0.1', 'byPlatform, byVersion, byHost kept for older devices');
check(a.byName === 'this computer', 'byName for a local connection');
const b = K.kickedPayload({ platform: 'ios', version: '1.6.1', host: '192.168.1.20' });
check(!('byName' in b), 'byName absent when no name is known (the device falls back to byPlatform / byHost)');
const c = K.kickedPayload({});
check(c.byPlatform === '' && c.byVersion === '' && c.byHost === '', 'missing fields are empty strings, never undefined');
const d = K.kickedPayload({ platform: 'ios', host: '203.0.113.7', guestCall: 'K1ABC' });
check(d.byName === 'K1ABC' && d.byHost === '203.0.113.7', 'a guest over the tunnel: callsign and the visitor address');

console.log('\n' + '='.repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
