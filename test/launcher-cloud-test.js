#!/usr/bin/env node
'use strict';
/**
 * Restart POTACAT from anywhere (docs/remote-launcher-anywhere-scope.md;
 * Casey 2026-10-27: option A, on by default). The Remote Launcher accepts an
 * ECHOCAT paired-device token from anywhere and the callsign only from the
 * LAN/tailnet, answers under /launcher/ for the Cloud Tunnel, shows nothing
 * anonymous through it, and runs its own cloudflared connector on the
 * tunnel so the shack answers while POTACAT is down.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { EventEmitter } = require('events');

const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); }
}

// A scratch config dir: the global settings file and two operator profiles.
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-cloud-'));
const TOKEN_A = 'a'.repeat(64), TOKEN_B = 'b'.repeat(64), TOKEN_OLD = 'c'.repeat(64);
fs.writeFileSync(path.join(DIR, 'settings.json'), JSON.stringify({ activeProfile: 'K3SBP', pairedDevices: [{ id: 'root', token: TOKEN_A }] }));
fs.mkdirSync(path.join(DIR, 'profiles', 'K3SBP'), { recursive: true });
fs.mkdirSync(path.join(DIR, 'profiles', 'W7RTA'), { recursive: true });
fs.writeFileSync(path.join(DIR, 'profiles', 'K3SBP', 'settings.json'), JSON.stringify({ myCallsign: 'K3SBP', pairedDevices: [{ id: 'old', token: TOKEN_OLD, expiresAt: 1000 }] }));
fs.writeFileSync(path.join(DIR, 'profiles', 'W7RTA', 'settings.json'), JSON.stringify({ myCallsign: 'W7RTA', pairedDevices: [{ id: 'w7', token: TOKEN_B, expiresAt: null }] }));
process.env.POTACAT_LAUNCHER_DIR = DIR;
const L = require('../scripts/launcher.js');

function request(port, { method = 'GET', p = '/', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      let body = ''; res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

(async () => {
  console.log('Who is asking');
  await check('the Cloud Tunnel is recognised by Cloudflare\'s header or the potacat.com host', () => {
    assert.strictEqual(L.isTunnelRequest({ 'cf-connecting-ip': '203.0.113.9' }), true);
    assert.strictEqual(L.isTunnelRequest({ host: 'k3sbp.potacat.com' }), true);
    assert.strictEqual(L.isTunnelRequest({ host: 'K3SBP.POTACAT.COM:443' }), true);
    assert.strictEqual(L.isTunnelRequest({ host: '192.168.1.5:7301' }), false);
    assert.strictEqual(L.isTunnelRequest({ host: 'shack.tail1234.ts.net:7301' }), false);
    assert.strictEqual(L.isTunnelRequest({ host: 'notpotacat.com' }), false);
  });
  await check('/launcher/* is the same API as the bare paths', () => {
    assert.strictEqual(L.routeOf('/launcher/status'), '/status');
    assert.strictEqual(L.routeOf('/launcher/restart'), '/restart');
    assert.strictEqual(L.routeOf('/launcher/'), '/');
    assert.strictEqual(L.routeOf('/launcher'), '/');
    assert.strictEqual(L.routeOf('/status'), '/status');
    assert.strictEqual(L.routeOf('/launchers/x'), '/launchers/x');
  });
  await check('paired devices come from the global file and EVERY profile', () => {
    const ids = L.readPairedDevices(DIR).map((d) => d.id).sort();
    assert.deepStrictEqual(ids, ['old', 'root', 'w7']);
  });
  await check('a device token works from anywhere; the callsign only off the tunnel; an expired device never', () => {
    const devices = L.readPairedDevices(DIR);
    const now = Date.now();
    const a = (o) => L.authorize({ devices, passphrase: 'K3SBP', now, ...o });
    assert.strictEqual(a({ bearer: TOKEN_A, tunnel: true }), 'device');
    assert.strictEqual(a({ bearer: TOKEN_B, tunnel: true }), 'device', 'a device paired under another operator');
    assert.strictEqual(a({ bearer: TOKEN_OLD, tunnel: true }), null, 'expired');
    assert.strictEqual(a({ bearer: 'k3sbp', tunnel: false }), 'callsign');
    assert.strictEqual(a({ bearer: 'K3SBP', tunnel: true }), null, 'a callsign is public: never through the tunnel');
    assert.strictEqual(a({ query: 'K3SBP', tunnel: true }), null);
    assert.strictEqual(a({ query: 'k3sbp', tunnel: false }), 'callsign');
    assert.strictEqual(a({ bearer: 'nope', tunnel: false }), null);
    assert.strictEqual(L.sameSecret('x', 'xy'), false);
  });

  console.log('The launcher over HTTP');
  const server = http.createServer(L.handleRequest);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const CF = (ip) => ({ 'cf-connecting-ip': ip, host: 'k3sbp.potacat.com' });
  try {
    await check('through the tunnel: no page, a constant 401, and a device token gets the status with the replica state', async () => {
      const page = await request(port, { p: '/launcher/', headers: CF('198.51.100.1') });
      assert.strictEqual(page.status, 404);
      assert.ok(!/POTACAT|K3SBP/i.test(page.body), 'nothing anonymous says what is here');
      const cs = await request(port, { p: '/launcher/status', headers: { ...CF('198.51.100.1'), authorization: 'Bearer K3SBP' } });
      assert.strictEqual(cs.status, 401);
      const none = await request(port, { p: '/launcher/restart', method: 'POST', headers: CF('198.51.100.1') });
      assert.strictEqual(none.status, 401);
      assert.strictEqual(none.body, cs.body, 'the same body whatever was tried');
      const ok = await request(port, { p: '/launcher/status', headers: { ...CF('198.51.100.1'), authorization: 'Bearer ' + TOKEN_B } });
      assert.strictEqual(ok.status, 200, ok.body);
      const j = JSON.parse(ok.body);
      assert.ok('running' in j && j.cloud === 'replica-off', JSON.stringify(j));
    });
    await check('on the LAN the page and the callsign still work', async () => {
      const page = await request(port, { p: '/', headers: { host: '192.168.1.5:7301' } });
      assert.strictEqual(page.status, 200);
      assert.ok(/POTACAT LAUNCHER/.test(page.body));
      const cs = await request(port, { p: '/status', headers: { host: '192.168.1.5:7301', authorization: 'Bearer k3sbp' } });
      assert.strictEqual(cs.status, 200);
    });
    await check('tunnel rate limits key on the caller\'s real address, not cloudflared\'s', async () => {
      let limited = false;
      for (let i = 0; i < 25 && !limited; i++) {
        const r = await request(port, { p: '/launcher/restart', method: 'POST', headers: CF('203.0.113.50') });
        if (r.status === 429) limited = true;
      }
      assert.ok(limited, 'one caller is limited');
      const other = await request(port, { p: '/launcher/restart', method: 'POST', headers: CF('203.0.113.51') });
      assert.strictEqual(other.status, 401, 'another caller behind the same tunnel is not');
    });
  } finally { server.close(); }

  await check('one port answers HTTPS (Tailscale, for iOS) and HTTP (the Cloud Tunnel) alike', async () => {
    const https = require('https');
    const dual = L.createDualServer(L.generateTlsCert(), L.handleRequest);
    await new Promise((r) => dual.listen(0, '127.0.0.1', r));
    const dport = dual.address().port;
    try {
      const plain = await request(dport, { p: '/launcher/status', headers: { 'cf-connecting-ip': '192.0.2.7', host: 'k3sbp.potacat.com', authorization: 'Bearer ' + TOKEN_A } });
      assert.strictEqual(plain.status, 200, 'HTTP through the tunnel');
      const secure = await new Promise((resolve, reject) => {
        const req = https.request({ host: '127.0.0.1', port: dport, path: '/status', rejectUnauthorized: false, headers: { authorization: 'Bearer K3SBP' } }, (res) => { res.resume(); resolve(res.statusCode); });
        req.on('error', reject); req.end();
      });
      assert.strictEqual(secure, 200, 'HTTPS on the LAN');
    } finally { dual.close(); }
  });

  console.log('The Cloud Tunnel replica');
  function fakeSpawn() {
    const calls = [];
    const fn = (cmd, args, opts) => {
      const child = new EventEmitter();
      child.stderr = new EventEmitter();
      child.killed = false;
      child.kill = () => { child.killed = true; };
      calls.push({ cmd, args, opts, child });
      return child;
    };
    fn.calls = calls;
    return fn;
  }
  await check('the token goes in the environment, never on the command line; "registered" means up', () => {
    const spawn = fakeSpawn();
    const r = new L.CloudReplica({ spawn, log: () => {}, backoffMs: [5] });
    r.apply({ enabled: true, tunnelToken: 'SECRET-TOKEN', cloudHost: 'k3sbp.potacat.com', cloudflaredPath: '/x/cloudflared' });
    assert.strictEqual(spawn.calls.length, 1);
    const c = spawn.calls[0];
    assert.strictEqual(c.cmd, '/x/cloudflared');
    assert.ok(!c.args.join(' ').includes('SECRET-TOKEN'), 'not in argv');
    assert.strictEqual(c.opts.env.TUNNEL_TOKEN, 'SECRET-TOKEN');
    assert.ok(c.args.includes('run') && c.args.includes('http2'));
    assert.strictEqual(r.state, 'replica-starting');
    c.child.stderr.emit('data', Buffer.from('INF Registered tunnel connection connIndex=0'));
    assert.strictEqual(r.state, 'replica-up');
    r.apply({ enabled: true, tunnelToken: 'SECRET-TOKEN', cloudHost: 'k3sbp.potacat.com', cloudflaredPath: '/x/cloudflared' });
    assert.strictEqual(spawn.calls.length, 1, 'the same config does not restart it');
    r.apply(null);
    assert.ok(c.child.killed);
    assert.strictEqual(r.state, 'replica-off');
    r.apply({ enabled: false });
    assert.strictEqual(r.state, 'disabled');
    assert.strictEqual(spawn.calls.length, 1);
  });
  await check('a connector that exits is restarted with backoff; a missing binary says so', async () => {
    const spawn = fakeSpawn();
    const r = new L.CloudReplica({ spawn, log: () => {}, backoffMs: [10] });
    r.apply({ enabled: true, tunnelToken: 't', cloudflaredPath: 'cloudflared' });
    spawn.calls[0].child.emit('exit', 1);
    await new Promise((res) => setTimeout(res, 40));
    assert.strictEqual(spawn.calls.length, 2, 'respawned');
    const e = new Error('spawn cloudflared ENOENT'); e.code = 'ENOENT';
    spawn.calls[1].child.emit('error', e);
    assert.strictEqual(r.state, 'no-cloudflared');
    r.stop();
  });

  console.log('CloudTunnelManager');
  const { CloudTunnelManager } = require('../lib/cloud-tunnel');
  await check('the launcher\'s credentials follow the tunnel', () => {
    const tm = new CloudTunnelManager({ userDataPath: fs.mkdtempSync(path.join(os.tmpdir(), 'ct-')), log: () => {} });
    assert.strictEqual(tm.launcherCredentials(), null);
    const seen = [];
    tm.on('credentials', (c) => seen.push(c));
    tm._enabled = true; tm._tunnelToken = 'tok'; tm._cloudHost = 'k3sbp.potacat.com';
    tm._persist();
    assert.deepStrictEqual(seen[0], { tunnelToken: 'tok', cloudHost: 'k3sbp.potacat.com' });
    tm._wipe();
    assert.strictEqual(seen[1], null);
    assert.strictEqual(tm.launcherCredentials(), null);
  });
  await check('a healthy tunnel (the launcher\'s connector) no longer hides that ours died', async () => {
    let spawned = 0;
    const tm = new CloudTunnelManager({
      userDataPath: fs.mkdtempSync(path.join(os.tmpdir(), 'ct-')), log: () => {},
      getCloudSync: () => ({ _authedRequest: async () => ({ healthy: true }) }),
      getCloudflaredPath: () => 'cloudflared',
    });
    tm._enabled = true; tm._tunnelToken = 'tok'; tm._cloudHost = 'k3sbp.potacat.com';
    tm._spawnCloudflared = () => { spawned++; };
    await tm._checkOnce();
    assert.strictEqual(spawned, 1);
  });

  console.log('main.js wiring');
  const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  await check('POTACAT --launcher calls main() (requiring the script no longer starts it)', () => {
    assert.ok(/const launcher = require\(launcherScript\);\s*\r?\n\s*if \(launcher && typeof launcher\.main === 'function'\) launcher\.main\(\);/.test(main));
    const src = fs.readFileSync(path.join(ROOT, 'scripts/launcher.js'), 'utf8');
    assert.ok(/if \(require\.main === module\) main\(\);/.test(src));
  });
  await check('the launcher\'s copy of the token follows the tunnel, the launcher and the setting', () => {
    for (const why of ["'Cloud Tunnel changed'", "'startup'", "'launcher installed'", "'launcher uninstalled'", "'turned on in Settings'"]) {
      assert.ok(main.includes('launcherCloudSync(' + why) || main.includes(why), why);
    }
    assert.ok(/cloudTunnel\.on\('credentials', \(\) => launcherCloudSync\(/.test(main));
    const fn = main.slice(main.indexOf('function launcherCloudSync('), main.indexOf('async function _launcherStatus('));
    assert.ok(/mode: 0o600/.test(fn) && /renameSync/.test(fn), 'written atomically, owner-only');
    assert.ok(/settings\.launcherViaCloud === false/.test(fn), 'on unless turned off');
    assert.ok(/'launcherViaCloud',/.test(main.slice(main.indexOf('const GLOBAL_KEYS'), main.indexOf('const GLOBAL_KEYS') + 600)), 'a machine setting');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
