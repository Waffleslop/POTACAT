// Held deletes (Cloud handoff 2026-11-26): the Cloud holds a burst of deletes
// of live QSOs for the member to review. The desktop shows one notice in
// Settings > Cloud and a review list, and resolves with `delete` or `keep`
// only (`restore` is not offered). The push path still retires its batch
// whatever `held` says, and nothing here writes the local log.
//
// Pure tests on lib/cloud-held.js, then CloudSyncClient and the real
// cloud-ipc with electron stubbed and a fake server (no network).

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const Held = require('../lib/cloud-held');
const CloudSyncClient = require('../lib/cloud-sync');
const SyncJournal = require('../lib/sync-journal');

let failures = 0;
const pending = [];
function check(name, fn) {
  pending.push(async () => {
    try { await fn(); console.log(`  ok   ${name}`); }
    catch (err) { failures++; console.error(`  FAIL ${name}\n       ${err.stack || err.message}`); }
  });
}
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'potacat-held-'));
let dirN = 0;
const freshDir = () => { const d = path.join(root, String(dirN++)); fs.mkdirSync(d, { recursive: true }); return d; };
const readSrc = (p) => fs.readFileSync(p, 'utf-8').replace(/\r\n/g, '\n');

// ── lib/cloud-held.js ──────────────────────────────────────────────────

check('only delete and keep are offered; restore is refused', () => {
  assert.deepStrictEqual(Held.ACTIONS, ['delete', 'keep']);
  assert.throws(() => Held.resolveBodies('restore', { uuids: ['a'] }), /unsupported/);
  assert.throws(() => Held.resolveBodies('', { all: true }), /unsupported/);
});

check('heldFromPush: uuids from the push reply; absent or junk is empty', () => {
  assert.deepStrictEqual(Held.heldFromPush({ accepted: ['x'], held: ['a', ' b ', '', null, { uuid: 'c' }] }), ['a', 'b', 'c']);
  assert.deepStrictEqual(Held.heldFromPush({ accepted: ['x'] }), []);
  assert.deepStrictEqual(Held.heldFromPush(null), []);
});

check('parseHeldList: rows formatted for the screen; uuid-less rows dropped; total never below rows', () => {
  const out = Held.parseHeldList({
    held: [
      { uuid: 'u1', call: 'w1aw', qsoDate: '20261125', timeOn: '134502', band: '20m', mode: 'ft8', stationCallsign: 'k3sbp', deviceId: 'd1', heldAt: '2026-11-26T01:00:00Z' },
      { call: 'NOUUID' },
      { uuid: 'u2', qsoDate: '2026-11-24', timeOn: '0915' },
    ],
    total: 10800,
  });
  assert.strictEqual(out.total, 10800);
  assert.deepStrictEqual(out.rows.map((r) => r.uuid), ['u1', 'u2']);
  const r = out.rows[0];
  assert.deepStrictEqual([r.call, r.date, r.time, r.band, r.mode, r.stationCall], ['W1AW', '2026-11-25', '13:45', '20m', 'FT8', 'K3SBP']);
  assert.deepStrictEqual([out.rows[1].date, out.rows[1].time, out.rows[1].call], ['2026-11-24', '09:15', '']);
  assert.strictEqual(Held.parseHeldList({ held: [{ uuid: 'a' }], total: 0 }).total, 1);
  assert.deepStrictEqual(Held.parseHeldList(undefined), { rows: [], total: 0 });
});

check('resolveBodies: chunks of at most 5000, duplicates dropped, or one all:true', () => {
  const uuids = Array.from({ length: 10801 }, (_, i) => `u${i}`);
  const bodies = Held.resolveBodies('delete', { uuids: [...uuids, 'U0', ''] });
  assert.deepStrictEqual(bodies.map((b) => b.uuids.length), [5000, 5000, 801]);
  assert.ok(bodies.every((b) => b.action === 'delete' && !('all' in b)));
  assert.deepStrictEqual(Held.resolveBodies('keep', { all: true }), [{ action: 'keep', all: true }]);
  assert.deepStrictEqual(Held.resolveBodies('keep', { uuids: [] }), []);
});

check('copy: plain, counted, no emoji, no promise', () => {
  assert.strictEqual(Held.noticeText(0), '');
  assert.strictEqual(Held.noticeText(1), 'POTACAT Cloud kept 1 contact that this computer tried to delete.');
  assert.strictEqual(Held.noticeText(42), 'POTACAT Cloud kept 42 contacts that this computer tried to delete.');
  assert.match(Held.reviewIntro(1000, 10800), /Showing the newest 1000 of 10800\.$/);
  assert.ok(!/Showing/.test(Held.reviewIntro(3, 3)));
  assert.match(Held.confirmText('delete', 2), /^Delete 2 contacts from POTACAT Cloud\?/);
  assert.match(Held.confirmText('keep', 1), /^Keep 1 contact in POTACAT Cloud\?/);
  assert.strictEqual(Held.doneText('keep', 3), 'Kept 3 contacts in POTACAT Cloud.');
  const all = [Held.noticeText(5), Held.reviewIntro(1, 5), Held.confirmText('delete', 5), Held.confirmText('keep', 5), Held.doneText('delete', 5)].join(' ');
  assert.ok(!/[\u{1F300}-\u{1FAFF}☀-➿]/u.test(all), 'no emoji');
  assert.ok(!/restore|will be back|guarantee/i.test(all), 'no restore, no promises');
});

// ── CloudSyncClient ────────────────────────────────────────────────────

function fakeServer(client, handler) {
  client.calls = [];
  client._authedRequest = async (method, url, body) => {
    client.calls.push({ method, url, body });
    return handler(method, url, body);
  };
}

check('push: a held list still retires the whole batch; the summary counts held', async () => {
  const j = new SyncJournal(freshDir());
  j.appendMany([{ uuid: 'a', action: 'delete' }, { uuid: 'b', action: 'delete' }, { uuid: 'c', action: 'create' }]);
  const client = new CloudSyncClient({ apiBase: 'http://x', accessToken: 't' });
  fakeServer(client, (m, url, body) => (url.startsWith('/v1/sync/push')
    ? { accepted: body.changes.map((c) => c.uuid).filter((u) => u === 'c'), conflicts: [], held: ['a', 'b'] }
    : { qsos: [], hasMore: false }));
  let synced = null;
  const res = await client.sync(j, { onSynced: (s) => { synced = s; } });
  assert.strictEqual(j.length, 0, 'batch retired whatever the lists say');
  assert.deepStrictEqual(res, { pushed: 1, pulled: 0, conflicts: 0, held: 2 });
  assert.deepStrictEqual(synced, res);
});

check('push without held: the summary is unchanged', async () => {
  const j = new SyncJournal(freshDir());
  j.appendMany([{ uuid: 'c', action: 'create' }]);
  const client = new CloudSyncClient({ apiBase: 'http://x', accessToken: 't' });
  fakeServer(client, (m, url, body) => (url.startsWith('/v1/sync/push') ? { accepted: ['c'], conflicts: [] } : { qsos: [], hasMore: false }));
  assert.deepStrictEqual(await client.sync(j, {}), { pushed: 1, pulled: 0, conflicts: 0 });
});

check('getHeld / resolveHeld: the endpoints, chunked at 5000', async () => {
  const client = new CloudSyncClient({ apiBase: 'http://x', accessToken: 't' });
  fakeServer(client, (m, url, body) => (url.startsWith('/v1/sync/held/resolve')
    ? { resolved: body.uuids || ['all'], action: body.action }
    : { held: [], total: 0 }));
  await client.getHeld(1);
  assert.deepStrictEqual(client.calls[0], { method: 'GET', url: '/v1/sync/held?limit=1', body: undefined });
  const res = await client.resolveHeld('keep', { uuids: Array.from({ length: 6000 }, (_, i) => `u${i}`) });
  assert.strictEqual(res.resolved.length, 6000);
  const posts = client.calls.filter((c) => c.url === '/v1/sync/held/resolve');
  assert.deepStrictEqual(posts.map((c) => [c.method, c.body.action, c.body.uuids.length]), [['POST', 'keep', 5000], ['POST', 'keep', 1000]]);
  await assert.rejects(client.resolveHeld('restore', { all: true }), /unsupported/);
});

// ── cloud-ipc ──────────────────────────────────────────────────────────

const handlers = {};
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return { ipcMain: { handle: (n, fn) => { handlers[n] = fn; }, on: () => {} }, dialog: {}, shell: {} };
  return origLoad.call(this, request, ...rest);
};
const { registerCloudIpc } = require('../lib/cloud-ipc');
Module._load = origLoad;

function cloudEnv(server) {
  const dir = freshDir();
  const logPath = path.join(dir, 'log.adi');
  fs.writeFileSync(logPath, 'header<EOH>\n<CALL:4>W1AW<QSO_DATE:8>20261125<TIME_ON:4>1345<EOR>\n');
  const settings = { cloudSyncEnabled: false, cloudAccessToken: 'tok', cloudUser: { id: 'acct-a' } };
  const sent = [];
  const cloud = registerCloudIpc({
    app: { getPath: () => dir },
    getSettings: () => settings,
    saveSettings: (s) => Object.assign(settings, s),
    getLogPath: () => logPath,
    loadWorkedQsos: () => {},
    sendToRenderer: (ch, data) => sent.push([ch, data]),
    log: () => {},
  });
  fakeServer(cloud.getCloudSync(), server);
  return { cloud, settings, sent, logPath };
}

check('cloud-ipc: sign-in check sets the notice from total; status carries it', async () => {
  const env = cloudEnv(() => ({ held: [{ uuid: 'u1' }], total: 37 }));
  assert.strictEqual(await env.cloud.checkHeldDeletes('signin'), 37);
  assert.deepStrictEqual(env.sent.filter(([c]) => c === 'cloud-held-notice').pop()[1],
    { count: 37, text: 'POTACAT Cloud kept 37 contacts that this computer tried to delete.' });
  assert.strictEqual(env.cloud.heldCount(), 37);
});

check('cloud-ipc: a push reply with held asks for the total; an older server falls back to the push count', async () => {
  const env = cloudEnv(() => { throw new Error('HTTP 404'); });
  env.cloud.getSyncCallbacks().onSynced({ pushed: 0, pulled: 0, conflicts: 0, held: 4 });
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(env.cloud.heldCount(), 4);
});

check('cloud-ipc: resolve sends only delete/keep, never touches the log, and refreshes the count', async () => {
  let total = 3;
  const env = cloudEnv((m, url, body) => {
    if (url === '/v1/sync/held/resolve') { total -= body.uuids.length; return { resolved: body.uuids, action: body.action }; }
    return { held: [], total };
  });
  const before = fs.readFileSync(env.logPath, 'utf-8');
  assert.deepStrictEqual(await handlers['cloud-held-resolve'](null, 'restore', { all: true }), { error: 'Unsupported action' });
  assert.deepStrictEqual(await handlers['cloud-held-resolve'](null, 'keep', { uuids: [] }), { error: 'Nothing selected' });
  const res = await handlers['cloud-held-resolve'](null, 'delete', { uuids: ['a', 'b'] });
  assert.deepStrictEqual(res, { success: true, action: 'delete', resolved: 2, remaining: 1 });
  assert.strictEqual(fs.readFileSync(env.logPath, 'utf-8'), before, 'local log untouched');
  assert.strictEqual(env.cloud.journal.length, 0, 'nothing journaled');
  const list = await handlers['cloud-held-list']();
  assert.deepStrictEqual(list, { rows: [], total: 1 });
});

check('cloud-ipc: a session change clears the notice; signed out asks nothing', async () => {
  const env = cloudEnv(() => ({ held: [], total: 5 }));
  await env.cloud.checkHeldDeletes('signin');
  env.settings.cloudAccessToken = null;
  env.cloud.cloudSessionChanged('signout');
  assert.strictEqual(env.cloud.heldCount(), 0);
  assert.strictEqual(await env.cloud.checkHeldDeletes('boot'), null);
});

// ── surfaces ───────────────────────────────────────────────────────────

check('Settings > Cloud: notice + review in the page; no alert/confirm; existing classes only', () => {
  const html = readSrc(path.join(__dirname, '..', 'renderer', 'index.html'));
  for (const id of ['cloud-held-notice', 'cloud-held-review-link', 'cloud-held-all', 'cloud-held-body', 'cloud-held-delete', 'cloud-held-keep', 'cloud-held-confirm-yes']) {
    assert.ok(html.includes(`id="${id}"`), id);
  }
  assert.ok(html.includes('>Delete from Cloud<') && html.includes('>Keep in Cloud<'));
  assert.ok(!/restore/i.test(html.slice(html.indexOf('id="cloud-held-notice"'), html.indexOf('id="cloud-held-status"'))), 'no restore button');
  for (const h of ['Call', 'Date', 'Time', 'Band', 'Mode', 'Station call']) assert.ok(html.includes(`<th>${h}</th>`), h);
  assert.ok(html.includes('<script src="../lib/cloud-held.js"></script>'));
  const ui = readSrc(path.join(__dirname, '..', 'renderer', 'cloud-ui.js'));
  const block = ui.slice(ui.indexOf('function renderHeldNotice'));
  assert.ok(!/\b(alert|confirm)\(/.test(block.slice(0, block.indexOf('setTimeout(refreshTunnelState'))), 'no alert/confirm in the held UI');
  assert.ok(!/#[0-9a-f]{3,6}\b/i.test(html.slice(html.indexOf('id="cloud-held-notice"'), html.indexOf('id="cloud-held-status"'))), 'no new colours');
});

(async () => {
  for (const run of pending) await run();
  fs.rmSync(root, { recursive: true, force: true });
  if (failures) { console.error(`\n${failures} cloud-held test(s) FAILED`); process.exit(1); }
  console.log('\nall cloud-held tests passed');
})();
