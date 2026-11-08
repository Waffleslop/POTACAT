// Cloud pull with several operator profiles on one PC (GitHub #245, LZ3AW).
//
// One cloud account, two desktop profiles (LZ3AW and LZ3AW/P). The server
// holds one flat QSO set per account; STATION_CALLSIGN says which station
// each QSO is for. Before this fix:
//   1. mergePulledQsos wrote EVERY pulled QSO into the active profile's log,
//      so the /P profile's first sync pulled LZ3AW's 10,000 QSOs into the /P
//      log;
//   2. the one-per-machine journal and the cross-device duplicate guard then
//      tombstoned LZ3AW's records as "duplicates", and the LZ3AW profile
//      pulled those tombstones and deleted its own log down to 235 QSOs.
//
// Rules under test:
//   A. a pulled QSO is left out only when its STATION_CALLSIGN is ANOTHER
//      profile on this PC signed in to the same account — never because it
//      differs from the active call (a single profile logging /P keeps all);
//   B. the duplicate guard never absorbs or tombstones another profile's record;
//   C. journal entries are stamped with their profile (an existing journal
//      becomes the active profile's on upgrade, silently), but pushes stay
//      account-wide: any profile of the account pushes them at once;
//   D. one log line per pull with the counts.
//
// Runs the real cloud-ipc with electron stubbed. No network: nothing here
// calls the cloud API.

const { readSrc } = require('./_src');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const electronStub = { ipcMain: { handle: () => {}, on: () => {} }, dialog: {}, shell: { openExternal: () => {} } };
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return electronStub;
  return origLoad.call(this, request, ...rest);
};
const { registerCloudIpc } = require('../lib/cloud-ipc');
Module._load = origLoad;

const { parseAllRawQsos } = require('../lib/adif');
const SyncJournal = require('../lib/sync-journal');

let failures = 0;
let passed = 0;
const queue = [];
function check(name, fn) {
  queue.push(async () => {
    try { await fn(); passed++; console.log(`  ok   ${name}`); }
    catch (err) { failures++; console.error(`  FAIL ${name}\n       ${err.stack || err.message}`); }
  });
}
/** Stand-in for the cloud API on this profile's client: records every call, never touches the network. */
function fakeServer(cloud) {
  const client = cloud.getCloudSync();
  client.calls = [];
  client._authedRequest = async (method, url, body) => {
    client.calls.push({ method, url, body });
    if (url.startsWith('/v1/sync/push')) return { accepted: body.changes.map((c) => c.uuid), conflicts: [] };
    return { qsos: [], hasMore: false };
  };
  client.pushed = () => client.calls.filter((c) => c.url.startsWith('/v1/sync/push')).flatMap((c) => c.body.changes.map((x) => x.uuid));
  return client;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'potacat-245-'));
let dirN = 0;
const freshDir = () => { const d = path.join(root, String(dirN++)); fs.mkdirSync(d); return d; };
const HEADER = 'ADIF Export from POTACAT\n<EOH>\n';
const writeLog = (file, records) => fs.writeFileSync(file, HEADER + records.map((r) =>
  Object.entries(r).map(([k, v]) => `<${k}:${String(v).length}>${v}`).join(' ') + ' <EOR>\n').join(''));

const ACCOUNT = 'acct-lz3aw';
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
let qsoN = 0;
/** A pulled server row: a distinct contact per call (different hour), stamped for `station`. */
function row(station, extra = {}) {
  const n = ++qsoN;
  const fields = {
    CALL: `K${n}ABC`, QSO_DATE: '20261030', TIME_ON: `${String(n % 24).padStart(2, '0')}0000`,
    BAND: '20m', FREQ: '14.074000', MODE: 'FT8', ...extra,
  };
  if (station) fields.STATION_CALLSIGN = station;
  return { uuid: uuid(n), version: 1, adifFields: fields };
}

/**
 * One desktop process with `active` as its profile. `profiles` is what
 * main.js hands over: every profile on the PC with the account it is signed
 * in to. Profiles share the userData dir (and its journal), each has its own
 * log — exactly the reporter's layout.
 */
function desktop({ dir, active, profiles, owner = ACCOUNT, logName }) {
  const logPath = path.join(dir, logName || `${String(active || 'none').replace(/\//g, '_')}.adi`);
  if (!fs.existsSync(logPath)) writeLog(logPath, []);
  const lines = [];
  const settings = {
    cloudSyncEnabled: true, cloudAccessToken: 'x', cloudUser: { id: owner },
    activeProfile: active, myCallsign: active,
  };
  const ctx = {
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
  };
  const cloud = registerCloudIpc(ctx);
  const { onPulled } = cloud.getSyncCallbacks();
  return { cloud, onPulled, logPath, lines, settings, log: () => parseAllRawQsos(logPath) };
}

const stationsIn = (qsos) => qsos.map((q) => q.STATION_CALLSIGN || '').sort();
const count = (arr, v) => arr.filter((x) => x === v).length;
const BOTH = [{ call: 'LZ3AW', owner: ACCOUNT }, { call: 'LZ3AW/P', owner: ACCOUNT }];

// ── A. two profiles on one account ─────────────────────────────────────────
check('two profiles, one account: each log gets only its own QSOs and the shared ones', () => {
  const dir = freshDir();
  const server = [
    row('LZ3AW'), row('LZ3AW'), row('LZ3AW'),
    row('LZ3AW/P'), row('LZ3AW/P'),
    row('lz3aw/p'),            // case-insensitive
    row(''),                   // no STATION_CALLSIGN: the active profile's, as today
    row('LZ3AW/M'),            // a station call no profile owns: everyone keeps it
  ];
  const base = desktop({ dir, active: 'LZ3AW', profiles: BOTH });
  base.onPulled(server);
  const b = stationsIn(base.log());
  assert.strictEqual(b.length, 5, `LZ3AW log: ${b.join(',')}`);
  assert.strictEqual(count(b, 'LZ3AW'), 3);
  assert.strictEqual(count(b, ''), 1);
  assert.strictEqual(count(b, 'LZ3AW/M'), 1);
  assert.ok(!b.some((s) => s.toUpperCase() === 'LZ3AW/P'), 'no /P QSO in the LZ3AW log');

  const port = desktop({ dir, active: 'LZ3AW/P', profiles: BOTH });
  port.onPulled(server);
  const p = stationsIn(port.log());
  assert.strictEqual(p.length, 5, `LZ3AW/P log: ${p.join(',')}`);
  assert.strictEqual(p.filter((s) => s.toUpperCase() === 'LZ3AW/P').length, 3);
  assert.strictEqual(count(p, ''), 1);
  assert.strictEqual(count(p, 'LZ3AW/M'), 1);
  assert.ok(!p.includes('LZ3AW'), 'no LZ3AW QSO in the /P log');
});

check('D. one log line per pull with the counts, call signs only', () => {
  const dir = freshDir();
  const port = desktop({ dir, active: 'LZ3AW/P', profiles: BOTH });
  port.onPulled([row('LZ3AW'), row('LZ3AW'), row('LZ3AW/P')]);
  const skipLines = port.lines.filter((l) => /belong to another profile/.test(l));
  assert.strictEqual(skipLines.length, 1, port.lines.join('\n'));
  assert.strictEqual(skipLines[0], "[Cloud] pull: 2 QSO(s) for LZ3AW belong to another profile on this PC — left out of LZ3AW/P's log");
  port.lines.length = 0;
  port.onPulled([row('LZ3AW/P')]);
  assert.ok(!port.lines.some((l) => /another profile/.test(l)), 'nothing skipped → no line');
});

check('a profile signed in to a DIFFERENT account is not "another profile of this account": its QSOs still arrive', () => {
  const dir = freshDir();
  const d = desktop({ dir, active: 'LZ3AW', profiles: [{ call: 'LZ3AW', owner: ACCOUNT }, { call: 'LZ3AW/P', owner: 'acct-other' }] });
  d.onPulled([row('LZ3AW'), row('LZ3AW/P')]);
  assert.strictEqual(d.log().length, 2);
});

check('a profile that is signed out never receives them, so they are kept', () => {
  const dir = freshDir();
  const d = desktop({ dir, active: 'LZ3AW', profiles: [{ call: 'LZ3AW', owner: ACCOUNT }, { call: 'LZ3AW/P', owner: null }] });
  d.onPulled([row('LZ3AW'), row('LZ3AW/P')]);
  assert.strictEqual(d.log().length, 2);
});

check('an update to a record already in this log still applies (only NEW arrivals are filtered)', () => {
  const dir = freshDir();
  const d = desktop({ dir, active: 'LZ3AW', profiles: BOTH });
  const r = row('LZ3AW/P');
  writeLog(d.logPath, [{ ...r.adifFields, APP_POTACAT_UUID: r.uuid, APP_POTACAT_VERSION: '1' }]);
  d.onPulled([{ ...r, version: 2, adifFields: { ...r.adifFields, COMMENT: 'edited' } }]);
  const q = d.log();
  assert.strictEqual(q.length, 1);
  assert.strictEqual(q[0].COMMENT, 'edited');
});

// ── single profile: unchanged ──────────────────────────────────────────────
check('single profile logging /P, /M and other station calls: everything arrives', () => {
  const dir = freshDir();
  const solo = desktop({ dir, active: 'LZ3AW', profiles: [{ call: 'LZ3AW', owner: ACCOUNT }] });
  solo.onPulled([row('LZ3AW'), row('LZ3AW/P'), row('LZ3AW/M'), row('LZ2XX'), row('')]);
  assert.strictEqual(solo.log().length, 5);
  assert.ok(!solo.lines.some((l) => /another profile/.test(l)));
});

check('no profile list from the host (older wiring): everything arrives', () => {
  const dir = freshDir();
  const d = desktop({ dir, active: 'LZ3AW', profiles: undefined });
  d.onPulled([row('LZ3AW'), row('LZ3AW/P')]);
  assert.strictEqual(d.log().length, 2);
});

check('no active profile known: nothing is filtered (never guess which profile this is)', () => {
  const dir = freshDir();
  const d = desktop({ dir, active: '', profiles: BOTH });
  d.onPulled([row('LZ3AW'), row('LZ3AW/P')]);
  assert.strictEqual(d.log().length, 2);
});

// ── B. the duplicate guard ─────────────────────────────────────────────────
check('B. absorb guard: another profile\'s pulled record is never tombstoned, even if this log holds a look-alike', () => {
  const dir = freshDir();
  const port = desktop({ dir, active: 'LZ3AW/P', profiles: BOTH });
  // The /P log already holds a copy of an LZ3AW contact under its own uuid —
  // the reporter's situation once the first full pull had polluted it.
  const theirs = row('LZ3AW');
  writeLog(port.logPath, [{ ...theirs.adifFields, APP_POTACAT_UUID: uuid(900001), APP_POTACAT_VERSION: '1' }]);
  const before = port.cloud.journal.length;
  port.onPulled([theirs]);
  assert.strictEqual(port.cloud.journal.length, before, 'no tombstone journaled for LZ3AW\'s record');
  assert.ok(!port.cloud.journal.getAll().some((e) => e.action === 'delete'));
  assert.strictEqual(port.log().length, 1, 'the log is left as it was');
});

check('B. absorb guard: a local record of another profile does not swallow (or tombstone) this profile\'s QSO', () => {
  const dir = freshDir();
  const port = desktop({ dir, active: 'LZ3AW/P', profiles: BOTH });
  // Same contact fields, but the local copy is LZ3AW's and the pulled one is /P's.
  const mine = row('LZ3AW/P');
  writeLog(port.logPath, [{ ...mine.adifFields, STATION_CALLSIGN: 'LZ3AW', APP_POTACAT_UUID: uuid(900002), APP_POTACAT_VERSION: '1' }]);
  port.onPulled([mine]);
  assert.ok(!port.cloud.journal.getAll().some((e) => e.action === 'delete'), 'no tombstone');
  const q = port.log();
  assert.strictEqual(q.length, 2, '/P\'s own QSO is added');
  assert.ok(q.some((r) => r.APP_POTACAT_UUID === mine.uuid));
  assert.ok(!q.some((r) => r.APP_POTACAT_MERGED_UUIDS), 'nothing absorbed');
});

check('B. the guard still absorbs a true cross-device duplicate within one profile', () => {
  const dir = freshDir();
  const port = desktop({ dir, active: 'LZ3AW/P', profiles: BOTH });
  const mine = row('LZ3AW/P');
  writeLog(port.logPath, [{ ...mine.adifFields, APP_POTACAT_UUID: uuid(900003), APP_POTACAT_VERSION: '1' }]);
  port.onPulled([mine]);
  const q = port.log();
  assert.strictEqual(q.length, 1);
  assert.strictEqual(q[0].APP_POTACAT_MERGED_UUIDS, mine.uuid);
  const dels = port.cloud.journal.getAll().filter((e) => e.action === 'delete');
  assert.strictEqual(dels.length, 1);
  assert.strictEqual(dels[0].profile, 'LZ3AW/P', 'the tombstone is the active profile\'s');
});

check('the reporter\'s sequence no longer empties the LZ3AW log', () => {
  const dir = freshDir();
  const server = [];
  for (let i = 0; i < 6; i++) server.push(row('LZ3AW'));
  for (let i = 0; i < 3; i++) server.push(row('LZ3AW/P'));
  const base = desktop({ dir, active: 'LZ3AW', profiles: BOTH, logName: 'base.adi' });
  base.onPulled(server);
  // The /P profile already held LZ3AW look-alikes (as on the reporter's PC).
  const port = desktop({ dir, active: 'LZ3AW/P', profiles: BOTH, logName: 'port.adi' });
  writeLog(port.logPath, server.slice(0, 6).map((r, i) => ({ ...r.adifFields, APP_POTACAT_UUID: uuid(800000 + i), APP_POTACAT_VERSION: '1' })));
  port.onPulled(server); // first sync: since = null → the whole account
  const tombstones = port.cloud.journal.getAll().filter((e) => e.action === 'delete');
  assert.strictEqual(tombstones.length, 0, 'no LZ3AW record tombstoned');
  // Even if a tombstone for a /P record came back, LZ3AW keeps its own.
  const again = desktop({ dir, active: 'LZ3AW', profiles: BOTH, logName: 'base.adi' });
  again.onPulled(tombstones.map((t) => ({ uuid: t.uuid, isDeleted: true, version: t.version })));
  assert.strictEqual(again.log().length, 6);
});

// ── C. journal: profile-stamped, pushed account-wide ───────────────────────
// The server holds one flat set per account, so any profile signed in to the
// account pushes every pending entry for it (#245 review). The stamp records
// whose change it is; only a different account (or signed out) holds a push.
check('C. entries carry the profile that wrote them; a same-account profile still pushes them', async () => {
  const dir = freshDir();
  const base = desktop({ dir, active: 'LZ3AW', profiles: BOTH });
  base.cloud.recordLogChanges([{ action: 'create', fields: { CALL: 'K1A', APP_POTACAT_UUID: uuid(1001), APP_POTACAT_VERSION: '1' } }]);
  assert.strictEqual(base.cloud.journal.getAll()[0].profile, 'LZ3AW');

  const port = desktop({ dir, active: 'LZ3AW/P', profiles: BOTH });
  assert.strictEqual(port.cloud.pendingStatus().pendingChanges, 1, 'same account: /P will push it');
  assert.deepStrictEqual(port.cloud.pendingStatus().pendingForOthers, { count: 0, owners: [] }, 'nothing shown as waiting');
  const client = fakeServer(port.cloud);
  await port.cloud.syncNow();
  assert.deepStrictEqual(client.pushed(), [uuid(1001)]);
  assert.strictEqual(port.cloud.journal.length, 0);
});

check('C. "Log as" a same-account profile: stamped with THAT profile and pushed by the current one right away', async () => {
  const dir = freshDir();
  const base = desktop({ dir, active: 'LZ3AW', profiles: BOTH });
  base.cloud.recordLogChangesFor(ACCOUNT, [{ action: 'create', fields: { CALL: 'K1B', APP_POTACAT_UUID: uuid(1002), APP_POTACAT_VERSION: '1' } }], 'lz3aw/p');
  assert.strictEqual(base.cloud.journal.getAll()[0].profile, 'LZ3AW/P');
  assert.strictEqual(base.cloud.pendingStatus().pendingChanges, 1);
  const client = fakeServer(base.cloud);
  const res = await base.cloud.syncNow();
  assert.deepStrictEqual(client.pushed(), [uuid(1002)], 'pushed now, not when /P is next active');
  assert.strictEqual(res.pushed, 1);
  assert.strictEqual(base.cloud.journal.length, 0);
});

check('C. "Log as" a profile on a DIFFERENT account still waits for that account', async () => {
  const dir = freshDir();
  const profiles = [{ call: 'LZ3AW', owner: ACCOUNT }, { call: 'LZ1ZZ', owner: 'acct-other' }];
  const base = desktop({ dir, active: 'LZ3AW', profiles });
  base.cloud.recordLogChangesFor('acct-other', [{ action: 'create', fields: { CALL: 'K1C', APP_POTACAT_UUID: uuid(1003), APP_POTACAT_VERSION: '1' } }], 'LZ1ZZ');
  assert.strictEqual(base.cloud.pendingStatus().pendingChanges, 0);
  assert.deepStrictEqual(base.cloud.pendingStatus().pendingForOthers, { count: 1, owners: ['acct-other'] });
  const client = fakeServer(base.cloud);
  await base.cloud.syncNow();
  assert.deepStrictEqual(client.pushed(), [], 'never pushed into this account');
  assert.strictEqual(base.cloud.journal.length, 1, 'still waiting');
});

check('C. the journal can still narrow a view to one profile (forOwner(owner, profile))', () => {
  const j = new SyncJournal(freshDir());
  j.appendMany([
    { uuid: uuid(1004), action: 'create', owner: ACCOUNT, profile: 'LZ3AW' },
    { uuid: uuid(1005), action: 'create', owner: ACCOUNT, profile: 'LZ3AW/P' },
  ]);
  assert.strictEqual(j.forOwner(ACCOUNT).length, 2);
  assert.strictEqual(j.forOwner(ACCOUNT, 'lz3aw/p').length, 1);
  j.forOwner(ACCOUNT, 'LZ3AW/P').removeWhere(() => true);
  assert.deepStrictEqual(j.getAll().map((e) => e.profile), ['LZ3AW']);
});

check('C. migration: an existing single-profile journal becomes the active profile\'s, silently, cursor kept', () => {
  const dir = freshDir();
  // A pre-#245 journal: owner-stamped and legacy (no owner) entries, no profile.
  const legacy = [
    { uuid: uuid(2001), action: 'create', adifFields: { CALL: 'K2A' }, version: 1, owner: ACCOUNT, timestamp: '2026-11-01T00:00:00Z' },
    { uuid: uuid(2002), action: 'update', adifFields: { CALL: 'K2B' }, version: 2, owner: null, timestamp: '2026-11-01T00:00:00Z' },
    { uuid: uuid(2003), action: 'delete', adifFields: { CALL: 'K2C' }, version: 3, owner: 'acct-someone-else', timestamp: '2026-11-01T00:00:00Z' },
  ];
  fs.writeFileSync(path.join(dir, 'sync-journal.json'), JSON.stringify(legacy));
  const d = desktop({ dir, active: 'LZ3AW', profiles: [{ call: 'LZ3AW', owner: ACCOUNT }] });
  d.settings.cloudLastSyncTimestamp = '2026-11-07T12:00:00Z';
  const all = d.cloud.journal.getAll();
  assert.strictEqual(all.length, 3, 'no entry lost');
  assert.ok(all.every((e) => e.profile === 'LZ3AW'), 'every legacy entry now belongs to the active profile');
  assert.strictEqual(all[2].owner, 'acct-someone-else', 'account ownership is untouched');
  assert.strictEqual(d.cloud.pendingStatus().pendingChanges, 2, 'same pending count as before the upgrade');
  assert.strictEqual(d.settings.cloudLastSyncTimestamp, '2026-11-07T12:00:00Z', 'the pull cursor is not reset (no re-pull)');
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'sync-journal.json'), 'utf-8'));
  assert.ok(onDisk.every((e) => e.profile === 'LZ3AW'), 'stamped on disk once');
  assert.ok(!d.lines.some((l) => /error|unreadable/i.test(l)));
  // Re-running is a no-op: the second profile does not re-stamp them (it
  // would still push them: pushes are account-wide).
  const port = desktop({ dir, active: 'LZ3AW/P', profiles: BOTH });
  assert.ok(port.cloud.journal.getAll().every((e) => e.profile === 'LZ3AW'));
});

check('C. no profile known: journal behaves exactly as before (account only)', () => {
  const dir = freshDir();
  const d = desktop({ dir, active: '', profiles: [] });
  d.cloud.recordLogChanges([{ action: 'create', fields: { CALL: 'K3A', APP_POTACAT_UUID: uuid(3001), APP_POTACAT_VERSION: '1' } }]);
  assert.strictEqual(d.cloud.journal.getAll()[0].profile, null);
  assert.strictEqual(d.cloud.pendingStatus().pendingChanges, 1);
  assert.deepStrictEqual(d.cloud.pendingStatus().pendingForOthers, { count: 0, owners: [] });
});

// ── wiring ─────────────────────────────────────────────────────────────────
check('main.js hands cloud-ipc the active profile and every profile with its account', () => {
  const src = readSrc('main.js');
  const at = src.indexOf('cloudIpc = registerCloudIpc({');
  assert.ok(at > 0);
  const block = src.slice(at, at + 4000);
  assert.ok(/getActiveProfile:\s*\(\)\s*=>/.test(block), 'getActiveProfile wired');
  assert.ok(/listProfiles:\s*\(\)\s*=>/.test(block), 'listProfiles wired');
  assert.ok(/ownerIdFor\(operatorSettingsFor\(/.test(block), 'each profile\'s account comes from its own settings');
  assert.ok(/recordLogChangesFor\(cloudIpc\.ownerIdFor\(ops\), changes, call\)/.test(src), '"Log as" passes the target profile');
});

(async () => {
  for (const run of queue) await run();
  console.log(`\nCloud pull per profile (#245): ${passed} passed, ${failures} failed`);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
})();
