#!/usr/bin/env node
'use strict';
// ECHOCAT access — the door itself (adversarial review of 1.13.9, finding 1;
// potacat-meta work/in-progress/guest-pass-authority-fixes.md part E).
//   - lib/remote-access.js: migration of the three legacy states, the
//     derived boolean, a boolean-only client cannot flip the door, the bind
//     host per level
//   - RemoteServer: `host` reaches server.listen (a real listener on
//     loopback), the log and serverState say so, mDNS stays off in Cloud only;
//     the default is still 0.0.0.0
//   - Cloud only keeps the tunnel origin reachable: lib/origin-health's probe
//     (the same request cloudflared's https://localhost:<port> ingress makes)
//     reaches the loopback-bound listener
//   - main.js / renderer wiring (source guards): Off starts no listener, the
//     forced-true block is gone, remote-status reports access, the save path
//     reconciles and restarts, the three-way control exists and is saved,
//     a device's save-settings cannot change the door
// Run: node test/remote-access-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const RA = require('../lib/remote-access');
const { RemoteServer } = require('../lib/remote-server');
const OriginHealth = require('../lib/origin-health');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
}
async function testAsync(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const root = path.join(__dirname, '..');
const mainSrc = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const rsSrc = fs.readFileSync(path.join(root, 'lib', 'remote-server.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(root, 'renderer', 'app.js'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');

console.log('lib/remote-access.js');
test('migration: enableRemote false → off; missing or true → lan; a saved level wins', () => {
  assert.deepStrictEqual(RA.normalizeRemoteAccess({ enableRemote: false }), { access: 'off', enableRemote: false, changed: true });
  assert.deepStrictEqual(RA.normalizeRemoteAccess({}), { access: 'lan', enableRemote: true, changed: true });
  assert.deepStrictEqual(RA.normalizeRemoteAccess({ enableRemote: true }), { access: 'lan', enableRemote: true, changed: true });
  assert.deepStrictEqual(RA.normalizeRemoteAccess({ remoteAccess: 'cloud', enableRemote: false }), { access: 'cloud', enableRemote: true, changed: true }, 'the level wins over a stale boolean');
  assert.deepStrictEqual(RA.normalizeRemoteAccess({ remoteAccess: 'off', enableRemote: false }), { access: 'off', enableRemote: false, changed: false }, 'already consistent');
  assert.deepStrictEqual(RA.normalizeRemoteAccess({ remoteAccess: 'bogus' }), { access: 'lan', enableRemote: true, changed: true }, 'an unknown level is the default');
  assert.strictEqual(RA.normalizeRemoteAccess(null).access, 'lan');
});
test('a patch: remoteAccess is authoritative; a boolean-only client cannot open or close the door', () => {
  assert.deepStrictEqual(RA.reconcileRemoteAccessPatch({ remoteAccess: 'off' }, { remoteAccess: 'lan', enableRemote: true }), { remoteAccess: 'off', enableRemote: false });
  assert.deepStrictEqual(RA.reconcileRemoteAccessPatch({ remoteAccess: 'cloud', enableRemote: false }, {}), { remoteAccess: 'cloud', enableRemote: true });
  assert.deepStrictEqual(RA.reconcileRemoteAccessPatch({ enableRemote: false }, { remoteAccess: 'cloud', enableRemote: true }), { enableRemote: true, remoteAccess: 'cloud' }, 'false from an old page does not close a Cloud-only door');
  assert.deepStrictEqual(RA.reconcileRemoteAccessPatch({ enableRemote: true }, { remoteAccess: 'off', enableRemote: false }), { enableRemote: false, remoteAccess: 'off' }, 'true from an old page does not open an Off door');
  assert.deepStrictEqual(RA.reconcileRemoteAccessPatch({ remoteAccess: 'nope' }, { remoteAccess: 'off' }), { remoteAccess: 'off', enableRemote: false }, 'an unknown level is ignored');
  assert.deepStrictEqual(RA.reconcileRemoteAccessPatch({ grid: 'FN20' }, { remoteAccess: 'off' }), { grid: 'FN20' }, 'a patch without either key is untouched');
});
test('the bind host and mDNS per level', () => {
  assert.strictEqual(RA.listenHostFor('lan'), '0.0.0.0');
  assert.strictEqual(RA.listenHostFor('cloud'), '127.0.0.1');
  assert.strictEqual(RA.listenHostFor('off'), null);
  assert.strictEqual(RA.listenHostFor(undefined), '0.0.0.0');
  assert.strictEqual(RA.mdnsFor('lan'), true);
  assert.strictEqual(RA.mdnsFor('cloud'), false);
  assert.strictEqual(RA.mdnsFor('off'), false);
  for (const a of RA.ACCESS) assert.ok(RA.describeRemoteAccess(a).length > 20, a);
});

(async () => {
  console.log('\nRemoteServer');
  const certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'potacat-ra-'));
  await testAsync('host reaches server.listen: Cloud only binds 127.0.0.1, says so, and starts no mDNS', async () => {
    const rs = new RemoteServer();
    const logs = [];
    rs.on('log', (l) => logs.push(l));
    rs.start(17420, 'tok', { requireToken: true, certDir, host: '127.0.0.1', mdns: false });
    await sleep(700);
    try {
      assert.strictEqual(rs.running, true, 'listening');
      const addr = rs._httpServer.address();
      assert.strictEqual(addr.address, '127.0.0.1', JSON.stringify(addr));
      assert.strictEqual(addr.port, 17420);
      assert.strictEqual(rs.serverState().host, '127.0.0.1');
      assert.ok(logs.some((l) => /Server listening on https:\/\/127\.0\.0\.1:17420 \(Cloud only — closed to the local network\)/.test(l)), logs.join(' | '));
      assert.ok(logs.some((l) => /mDNS off — ECHOCAT access is Cloud only/.test(l)), 'mDNS declined out loud');
      assert.deepStrictEqual(rs._bonjourInstances || [], [], 'no Bonjour instance');
    } finally { rs.stop(); await sleep(200); }
  });
  await testAsync('Cloud only keeps the tunnel origin reachable: the ingress probe (https://localhost:<port>) answers', async () => {
    const rs = new RemoteServer();
    rs.start(17421, 'tok', { requireToken: true, certDir, host: '127.0.0.1', mdns: false });
    await sleep(700);
    try {
      const probe = await OriginHealth.probeLocalOrigin(17421);
      assert.strictEqual(probe.ok, true, JSON.stringify(probe));
      assert.strictEqual(probe.https, true);
      const d = OriginHealth.decideOriginState({ tunnelEnabled: true, tunnelStatus: 'live', port: 17421, server: rs.serverState(), probe });
      assert.ok(d.state === 'ok' || d.state === 'port-mismatch', d.state); // the fixed ingress port is 7300; the probe itself is what this proves
    } finally { rs.stop(); await sleep(200); }
  });
  await testAsync('the default is unchanged: no host = 0.0.0.0, mDNS attempted', async () => {
    const rs = new RemoteServer();
    const logs = [];
    rs.on('log', (l) => logs.push(l));
    rs.start(17422, 'tok', { requireToken: true, certDir });
    await sleep(700);
    try {
      assert.strictEqual(rs._httpServer.address().address, '0.0.0.0');
      assert.strictEqual(rs.serverState().host, '0.0.0.0');
      assert.ok(logs.some((l) => /Server listening on https:\/\/0\.0\.0\.0:17422/.test(l)), logs.join(' | '));
      assert.ok(!logs.some((l) => /mDNS off — ECHOCAT access is Cloud only/.test(l)));
    } finally { rs.stop(); await sleep(200); }
  });

  console.log('\nmain.js wiring');
  test('Off starts no listener; the forced-true block is gone (missing → lan, never false → true)', () => {
    const i = mainSrc.indexOf('function connectRemote() {');
    const body = mainSrc.slice(i, mainSrc.indexOf('remoteServer = new RemoteServer();', i));
    assert.ok(/const remoteAccess = RemoteAccess\.normalizeRemoteAccess\(settings\)\.access;/.test(body));
    assert.ok(/if \(!settings\.enableRemote \|\| remoteAccess === 'off'\) \{[\s\S]*?return;\s*\}/.test(body), 'Off returns before a server exists');
    assert.strictEqual((mainSrc.match(/settings\.enableRemote = true;/g) || []).length, 1, 'the one remaining write is headless (Off → lan)');
    const h = mainSrc.indexOf("if (RemoteAccess.normalizeRemoteAccess(settings).access === 'off') {");
    assert.ok(h > 0 && /settings\.remoteAccess = 'lan';\s*\n\s*settings\.enableRemote = true;/.test(mainSrc.slice(h, h + 200)), 'headless: Off → lan');
    assert.ok(!/if \(!settings\.enableRemote\) \{ settings\.enableRemote = true; saveSettings\(settings\); \}/.test(mainSrc), 'the GUI forced-true line is gone');
    assert.ok(/const ra = RemoteAccess\.normalizeRemoteAccess\(settings\);\s*\n\s*if \(ra\.changed \|\| settings\.remoteAccess !== ra\.access\)/.test(mainSrc), 'startup persists the normalised level');
  });
  test('the listener gets host + mdns from the access level', () => {
    assert.ok(/host: RemoteAccess\.listenHostFor\(remoteAccess\),\s*\n\s*mdns: RemoteAccess\.mdnsFor\(remoteAccess\),/.test(mainSrc));
    assert.ok(/this\._host = \(typeof opts\.host === 'string' && opts\.host\) \? opts\.host : '0\.0\.0\.0';/.test(rsSrc));
    assert.ok(/server\.listen\(this\._port, this\._host\);/.test(rsSrc));
    assert.ok(!/server\.listen\(this\._port, '0\.0\.0\.0'\)/.test(rsSrc));
  });
  test('remote-status reports access, in the IPC and in the diagnostic snapshot', () => {
    const n = (mainSrc.match(/return \{ enabled: false, access: 'off', listening: false/g) || []).length;
    assert.strictEqual(n, 2, 'echocat-server-state-get and the snapshot localServer');
    assert.strictEqual((mainSrc.match(/Object\.assign\(\{ enabled: true, access \}/g) || []).length, 2);
  });
  test('the save path reconciles the level and restarts the listener on a change', () => {
    assert.ok(/if \(has\('remoteAccess'\) \|\| has\('enableRemote'\)\) RemoteAccess\.reconcileRemoteAccessPatch\(newSettings, settings\);/.test(mainSrc));
    assert.ok(/\(has\('remoteAccess'\) && newSettings\.remoteAccess !== settings\.remoteAccess\) \|\|/.test(mainSrc), 'remoteChanged sees the level');
  });
  test('settings load normalises the level; remoteAccess is machine-scoped (GLOBAL_KEYS); a device cannot change the door', () => {
    assert.ok(/function _normalizeLoadedSettings\(s\) \{\s*\n\s*const ra = RemoteAccess\.normalizeRemoteAccess\(s\);\s*\n\s*s\.remoteAccess = ra\.access;\s*\n\s*s\.enableRemote = ra\.enableRemote;/.test(mainSrc));
    assert.strictEqual((mainSrc.match(/return _normalizeLoadedSettings\(/g) || []).length, 2, 'both disk-load returns (global-only and profile+global)');
    const gk = mainSrc.slice(mainSrc.indexOf('const GLOBAL_KEYS = new Set(['), mainSrc.indexOf(']);', mainSrc.indexOf('const GLOBAL_KEYS = new Set([')));
    assert.ok(/'remoteAccess',/.test(gk), 'in GLOBAL_KEYS');
    const i = mainSrc.indexOf("remoteServer.on('save-settings', (partial) => {");
    assert.ok(/if \(partial\) \{ delete partial\.remoteAccess; delete partial\.enableRemote; \}/.test(mainSrc.slice(i, i + 3000)), 'a device partial loses both keys');
  });
  test('the Cloud card says the Cloud address and Guest Pass are unavailable when Off', () => {
    assert.ok(/lastError: 'ECHOCAT access is Off, so the Cloud address and Guest Pass are unavailable/.test(mainSrc));
  });

  console.log('\nrenderer');
  test('Settings > ECHOCAT has the three-way control and saves the level with the derived boolean', () => {
    assert.ok(/<select id="set-remote-access"[^>]*>\s*<option value="lan">Local network and Cloud<\/option>\s*<option value="cloud">Cloud only<\/option>\s*<option value="off">Off<\/option>/.test(htmlSrc));
    assert.ok(/const remoteEnabled = remoteAccessVal !== 'off';/.test(appSrc), 'derived');
    assert.ok(/remoteAccess: remoteAccessVal,/.test(appSrc), 'saved');
    assert.ok(!/const remoteEnabled = true;/.test(appSrc), 'the always-on constant is gone');
    assert.ok(/setRemoteAccess\.value = remoteAccess; updateRemoteAccessHelp\(\);/.test(appSrc), 'loaded');
    assert.ok(/REMOTE_ACCESS_HELP = \{[\s\S]*off: 'No phone, web or Cloud access\. The Cloud address and Guest Pass are unavailable while this is off\.'/.test(appSrc));
    assert.ok(/if \(access === 'off'\) web = \{ access: 'off' \};/.test(appSrc), 'the ECHOCAT card knows Off');
    assert.ok(/web\.access === 'cloud'/.test(appSrc), 'and Cloud only');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
