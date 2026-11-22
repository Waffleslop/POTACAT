#!/usr/bin/env node
'use strict';
// ECHOCAT ask 2026-11-21 "cloud trial just works", item 3 (Casey: "yes"; it
// changes "the door is set at the desktop only" for this one case): an owner
// device may turn the shack's Cloud Tunnel ON, only while the account has
// Cloud access. A Guest Pass never may. Off stays a desktop choice.
// Run: node test/cloud-tunnel-enable-remote-test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { RemoteServer } = require('../lib/remote-server');
const GPA = require('../lib/guest-pass-authority');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
}
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

console.log('Cloud Tunnel on from an owner device');

test('remote-server: an owner\'s request reaches main and gets cloud-tunnel-result; a guest is refused', () => {
  const src = read('lib/remote-server.js');
  const c = src.slice(src.indexOf("case 'cloud-tunnel-enable':"), src.indexOf("case 'cloud-stripe-portal':"));
  assert.ok(/if \(ws\._passSession\) \{ this\._sendTo\(ws, \{ type: 'cloud-tunnel-result', ok: false, error: 'guest_pass' \}\); break; \}/.test(c));
  assert.ok(/this\.emit\('cloud-tunnel-enable', \(result\) => this\._sendTo\(ws, \{ type: 'cloud-tunnel-result', ok: false, \.\.\.result \}\)\)/.test(c));
  assert.ok(src.includes("'cloud-tunnel-enable',"), 'hello capability');
});

test('the Guest Pass authority accounts for it (refused inside, with a reply)', () => {
  const src = read('lib/guest-pass-authority.js');
  assert.ok(/'cloud-stripe-checkout', 'cloud-tunnel-enable',/.test(src));
  assert.ok(GPA);
});

test('main: only with Cloud access; signed out or no access says why; never turns it off', async () => {
  const main = read('main.js');
  const at = main.indexOf("cloudBridge('cloud-tunnel-enable'");
  assert.ok(at > 0);
  const fn = main.slice(at, main.indexOf('});', at) + 3);
  assert.ok(/if \(!settings\.cloudAccessToken\) return \{ ok: false, error: 'signed_out'/.test(fn));
  assert.ok(/if \(!CloudBillingUi\.hasAccess\(settings\.cloudSubscriptionCache\)\) return \{ ok: false, error: 'no_access'/.test(fn));
  assert.ok(/await cloudTunnel\.enable\(\{\}\)/.test(fn));
  assert.ok(!/\.disable\(/.test(fn), 'a device never turns it off');
  assert.ok(main.lastIndexOf('onRemoteServer(', at) > 0, 'inside an onRemoteServer block');
});

test('protocol registry', () => {
  const src = read('lib/echocat-protocol.js');
  assert.ok(/'cloud-tunnel-enable': \{ dir: Dir\.C2S, feature: 'cloud' \}/.test(src));
  assert.ok(/'cloud-tunnel-result': \{ dir: Dir\.S2C, feature: 'cloud', fields: \{ ok: f\.boolean, error: f\.optString, message: f\.optString \} \}/.test(src));
  assert.ok(new RemoteServer());
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
