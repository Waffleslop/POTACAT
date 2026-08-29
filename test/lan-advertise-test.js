#!/usr/bin/env node
'use strict';
// RemoteServer.lanAddress() — the ONE definition of "the address a client on
// the same network should dial". getLocalIPs() sorts TAILSCALE FIRST, so any
// caller taking ips[0] advertises the 100.x overlay as the LAN address; the
// phone's LAN leg then fails against an unreachable overlay and silently
// promotes cloud (K6RBJ 2026-08-26). The pairing QR fixed this in June
// (HI3NLER) and the cloud heartbeat didn't — hence one shared definition.
// Run: node test/lan-advertise-test.js
const assert = require('assert');
const { RemoteServer } = require('../lib/remote-server');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

// Shape as getLocalIPs() returns it — tailscale sorted to the front.
const TS = { name: 'Tailscale', address: '100.93.206.18', tailscale: true, tailscaleHostname: 'shack.tail1234.ts.net' };
const LAN = { name: 'Ethernet', address: '192.168.0.42', tailscale: false, tailscaleHostname: null };
const LAN2 = { name: 'Wi-Fi', address: '192.168.10.237', tailscale: false, tailscaleHostname: null };

test('K6RBJ case: tailscale first, real LAN present -> the LAN address', () => {
  assert.strictEqual(RemoteServer.lanAddress([TS, LAN]), '192.168.0.42');
});

test('tailscale-ONLY returns EMPTY, never the overlay address', () => {
  // The critical assertion. Advertising 100.x as lanHost is what made the
  // phone's LAN attempt fail; tsHost/tsIp carry the tailnet leg separately.
  assert.strictEqual(RemoteServer.lanAddress([TS]), '');
});

test('multi-homed: first non-tailscale entry, order preserved', () => {
  assert.strictEqual(RemoteServer.lanAddress([TS, LAN, LAN2]), '192.168.0.42');
  assert.strictEqual(RemoteServer.lanAddress([LAN2, LAN]), '192.168.10.237');
});

test('empty / garbage input is empty, never a throw', () => {
  assert.strictEqual(RemoteServer.lanAddress([]), '');
  assert.strictEqual(RemoteServer.lanAddress('nonsense'), '');
  assert.strictEqual(RemoteServer.lanAddress([{ name: 'x', tailscale: false }]), '');
  // null means "ask the live machine" (the no-arg contract), not a crash.
  assert.strictEqual(typeof RemoteServer.lanAddress(null), 'string');
});

test('live machine: never returns a 100.x address', () => {
  const addr = RemoteServer.lanAddress();
  assert.ok(typeof addr === 'string');
  assert.ok(!addr.startsWith('100.'), 'advertised a tailnet address as LAN: ' + addr);
});

console.log(`\nLAN advertise: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
