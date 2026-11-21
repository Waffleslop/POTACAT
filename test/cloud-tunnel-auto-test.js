#!/usr/bin/env node
'use strict';
// ECHOCAT ask 2026-11-21 "cloud trial just works", item 1 (Casey: "yes
// absolutely"): the Cloud Tunnel switches itself on when this desktop's
// account gets Cloud access (a trial from sign-up, or no access to paid), and
// never reopens a tunnel the operator turned off.
// Run: node test/cloud-tunnel-auto-test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const A = require('../lib/cloud-tunnel-auto');
const CloudBillingUi = require('../lib/cloud-billing-ui');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
}
const base = { signedIn: true, tunnelOn: false, userOff: false };

console.log('Cloud Tunnel on with Cloud access');

test('access from the Cloud card\'s own rules', () => {
  assert.strictEqual(A.accessOf(null, CloudBillingUi), 'none');
  assert.strictEqual(A.accessOf({ status: 'trial', trialActive: true }, CloudBillingUi), 'trial');
  assert.strictEqual(A.accessOf({ status: 'active' }, CloudBillingUi), 'paid');
  assert.strictEqual(A.accessOf({ status: 'expired', trialActive: false, trialExpiresAt: '2026-01-01' }, CloudBillingUi), 'none');
});

test('a trial starting, or no access to paid, turns the tunnel on', () => {
  assert.deepStrictEqual(A.decide({ ...base, prev: 'none', now: 'trial' }), { enable: true, why: 'trial-started' });
  assert.deepStrictEqual(A.decide({ ...base, prev: 'none', now: 'paid' }), { enable: true, why: 'paid' });
});

test('never: trial to paid, already on, the operator turned it off, no access, signed out', () => {
  assert.strictEqual(A.decide({ ...base, prev: 'trial', now: 'paid' }).enable, false);
  assert.strictEqual(A.decide({ ...base, prev: 'none', now: 'trial', tunnelOn: true }).enable, false);
  assert.deepStrictEqual(A.decide({ ...base, prev: 'none', now: 'paid', userOff: true }), { enable: false, why: 'operator-off' });
  assert.strictEqual(A.decide({ ...base, prev: 'none', now: 'none' }).enable, false);
  assert.strictEqual(A.decide({ ...base, signedIn: false, prev: 'none', now: 'trial' }).enable, false);
});

test('main: every billing state checks; a sign-up reads its trial at once; off/on by hand is remembered; first run only records', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.ok(/onBillingState: \(payload\) => \{ if \(remoteServer\) remoteServer\.broadcastCloudBilling\(payload\);[^}]* cloudTunnelOnWithAccess\(payload && payload\.subscription\); \}/.test(main));
  assert.ok(/if \(reason === 'register' && cloudIpc\) setTimeout\(\(\) => \{ cloudIpc\.refreshSubscription\('register'\)/.test(main), 'desktop and ECHOCAT sign-ups both end in cloudSessionChanged(register)');
  const dis = main.slice(main.indexOf("ipcMain.handle('cloud-tunnel-disable'"), main.indexOf("ipcMain.handle('cloud-tunnel-disable'") + 600);
  assert.ok(/settings\.cloudTunnelUserOff = true/.test(dis), 'off by hand is remembered');
  const en = main.slice(main.indexOf("ipcMain.handle('cloud-tunnel-enable'"), main.indexOf("ipcMain.handle('cloud-tunnel-enable'") + 1200);
  assert.ok(/delete settings\.cloudTunnelUserOff/.test(en), 'on by hand clears it');
  const fn = main.slice(main.indexOf('function cloudTunnelOnWithAccess(sub) {'), main.indexOf('function cloudTunnelOnWithAccess(sub) {') + 1500);
  assert.ok(/if \(settings\.cloudAccessSeen === undefined\) \{/.test(fn), 'an account that had access before this rule is not switched');
  assert.ok(/reason === 'signout' && settings\.cloudAccessSeen !== 'none'/.test(main), 'signed out: the next access is a new start');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
