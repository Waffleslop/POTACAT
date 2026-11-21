#!/usr/bin/env node
'use strict';
// ECHOCAT ask 2026-11-21 "cloud trial just works", item 4 (Casey: yes):
// - the Cloud form opens on starting a trial for a desktop that never had an account;
// - one label for the tunnel button everywhere: "Turn on Cloud Tunnel";
// - Buy Me a Coffee is not offered to new subscribers while Stripe works (the
//   "Already paying on Buy Me a Coffee?" box stays for people paying there);
// - a sign-up from ECHOCAT turns on Cloud Sync, like the desktop's own.
// Run: node test/cloud-signup-tidy-test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
}

console.log('Cloud sign-up tidy-up');

test('the form opens on a trial for a desktop that never signed in', () => {
  const ui = read('renderer/cloud-ui.js');
  assert.ok(/if \(s && !s\.cloudAccessToken && !s\.cloudUser && !s\.cloudEverSignedIn\) setCloudAuthMode\('register'\);/.test(ui));
  const main = read('main.js');
  assert.ok(/reason !== 'signout' && settings\.cloudAccessToken && !settings\.cloudEverSignedIn\) \{ settings\.cloudEverSignedIn = true;/.test(main));
});

test('one tunnel button label', () => {
  const all = ['renderer/index.html', 'renderer/cloud-ui.js', 'renderer/app.js'].map(read).join('\n');
  assert.ok(!/Enable POTACAT Cloud( Tunnel)?</.test(all) && !/'Enable POTACAT Cloud'/.test(all) && !/Enable POTACAT Cloud Tunnel/.test(all), 'old labels gone');
  assert.ok(/id="cloud-tunnel-enable-btn" class="btn btn-primary">Turn on Cloud Tunnel</.test(read('renderer/index.html')));
});

test('Buy Me a Coffee hidden from new subscribers while Stripe works', () => {
  const ui = read('renderer/cloud-ui.js');
  assert.ok(/subscribeBtn\.classList\.toggle\('hidden', !!d\.subscribe\.stripe\)/.test(ui));
  assert.ok(!/Prefer Buy Me a Coffee\?'/.test(ui));
  assert.ok(/Already paying on Buy Me a Coffee\?/.test(read('renderer/index.html')), 'existing members keep the verify box');
});

test('an ECHOCAT sign-up turns on Cloud Sync', () => {
  const main = read('main.js');
  const at = main.indexOf("cloudBridge('cloud-register'");
  const fn = main.slice(at, main.indexOf('});', at));
  assert.ok(/settings\.cloudSyncEnabled = true;/.test(fn));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
