#!/usr/bin/env node
'use strict';
// ECHOCAT ask 2026-11-21 ("cloud trial just works", item 2; Casey: "yes"):
// the shack tells its own devices its Cloud state, so the phone need not
// poll cloud-get-status: auth-ok carries `cloud: {signedIn, access:
// 'trial'|'paid'|'none', trialEndsAt?, tunnel: 'on'|'off'}` and changes come
// as cloud-state (capability cloud-state). A Guest Pass session never gets it.
// Run: node test/cloud-state-test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { RemoteServer } = require('../lib/remote-server');
const P = require('../lib/echocat-protocol');
const CloudBillingUi = require('../lib/cloud-billing-ui');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
}
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

console.log('Cloud state to the shack\'s devices');

test('remote-server: cloud-state goes to owner devices on change only, never to a Guest Pass', () => {
  const rs = new RemoteServer();
  const sent = [];
  const owner = { readyState: 1, _authenticated: true, tag: 'owner' };
  const guest = { readyState: 1, _authenticated: true, _passSession: { code: 'X' }, tag: 'guest' };
  rs._wss = { clients: new Set([owner, guest]) };
  rs._sendTo = (ws, msg) => sent.push([ws.tag, msg]);
  const st = { signedIn: true, access: 'trial', trialEndsAt: '2026-12-21T00:00:00.000Z', tunnel: 'off' };
  rs.setCloudState(st);
  rs.setCloudState({ ...st });            // same: nothing new
  rs.setCloudState({ ...st, tunnel: 'on' });
  assert.deepStrictEqual(sent.map(([t, m]) => [t, m.type, m.tunnel]), [['owner', 'cloud-state', 'off'], ['owner', 'cloud-state', 'on']]);
  assert.deepStrictEqual(rs._cloudFor(owner), { ...st, tunnel: 'on' }, 'auth-ok cloud for an owner');
  assert.strictEqual(rs._cloudFor(guest), undefined, 'none for a guest');
});

test('auth-ok carries cloud at every owner admission, and the hello lists cloud-state', () => {
  const src = read('lib/remote-server.js');
  // One owner auth-ok (_ownerAuthOk), used by both owner admissions (a
  // credential: _finishWsAuth; no token required, on the hello:
  // _admitLocalTrust); the Guest Pass auth-ok carries none.
  assert.strictEqual((src.match(/type: 'auth-ok', cloud: this\._cloudFor\(ws\)/g) || []).length, 1);
  for (const fn of ['_finishWsAuth(ws, req) {', '_admitLocalTrust(ws, req) {']) {
    const from = src.slice(src.indexOf(fn));
    const body = from.slice(0, from.search(/\r?\n  \}\r?\n/)); // CRLF main checkout, LF worktree
    assert.ok(body.includes('this._sendTo(ws, this._ownerAuthOk(ws));'), fn + ' sends the owner auth-ok');
  }
  assert.ok(src.includes("'cloud-state',"));
});

test('the protocol registry knows cloud-state and auth-ok.cloud', () => {
  const src = read('lib/echocat-protocol.js');
  assert.ok(/'cloud-state': \{ dir: Dir\.S2C, feature: 'handshake', fields: \{ signedIn: f\.boolean, access: f\.oneOf\(\['trial', 'paid', 'none'\]\), trialEndsAt: f\.optString, tunnel: f\.oneOf\(\['on', 'off'\]\) \} \}/.test(src));
  assert.ok(/'auth-ok': \{ dir: Dir\.S2C, feature: 'handshake', fields: \{ cloud: f\.optObject,/.test(src));
  assert.ok(P);
});

test('main: access is trial / paid / none from the cached subscription; the tunnel from the tunnel', () => {
  const main = read('main.js');
  const fn = main.slice(main.indexOf('function cloudStateNow() {'), main.indexOf('function pushCloudState() {'));
  const run = (settings, enabled) => {
    // eslint-disable-next-line no-new-func
    return new Function('settings', 'cloudTunnel', 'CloudBillingUi', fn + '\nreturn cloudStateNow();')(settings, { getState: () => ({ enabled }) }, CloudBillingUi);
  };
  assert.deepStrictEqual(run({}, false), { signedIn: false, access: 'none', tunnel: 'off' });
  const trial = run({ cloudAccessToken: 't', cloudSubscriptionCache: { status: 'trial', trialActive: true, trialExpiresAt: '2026-12-21T00:00:00Z' } }, true);
  assert.deepStrictEqual(trial, { signedIn: true, access: 'trial', tunnel: 'on', trialEndsAt: '2026-12-21T00:00:00.000Z' });
  assert.strictEqual(run({ cloudAccessToken: 't', cloudSubscriptionCache: { status: 'active' } }, false).access, 'paid');
  assert.strictEqual(run({ cloudAccessToken: 't', cloudSubscriptionCache: { status: 'expired', trialActive: false, trialExpiresAt: '2026-01-01' } }, false).access, 'none');
  // Pushed on billing state, sign-in/out and tunnel changes, and seeded when the server starts.
  assert.ok(/onBillingState: \(payload\) => \{ if \(remoteServer\) remoteServer\.broadcastCloudBilling\(payload\); pushCloudState\(\);/.test(main));
  assert.ok(/onCloudSessionChanged: \(reason\) => \{\n\s*pushCloudState\(\);/.test(main));
  assert.ok(/cloudTunnel\.on\('change', \(state\) => \{[\s\S]{0,200}pushCloudState\(\);/.test(main));
  assert.ok(/remoteServer = new RemoteServer\(\);[\s\S]{0,300}\n  pushCloudState\(\); \/\/ auth-ok carries/.test(main));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
