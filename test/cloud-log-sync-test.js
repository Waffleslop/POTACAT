// Cloud sync journal + QSO log writes (2026-09-17).
//
// Reports that drove this: the cloud admin page showed K3SBP's synced QSOs
// with blank call/date/time/freq (the journal upper-cased qsoData's own keys:
// CALLSIGN, QSODATE, FREQUENCY in kHz), and NO4D's QSOs never reached the
// cloud (logged in ACLog, imported into POTACAT, and import never synced).
// Along the way: most log-writing paths never journaled, updates bumped the
// version after the file was written, conflicts were retried forever, the
// mobile-started Sync Now threw away what it pulled, the full-log upload
// cleared pending edits, and any log rewrite deleted pseudo-named records.
//
// Runs the real modules; electron is stubbed for cloud-ipc.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const { buildAdifFields, buildAdifRecord } = require('../lib/adif-writer');
const { parseAllRawQsos, parseRecord } = require('../lib/adif');
const { normalizeAdifFields } = require('../lib/adif-normalize');
const QsoLog = require('../lib/qso-log');
const { sameContact, modeKey, planImport, findDuplicateGroups } = require('../lib/qso-match');
const SyncJournal = require('../lib/sync-journal');
const CloudSyncClient = require('../lib/cloud-sync');

let failures = 0;
const pending = [];
function check(name, fn) {
  const run = async () => {
    try { await fn(); console.log(`  ok   ${name}`); }
    catch (err) { failures++; console.error(`  FAIL ${name}\n       ${err.stack || err.message}`); }
  };
  pending.push(run);
}

// Fixture uuids in the real format (a Postgres UUID column is the cloud's truth).
const UA = '11111111-1111-4111-8111-111111111111';
const UB = '22222222-2222-4222-8222-222222222222';
const UP = '33333333-3333-4333-8333-333333333333';
const UF = '44444444-4444-4444-8444-444444444444';
const UN = '55555555-5555-4555-8555-555555555555';
const UR = '66666666-6666-4666-8666-666666666666';
const UX = '77777777-7777-4777-8777-777777777777';
const UC = '88888888-8888-4888-8888-888888888888';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'potacat-cloud-log-'));
let dirN = 0;
const freshDir = () => { const d = path.join(root, String(dirN++)); fs.mkdirSync(d); return d; };
const HEADER = 'ADIF Export from POTACAT\n<EOH>\n';
const writeLog = (file, records) => fs.writeFileSync(file, HEADER + records.map((r) =>
  Object.entries(r).map(([k, v]) => `<${k}:${String(v).length}>${v}`).join(' ') + ' <EOR>\n').join(''));
const recordingSink = () => { const calls = []; const sink = (c) => calls.push(...c.map((x) => ({ action: x.action, fields: { ...x.fields } }))); sink.calls = calls; return sink; };

const QSO_DATA = {
  callsign: 'W1AW', frequency: '14074', mode: 'FT8', qsoDate: '20260917', timeOn: '2002',
  rstSent: '-05', rstRcvd: '+02', txPower: '50', band: '20m', sig: 'POTA', sigInfo: 'US-0001',
  operator: 'K3SBP', stationCallsign: 'K3SBP', county: 'Middlesex', eventId: 'route66',
  uuid: UN, respot: true, skipLogbookForward: false,
};

// ── §2 field names ────────────────────────────────────────────────────────
check('buildAdifFields: real ADIF names, FREQ in MHz, 6-char TIME_ON, no internal keys', () => {
  const f = buildAdifFields(QSO_DATA);
  assert.strictEqual(f.CALL, 'W1AW');
  assert.strictEqual(f.FREQ, '14.074000');
  assert.strictEqual(f.QSO_DATE, '20260917');
  assert.strictEqual(f.TIME_ON, '200200');
  assert.strictEqual(f.RST_SENT, '-05');
  assert.strictEqual(f.TX_PWR, '50');
  assert.strictEqual(f.SIG_INFO, 'US-0001');
  assert.strictEqual(f.POTA_REF, 'US-0001');
  assert.strictEqual(f.CNTY, 'Middlesex');
  assert.strictEqual(f.APP_POTACAT_EVENT, 'route66');
  assert.strictEqual(f.APP_POTACAT_UUID, UN);
  for (const bad of ['CALLSIGN', 'QSODATE', 'TIMEON', 'FREQUENCY', 'UUID', 'RESPOT', 'SKIPLOGBOOKFORWARD', 'COUNTY', 'EVENTID']) {
    assert.ok(!(bad in f), `unexpected ${bad}`);
  }
});

check('buildAdifFields: the cloud copy equals the record written to the file', () => {
  const written = parseRecord(buildAdifRecord(QSO_DATA));
  assert.deepStrictEqual(written, buildAdifFields(QSO_DATA));
});

// ── pseudo-name repair ────────────────────────────────────────────────────
const PSEUDO = {
  BAND: '40m', MODE: 'FT8', UUID: UP, TIMEON: '0159', QSODATE: '20260402',
  RSTRCVD: '+00', RSTSENT: '+01', CALLSIGN: 'W3BOO', OPERATOR: 'K3SBP', FREQUENCY: '7074',
  MYSIGINFO: 'US-1234', APP_POTACAT_UUID: UP, APP_POTACAT_VERSION: '1',
};

check('normalizeAdifFields: maps pseudo keys, converts kHz, never clobbers real values', () => {
  const n = normalizeAdifFields(PSEUDO);
  assert.strictEqual(n.CALL, 'W3BOO');
  assert.strictEqual(n.QSO_DATE, '20260402');
  assert.strictEqual(n.TIME_ON, '0159');
  assert.strictEqual(n.FREQ, '7.074000');
  assert.strictEqual(n.MY_SIG_INFO, 'US-1234');
  assert.strictEqual(n.APP_POTACAT_UUID, UP);
  for (const k of ['CALLSIGN', 'QSODATE', 'TIMEON', 'FREQUENCY', 'UUID', 'MYSIGINFO']) assert.ok(!(k in n), k);
  const both = normalizeAdifFields({ CALL: 'K1ABC', CALLSIGN: 'WRONG', FREQ: '14.2', FREQUENCY: '7000' });
  assert.strictEqual(both.CALL, 'K1ABC');
  assert.strictEqual(both.FREQ, '14.2');
  const clean = { CALL: 'K1ABC' };
  assert.strictEqual(normalizeAdifFields(clean), clean, 'clean input returned as-is');
});

check('parseAllRawQsos: a pseudo-named record is visible (it used to be skipped)', () => {
  const file = path.join(freshDir(), 'log.adi');
  writeLog(file, [{ CALL: 'K1ABC', QSO_DATE: '20260101', TIME_ON: '1200' }, PSEUDO]);
  const qsos = parseAllRawQsos(file);
  assert.strictEqual(qsos.length, 2);
  assert.strictEqual(qsos[1].CALL, 'W3BOO');
});

check('mutateLog: a rewrite keeps pseudo-named records (it used to delete them)', () => {
  const file = path.join(freshDir(), 'log.adi');
  writeLog(file, [{ CALL: 'K1ABC', QSO_DATE: '20260101', TIME_ON: '1200', APP_POTACAT_UUID: UX }, PSEUDO]);
  QsoLog.mutateLog(file, (qsos) => { qsos[0].COMMENT = 'edited'; });
  const calls = parseAllRawQsos(file).map((q) => q.CALL);
  assert.deepStrictEqual(calls, ['K1ABC', 'W3BOO']);
});

check('repairFieldNames: rewrites once with a backup, collapses identical re-appends; a clean log is untouched', () => {
  const dir = freshDir();
  const file = path.join(dir, 'log.adi');
  // The pseudo row three times over: a pull that could not see it re-appended it.
  writeLog(file, [{ CALL: 'K1ABC', QSO_DATE: '20260101' }, PSEUDO, PSEUDO, { ...PSEUDO, COMMENT: 'differs' }, PSEUDO]);
  assert.deepStrictEqual(QsoLog.repairFieldNames(file), { repaired: 4, collapsed: 2 });
  assert.strictEqual(parseAllRawQsos(file).length, 3, 'identical copies collapsed, the differing one kept');
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(!/<CALLSIGN:/i.test(text) && /<CALL:5>W3BOO/.test(text) && /<FREQ:8>7\.074000/.test(text));
  assert.strictEqual(fs.readdirSync(dir).filter((f) => f.includes('.pre-field-repair-')).length, 1);
  const mtime = fs.statSync(file).mtimeMs;
  assert.deepStrictEqual(QsoLog.repairFieldNames(file), { repaired: 0, collapsed: 0 });
  assert.strictEqual(fs.statSync(file).mtimeMs, mtime);
});

// ── the log store ─────────────────────────────────────────────────────────
function seededLog(records) {
  const file = path.join(freshDir(), 'log.adi');
  writeLog(file, records);
  return file;
}
const A = { CALL: 'K1ABC', FREQ: '14.074', MODE: 'FT8', QSO_DATE: '20260101', TIME_ON: '120000', APP_POTACAT_UUID: UA, APP_POTACAT_VERSION: '1' };
const B = { CALL: 'N2XYZ', FREQ: '7.030', MODE: 'CW', QSO_DATE: '20260102', TIME_ON: '010000', APP_POTACAT_UUID: UB, APP_POTACAT_VERSION: '3' };

check('mutateLog: an edit bumps the version BEFORE the write, so file and journal agree', () => {
  const file = seededLog([A, B]);
  const sink = recordingSink();
  QsoLog.mutateLog(file, (q) => { q[0].COMMENT = 'one'; }, { sink });
  QsoLog.mutateLog(file, (q) => { q[0].COMMENT = 'two'; }, { sink });
  assert.deepStrictEqual(sink.calls.map((c) => [c.action, c.fields.APP_POTACAT_VERSION]), [['update', '2'], ['update', '3']]);
  assert.strictEqual(parseAllRawQsos(file)[0].APP_POTACAT_VERSION, '3');
});

check('mutateLog: no change means no write and no journal entry; false aborts', () => {
  const file = seededLog([A]);
  const before = fs.readFileSync(file, 'utf8');
  const sink = recordingSink();
  assert.strictEqual(QsoLog.mutateLog(file, () => {}, { sink }).changes.length, 0);
  assert.strictEqual(QsoLog.mutateLog(file, (q) => { q[0].COMMENT = 'x'; return false; }, { sink }).changes.length, 0);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
  assert.strictEqual(sink.calls.length, 0);
});

check('mutateLog: a {...record} clone gets its own uuid and is a create (multipark split)', () => {
  const file = seededLog([A, B]);
  const sink = recordingSink();
  QsoLog.mutateLog(file, (q) => { q.splice(1, 0, { ...q[0], SIG_INFO: 'US-0002' }); }, { sink });
  const qsos = parseAllRawQsos(file);
  assert.strictEqual(qsos[0].APP_POTACAT_UUID, UA);
  assert.notStrictEqual(qsos[1].APP_POTACAT_UUID, UA);
  assert.strictEqual(qsos[1].APP_POTACAT_VERSION, '1');
  assert.deepStrictEqual(sink.calls.map((c) => c.action), ['create']);
  assert.strictEqual(sink.calls[0].fields.APP_POTACAT_UUID, qsos[1].APP_POTACAT_UUID);
});

check('mutateLog: removal is a delete carrying the removed record', () => {
  const file = seededLog([A, B]);
  const sink = recordingSink();
  QsoLog.mutateLog(file, (q) => q.filter((r) => r.CALL !== 'N2XYZ'), { sink });
  assert.deepStrictEqual(sink.calls.map((c) => [c.action, c.fields.APP_POTACAT_UUID, c.fields.APP_POTACAT_VERSION]), [['delete', UB, '3']]);
  assert.strictEqual(parseAllRawQsos(file).length, 1);
});

check('mutateLog: a rebuilt object with a removed record\'s uuid is an update, not create+delete', () => {
  const file = seededLog([A, B]);
  const sink = recordingSink();
  QsoLog.mutateLog(file, (q) => q.map((r) => (r.CALL === 'N2XYZ' ? { ...r, COMMENT: 'rebuilt' } : r)), { sink });
  assert.deepStrictEqual(sink.calls.map((c) => [c.action, c.fields.APP_POTACAT_UUID, c.fields.APP_POTACAT_VERSION]), [['update', UB, '4']]);
});

check('mutateLog: editing a never-synced record (no uuid) gives it an identity', () => {
  const file = seededLog([{ CALL: 'K9OLD', QSO_DATE: '20200101' }]);
  const sink = recordingSink();
  QsoLog.mutateLog(file, (q) => { q[0].COMMENT = 'x'; }, { sink });
  assert.strictEqual(sink.calls[0].action, 'create');
  assert.ok(sink.calls[0].fields.APP_POTACAT_UUID);
  assert.strictEqual(parseAllRawQsos(file)[0].APP_POTACAT_UUID, sink.calls[0].fields.APP_POTACAT_UUID);
});

check('mutateLog: of two records sharing a uuid, only the first keeps it', () => {
  const file = seededLog([A, { ...A, SIG_INFO: 'US-0002' }]);
  const sink = recordingSink();
  QsoLog.mutateLog(file, (q) => { q[1].COMMENT = 'x'; }, { sink });
  assert.strictEqual(sink.calls[0].action, 'create');
  assert.notStrictEqual(sink.calls[0].fields.APP_POTACAT_UUID, UA);
});

check('appendRecords: assigns identity, keeps a unique incoming uuid, replaces a colliding one', () => {
  const file = seededLog([A]);
  const sink = recordingSink();
  const recs = [{ CALL: 'X1' }, { CALL: 'X2', APP_POTACAT_UUID: UF }, { CALL: 'X3', APP_POTACAT_UUID: UA }];
  QsoLog.appendRecords(file, recs, { sink });
  const qsos = parseAllRawQsos(file);
  assert.strictEqual(qsos.length, 4);
  assert.ok(qsos[1].APP_POTACAT_UUID && qsos[1].APP_POTACAT_VERSION === '1');
  assert.strictEqual(qsos[2].APP_POTACAT_UUID, UF);
  assert.notStrictEqual(qsos[3].APP_POTACAT_UUID, UA);
  assert.deepStrictEqual(sink.calls.map((c) => c.action), ['create', 'create', 'create']);
});

// ── §5 matching, import, duplicates ───────────────────────────────────────
check('modeKey: USB/LSB = SSB, MFSK/FT4 = FT4, PSK/PSK31 = PSK31', () => {
  assert.strictEqual(modeKey({ MODE: 'USB' }), 'SSB');
  assert.strictEqual(modeKey({ MODE: 'ssb', SUBMODE: 'LSB' }), 'SSB');
  assert.strictEqual(modeKey({ MODE: 'MFSK', SUBMODE: 'FT4' }), modeKey({ MODE: 'FT4' }));
  assert.strictEqual(modeKey({ MODE: 'PSK', SUBMODE: 'PSK31' }), modeKey({ MODE: 'PSK31' }));
  assert.notStrictEqual(modeKey({ MODE: 'CW' }), modeKey({ MODE: 'SSB' }));
});

const ACLOG_SSB = { CALL: 'no4d', FREQ: '14.2855', MODE: 'USB', QSO_DATE: '20260915', TIME_ON: '1402' };
const POTACAT_SSB = { CALL: 'NO4D', FREQ: '14.285500', MODE: 'SSB', QSO_DATE: '20260915', TIME_ON: '140230' };

check('sameContact: another logger\'s spelling of the same QSO matches; a rework hours later does not', () => {
  assert.ok(sameContact(ACLOG_SSB, POTACAT_SSB));
  assert.ok(!sameContact(ACLOG_SSB, { ...POTACAT_SSB, TIME_ON: '171500' }));
  assert.ok(!sameContact(ACLOG_SSB, { ...POTACAT_SSB, MODE: 'CW' }));
  assert.ok(!sameContact(ACLOG_SSB, { ...POTACAT_SSB, FREQ: '7.1855' }));
  assert.ok(sameContact({ CALL: 'A1A', BAND: '20m', MODE: 'CW', QSO_DATE: '20260101', TIME_ON: '0000' },
    { CALL: 'A1A', BAND: '20M', MODE: 'CW', QSO_DATE: '20260101', TIME_ON: '0002' }), 'band fallback');
});

check('planImport: importing the same file twice adds its QSOs once', () => {
  const file = [ACLOG_SSB, { CALL: 'K4XYZ', FREQ: '7.074', MODE: 'FT8', QSO_DATE: '20260915', TIME_ON: '0100' }];
  const first = planImport([POTACAT_SSB], file);
  assert.strictEqual(first.fresh.length, 1);
  assert.strictEqual(first.skipped, 1);
  const second = planImport([POTACAT_SSB, ...first.fresh], file.map((r) => ({ ...r })));
  assert.strictEqual(second.fresh.length, 0);
  assert.strictEqual(second.skipped, 2);
  const within = planImport([], [ACLOG_SSB, { ...ACLOG_SSB }]);
  assert.deepStrictEqual([within.fresh.length, within.skipped], [1, 1]);
});

check('findDuplicateGroups: transitive groups (0:00 ~ 0:02:30 ~ 0:05), keeps the fullest record, leaves singles alone', () => {
  const qsos = [
    { CALL: 'W1A', MODE: 'CW', FREQ: '7.030', QSO_DATE: '20260101', TIME_ON: '000000' },
    { CALL: 'K2B', MODE: 'CW', FREQ: '7.030', QSO_DATE: '20260101', TIME_ON: '000000' },
    { CALL: 'W1A', MODE: 'CW', FREQ: '7.030', QSO_DATE: '20260101', TIME_ON: '000230', NAME: 'Al', STATE: 'CT' },
    { CALL: 'W1A', MODE: 'CW', FREQ: '7.030', QSO_DATE: '20260101', TIME_ON: '000500' },
    { CALL: 'W1A', MODE: 'CW', FREQ: '7.030', QSO_DATE: '20260101', TIME_ON: '230000' },
  ];
  assert.deepStrictEqual(findDuplicateGroups(qsos), [{ members: [0, 2, 3], keep: 2 }]);
});

// ── §4 journal ────────────────────────────────────────────────────────────
check('SyncJournal: an unreadable file is set aside, never silently overwritten', () => {
  const dir = freshDir();
  fs.writeFileSync(path.join(dir, 'sync-journal.json'), '[{"uuid":');
  const logged = [];
  const j = new SyncJournal(dir, { log: (m) => logged.push(m) });
  assert.strictEqual(j.length, 0);
  const aside = fs.readdirSync(dir).filter((f) => f.startsWith('sync-journal.json.corrupt-'));
  assert.strictEqual(aside.length, 1);
  assert.strictEqual(fs.readFileSync(path.join(dir, aside[0]), 'utf8'), '[{"uuid":');
  assert.ok(logged[0].includes('unreadable'));
});

check('SyncJournal: removeEntries removes exactly the objects given, even when uuids repeat', () => {
  const j = new SyncJournal(freshDir());
  j.appendMany([{ uuid: 'u', action: 'create' }, { uuid: 'u', action: 'update', version: 2 }]);
  const pushed = j.getAll();
  j.append({ uuid: 'u', action: 'update', version: 3 }); // edited while the push was in flight
  j.removeEntries(pushed);
  assert.deepStrictEqual(j.getAll().map((e) => e.version), [3]);
  assert.strictEqual(new SyncJournal(path.dirname(j._filePath)).length, 1, 'persisted');
});

function fakeServer(client, handler) {
  client.calls = [];
  client._authedRequest = async (method, url, body) => {
    client.calls.push({ method, url, body });
    return handler(method, url, body);
  };
}
const pushOutcome = (body, conflictUuids = []) => ({
  accepted: body.changes.filter((c) => !conflictUuids.includes(c.uuid)).map((c) => c.uuid),
  conflicts: body.changes.filter((c) => conflictUuids.includes(c.uuid))
    .map((c) => ({ uuid: c.uuid, serverVersion: 9, serverFields: { CALL: 'SRV' }, serverIsDeleted: false })),
});

check('sync: a conflict is merged and then leaves the journal (it used to be re-pushed forever)', async () => {
  const j = new SyncJournal(freshDir());
  j.appendMany([{ uuid: 'ok', action: 'create' }, { uuid: 'clash', action: 'update', version: 2 }]);
  const client = new CloudSyncClient({ apiBase: 'http://x', accessToken: 't' });
  fakeServer(client, (m, url, body) => (url.startsWith('/v1/sync/push') ? pushOutcome(body, ['clash']) : { qsos: [], hasMore: false }));
  const merged = [];
  let synced = null;
  const res = await client.sync(j, { onConflicts: (c) => merged.push(...c), onSynced: (s) => { synced = s; } });
  assert.deepStrictEqual(res, { pushed: 1, pulled: 0, conflicts: 1 });
  assert.deepStrictEqual(merged.map((c) => c.uuid), ['clash']);
  assert.strictEqual(j.length, 0);
  assert.deepStrictEqual(synced, res);
  await client.sync(j, {});
  assert.strictEqual(client.calls.filter((c) => c.url.startsWith('/v1/sync/push')).length, 1, 'nothing re-pushed');
});

check('sync: a failure on batch 2 keeps only batch 2 onward (batch 1 is committed server-side)', async () => {
  const j = new SyncJournal(freshDir());
  j.appendMany(Array.from({ length: 250 }, (_, i) => ({ uuid: `u${i}`, action: 'create' })));
  const client = new CloudSyncClient({ apiBase: 'http://x', accessToken: 't' });
  let pushes = 0;
  fakeServer(client, (m, url, body) => {
    if (!url.startsWith('/v1/sync/push')) return { qsos: [], hasMore: false };
    if (++pushes === 2) throw new Error('HTTP 502');
    return pushOutcome(body);
  });
  await assert.rejects(client.sync(j, {}), /502/);
  assert.strictEqual(j.length, 50);
  assert.strictEqual(j.getAll()[0].uuid, 'u200');
});

// ── cloud-ipc (journal gate, conflicts, full upload) ──────────────────────
const handlers = {};
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return { ipcMain: { handle: (n, fn) => { handlers[n] = fn; }, on: () => {} }, dialog: {}, shell: {} };
  return origLoad.call(this, request, ...rest);
};
const { registerCloudIpc } = require('../lib/cloud-ipc');
Module._load = origLoad;

function cloudEnv(settingsOverride) {
  const dir = freshDir();
  const logPath = path.join(dir, 'log.adi');
  const settings = { cloudSyncEnabled: false, cloudAccessToken: 'tok', cloudUser: { id: 'acct-a', email: 'a@example.com' }, ...settingsOverride };
  const logs = [];
  const cloud = registerCloudIpc({
    app: { getPath: () => dir },
    getSettings: () => settings,
    saveSettings: (s) => Object.assign(settings, s),
    getLogPath: () => logPath,
    loadWorkedQsos: () => {},
    sendToRenderer: () => {},
    log: (m) => logs.push(m),
  });
  const sink = (c) => cloud.recordLogChanges(c);
  return { dir, logPath, settings, cloud, sink, logs };
}

check('recordLogChanges: journaled while signed in even with auto-sync OFF; nothing when signed out', () => {
  const on = cloudEnv({ cloudSyncEnabled: false });
  QsoLog.appendRecords(on.logPath, [buildAdifFields(QSO_DATA)], { existing: [], sink: on.sink });
  assert.strictEqual(on.cloud.journal.length, 1);
  const e = on.cloud.journal.getAll()[0];
  assert.deepStrictEqual([e.uuid, e.action, e.version, e.adifFields.CALL, e.adifFields.FREQ], [UN, 'create', 1, 'W1AW', '14.074000']);
  assert.ok(!('CALLSIGN' in e.adifFields));

  const off = cloudEnv({ cloudAccessToken: null });
  QsoLog.appendRecords(off.logPath, [buildAdifFields(QSO_DATA)], { existing: [], sink: off.sink });
  assert.strictEqual(off.cloud.journal.length, 0);
});

check('recordLogChanges: a delete goes out one version above the deleted record', () => {
  const env = cloudEnv();
  writeLog(env.logPath, [A, B]);
  QsoLog.mutateLog(env.logPath, (q) => q.slice(0, 1), { sink: env.sink });
  const e = env.cloud.journal.getAll()[0];
  assert.deepStrictEqual([e.action, e.uuid, e.version], ['delete', UB, 4]);
});

check('conflict merge: the server copy replaces the local record at an EQUAL version', () => {
  const env = cloudEnv();
  writeLog(env.logPath, [{ ...A, APP_POTACAT_VERSION: '2', COMMENT: 'local edit' }]);
  env.cloud.getSyncCallbacks().onConflicts([{ uuid: UA, serverVersion: 2, serverFields: { ...A, COMMENT: 'other device' }, serverIsDeleted: false }]);
  assert.strictEqual(parseAllRawQsos(env.logPath)[0].COMMENT, 'other device');
});

check('pull merge: pseudo-named rows from the server land with real names', () => {
  const env = cloudEnv();
  writeLog(env.logPath, [A]);
  env.cloud.getSyncCallbacks().onPulled([{ uuid: UP, version: 1, adifFields: PSEUDO }]);
  const got = parseAllRawQsos(env.logPath).find((q) => q.APP_POTACAT_UUID === UP);
  assert.ok(got && got.CALL === 'W3BOO');
  assert.ok(!/<CALLSIGN:/i.test(fs.readFileSync(env.logPath, 'utf8')));
});

check('uploadFullLog: retires uploaded creates, keeps pending edits and deletes', async () => {
  const env = cloudEnv();
  writeLog(env.logPath, [A, { CALL: 'K9OLD', QSO_DATE: '20200101' }]);
  env.cloud.journal.appendMany([
    { uuid: UA, action: 'create' },
    { uuid: UA, action: 'update', version: 2 },
    { uuid: 'gone', action: 'delete', version: 2 },
  ]);
  let uploaded = null;
  env.cloud.getCloudSync().bulkUpload = async (qsos) => { uploaded = qsos; return { imported: 1, duplicates: 1 }; };
  const res = await env.cloud.uploadFullLog();
  assert.deepStrictEqual([res.success, res.total], [true, 2]);
  assert.ok(uploaded.every((q) => q.uuid), 'every uploaded record has a uuid');
  assert.ok(parseAllRawQsos(env.logPath)[1].APP_POTACAT_UUID, 'uuid persisted to the file');
  assert.deepStrictEqual(env.cloud.journal.getAll().map((e) => e.action), ['update', 'delete']);
});

check('cloud-sync-now: pushes, merges pulls, persists the cursor, reports counts', async () => {
  const env = cloudEnv();
  writeLog(env.logPath, [A]);
  env.cloud.journal.append({ uuid: UA, action: 'update', version: 2, adifFields: A });
  const client = env.cloud.getCloudSync();
  fakeServer(client, (m, url, body) => {
    if (url.startsWith('/v1/sync/push')) return pushOutcome(body);
    return { qsos: [{ uuid: UR, version: 1, adifFields: B, updatedAt: '2026-09-17T20:00:00Z' }], hasMore: false };
  });
  const res = await handlers['cloud-sync-now']();
  assert.deepStrictEqual(res, { success: true, pushed: 1, pulled: 1, conflicts: 0, pending: 0 });
  assert.ok(parseAllRawQsos(env.logPath).some((q) => q.CALL === 'N2XYZ'), 'pulled QSO merged into the log');
  assert.strictEqual(env.settings.cloudLastSyncTimestamp, '2026-09-17T20:00:00Z');
});

// ── account ownership of journal entries ──────────────────────────────────
check('owner: entries carry the signed-in account; another account never pushes them, but sees they exist', async () => {
  const env = cloudEnv();
  QsoLog.appendRecords(env.logPath, [buildAdifFields(QSO_DATA)], { existing: [], sink: env.sink });
  assert.strictEqual(env.cloud.journal.getAll()[0].owner, 'acct-a');
  assert.deepStrictEqual(env.cloud.pendingStatus(), { pendingChanges: 1, pendingForOthers: { count: 0, owners: [] } });

  env.settings.cloudUser = { id: 'acct-b', email: 'b@example.com' };
  assert.deepStrictEqual(env.cloud.pendingStatus(), { pendingChanges: 0, pendingForOthers: { count: 1, owners: ['acct-a'] } });
  const client = env.cloud.getCloudSync();
  fakeServer(client, (m, url, body) => (url.startsWith('/v1/sync/push') ? pushOutcome(body) : { qsos: [], hasMore: false }));
  const res = await env.cloud.syncNow();
  assert.strictEqual(res.pushed, 0);
  assert.ok(!client.calls.some((c) => c.url.startsWith('/v1/sync/push')), "B's sync never pushed A's entry");
  assert.deepStrictEqual(res.pendingForOthers, { count: 1, owners: ['acct-a'] });
  assert.strictEqual(env.cloud.journal.length, 1, "A's entry is still waiting for A");

  env.settings.cloudUser = { id: 'acct-a' };
  await env.cloud.syncNow();
  assert.strictEqual(env.cloud.journal.length, 0, 'A signs back in and it goes');
});

check('owner: the account id comes from the token when the cached user lacks one; null when signed out', () => {
  const sub = Buffer.from(JSON.stringify({ sub: 'jwt-user-9' })).toString('base64url');
  const env = cloudEnv({ cloudUser: null, cloudAccessToken: `h.${sub}.s` });
  assert.strictEqual(env.cloud.currentOwnerId(), 'jwt-user-9');
  env.settings.cloudAccessToken = null;
  assert.strictEqual(env.cloud.currentOwnerId(), null);
  assert.strictEqual(env.cloud.pendingStatus().pendingChanges, 0);
});

check('owner: legacy entries without an owner are adopted by the first account to push, once', () => {
  const j = new SyncJournal(freshDir());
  j.append({ uuid: UA, action: 'create' });
  assert.strictEqual(j.forOwner(null).length, 0, 'signed out: nothing is anyone\'s');
  const view = j.forOwner('acct-a');
  assert.strictEqual(view.length, 1);
  view.getAll();
  assert.strictEqual(j.getAll()[0].owner, 'acct-a', 'stamped');
  assert.strictEqual(new SyncJournal(path.dirname(j._filePath)).getAll()[0].owner, 'acct-a', 'persisted');
  assert.strictEqual(j.forOwner('acct-b').length, 0, 'and now nobody else\'s');
});

check('owner: forOwner().removeWhere never touches another account\'s entries', () => {
  const j = new SyncJournal(freshDir());
  j.appendMany([{ uuid: UA, action: 'create', owner: 'acct-a' }, { uuid: UA, action: 'create', owner: 'acct-b' }]);
  j.forOwner('acct-a').removeWhere((e) => e.action === 'create');
  assert.deepStrictEqual(j.getAll().map((e) => e.owner), ['acct-b']);
});

// ── identities and the sign-in catch-up ───────────────────────────────────
check('ensureIdentities: missing, malformed and duplicated uuids become real ones, journaled as creates', () => {
  const file = seededLog([
    { CALL: 'K1A', QSO_DATE: '20260101' },
    { CALL: 'K2B', QSO_DATE: '20260101', APP_POTACAT_UUID: 'not-a-uuid' },
    { CALL: 'K3C', QSO_DATE: '20260101', APP_POTACAT_UUID: UA },
    { CALL: 'K4D', QSO_DATE: '20260101', APP_POTACAT_UUID: UA },
  ]);
  const sink = recordingSink();
  const changed = QsoLog.ensureIdentities(file, { sink });
  assert.deepStrictEqual(changed.map((r) => r.CALL), ['K1A', 'K2B', 'K4D']);
  const qsos = parseAllRawQsos(file);
  assert.ok(qsos.every((q) => QsoLog.isValidUuid(q.APP_POTACAT_UUID)));
  assert.strictEqual(new Set(qsos.map((q) => q.APP_POTACAT_UUID)).size, 4);
  assert.strictEqual(qsos[2].APP_POTACAT_UUID, UA, 'the first holder keeps it');
  assert.deepStrictEqual(sink.calls.map((c) => [c.action, c.fields.CALL]), [['create', 'K1A'], ['create', 'K2B'], ['create', 'K4D']]);
  assert.deepStrictEqual(QsoLog.ensureIdentities(file, { sink }), [], 'idempotent');
});

check('recordLogChanges: a malformed uuid is never journaled (it would fail every push batch)', () => {
  const env = cloudEnv();
  env.cloud.recordLogChanges([{ action: 'create', fields: { CALL: 'K1A', APP_POTACAT_UUID: 'bogus' } }]);
  assert.strictEqual(env.cloud.journal.length, 0);
});

function missingServer(client, { missing, onPush }) {
  fakeServer(client, (m, url, body) => {
    if (url === '/v1/sync/missing') {
      assert.ok(body.uuids.length <= 5000);
      assert.ok(body.uuids.every((u) => QsoLog.isValidUuid(u)), 'only well-formed uuids are asked about');
      return { missing: body.uuids.filter((u) => missing.has(u.toLowerCase())) };
    }
    if (url.startsWith('/v1/sync/push')) { if (onPush) onPush(body); return pushOutcome(body); }
    return { qsos: [], hasMore: false };
  });
}

check('catch-up: asks /missing about local QSOs, queues the absent ones for THIS account, and pushes them', async () => {
  const env = cloudEnv();
  writeLog(env.logPath, [A, { CALL: 'N3NEW', FREQ: '7.030', MODE: 'CW', QSO_DATE: '20260110', TIME_ON: '010000', APP_POTACAT_UUID: UC, APP_POTACAT_VERSION: '2' }, { CALL: 'K9OLD', QSO_DATE: '20200101' }]);
  const pushed = [];
  missingServer(env.cloud.getCloudSync(), { missing: new Set([UC]), onPush: (b) => pushed.push(...b.changes) });
  const res = await env.cloud.reconcileWithCloud('signin');
  assert.strictEqual(res.identities, 1, 'K9OLD was given an identity');
  assert.strictEqual(res.missing, 1);
  assert.deepStrictEqual(pushed.map((c) => [c.uuid, c.version]).sort(), [[UC, 2], [pushed.find((c) => c.uuid !== UC).uuid, 1]].sort(), 'the absent QSO at its local version + the newly identified one');
  assert.strictEqual(env.cloud.journal.length, 0, 'everything went out');
  // K9OLD (just identified, queued) + N3NEW (absent) = 2 of 3 not there yet.
  assert.ok(env.logs.some((l) => /Catch-up \(signin\): 2 of 3 local QSOs are not in the cloud yet/.test(l)), env.logs.join('\n'));
  // The uuid queued as a create was not asked about a second time.
  const calls = env.cloud.getCloudSync().calls.filter((c) => c.url === '/v1/sync/missing');
  assert.strictEqual(calls.length, 1);
  assert.ok(!calls[0].body.uuids.some((u) => u !== UA.toLowerCase() && u !== UC.toLowerCase() && u !== UA && u !== UC), 'newly identified record went straight to the journal');
});

check('catch-up: nothing missing → nothing queued, and it says so; signed out → does nothing', async () => {
  const env = cloudEnv();
  writeLog(env.logPath, [A, B]);
  missingServer(env.cloud.getCloudSync(), { missing: new Set() });
  const res = await env.cloud.reconcileWithCloud('boot');
  assert.deepStrictEqual([res.checked, res.missing, res.pushed], [2, 0, null]);
  assert.ok(env.logs.some((l) => /all 2 local QSOs are in the cloud/.test(l)));
  env.settings.cloudAccessToken = null;
  assert.strictEqual(await env.cloud.reconcileWithCloud('boot'), null);
});

check('catch-up: a /missing failure is logged and leaves the journal alone', async () => {
  const env = cloudEnv();
  writeLog(env.logPath, [A]);
  fakeServer(env.cloud.getCloudSync(), () => { throw new Error('HTTP 503'); });
  assert.strictEqual(await env.cloud.reconcileWithCloud('signin'), null);
  assert.ok(env.logs.some((l) => /Catch-up check failed: HTTP 503/.test(l)));
  assert.strictEqual(env.cloud.journal.length, 0);
});

check('checkMissing: batches at 5000 and lower-cases the answer', async () => {
  const client = new CloudSyncClient({ apiBase: 'http://x', accessToken: 't' });
  const sizes = [];
  fakeServer(client, (m, url, body) => { sizes.push(body.uuids.length); return { missing: [body.uuids[0].toUpperCase()] }; });
  const ids = Array.from({ length: 5001 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
  const missing = await client.checkMissing(ids);
  assert.deepStrictEqual(sizes, [5000, 1]);
  assert.ok(missing.has(ids[0]) && missing.has(ids[5000]));
});

check('wiring: sign-in schedules the catch-up (never on sign-out); boot runs it once; status is owner-scoped', () => {
  const ipc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'cloud-ipc.js'), 'utf8');
  assert.ok(/if \(reason !== 'signout'\) \{[\s\S]{0,200}reconcileWithCloud\(reason\)/.test(ipc));
  assert.ok(/sync\.startInterval\(interval, myJournal\(\), getSyncCallbacks\(\)\)/.test(ipc), 'background sync uses the owner view');
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.ok(/cloudIpc\.reconcileWithCloud\('boot'\)/.test(main));
  assert.ok(/cloudIpc\.pendingStatus\(\)/.test(main) && !/cloudIpc\.journal\.length/.test(main), 'ECHOCAT status counts only this account');
});

// ── source guards on main.js ──────────────────────────────────────────────
check('main.js: every log write goes through lib/qso-log.js', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  for (const banned of ['rewriteAdifFile(', 'appendRawQso(', 'appendQso(', 'appendImportedQso(', 'journalCreate(', 'journalUpdate(', 'journalDelete(']) {
    assert.ok(!src.includes(banned), `main.js still calls ${banned}`);
  }
  assert.ok(/cloudBridge\('cloud-sync-now'[\s\S]{0,400}cloudIpc\.syncNow\(\)/.test(src), 'mobile Sync Now uses the shared cycle');
  assert.ok(!/journal\.clear\(\)/.test(src), 'full upload must not clear pending edits');
});

(async () => {
  for (const run of pending) await run();
  fs.rmSync(root, { recursive: true, force: true });
  if (failures) { console.error(`\n${failures} cloud-log-sync test(s) FAILED`); process.exit(1); }
  console.log('\nall cloud-log-sync tests passed');
})();
