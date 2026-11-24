// Cloud delete guard (GitHub #245): accounts with several station callsigns
// lost hundreds to thousands of QSOs to delete pushes in one go. The push now
// holds:
//   A. any delete of a QSO whose STATION_CALLSIGN is another profile on this PC;
//   B. every pending delete once more than 25 would reach the Cloud in an hour;
// until the operator answers one dialog naming the count. Held deletes stay in
// the journal; "keep" never asks again for them; "delete" sends them.
//   C. the pull's duplicate guard never treats two QSOs with different
//      station callsigns as one contact reported twice.
//
// Pure tests on lib/cloud-delete-guard.js, then the real cloud-ipc with
// electron stubbed and a fake server (no network).

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const Guard = require('../lib/cloud-delete-guard');

const electronStub = { ipcMain: { handle: () => {}, on: () => {} }, dialog: {}, shell: { openExternal: () => {} } };
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return electronStub;
  return origLoad.call(this, request, ...rest);
};
const { registerCloudIpc } = require('../lib/cloud-ipc');
Module._load = origLoad;
const { parseAllRawQsos } = require('../lib/adif');

let failures = 0;
let passed = 0;
const queue = [];
function check(name, fn) {
  queue.push(async () => {
    try { await fn(); passed++; console.log(`  ok   ${name}`); }
    catch (err) { failures++; console.error(`  FAIL ${name}\n       ${err.stack || err.message}`); }
  });
}

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const del = (n, station, extra = {}) => ({ uuid: uuid(n), action: 'delete', adifFields: { CALL: `K${n}X`, STATION_CALLSIGN: station }, version: 2, ...extra });
const upd = (n, station) => ({ uuid: uuid(n), action: 'update', adifFields: { CALL: `K${n}X`, STATION_CALLSIGN: station }, version: 2 });
const NOW = Date.UTC(2026, 10, 19, 13, 0, 0);

// ── pure ────────────────────────────────────────────────────────────────────
check('a few deletes of this station go out', () => {
  const entries = [del(1, 'K0ABC'), upd(2, 'K0ABC'), del(3, '')];
  const p = Guard.planPush(entries, { now: NOW });
  assert.deepStrictEqual(p.send, entries);
  assert.strictEqual(p.held.length, 0);
  assert.strictEqual(p.reason, null);
});

check('exactly the limit goes out; one more holds every delete, never the creates or updates', () => {
  const at = Array.from({ length: Guard.DELETE_LIMIT }, (_, i) => del(i + 1, 'K0ABC'));
  assert.strictEqual(Guard.planPush(at, { now: NOW }).send.length, Guard.DELETE_LIMIT);
  const over = [...at, del(99, 'K0ABC/P'), upd(100, 'K0ABC')];
  const p = Guard.planPush(over, { now: NOW });
  assert.deepStrictEqual(p.send.map((e) => e.action), ['update'], 'only the update is sent');
  assert.strictEqual(p.held.length, Guard.DELETE_LIMIT + 1, 'all deletes held, not the first 25 sent');
  assert.strictEqual(p.ask.length, Guard.DELETE_LIMIT + 1);
  assert.strictEqual(p.reason, 'volume');
});

check('deletes already sent this hour count; older ones do not', () => {
  const ten = Array.from({ length: 10 }, (_, i) => del(i + 1, 'K0ABC'));
  const sentRecently = Array(20).fill(NOW - 10 * 60 * 1000);
  assert.strictEqual(Guard.planPush(ten, { now: NOW, sentTimes: sentRecently }).held.length, 10, '20 sent + 10 > 25');
  const sentLongAgo = Array(20).fill(NOW - 2 * 60 * 60 * 1000);
  assert.strictEqual(Guard.planPush(ten, { now: NOW, sentTimes: sentLongAgo }).held.length, 0);
  assert.strictEqual(Guard.pruneSent([...sentRecently, ...sentLongAgo], NOW).length, 20);
});

check('a slow trickle (one a second for hours) is held once it passes the limit in the hour', () => {
  // Deletes arriving over 2.5 hours, pushed each 60 s cycle.
  let sent = [];
  let held = 0;
  let n = 0;
  for (let minute = 0; minute < 150; minute++) {
    const now = NOW + minute * 60000;
    const batch = Array.from({ length: 60 }, () => del(++n, 'K0ABC'));
    const p = Guard.planPush(batch, { now, sentTimes: sent });
    sent = sent.concat(Array(p.send.filter((e) => e.action === 'delete').length).fill(now));
    held += p.held.length;
  }
  assert.strictEqual(sent.length, 0, 'a 60-delete cycle is over the limit from the first minute');
  assert.strictEqual(held, 150 * 60);
});

check('A: another profile\'s QSO is held even alone, case-insensitive', () => {
  const p = Guard.planPush([del(1, 'k0abc'), del(2, 'K0ABC/P')], { now: NOW, otherProfiles: ['K0ABC'] });
  assert.deepStrictEqual(p.send.map((e) => e.uuid), [uuid(2)]);
  assert.deepStrictEqual(p.held.map((e) => e.uuid), [uuid(1)]);
  assert.strictEqual(p.reason, 'other-profile');
});

check('confirmed deletes go regardless; declined ones stay held and are not asked again', () => {
  const many = Array.from({ length: 40 }, (_, i) => del(i + 1, 'K0ABC', { deleteGuard: Guard.CONFIRMED }));
  assert.strictEqual(Guard.planPush(many, { now: NOW }).send.length, 40);
  const declined = Array.from({ length: 40 }, (_, i) => del(i + 1, 'K0ABC', { deleteGuard: Guard.DECLINED }));
  const p = Guard.planPush(declined, { now: NOW });
  assert.strictEqual(p.send.length, 0);
  assert.strictEqual(p.held.length, 40);
  assert.strictEqual(p.ask.length, 0);
  const foreign = Guard.planPush([del(1, 'K0ABC', { deleteGuard: Guard.CONFIRMED })], { now: NOW, otherProfiles: ['K0ABC'] });
  assert.strictEqual(foreign.send.length, 1, 'the operator said yes');
});

check('dialog names the count and every station callsign, and says what each answer does', () => {
  const ask = [del(1, 'K0ABC'), del(2, 'K0ABC'), del(3, 'IS0/K0ABC'), del(4, '')];
  const t = Guard.dialogText(ask, { otherProfiles: ['K0ABC'] });
  assert.match(t.message, /Delete 4 QSOs from the Cloud\?/);
  assert.match(t.detail, /K0ABC: 2/);
  assert.match(t.detail, /IS0\/K0ABC: 1/);
  assert.match(t.detail, /\(no station callsign\): 1/);
  assert.match(t.detail, /K0ABC is another operator profile/);
  assert.strictEqual(t.buttons[t.keepIndex], 'Keep in Cloud');
  assert.strictEqual(t.buttons[t.deleteIndex], 'Delete 4 from Cloud');
  assert.ok(!/[\u{1F300}-\u{1FAFF}]/u.test(t.detail + t.message), 'no emoji');
  assert.match(Guard.heldLine(ask), /holding 4 QSO deletion\(s\) \(K0ABC 2, /);
});

// ── through cloud-ipc ───────────────────────────────────────────────────────
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'potacat-delete-guard-'));
let dirN = 0;
const freshDir = () => { const d = path.join(root, String(dirN++)); fs.mkdirSync(d); return d; };
const HEADER = 'ADIF Export from POTACAT\n<EOH>\n';
const writeLog = (file, records) => fs.writeFileSync(file, HEADER + records.map((r) =>
  Object.entries(r).map(([k, v]) => `<${k}:${String(v).length}>${v}`).join(' ') + ' <EOR>\n').join(''));
const ACCOUNT = 'acct-1';
const rec = (n, station) => ({
  CALL: `K${n}ABC`, QSO_DATE: '20261030', TIME_ON: `${String(n % 24).padStart(2, '0')}${String(n % 60).padStart(2, '0')}00`,
  BAND: '20m', FREQ: '14.074000', MODE: 'FT8', STATION_CALLSIGN: station, APP_POTACAT_UUID: uuid(n), APP_POTACAT_VERSION: '1',
});

function desktop({ dir, active, profiles, records = [], answer }) {
  const logPath = path.join(dir, 'log.adi');
  writeLog(logPath, records);
  const lines = [];
  const asked = [];
  const settings = { cloudSyncEnabled: true, cloudAccessToken: 'x', cloudUser: { id: ACCOUNT }, activeProfile: active, myCallsign: active };
  const cloud = registerCloudIpc({
    app: { getPath: () => dir },
    win: null,
    getSettings: () => settings,
    saveSettings: (s) => Object.assign(settings, s),
    getLogPath: () => logPath,
    loadWorkedQsos: () => {},
    sendToRenderer: () => {},
    log: (m) => lines.push(m),
    getActiveProfile: () => active,
    listProfiles: () => profiles,
    confirmCloudDeletes: async (t) => { asked.push(t); return answer; },
  });
  const client = cloud.getCloudSync();
  client.calls = [];
  client._authedRequest = async (method, url, body) => {
    client.calls.push({ method, url, body });
    if (url.startsWith('/v1/sync/push')) return { accepted: body.changes.map((c) => c.uuid), conflicts: [] };
    if (url.startsWith('/v1/sync/status')) return { totalQsos: 0 };
    return { qsos: [], hasMore: false };
  };
  const pushedDeletes = () => client.calls.filter((c) => c.url.startsWith('/v1/sync/push'))
    .flatMap((c) => c.body.changes).filter((c) => c.isDeleted).map((c) => c.uuid);
  return { cloud, logPath, lines, asked, pushedDeletes, journal: cloud.journal };
}
const tick = () => new Promise((r) => setTimeout(r, 20));
const QsoLog = require('../lib/qso-log');
const removeAll = (d, pred) => QsoLog.mutateLog(d.logPath, (qsos) => qsos.filter((q) => !pred(q)), { sink: d.cloud.recordLogChanges });

check('a mass delete from the log is held, asked about once, and kept on "Keep in Cloud"', async () => {
  const dir = freshDir();
  const records = Array.from({ length: 300 }, (_, i) => rec(i + 1, 'K0ABC'));
  const d = desktop({ dir, active: 'K0ABC', profiles: [{ call: 'K0ABC', owner: ACCOUNT }], records, answer: false });
  removeAll(d, () => true);
  assert.strictEqual(parseAllRawQsos(d.logPath).length, 0, 'the local log changed as the operator asked');
  await d.cloud.syncNow();
  await tick();
  assert.strictEqual(d.pushedDeletes().length, 0, 'nothing deleted in the Cloud');
  assert.strictEqual(d.asked.length, 1);
  assert.match(d.asked[0].message, /Delete 300 QSOs/);
  assert.ok(d.lines.some((l) => /holding 300 QSO deletion\(s\) \(K0ABC 300\)/.test(l)), d.lines.join('\n'));
  assert.ok(d.lines.some((l) => /kept 300 QSO\(s\) in the Cloud/.test(l)));
  assert.strictEqual(d.journal.getAll().filter((e) => e.deleteGuard === 'declined').length, 300, 'held in the journal');
  await d.cloud.syncNow();
  await tick();
  assert.strictEqual(d.asked.length, 1, 'not asked again');
  assert.strictEqual(d.pushedDeletes().length, 0);
});

check('"Delete from Cloud" sends them all', async () => {
  const dir = freshDir();
  const records = Array.from({ length: 60 }, (_, i) => rec(i + 1, 'K0ABC'));
  const d = desktop({ dir, active: 'K0ABC', profiles: [], records, answer: true });
  removeAll(d, () => true);
  await d.cloud.syncNow();
  for (let i = 0; i < 20 && d.pushedDeletes().length < 60; i++) await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(d.asked.length, 1);
  assert.strictEqual(d.pushedDeletes().length, 60);
  assert.strictEqual(d.journal.getAll().length, 0);
});

check('a few deletes go straight out, and count toward the hour', async () => {
  const dir = freshDir();
  const records = Array.from({ length: 40 }, (_, i) => rec(i + 1, 'K0ABC'));
  const d = desktop({ dir, active: 'K0ABC', profiles: [], records, answer: false });
  removeAll(d, (q) => Number(q.APP_POTACAT_UUID.slice(-3)) <= 20);
  await d.cloud.syncNow();
  assert.strictEqual(d.pushedDeletes().length, 20);
  assert.strictEqual(d.asked.length, 0);
  removeAll(d, (q) => Number(q.APP_POTACAT_UUID.slice(-3)) <= 30);
  await d.cloud.syncNow();
  await tick();
  assert.strictEqual(d.pushedDeletes().length, 20, 'the next 10 would make 30 in the hour');
  assert.strictEqual(d.asked.length, 1);
});

check('a delete of another profile\'s QSO from this profile\'s log is held, even one', async () => {
  const dir = freshDir();
  const both = [{ call: 'K0ABC', owner: ACCOUNT }, { call: 'K0ABC/P', owner: ACCOUNT }];
  const d = desktop({ dir, active: 'K0ABC/P', profiles: both, records: [rec(1, 'K0ABC'), rec(2, 'K0ABC/P')], answer: false });
  removeAll(d, () => true);
  await d.cloud.syncNow();
  await tick();
  assert.deepStrictEqual(d.pushedDeletes(), [uuid(2)], 'its own QSO goes; K0ABC\'s stays in the Cloud');
  assert.strictEqual(d.asked.length, 1);
  assert.match(d.asked[0].detail, /K0ABC is another operator profile/);
});

check('C: the pull\'s duplicate guard never tombstones a QSO of another station callsign', async () => {
  const dir = freshDir();
  // One profile logging two callsigns: the same station worked from K0ABC and,
  // a minute later, from K0ABC/P. Two QSOs, not one reported twice.
  const mine = rec(1, 'K0ABC');
  const d = desktop({ dir, active: 'K0ABC', profiles: [], records: [mine], answer: false });
  const other = { ...mine, STATION_CALLSIGN: 'K0ABC/P', TIME_ON: mine.TIME_ON.slice(0, 2) + String(Number(mine.TIME_ON.slice(2, 4)) + 1).padStart(2, '0') + '00' };
  delete other.APP_POTACAT_UUID; delete other.APP_POTACAT_VERSION;
  const { onPulled } = d.cloud.getSyncCallbacks();
  await onPulled([{ uuid: uuid(500), version: 1, adifFields: other }]);
  assert.strictEqual(d.journal.getAll().filter((e) => e.action === 'delete').length, 0, 'no tombstone queued');
  assert.strictEqual(parseAllRawQsos(d.logPath).length, 2, 'both QSOs in the log');
  // Same station callsign, same contact: absorbed locally as before, never
  // deleted in the Cloud.
  const twin = { ...mine }; delete twin.APP_POTACAT_UUID; delete twin.APP_POTACAT_VERSION;
  await onPulled([{ uuid: uuid(501), version: 1, adifFields: twin }]);
  assert.strictEqual(parseAllRawQsos(d.logPath).length, 2, 'not appended twice');
  assert.strictEqual(d.journal.getAll().filter((e) => e.action === 'delete').length, 0, 'aliased, not tombstoned');
});

check('root cause: two logs holding one contact under two uuids no longer delete each other\'s copy', async () => {
  // The chain the Cloud saw: a catch-up or re-upload gives the server a second
  // copy under a new uuid, then a whole-history pull on each side found the
  // other's copy and tombstoned it. Both copies died.
  const a = rec(7, 'K0ABC');
  const b = { ...a, APP_POTACAT_UUID: uuid(70007) };
  const strip = (r) => { const f = { ...r }; delete f.APP_POTACAT_UUID; delete f.APP_POTACAT_VERSION; return f; };
  const left = desktop({ dir: freshDir(), active: 'K0ABC', profiles: [], records: [a], answer: false });
  const right = desktop({ dir: freshDir(), active: 'K0ABC', profiles: [], records: [b], answer: false });
  await left.cloud.getSyncCallbacks().onPulled([{ uuid: b.APP_POTACAT_UUID, version: 1, adifFields: strip(b) }]);
  await right.cloud.getSyncCallbacks().onPulled([{ uuid: a.APP_POTACAT_UUID, version: 1, adifFields: strip(a) }]);
  for (const d of [left, right]) {
    assert.strictEqual(d.journal.getAll().filter((e) => e.action === 'delete').length, 0, 'no delete pushed by either side');
    assert.strictEqual(parseAllRawQsos(d.logPath).length, 1, 'each log keeps its one record');
  }
});

check('a uuid in another case is the same QSO (no look-alike match against itself)', async () => {
  const mine = { ...rec(9, 'K0ABC'), APP_POTACAT_UUID: uuid(9).toUpperCase() };
  const d = desktop({ dir: freshDir(), active: 'K0ABC', profiles: [], records: [mine], answer: false });
  const fields = { ...mine }; delete fields.APP_POTACAT_UUID; delete fields.APP_POTACAT_VERSION;
  await d.cloud.getSyncCallbacks().onPulled([{ uuid: uuid(9), version: 2, adifFields: { ...fields, COMMENT: 'edited' } }]);
  const q = parseAllRawQsos(d.logPath);
  assert.strictEqual(q.length, 1);
  assert.strictEqual(q[0].COMMENT, 'edited', 'applied as an update of the same QSO');
  assert.ok(!q[0].APP_POTACAT_MERGED_UUIDS, 'not absorbed as a look-alike');
});

check('a profile sharing its account with another profile does not re-pull the whole history on Sync Now', async () => {
  const both = [{ call: 'K0ABC', owner: ACCOUNT }, { call: 'K0ABC/P', owner: ACCOUNT }];
  const d = desktop({ dir: freshDir(), active: 'K0ABC', profiles: both, records: [rec(1, 'K0ABC')], answer: false });
  const client = d.cloud.getCloudSync();
  client._lastSyncTimestamp = '2026-11-01T00:00:00.000Z';
  const base = client._authedRequest;
  client._authedRequest = async (m, url, body) => (url.startsWith('/v1/sync/status') ? { totalQsos: 5000 } : base(m, url, body));
  await d.cloud.syncNow();
  const pulls = client.calls.filter((c) => c.url.startsWith('/v1/sync/pull'));
  assert.ok(pulls.length >= 1 && pulls.every((c) => /since=/.test(c.url)), 'the pull keeps its cursor');
  assert.ok(!d.lines.some((l) => /pulling the account's whole history again/.test(l)));
});

check('main.js gives cloud-ipc the window the dialog belongs to', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf-8');
  const at = src.indexOf('cloudIpc = registerCloudIpc({');
  assert.ok(/win:\s*\(\)\s*=>\s*win/.test(src.slice(at, at + 400)));
  const ipc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'cloud-ipc.js'), 'utf-8');
  assert.ok(/startInterval\(interval, pushJournal\(\)/.test(ipc), 'background sync pushes through the guard');
  assert.ok(/const view = pushJournal\(\);/.test(ipc), 'Sync Now pushes through the guard');
});

(async () => {
  for (const run of queue) await run();
  console.log(`\nCloud delete guard (#245): ${passed} passed, ${failures} failed`);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
})();
