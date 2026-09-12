// Cloud session change — one funnel for every sign-in / sign-out path.
//
// Until 2026-09-12 the Settings-tab login only did `cloudSync = null`: the
// previous account's sync timer kept firing with ITS tokens, and main.js's
// cloud_devices heartbeat kept the client it captured at registration while
// its "already registered" early return meant the new account never got a
// device row (D1 in the callsign-onboarding handoff). Now cloud-login /
// cloud-register / the OAuth exchange / cloud-logout all go through
// cloudSessionChanged(): stop the old client's timer, drop it, restart
// background sync on the new tokens, tell main.js to rebind.
//
// Runs registerCloudIpc against a stubbed electron and a recording
// CloudSyncClient so the REAL handler code is under test.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

// --- Recording CloudSyncClient stand-in ---
const clients = [];
class FakeSync {
  constructor(opts) {
    this.opts = opts;
    this.accessToken = opts.accessToken;
    this.intervalRunning = false;
    this.stops = 0;
    this.posts = [];
    clients.push(this);
  }
  on() {}
  startInterval() { this.intervalRunning = true; }
  stopInterval() { if (this.intervalRunning) this.stops++; this.intervalRunning = false; }
  async _post(p, body) {
    this.posts.push(p);
    if (p === '/v1/auth/login' || p === '/v1/auth/register') {
      return { accessToken: 'tok-' + body.email, refreshToken: 'ref-' + body.email, user: { email: body.email } };
    }
    return {};
  }
}

const handlers = {};
const electronStub = {
  ipcMain: { handle: (name, fn) => { handlers[name] = fn; }, on: () => {} },
  dialog: {},
  shell: {},
};
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return electronStub;
  if (request === './cloud-sync') return FakeSync;
  return origLoad.call(this, request, ...rest);
};
const { registerCloudIpc } = require('../lib/cloud-ipc');
Module._load = origLoad;

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (err) { failures++; console.error(`  FAIL ${name}\n       ${err.message}`); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'potacat-cloud-session-'));
const settings = { cloudSyncEnabled: true, cloudAccessToken: 'tok-a@example.com', cloudRefreshToken: 'ref-a', cloudDeviceId: 'dev-1' };
const hookCalls = [];
const ctx = {
  app: { getPath: () => tmp },
  win: null,
  getSettings: () => settings,
  saveSettings: (s) => { Object.assign(settings, s); },
  getLogPath: () => path.join(tmp, 'log.adi'),
  loadWorkedQsos: () => {},
  sendToRenderer: () => {},
  onCloudSessionChanged: (reason) => hookCalls.push(reason),
};
const cloud = registerCloudIpc(ctx);
const live = () => clients.filter((c) => c.intervalRunning);

(async () => {
  // Boot: signed in as A, background sync running on A's client.
  cloud.startBackgroundSync();
  const a = clients[0];
  check('boot: one client on A, its interval running', () => {
    assert.strictEqual(clients.length, 1);
    assert.strictEqual(a.accessToken, 'tok-a@example.com');
    assert.deepStrictEqual(live(), [a]);
  });

  // Settings-tab sign-in as B.
  const res = await handlers['cloud-login'](null, 'b@example.com', 'pw');
  const b = clients[clients.length - 1];
  check('login: success + settings now hold B', () => {
    assert.strictEqual(res.success, true);
    assert.strictEqual(settings.cloudAccessToken, 'tok-b@example.com');
    assert.strictEqual(settings.cloudUser.email, 'b@example.com');
  });
  check("login: A's interval stopped, exactly one live interval and it is on B's tokens", () => {
    assert.strictEqual(a.intervalRunning, false);
    assert.strictEqual(a.stops, 1);
    assert.strictEqual(live().length, 1);
    assert.strictEqual(live()[0].accessToken, 'tok-b@example.com');
    assert.notStrictEqual(live()[0], a);
  });
  check('login: getCloudSync() is the B client (not a stale reference)', () => {
    assert.strictEqual(cloud.getCloudSync().accessToken, 'tok-b@example.com');
  });
  check("login: main.js hook told to rebind ('signin')", () => {
    assert.deepStrictEqual(hookCalls, ['signin']);
  });

  // Register as C (same funnel).
  await handlers['cloud-register'](null, 'c@example.com', 'pw', 'K1ABC');
  check('register: only one live interval, on C', () => {
    assert.strictEqual(b.intervalRunning, false);
    assert.strictEqual(live().length, 1);
    assert.strictEqual(live()[0].accessToken, 'tok-c@example.com');
    assert.deepStrictEqual(hookCalls, ['signin', 'register']);
  });

  // Sign out.
  const out = await handlers['cloud-logout']();
  check('logout: tokens cleared, no live interval anywhere, hook told', () => {
    assert.strictEqual(out.success, true);
    assert.strictEqual(settings.cloudAccessToken, null);
    assert.strictEqual(settings.cloudUser, null);
    assert.strictEqual(live().length, 0);
    assert.strictEqual(hookCalls[hookCalls.length - 1], 'signout');
  });
  check('logout: a client built afterwards carries no token', () => {
    assert.strictEqual(cloud.getCloudSync().accessToken, null);
    assert.strictEqual(live().length, 0, 'signed out: startBackgroundSync must not start a timer');
  });

  // A missing hook is fine (headless / tests) — the funnel must not throw.
  delete ctx.onCloudSessionChanged;
  const again = await handlers['cloud-login'](null, 'd@example.com', 'pw');
  check('no hook: sign-in still succeeds and restarts sync on the new tokens', () => {
    assert.strictEqual(again.success, true);
    assert.strictEqual(live().length, 1);
    assert.strictEqual(live()[0].accessToken, 'tok-d@example.com');
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  if (failures) { console.error(`cloud-session-change-test: ${failures} FAILED`); process.exit(1); }
  console.log('cloud-session-change-test: OK');
})().catch((err) => { console.error(err); process.exit(1); });
