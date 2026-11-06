// test/qrz-login-message-test.js — K0DHW (2026-11-04): Settings > Logging said
// he had no QRZ account. A login that works on an account with no XML Data
// subscription read "No active QRZ XML subscription" in red; a rejected
// password showed QRZ's raw text. One plain sentence per situation.
'use strict';
const { readSrc } = require('./_src');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { describeQrzLogin } = require('../lib/qrz');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
}
const now = new Date('2026-11-04T12:00:00Z');
console.log('QRZ login message:');
t('signed in, no XML subscription: says the login is fine', () => {
  const r = describeQrzLogin({ loggedIn: true, subExp: 'non-subscriber', username: 'k0dhw', now });
  assert.strictEqual(r.ok, true); assert.strictEqual(r.subscriber, false);
  assert.ok(/Signed in to QRZ as K0DHW/.test(r.text) && /no XML Data subscription/.test(r.text) && /login itself is fine/.test(r.text), r.text);
});
t('subscriber and lapsed subscriber', () => {
  assert.ok(/active through 2027-01-01/.test(describeQrzLogin({ loggedIn: true, subExp: '2027-01-01', now }).text));
  assert.ok(/ended 2026-01-01/.test(describeQrzLogin({ loggedIn: true, subExp: '2026-01-01', now }).text));
});
t('wrong password, unknown user, network: three different sentences', () => {
  assert.ok(/did not accept the username and password/.test(describeQrzLogin({ loggedIn: false, error: 'QRZ login failed: Username/password incorrect' }).text));
  assert.ok(/no account with the username W1XYZ/.test(describeQrzLogin({ loggedIn: false, error: 'Not found: w1xyz', username: 'w1xyz' }).text));
  assert.ok(/Could not reach QRZ/.test(describeQrzLogin({ loggedIn: false, error: 'QRZ login network error: getaddrinfo ENOTFOUND xmldata.qrz.com' }).text));
});
t('both status paths in Settings use the one function, amber for a working login', () => {
  const app = readSrc(path.join(__dirname, '..', 'renderer', 'app.js')).replace(/\r\n/g, '\n');
  assert.ok(app.includes('window.api.qrzCheckSub().then(showQrzLoginStatus)'), 'on load');
  assert.ok(app.includes('showQrzLoginStatus(await window.api.qrzCheckSub(true));'), 'Recheck');
  assert.ok(/qrzSubStatus\.style\.color = '#f0a500';/.test(app));
  const main = readSrc(path.join(__dirname, '..', 'main.js'));
  assert.ok(main.includes("text: describeQrzLogin({ loggedIn: false, error: err.message, username }).text"));
});
console.log('\nQRZ login message: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
