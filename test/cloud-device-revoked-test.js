#!/usr/bin/env node
'use strict';
// A computer removed from the POTACAT Cloud account is signed out
// (CLOUD_TO_DESKTOP_HANDOFF_2026-11-20_DEVICE_REMOVE_SIGNS_OUT). Cloud answers
// every call, the refresh and register / heartbeat with
//   401 {"error":"device_revoked","message":"..."}
// and the desktop must: clear both tokens, show the signed-out Cloud card with
// the server's words, stop every Cloud loop (no retry, no re-register), and
// stop the POTACAT Tunnel. The real CloudSyncClient against a fake cloud over
// HTTP, the real registerCloudIpc against a stubbed electron, the real
// CloudTunnelManager with a fake cloudflared. No live Cloud call.
// Run: node test/cloud-device-revoked-test.js
const assert = require('assert');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { EventEmitter } = require('events');
const { readSrc } = require('./_src');
const CR = require('../lib/cloud-revoked');
const CloudSyncClient = require('../lib/cloud-sync');
const { CloudTunnelManager } = require('../lib/cloud-tunnel');
const PairErrors = require('../lib/cloud-pair-errors');

const queue = [];
function test(name, fn) { queue.push([name, fn]); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const SERVER_MSG = 'This device was removed from your POTACAT Cloud account. Sign in again to use it.';
const REVOKED = { error: 'device_revoked', message: SERVER_MSG, hint: 'sign in again' };

// A fake cloud: `revoked` flips every authenticated route (and the refresh)
// to 401 device_revoked, as cloud PR #8 does once the row is deleted.
function fakeCloud() {
  const st = { revoked: true, calls: [], legacy401: false };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      st.calls.push(`${req.method} ${u.pathname}`);
      const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (u.pathname === '/v1/auth/login') return send(200, { accessToken: 'fresh-access', refreshToken: 'fresh-refresh', user: { id: 'u1' } });
      if (st.legacy401) return send(401, { error: 'unauthorized' });
      if (st.revoked) return send(401, REVOKED);
      if (u.pathname === '/v1/cloud-tunnel/status') return send(200, { healthy: true });
      send(200, { ok: true, user: { id: 'u1' } });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ st, server, base: `http://127.0.0.1:${server.address().port}` })));
}

// ── The one detection point ───────────────────────────────────────────

test('classifier: 401 device_revoked (object or raw text) is device_revoked; another 401 is auth_expired', () => {
  assert.strictEqual(CR.classifyCloudResponse(401, REVOKED), 'device_revoked');
  assert.strictEqual(CR.classifyCloudResponse(401, JSON.stringify(REVOKED)), 'device_revoked');
  assert.strictEqual(CR.classifyCloudResponse('401', { error: 'device_revoked' }), 'device_revoked');
  assert.strictEqual(CR.classifyCloudResponse(401, { error: 'unauthorized' }), 'auth_expired');
  assert.strictEqual(CR.classifyCloudResponse(401, '<html>nginx</html>'), 'auth_expired');
  assert.strictEqual(CR.classifyCloudResponse(401, null), 'auth_expired');
  assert.strictEqual(CR.classifyCloudResponse(403, REVOKED), 'error', 'only a 401 signs out');
  assert.strictEqual(CR.classifyCloudResponse(404, REVOKED), 'error');
  assert.strictEqual(CR.classifyCloudResponse(200, {}), 'ok');
  assert.strictEqual(CR.classifyCloudResponse(204, ''), 'ok');
});

test('the words: the server\'s message, else the fallback; the error carries the code', () => {
  assert.strictEqual(CR.signedOutText(REVOKED), SERVER_MSG);
  assert.strictEqual(CR.signedOutText({ error: 'device_revoked' }), CR.SIGNED_OUT_TEXT);
  assert.strictEqual(CR.signedOutText(null), CR.SIGNED_OUT_TEXT);
  assert.strictEqual(CR.signedOutText('device_revoked'), CR.SIGNED_OUT_TEXT);
  assert.strictEqual(CR.SIGNED_OUT_TEXT, 'This computer was removed from your POTACAT Cloud account, so it was signed out. Sign in again to use Cloud here.');
  const err = CR.deviceRevokedError(JSON.stringify(REVOKED));
  assert.strictEqual(err.code, 'device_revoked');
  assert.strictEqual(err.status, 401);
  assert.strictEqual(err.message, SERVER_MSG);
  assert.ok(CR.isDeviceRevoked(err));
  assert.strictEqual(CR.signedOutText(err), SERVER_MSG);
  assert.ok(!CR.isDeviceRevoked(new Error('AUTH_EXPIRED')));
  assert.ok(!CR.isDeviceRevoked(null));
  for (const t of [CR.SIGNED_OUT_TEXT, CR.GUEST_PASS_SIGNED_OUT_TEXT]) assert.ok(!/[\u{1F300}-\u{1FAFF}]/u.test(t), 'no emoji');
});

test('handler: every step once, in order; a second revoked answer does nothing until reset (sign-in)', () => {
  const calls = [];
  const step = (n) => (t) => calls.push([n, t]);
  const h = CR.createDeviceRevokedHandler({ notify: step('notify'), stopTunnel: step('stopTunnel'), clearTokens: step('clearTokens'),
    stopOther: step('stopOther'), stopDevice: step('stopDevice'), stopSync: () => { calls.push(['stopSync']); throw new Error('boom'); } });
  assert.strictEqual(h.handle(REVOKED), true);
  assert.deepStrictEqual(calls.map((c) => c[0]), ['clearTokens', 'stopSync', 'stopDevice', 'stopTunnel', 'stopOther', 'notify'], 'a failing step does not stop the rest');
  assert.strictEqual(calls[0][1], SERVER_MSG);
  assert.strictEqual(h.handle(REVOKED), false);
  assert.strictEqual(calls.length, 6);
  assert.ok(h.signedOut);
  h.reset();
  assert.ok(!h.signedOut);
  assert.strictEqual(h.handle(null), true);
  assert.strictEqual(calls[6][1], CR.SIGNED_OUT_TEXT);
});

test('pairing / register words, and the device id is never rotated on device_revoked', () => {
  const err = CR.deviceRevokedError(REVOKED);
  assert.strictEqual(PairErrors.cloudPairErrorText(err), CR.SIGNED_OUT_TEXT);
  assert.strictEqual(PairErrors.cloudRegisterErrorText(err), CR.SIGNED_OUT_TEXT);
  assert.strictEqual(PairErrors.shouldRotateDeviceId(err), false, 'a new id would dodge the removal');
});

// ── The real CloudSyncClient ──────────────────────────────────────────

test('refresh on device_revoked: both tokens cleared, emitted once, never retried', async () => {
  const { st, server, base } = await fakeCloud();
  // No access token: the first call refreshes.
  const persisted = [];
  const c = new CloudSyncClient({ apiBase: base, refreshToken: 'old-refresh', deviceId: 'dev-1', onTokenRefresh: (...a) => persisted.push(a) });
  const events = [];
  c.on('device-revoked', (e) => events.push(e));
  await assert.rejects(c.getMe(), (e) => CR.isDeviceRevoked(e) && e.message === SERVER_MSG);
  assert.deepStrictEqual(st.calls, ['POST /v1/auth/refresh']);
  assert.strictEqual(c._accessToken, null);
  assert.strictEqual(c._refreshToken, null, 'the dead refresh token is dropped, not kept for a retry');
  assert.strictEqual(events.length, 1);
  assert.strictEqual(persisted.length, 0);
  // Later calls fail locally: no refresh retry, no network at all.
  await assert.rejects(c.getMe(), (e) => CR.isDeviceRevoked(e));
  await assert.rejects(c.heartbeatDevice('dev-1'), (e) => CR.isDeviceRevoked(e));
  await assert.rejects(c.registerDevice({ deviceId: 'dev-1' }), (e) => CR.isDeviceRevoked(e));
  await assert.rejects(c.pull(), (e) => CR.isDeviceRevoked(e));
  await wait(50);
  assert.strictEqual(st.calls.length, 1, 'one request in all: ' + st.calls.join(', '));
  assert.strictEqual(events.length, 1, 'emitted once per client');
  server.close();
});

test('an authed call answered device_revoked is not treated as AUTH_EXPIRED (no refresh attempt)', async () => {
  const { st, server, base } = await fakeCloud();
  const c = new CloudSyncClient({ apiBase: base, accessToken: 'jwt', refreshToken: 'ref', deviceId: 'dev-1' });
  const events = [];
  c.on('device-revoked', (e) => events.push(e));
  await assert.rejects(c.getSubscriptionStatus(), (e) => e.code === 'device_revoked');
  assert.deepStrictEqual(st.calls, ['GET /v1/subscription/status'], 'no /v1/auth/refresh');
  assert.strictEqual(c._refreshToken, null);
  assert.strictEqual(events.length, 1);
  // A plain 401 still refreshes as before.
  st.calls.length = 0; st.legacy401 = true;
  const d = new CloudSyncClient({ apiBase: base, accessToken: 'jwt', refreshToken: 'ref', deviceId: 'dev-2' });
  await assert.rejects(d.getMe(), (e) => !CR.isDeviceRevoked(e));
  assert.deepStrictEqual(st.calls, ['GET /v1/auth/me', 'POST /v1/auth/refresh']);
  assert.strictEqual(d._refreshToken, 'ref', 'an ordinary refresh failure keeps the refresh token');
  server.close();
});

test('heartbeat and register on device_revoked: stop, sync timer cleared, nothing re-registers', async () => {
  const { st, server, base } = await fakeCloud();
  const c = new CloudSyncClient({ apiBase: base, accessToken: 'jwt', refreshToken: 'ref', deviceId: 'dev-1' });
  let n = 0;
  c.on('device-revoked', () => { n++; });
  c.startInterval(3600, { hasPending: false }, {});
  assert.ok(c._syncTimer);
  await assert.rejects(c.heartbeatDevice('dev-1'), (e) => CR.isDeviceRevoked(e));
  assert.strictEqual(c._syncTimer, null, 'the sync interval is not left running');
  await assert.rejects(c.registerDevice({ deviceId: 'dev-1' }), (e) => CR.isDeviceRevoked(e));
  assert.deepStrictEqual(st.calls, ['POST /v1/devices/dev-1/heartbeat'], 'register never reached the network');
  assert.strictEqual(n, 1);
  server.close();
});

test('register answered device_revoked, the ADIF export too', async () => {
  const { st, server, base } = await fakeCloud();
  const c = new CloudSyncClient({ apiBase: base, accessToken: 'jwt', refreshToken: 'ref', deviceId: 'dev-1' });
  await assert.rejects(c.registerDevice({ deviceId: 'dev-1' }), (e) => CR.isDeviceRevoked(e));
  assert.deepStrictEqual(st.calls, ['POST /v1/devices']);
  const e2 = new CloudSyncClient({ apiBase: base, accessToken: 'jwt', refreshToken: 'ref', deviceId: 'dev-1' });
  const dest = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'potacat-revoked-')), 'log.adi');
  await assert.rejects(e2.downloadAdif(dest), (e) => CR.isDeviceRevoked(e) && e.message === SERVER_MSG);
  assert.strictEqual(e2._refreshToken, null);
  assert.ok(!fs.existsSync(dest));
  server.close();
});

test('a fresh sign-in on the same client works at once', async () => {
  const { st, server, base } = await fakeCloud();
  const c = new CloudSyncClient({ apiBase: base, accessToken: 'jwt', refreshToken: 'ref', deviceId: 'dev-1' });
  await assert.rejects(c.getMe());
  st.revoked = false;
  const r = await c._post('/v1/auth/login', { email: 'a', password: 'b', deviceId: 'dev-1' }, true);
  c.configure({ accessToken: r.accessToken, refreshToken: r.refreshToken });
  assert.ok(!c.revoked);
  const me = await c.getMe();
  assert.strictEqual(me.user.id, 'u1');
  server.close();
});

// ── The POTACAT Tunnel ────────────────────────────────────────────────

test('tunnel: a device_revoked health check stops cloudflared, the timers and the launcher copy; saved off', async () => {
  const { st, server, base } = await fakeCloud();
  st.revoked = false;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'potacat-revoked-tunnel-'));
  const cfg = path.join(dir, 'cloud-tunnel.json');
  const sync = new CloudSyncClient({ apiBase: base, accessToken: 'jwt', refreshToken: 'ref', deviceId: 'dev-1' });
  const spawned = [];
  const fakeSpawn = () => {
    const child = new EventEmitter();
    child.stderr = new EventEmitter(); child.stdout = new EventEmitter();
    child.exitCode = null; child.signalCode = null;
    child.kill = () => { child.killed = true; };
    spawned.push(child);
    return child;
  };
  const m = new CloudTunnelManager({ userDataPath: dir, configPath: cfg, getCloudSync: () => sync,
    getCloudflaredPath: () => 'cloudflared-fake', spawn: fakeSpawn, getDeviceInfo: () => ({ deviceId: 'dev-1', name: 'PC' }), claimPollMs: 60_000 });
  // Running as it would be: enabled, token saved, cloudflared up, timers on.
  m._enabled = true; m._cloudHost = 'k3sbp.potacat.com'; m._tunnelId = 'tid'; m._tunnelToken = 'tunnel-secret';
  m._persist();
  m._spawnCloudflared();
  m.startHealthCheck();
  m._startClaimPoll();
  const creds = [];
  m.on('credentials', (c) => creds.push(c));
  // main.js's wiring in miniature: the client's device-revoked -> stopTunnel.
  let stopped = 0;
  sync.on('device-revoked', () => { if (m.stopSignedOut()) stopped++; });
  st.revoked = true;
  await m._checkOnce();
  assert.strictEqual(stopped, 1, 'stopSignedOut ran');
  assert.ok(spawned.length >= 1 && spawned.every((c) => c.killed), 'cloudflared stopped');
  const s = m.getState();
  assert.strictEqual(s.enabled, false);
  assert.strictEqual(s.status, 'off');
  assert.strictEqual(m.getCloudHost(), '', 'alt-hosts lose the cloud leg: the pill reads LAN only');
  assert.strictEqual(m._healthTimer, null);
  assert.strictEqual(m._claimTimer, null);
  assert.strictEqual(m._restartTimer, null);
  assert.strictEqual(JSON.parse(fs.readFileSync(cfg, 'utf8')).enabled, false, 'does not start again at launch');
  assert.strictEqual(creds[creds.length - 1], null, 'the Remote Launcher drops its copy of the tunnel');
  // No /revoke and no /release: local only, the address stays on the account.
  assert.ok(!st.calls.some((x) => /revoke|release/.test(x)), st.calls.join(', '));
  assert.strictEqual(m.stopSignedOut(), false, 'a second call is a no-op');
  m.shutdown();
  server.close();
});

// ── registerCloudIpc: the sign-out itself ─────────────────────────────

test('cloud-ipc: device_revoked clears tokens, keeps the words, stops sync, runs main\'s steps; a stale client is ignored; sign-in resets', async () => {
  const clients = [];
  class FakeSync extends EventEmitter {
    constructor(opts) { super(); this.opts = opts; this.intervalRunning = false; clients.push(this); }
    startInterval() { this.intervalRunning = true; }
    stopInterval() { this.intervalRunning = false; }
    async _post(p, body) {
      if (p === '/v1/auth/login') return { accessToken: 'tok2', refreshToken: 'ref2', user: { id: 'u1', email: body.email } };
      return {};
    }
  }
  const handlers = {};
  const electronStub = { ipcMain: { handle: (n, fn) => { handlers[n] = fn; }, on: () => {} }, dialog: {}, shell: {} };
  const origLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'electron') return electronStub;
    if (request === './cloud-sync') return FakeSync;
    return origLoad.call(this, request, ...rest);
  };
  delete require.cache[require.resolve('../lib/cloud-ipc')];
  const { registerCloudIpc } = require('../lib/cloud-ipc');
  Module._load = origLoad;

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'potacat-revoked-ipc-'));
  const settings = { cloudSyncEnabled: true, cloudAccessToken: 'tok1', cloudRefreshToken: 'ref1', cloudUser: { id: 'u1' }, cloudDeviceId: 'dev-1', cloudLastSyncTimestamp: 't', cloudLastSyncAt: 't' };
  const steps = [];
  const sent = [];
  const sessions = [];
  const cloud = registerCloudIpc({
    app: { getPath: () => tmp }, win: null,
    getSettings: () => settings, saveSettings: (s) => Object.assign(settings, s),
    getLogPath: () => path.join(tmp, 'log.adi'), loadWorkedQsos: () => {},
    sendToRenderer: (ch, d) => sent.push([ch, d]),
    onCloudSessionChanged: (r) => sessions.push(r),
    deviceRevokedSteps: {
      stopDevice: () => steps.push('stopDevice'),
      stopTunnel: () => steps.push('stopTunnel'),
      stopOther: () => steps.push('stopOther'),
      notify: (t) => steps.push('notify:' + t),
    },
  });
  cloud.startBackgroundSync();
  const first = cloud.getCloudSync();
  assert.ok(first.intervalRunning, 'background sync was running');

  first.emit('device-revoked', CR.deviceRevokedError(REVOKED));
  assert.strictEqual(settings.cloudAccessToken, null);
  assert.strictEqual(settings.cloudRefreshToken, null);
  assert.strictEqual(settings.cloudUser, null);
  assert.strictEqual(settings.cloudLastSyncTimestamp, null);
  assert.strictEqual(settings.cloudSignedOutNotice, SERVER_MSG);
  assert.strictEqual(first.intervalRunning, false, 'sync timer stopped');
  assert.deepStrictEqual(sessions, ['revoked']);
  assert.deepStrictEqual(steps, ['stopDevice', 'stopTunnel', 'stopOther', 'notify:' + SERVER_MSG]);
  assert.deepStrictEqual(sent.find(([ch]) => ch === 'cloud-signed-out'), ['cloud-signed-out', { reason: 'device_revoked', message: SERVER_MSG }]);
  assert.ok(clients.every((c) => !c.intervalRunning), 'no loop restarted');

  // Several calls in flight all come back revoked: one sign-out.
  first.emit('device-revoked', CR.deviceRevokedError(REVOKED));
  assert.strictEqual(steps.length, 4);

  // The Cloud card and Share My Rig read why.
  assert.deepStrictEqual(await handlers['cloud-get-status'](), { loggedIn: false, signedOutNotice: SERVER_MSG });
  assert.deepStrictEqual(handlers['cloud-session-get'](), { loggedIn: false, signedOutNotice: SERVER_MSG, guestPassNotice: CR.GUEST_PASS_SIGNED_OUT_TEXT });

  // A fresh sign-in works at once and clears the notice.
  const r = await handlers['cloud-login'](null, 'a@example.com', 'pw');
  assert.ok(r.success, JSON.stringify(r));
  assert.strictEqual(settings.cloudAccessToken, 'tok2');
  assert.strictEqual(settings.cloudSignedOutNotice, null);
  assert.deepStrictEqual(handlers['cloud-session-get'](), { loggedIn: true, signedOutNotice: null, guestPassNotice: null });
  assert.strictEqual(sessions[sessions.length - 1], 'signin');

  // A request still in flight on the dropped client must not sign out the new session.
  first.emit('device-revoked', CR.deviceRevokedError(REVOKED));
  assert.strictEqual(settings.cloudAccessToken, 'tok2');
  assert.strictEqual(steps.length, 4);

  // The handler was reset by the sign-in: the current client acts again.
  const now = cloud.getCloudSync();
  assert.notStrictEqual(now, first);
  now.emit('device-revoked', CR.deviceRevokedError({ error: 'device_revoked' }));
  assert.strictEqual(settings.cloudAccessToken, null);
  assert.strictEqual(settings.cloudSignedOutNotice, CR.SIGNED_OUT_TEXT, 'no message: the fallback text');
  assert.strictEqual(steps.length, 8);

  // Sign Out by hand clears the notice.
  await handlers['cloud-logout']();
  assert.strictEqual(settings.cloudSignedOutNotice, null);
});

// ── main.js glue (source guards: main.js cannot be required in a test) ──

test('main.js wires the steps: heartbeat torn down, tunnel stopped, TURN re-mint stopped, ECHOCAT told; Guest Pass redeem signs out', () => {
  const src = readSrc(path.join(__dirname, '..', 'main.js'));
  const i = src.indexOf('deviceRevokedSteps: {');
  assert.ok(i > 0, 'deviceRevokedSteps passed to registerCloudIpc');
  const block = src.slice(i, i + 1200);
  assert.ok(/stopDevice: \(\) => teardownCloudDeviceHeartbeat\(\)/.test(block));
  assert.ok(/stopTunnel:[^\n]*cloudTunnel\.stopSignedOut\(\)/.test(block));
  assert.ok(/stopOther:[^\n]*_stopTurnRemint\(\)/.test(block));
  assert.ok(/broadcastCloudStatus\(\{ loggedIn: false \}\)/.test(block));
  // A revoked session change schedules no reconcile / template sync.
  assert.ok(/isSignOutReason\(reason\) && sstvTemplateSync/.test(src));
  // The Guest Pass redeem runs its own fetch with the owner's token.
  assert.ok(/classifyCloudResponse\(r\.status, r\.body\) === 'device_revoked' && cloudIpc\) \{\n\s*cloudIpc\.signOutRevoked\(r\.body\)/.test(src));
  // Heartbeat / register failures never rotate the id or re-register on their own.
  const hb = src.slice(src.indexOf('async function ensureCloudDeviceRegistered'), src.indexOf('function teardownCloudDeviceHeartbeat'));
  assert.ok(/shouldRotateDeviceId\(err\)/.test(hb));
  assert.ok(!/status === 404|\.status == 404/.test(hb), 'no 404 re-register path that a 401 could fall into');
});

test('ECHOCAT: the push is the existing cloud-status message, owner clients only', () => {
  const RemoteServer = require('../lib/remote-server').RemoteServer || require('../lib/remote-server');
  const proto = RemoteServer.prototype || RemoteServer;
  const sent = [];
  const fake = { _wss: { clients: [
    { readyState: 1, id: 'owner' },
    { readyState: 1, id: 'guest', _passSession: { code: 'x' } },
    { readyState: 3, id: 'closed' },
  ] }, _sendTo: (c, m) => sent.push([c.id, m]) };
  proto.broadcastCloudStatus.call(fake, { loggedIn: false });
  assert.deepStrictEqual(sent, [['owner', { type: 'cloud-status', loggedIn: false }]]);
});

test('renderer: the Cloud card and Share My Rig show the signed-out line with existing styles', () => {
  const html = readSrc(path.join(__dirname, '..', 'renderer', 'index.html'));
  assert.ok(/<div id="cloud-signed-out-notice" class="share-rig-notice warn hidden" role="status"><\/div>/.test(html));
  assert.ok(/<div id="share-rig-signed-out" class="share-rig-notice warn hidden" role="status"><\/div>/.test(html));
  const ui = readSrc(path.join(__dirname, '..', 'renderer', 'cloud-ui.js'));
  assert.ok(/onCloudSignedOut\(\(data\) => \{\n\s*showLogin\(false, \(data && data\.message\) \|\| ''\);/.test(ui));
  assert.ok(/showLogin\(!!status\.error, status\.signedOutNotice \|\| ''\)/.test(ui));
  const app = readSrc(path.join(__dirname, '..', 'renderer', 'app.js'));
  assert.ok(/_shareRigUpdateSignedOut\(\);\n\s*_shareRigUpdateReachNotice\(\);/.test(app));
  const pre = readSrc(path.join(__dirname, '..', 'preload.js'));
  assert.ok(/cloudSessionGet: \(\) => ipcRenderer\.invoke\('cloud-session-get'\)/.test(pre));
  assert.ok(/onCloudSignedOut: \(cb\) => ipcRenderer\.on\('cloud-signed-out'/.test(pre));
});

(async () => {
  let passed = 0, failed = 0;
  for (const [name, fn] of queue) {
    try { await fn(); passed++; console.log('  ok   ' + name); }
    catch (err) { failed++; console.error('  FAIL ' + name + '\n       ' + (err && err.stack || err)); }
  }
  console.log(`\ncloud-device-revoked: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
