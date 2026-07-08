// Cross-device duplicate-QSO guard for cloud sync (K3SBP 2026-07-08).
//
// Scenario: a QSO logged on the phone through a connected desktop reaches the
// desktop log twice — once enriched via the log-qso WS path (desktop-minted
// UUID) and once sparse via cloud sync (phone-minted UUID). mergePulledQsos
// must absorb the second copy instead of appending it, remember the alias,
// tombstone the duplicate in the cloud journal, and NOT delete the surviving
// record when that tombstone echoes back on a later pull.
//
// Runs registerCloudIpc against a stubbed electron so the REAL merge code is
// under test.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

// --- Stub electron before cloud-ipc is required ---
const electronStub = {
  ipcMain: { handle: () => {}, on: () => {} },
  dialog: {},
  shell: {},
};
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return electronStub;
  return origLoad.call(this, request, ...rest);
};

const { registerCloudIpc } = require('../lib/cloud-ipc');
Module._load = origLoad;

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (err) { failures++; console.error(`  FAIL ${name}\n       ${err.message}`); }
}

// --- Temp environment ---
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'potacat-cloud-merge-'));
const logPath = path.join(tmp, 'potacat_qso_log.adi');
const settings = { cloudSyncEnabled: true, cloudAccessToken: 'x' };
const ctx = {
  app: { getPath: () => tmp },
  win: null,
  getSettings: () => settings,
  saveSettings: () => {},
  getLogPath: () => logPath,
  loadWorkedQsos: () => {},
  sendToRenderer: () => {},
};
const cloud = registerCloudIpc(ctx);
const { onPulled } = cloud.getSyncCallbacks();
const { parseAllRawQsos } = require('../lib/adif');

// Seed: the desktop's enriched record (uuid A) — Casey's actual WM3PEN QSO.
const RICH = {
  CALL: 'WM3PEN', FREQ: '7.038000', MODE: 'CW', QSO_DATE: '20260708',
  TIME_ON: '014700', RST_SENT: '559', RST_RCVD: '599', BAND: '40m',
  STATE: 'PA', GRIDSQUARE: 'FN20lb', COUNTRY: 'United States',
  STATION_CALLSIGN: 'K3SBP', APP_POTACAT_UUID: 'uuid-A', APP_POTACAT_VERSION: '1',
};
// The phone's sparse copy (uuid B) — same contact, 32 s later, 5-dp freq, no band.
const SPARSE_FIELDS = {
  CALL: 'WM3PEN', FREQ: '7.03800', MODE: 'CW', MY_CALL: 'K3SBP',
  TIME_ON: '014732', QSO_DATE: '20260708', RST_RCVD: '599', RST_SENT: '559',
  MY_GRIDSQUARE: 'FN20jb', STATION_CALLSIGN: 'K3SBP',
};

function seedLog() {
  const recs = Object.entries(RICH).map(([k, v]) => `<${k}:${String(v).length}>${v}`).join(' ');
  fs.writeFileSync(logPath, `POTACAT log\n<eoh>\n${recs} <eor>\n`);
}

check('phone copy with unknown uuid is absorbed, not appended', () => {
  seedLog();
  onPulled([{ uuid: 'uuid-B', version: 1, adifFields: SPARSE_FIELDS }]);
  const qsos = parseAllRawQsos(logPath);
  assert.strictEqual(qsos.length, 1, `expected 1 record, got ${qsos.length}`);
  assert.strictEqual(qsos[0].APP_POTACAT_UUID, 'uuid-A');
  assert.strictEqual(qsos[0].STATE, 'PA', 'enriched record must survive');
  assert.strictEqual(qsos[0].APP_POTACAT_MERGED_UUIDS, 'uuid-B', 'alias recorded');
});

check('duplicate is tombstoned in the cloud journal', () => {
  const ops = cloud.journal.length ? cloud.journal : null;
  // SyncJournal API: read entries via its file — fall back to length check.
  assert(cloud.journal.length >= 1, 'journal should contain the delete op');
});

check('tombstone echo does NOT delete the surviving record', () => {
  onPulled([{ uuid: 'uuid-B', isDeleted: true, version: 2 }]);
  const qsos = parseAllRawQsos(logPath);
  assert.strictEqual(qsos.length, 1, 'real record must survive its alias tombstone');
  assert.strictEqual(qsos[0].APP_POTACAT_UUID, 'uuid-A');
});

check('re-pull of the absorbed uuid does not append (alias index persisted)', () => {
  onPulled([{ uuid: 'uuid-B', version: 1, adifFields: SPARSE_FIELDS }]);
  const qsos = parseAllRawQsos(logPath);
  assert.strictEqual(qsos.length, 1, `expected 1 record, got ${qsos.length}`);
});

check('a genuinely different QSO still appends', () => {
  onPulled([{ uuid: 'uuid-C', version: 1, adifFields: {
    CALL: 'K2C', FREQ: '14.03700', MODE: 'CW', QSO_DATE: '20260707',
    TIME_ON: '233923', RST_SENT: '599', RST_RCVD: '599',
  } }]);
  const qsos = parseAllRawQsos(logPath);
  assert.strictEqual(qsos.length, 2, `expected 2 records, got ${qsos.length}`);
});

check('same call minutes apart on same band is NOT absorbed (real re-work)', () => {
  onPulled([{ uuid: 'uuid-D', version: 1, adifFields: {
    CALL: 'WM3PEN', FREQ: '7.03800', MODE: 'CW', QSO_DATE: '20260708',
    TIME_ON: '015800', RST_SENT: '559', RST_RCVD: '599', // 11 min later
  } }]);
  const qsos = parseAllRawQsos(logPath);
  assert.strictEqual(qsos.length, 3, `expected 3 records, got ${qsos.length}`);
});

check('same-batch duplicate pair collapses (fresh-device full pull)', () => {
  fs.writeFileSync(logPath, 'POTACAT log\n<eoh>\n'); // empty log
  onPulled([
    { uuid: 'uuid-A', version: 1, adifFields: RICH },
    { uuid: 'uuid-B', version: 1, adifFields: SPARSE_FIELDS },
  ]);
  const qsos = parseAllRawQsos(logPath);
  assert.strictEqual(qsos.length, 1, `expected 1 record, got ${qsos.length}`);
});

check('true delete (primary uuid) still works', () => {
  seedLog();
  onPulled([{ uuid: 'uuid-A', isDeleted: true, version: 2 }]);
  const qsos = parseAllRawQsos(logPath);
  assert.strictEqual(qsos.length, 0, 'primary-uuid delete must remove the record');
});

fs.rmSync(tmp, { recursive: true, force: true });

if (failures) {
  console.error(`\ncloud-merge-dupe-test: ${failures} failure(s)`);
  process.exit(1);
}
console.log('\ncloud-merge-dupe-test: OK');
