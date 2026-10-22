#!/usr/bin/env node
'use strict';
// A Linux shack on Tailscale whose `tailscale` command POTACAT could not run
// published NO tailnet leg: the pairing QR, the /api/pair reply and auth-ok
// carried the LAN address only, so an iPhone paired at home never reached the
// shack from anywhere else, and Settings said "Tailscale not detected"
// (Linux + iPhone, 2026-10-21). The tailnet address on the interfaces is
// evidence enough for the address leg; the CLI adds only the name.
// Run: node test/tailscale-detect-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const RS = require('../lib/remote-server');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
const R = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n');
console.log('Tailscale detection without the CLI');

test('the tailnet address comes from the interfaces: 100.64/10 only, never loopback or a LAN 100.x', () => {
  assert.strictEqual(RS.tailnetIpFromInterfaces({
    eth0: [{ family: 'IPv4', address: '192.168.1.5', internal: false }],
    tailscale0: [{ family: 'IPv4', address: '100.93.206.18', internal: false }, { family: 'IPv6', address: 'fd7a::1', internal: false }],
  }), '100.93.206.18');
  assert.strictEqual(RS.tailnetIpFromInterfaces({ eth0: [{ family: 'IPv4', address: '100.10.0.1', internal: false }] }), null, '100.10 is not a tailnet');
  assert.strictEqual(RS.tailnetIpFromInterfaces({ eth0: [{ family: 'IPv4', address: '100.127.255.1', internal: false }] }), '100.127.255.1', 'the top of the range');
  assert.strictEqual(RS.tailnetIpFromInterfaces({ eth0: [{ family: 'IPv4', address: '100.128.0.1', internal: false }] }), null, 'just past it');
  assert.strictEqual(RS.tailnetIpFromInterfaces({ lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }] }), null);
  assert.strictEqual(RS.tailnetIpFromInterfaces({}), null);
});

test('the probe state says why the CLI gave nothing', () => {
  const st = RS.tailscaleProbeState();
  assert.ok(st && typeof st.error === 'string' && 'binary' in st);
});

test('Linux looks in the snap and per-user locations, then the login shell\'s PATH', () => {
  const src = R('lib/remote-server.js');
  assert.ok(/'\/snap\/bin\/tailscale'/.test(src) && /\.local\/bin\/tailscale/.test(src));
  assert.ok(/execFileSync\('\/bin\/sh', \['-lc', 'command -v tailscale'\]/.test(src));
});

test('main publishes the interface address as the tailnet leg when the CLI gives nothing, and says why once', () => {
  const main = R('main.js');
  const at = main.indexOf('function _refreshAltHosts() {');
  const fn = main.slice(at, at + 3500);
  assert.ok(/if \(!\(ts && ts\.loggedIn\)\) \{\n\s+const ifIp = tailnetIpFromInterfaces\(\);/.test(fn));
  assert.ok(/tsIp = ifIp \+ ':' \+ port;/.test(fn));
  assert.ok(/if \(line !== _altHostsNoteLogged\)/.test(fn), 'logged on change, not every 10 minutes');
  assert.ok(/\[Pair QR\] OK — mode=\$\{effectiveMode\} lan=.*tailscale=/.test(main), 'the QR log names every leg');
  const ipc = main.slice(main.indexOf("ipcMain.handle('echocat-tailscale-status'"), main.indexOf("ipcMain.handle('echocat-tailscale-status'") + 1600);
  assert.ok(/ipFromInterfaces: ipFromInterfaces \|\| null,/.test(ipc) && /cliError: ts \? '' : \(probe\.error \|\| ''\)/.test(ipc));
  const app = R('renderer/app.js');
  assert.ok(/if \(!s\.installed && s\.ipFromInterfaces\) \{/.test(app), 'the card tells the truth');
});

test('a refused tailscale cert names the operator command (KX4MG, Linux)', () => {
  const m = RS.describeTailscaleCertError("Access denied: cert access denied\n\nUse 'sudo tailscale cert' or 'tailscale up --operator=$USER' to not require root.");
  assert.ok(/sudo tailscale set --operator=\$USER/.test(m), m);
  assert.ok(/not enabled in your Tailscale admin console/.test(RS.describeTailscaleCertError('your Tailscale account does not support getting TLS certs; HTTPS is not enabled')));
  assert.strictEqual(RS.describeTailscaleCertError('', 'boom'), 'tailscale cert failed: boom');
});

test('a failed cert never disappears silently (source guard)', () => {
  const main = R('main.js');
  assert.ok(/\[Tailscale\] Cert for \$\{ts\.hostname\} not issued/.test(main), 'ensureTailscaleCertReady logs the failure');
  assert.ok(/const certResult = await ensureTailscaleCertReady\(\(msg\) => sendCatLog\('\[Pair-Link\] '/.test(main), 'the share-link path reads the result');
});

test('Linux operators are told the operator step before and after a failure (source guard)', () => {
  const main = R('main.js'), app = R('renderer/app.js'), html = R('renderer/index.html');
  assert.ok(/certError: cached \? '' : _tailscaleCertError,/.test(main), 'status carries the last cert error');
  assert.ok(/platform: process\.platform,/.test(main), 'status carries the platform');
  assert.ok(/if \(!s\.certCached && s\.certError\)/.test(app), 'the card shows the failure');
  assert.ok(/if \(!s\.certCached && s\.platform === 'linux'\)/.test(app), 'the card names the step on Linux before any failure');
  assert.ok(/sudo tailscale set --operator=\$USER/.test(html), 'the setup steps name it');
  assert.ok(!/if \(certResult && certResult\.error\) \{\n\s+return \{ error/.test(main), 'a cert failure must not withhold the LAN pairing QR');
  assert.ok(/certWarning,\n\s+\};/.test(main) && /r\.certWarning/.test(app), 'the share-link dialog shows the reason');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
