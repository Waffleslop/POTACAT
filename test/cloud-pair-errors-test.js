'use strict';
// Pairing a second desktop with a shack through POTACAT Cloud (2026-11-17).
// The operator saw "Pair failed: cloud authorize failed: client_not_registered".
// Now: this computer registers itself before it asks Cloud for a pair token,
// every Cloud answer reads as plain words, a device id another account holds
// is replaced once, and a settings export never carries this computer's id.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const E = require('../lib/cloud-pair-errors');
const { stripSecrets, restoreSecrets } = require('../lib/settings-secrets');

let passed = 0;
function t(name, fn) { fn(); passed++; console.log('  ok ' + name); }
const err = (code, extra) => Object.assign(new Error('HTTP 404'), { code }, extra || {});

t('client_not_registered reads as plain words with the way out', () => {
  assert.strictEqual(E.cloudPairErrorText(err('client_not_registered')),
    'This computer is not listed in your POTACAT Cloud account yet. Sign out of Cloud and back in, then try again, or use the pairing link from the shack.');
});

t('every code the authorize and register routes return has its own sentence', () => {
  const codes = ['client_not_registered', 'shack_not_found', 'same_device', 'cannot_pair_self',
    'device_id_in_use', 'device_limit_reached', 'validation_error', 'clientDeviceId required',
    'authorize_failed', 'register_failed'];
  const seen = new Set();
  for (const c of codes) {
    const s = E.cloudPairErrorText(err(c));
    assert.ok(s && !s.includes(c), `${c} has plain text without the raw code: ${s}`);
    assert.ok(!/cloud authorize failed/i.test(s), c);
    assert.ok(/[.]$/.test(s), `${c} ends as a sentence`);
    seen.add(s);
  }
  // same_device and cannot_pair_self are one case; the two failed-on-our-side
  // codes share one sentence; validation_error and its old spelling share one.
  assert.ok(seen.size >= 7);
});

t('the code is read from err.code, a bare message, or a 5xx message', () => {
  const want = E.cloudPairErrorText(err('shack_not_found'));
  assert.strictEqual(E.cloudPairErrorText(new Error('shack_not_found')), want);
  assert.strictEqual(E.cloudPairErrorText('shack_not_found'), want);
  assert.strictEqual(E.cloudPairErrorText(new Error('POTACAT cloud error (HTTP 500): authorize_failed')),
    E.cloudPairErrorText(err('authorize_failed')));
});

t('an expired sign-in and no network each say what to do', () => {
  assert.match(E.cloudPairErrorText(new Error('AUTH_EXPIRED')), /sign in again/i);
  assert.match(E.cloudPairErrorText(Object.assign(new Error('getaddrinfo ENOTFOUND api.potacat.com'), { code: 'ENOTFOUND' })), /could not reach POTACAT Cloud/);
  assert.match(E.cloudPairErrorText(new Error('Request timeout')), /could not reach POTACAT Cloud/);
});

t('an unknown code gets a plain sentence with the code in brackets', () => {
  assert.strictEqual(E.cloudPairErrorText(err('weird_thing')),
    'Cloud pairing did not work (weird_thing). Try again, or use the pairing link from the shack.');
  assert.strictEqual(E.cloudPairErrorText(null),
    'Cloud pairing did not work (unknown). Try again, or use the pairing link from the shack.');
});

t('a failed registration says this computer could not be added', () => {
  assert.match(E.cloudRegisterErrorText(err('register_failed')), /could not add this computer/i);
  assert.match(E.cloudRegisterErrorText(err('odd')), /\(odd\)/);
  // Known codes keep their own sentence.
  assert.strictEqual(E.cloudRegisterErrorText(err('device_limit_reached')), E.cloudPairErrorText(err('device_limit_reached')));
});

t('only device_id_in_use on registration means a new device id', () => {
  assert.strictEqual(E.shouldRotateDeviceId(err('device_id_in_use')), true);
  assert.strictEqual(E.shouldRotateDeviceId(err('device_limit_reached')), false);
  assert.strictEqual(E.shouldRotateDeviceId(new Error('Request timeout')), false);
  assert.strictEqual(E.shouldRotateDeviceId(null), false);
});

t('a settings export never carries this computer\'s Cloud device id', () => {
  const out = stripSecrets({ cloudDeviceId: 'aaaa-1111', callsign: 'K3SBP' });
  assert.ok(!('cloudDeviceId' in out));
  assert.strictEqual(out.callsign, 'K3SBP');
});

t('an import keeps this computer\'s Cloud device id, even from an old export that has one', () => {
  const imported = restoreSecrets({ cloudDeviceId: 'other-pc', callsign: 'K3SBP' }, { cloudDeviceId: 'this-pc' });
  assert.strictEqual(imported.cloudDeviceId, 'this-pc');
  const fresh = restoreSecrets({ cloudDeviceId: 'other-pc' }, {});
  assert.ok(!('cloudDeviceId' in fresh), 'no id here: the import does not bring one');
});

// Wiring in main.js (glue only).
const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const fnStart = main.indexOf('async function cloudPairShackById(');
const fnBody = main.slice(fnStart, main.indexOf('_doPairAccountRedeem(', fnStart));

t('pairing registers this computer before it asks Cloud for a token, and stops if that fails', () => {
  assert.ok(fnStart > 0);
  const reg = fnBody.indexOf('ensureCloudDeviceRegistered(');
  const auth = fnBody.indexOf('authorizePair(');
  assert.ok(reg > 0 && auth > reg, 'register comes before authorize');
  assert.ok(/cloudRegisterErrorText\(/.test(fnBody.slice(reg, auth)), 'a failed registration returns its own plain text');
});

t('the authorize failure is mapped, without the old prefix', () => {
  assert.ok(!main.includes("'cloud authorize failed: '"));
  assert.ok(/cloudPairErrorText\(err\)/.test(fnBody));
});

t('registration replaces a device id another account holds, once', () => {
  const s = main.indexOf('async function ensureCloudDeviceRegistered(');
  const body = main.slice(s, main.indexOf('_cloudDeviceHeartbeatTimer = setInterval', s));
  assert.ok(/shouldRotateDeviceId\(/.test(body));
  assert.ok(/randomUUID\(\)/.test(body.slice(body.indexOf('shouldRotateDeviceId('))));
  assert.ok(/return \{ error/.test(body), 'a failure is returned to the caller, not only logged');
});

console.log(`cloud-pair-errors-test: ${passed} passed`);
