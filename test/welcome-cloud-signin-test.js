#!/usr/bin/env node
'use strict';
// Fresh install, setup screen, "Sign in to POTACAT Cloud" → "Sign-in failed:
// Google Client ID not configured" (2026-10-21). The button called Google
// sign-in, which needs settings.cloudGoogleClientId / GOOGLE_CLIENT_ID —
// never shipped — so it could only fail. It now uses the email + password
// sign-in that Settings > Cloud uses.
// Run: node test/welcome-cloud-signin-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const R = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n');
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
console.log('Welcome screen Cloud sign-in');
const app = R('renderer/app.js'), html = R('renderer/index.html');

test('the setup screen never calls Google sign-in', () => {
  const block = app.slice(app.indexOf("const cloudBtn = document.getElementById('welcome-remote-cloud-btn');"), app.indexOf('async function checkFirstRun('));
  assert.ok(block.length > 100, 'welcome cloud block found');
  assert.ok(!/cloudGoogleSignIn/.test(block), 'no Google sign-in in the welcome flow');
  assert.ok(/await window\.api\.cloudLogin\(email, password\)/.test(block), 'email + password, the Settings > Cloud path');
  assert.ok(/if \(st && st\.loggedIn\) \{ _welcomeRemoteShowCloudShacks\(\); return; \}/.test(block), 'already signed in skips the form');
  assert.ok(/_welcomeRemoteShowCloudShacks\(\);\n\s*\} catch/.test(block), 'shows the shacks after sign-in');
});

test('the form exists and Enter submits', () => {
  for (const id of ['welcome-cloud-login', 'welcome-cloud-email', 'welcome-cloud-password', 'welcome-cloud-signin']) assert.ok(html.includes(`id="${id}"`), id);
  // Cloud 2026-10-23: the login name is an email OR a callsign (Apple relay
  // accounts). A type="email" box refuses a callsign before it is sent.
  for (const id of ['cloud-email', 'welcome-cloud-email', 'cloud-forgot-email']) {
    const m = html.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`));
    assert.ok(m && /type="text"/.test(m[0]) && /placeholder="Email or callsign"/.test(m[0]), `${id} takes a callsign`);
  }
  const ipc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'cloud-ipc.js'), 'utf8');
  assert.ok(/return \{ error: err\.message, code: err\.code \|\| undefined \};/.test(ipc), 'cloud-login hands the error code to the renderer');
  const ui = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'cloud-ui.js'), 'utf8');
  assert.ok(/result\.code === 'no_account' && email\.includes\('@'\)/.test(ui), 'no account under an email → try the callsign');
  assert.ok(/user\?\.emailIsRelay && accountCallsign\) \? 'signed in with Apple'/.test(ui), 'relay address is never shown as the account name');
  assert.ok(/msg = res\.message \|\| "No POTACAT Cloud account uses that email or callsign/.test(ui), 'forgot-password 404 shows the server message');
  assert.ok(/cloudPassword\.addEventListener\('keydown', \(e\) => \{ if \(e\.key === 'Enter'\)/.test(app));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
