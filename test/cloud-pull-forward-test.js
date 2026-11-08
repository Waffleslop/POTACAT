#!/usr/bin/env node
'use strict';
// GitHub #267 (NA4DQ, MacLoggerDX): an off-grid ECHOCAT activation reached the
// Cloud log and the POTACAT log but never MacLoggerDX. A QSO the phone logs
// THROUGH the desktop is forwarded by saveQsoRecord; off-grid, the phone keeps
// it and this PC gets it only by the Cloud pull, which forwarded nothing.
//
// Casey's rule: forward a pulled QSO only when it is this station's own,
// logged on a phone paired here; never one logged at another PC; never the
// account's history (first sync); never twice. The rule: lib/cloud-pull-forward.js.
// The fan-out shared with the live path: lib/logger-forward.js.
//
// Runs the real cloud-ipc with electron stubbed and fake loggers. No network:
// nothing here calls the cloud API or a real logger.

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
const LoggerForward = require('../lib/logger-forward');
const CPF = require('../lib/cloud-pull-forward');

let failures = 0;
let passed = 0;
const queue = [];
function check(name, fn) {
  queue.push(async () => {
    try { await fn(); passed++; console.log(`  ok   ${name}`); }
    catch (err) { failures++; console.error(`  FAIL ${name}\n       ${err.stack || err.message}`); }
  });
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'potacat-267-'));
let dirN = 0;
const freshDir = () => { const d = path.join(root, String(dirN++)); fs.mkdirSync(d); return d; };
const HEADER = 'ADIF Export from POTACAT\n<EOH>\n';
const writeLog = (file, records) => fs.writeFileSync(file, HEADER + records.map((r) =>
  Object.entries(r).map(([k, v]) => `<${k}:${String(v).length}>${v}`).join(' ') + ' <EOR>\n').join(''));

const ACCOUNT = 'acct-na4dq';
const ME = 'NA4DQ';
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ARMED_AT = '2026-11-01T00:00:00.000Z'; // forwarding started on this PC

let qsoN = 0;
/** A QSO the ECHOCAT app logged off-grid (potacat-app QsoBuilder: no APP_POTACAT_UUID). */
function phoneRow(extra = {}, { date = '20261107', station = ME } = {}) {
  const n = ++qsoN;
  const fields = {
    CALL: `K${n}XYZ`, QSO_DATE: date, TIME_ON: `${String(n % 24).padStart(2, '0')}1500`,
    MODE: 'SSB', FREQ: '14.28500', BAND: '20m', RST_SENT: '59', RST_RCVD: '57',
    MY_SIG: 'POTA', MY_SIG_INFO: 'US-1234', ...extra,
  };
  if (station) { fields.STATION_CALLSIGN = station; fields.MY_CALL = station; }
  return { uuid: uuid(n), version: 1, adifFields: fields, updatedAt: '2026-11-08T12:00:00.000Z' };
}
/** The same kind of QSO written by a desktop (lib/adif-writer.js buildAdifFields stamps APP_POTACAT_UUID). */
function desktopRow(extra = {}, opts) {
  const r = phoneRow(extra, opts);
  r.adifFields.APP_POTACAT_UUID = r.uuid;
  return r;
}

/**
 * One desktop with fake loggers. `armed` pre-starts forwarding for the
 * account (the store file a previous run left); `cursor` = a pull cursor is
 * saved (not the account's first sync here); `paired` = a phone is paired.
 */
function desktop({ dir = freshDir(), armed = true, cursor = true, paired = true, ops = {}, existing = [] } = {}) {
  const logPath = path.join(dir, 'log.adi');
  if (!fs.existsSync(logPath)) writeLog(logPath, existing);
  if (armed && !fs.existsSync(path.join(dir, 'cloud-pull-forwarded.json'))) {
    fs.writeFileSync(path.join(dir, 'cloud-pull-forwarded.json'), JSON.stringify({ since: { [ACCOUNT]: ARMED_AT }, uuids: [] }));
  }
  const lines = [];
  const sent = { logbook: [], extraUdp: [], qrz: [], clublog: [] };
  const settings = {
    cloudSyncEnabled: true, cloudAccessToken: 'x', cloudUser: { id: ACCOUNT },
    activeProfile: ME, myCallsign: ME,
    cloudLastSyncTimestamp: cursor ? '2026-11-05T00:00:00.000Z' : null,
    pairedDevices: paired ? [{ id: 'abc', name: 'iPhone' }] : [],
    sendToLogbook: true, logbookType: 'macloggerdx', logbookHost: '127.0.0.1', logbookPort: 2237,
    ...ops,
  };
  const deps = {
    forwardToLogbook: async (q, o) => { sent.logbook.push({ q, o }); },
    sendExtraUdp: async (q, host, port, format) => { sent.extraUdp.push({ q, host, port, format }); },
    sendToQrzLogbook: async (q, o) => { sent.qrz.push({ q, o }); },
    addClublog: (e) => { sent.clublog.push(e); },
    buildAdifRecord: (q) => `<CALL:${q.callsign.length}>${q.callsign} <EOR>`,
    newUuid: () => 'new-uuid',
    log: (m) => lines.push(m),
    error: () => {},
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
    getActiveProfile: () => ME,
    listProfiles: () => [{ call: ME, owner: ACCOUNT }],
    // What main.js forwardPulledQsoToLoggers does, with fake senders.
    forwardPulledQso: async (f) => {
      const q = { callsign: f.CALL, frequency: String(parseFloat(f.FREQ) * 1000), mode: f.MODE, qsoDate: f.QSO_DATE, timeOn: f.TIME_ON, uuid: f.APP_POTACAT_UUID };
      await LoggerForward.forwardToLoggers(q, settings, deps);
      LoggerForward.queueClublog(q, settings, deps);
    },
    hasPairedDevice: () => settings.pairedDevices.length > 0,
  };
  const cloud = registerCloudIpc(ctx);
  const cb = cloud.getSyncCallbacks();
  return { cloud, cb, pull: (rows) => cb.onPulled(rows), logPath, lines, settings, sent, dir, log: () => parseAllRawQsos(logPath) };
}
const calls = (list) => list.map((x) => (x.q ? x.q.callsign : x.call));

// ── the fix ────────────────────────────────────────────────────────────────
check('an off-grid phone QSO pulled later is forwarded to MacLoggerDX, once', async () => {
  const d = desktop();
  const r = phoneRow();
  const out = await d.pull([r]);
  assert.strictEqual(d.log().length, 1, 'written to the POTACAT log as before');
  assert.strictEqual(out.forwarded, 1);
  assert.deepStrictEqual(calls(d.sent.logbook), [r.adifFields.CALL]);
  assert.strictEqual(d.sent.logbook[0].o.logbookType, 'macloggerdx');
  assert.strictEqual(d.sent.logbook[0].q.uuid, r.uuid, 'the logger sees the record\'s uuid');
  assert.ok(d.lines.some((l) => /logged on the phone off-line — forwarding to the external loggers/.test(l)), d.lines.join('\n'));
});

check('a QSO logged at another desktop is written but not forwarded', async () => {
  const d = desktop();
  const out = await d.pull([desktopRow()]);
  assert.strictEqual(d.log().length, 1);
  assert.strictEqual(out.forwarded, 0);
  assert.strictEqual(d.sent.logbook.length, 0);
});

check('an older desktop journal row (pseudo field names) is a desktop record: not forwarded', async () => {
  const d = desktop();
  const r = phoneRow();
  const f = r.adifFields;
  r.adifFields = { CALLSIGN: f.CALL, QSODATE: f.QSO_DATE, TIMEON: f.TIME_ON, MODE: f.MODE, FREQ: f.FREQ, STATION_CALLSIGN: ME };
  const out = await d.pull([r]);
  assert.strictEqual(out.forwarded, 0);
  assert.strictEqual(d.sent.logbook.length, 0);
});

check('a phone QSO another desktop also logged live (same batch) is not forwarded', async () => {
  const d = desktop();
  const phone = phoneRow();
  const other = { ...desktopRow(), adifFields: { ...phone.adifFields } };
  other.adifFields.APP_POTACAT_UUID = other.uuid;
  const out = await d.pull([phone, other]);
  assert.strictEqual(d.log().length, 1, 'one contact in the log');
  assert.strictEqual(out.forwarded, 0, 'the other desktop already forwarded it');
});

check('another station\'s QSO, or one with no STATION_CALLSIGN, is not forwarded', async () => {
  const d = desktop();
  const out = await d.pull([phoneRow({}, { station: 'W1AW' }), phoneRow({}, { station: '' })]);
  assert.strictEqual(d.log().length, 2);
  assert.strictEqual(out.forwarded, 0);
});

check('a portable on-air call (NA4DQ/P) is this station', async () => {
  const d = desktop();
  const out = await d.pull([phoneRow({}, { station: 'NA4DQ/P' })]);
  assert.strictEqual(out.forwarded, 1);
});

check('no phone paired to this profile: nothing is forwarded', async () => {
  const d = desktop({ paired: false });
  const out = await d.pull([phoneRow()]);
  assert.strictEqual(out.forwarded, 0);
  assert.strictEqual(d.log().length, 1);
});

// ── backfill ───────────────────────────────────────────────────────────────
check('the first sync of an account (no cursor) forwards nothing, however recent', async () => {
  const d = desktop({ cursor: false });
  const out = await d.pull([phoneRow(), phoneRow(), phoneRow()]);
  assert.strictEqual(d.log().length, 3);
  assert.strictEqual(out.forwarded, 0);
  assert.strictEqual(d.sent.logbook.length, 0);
});

check('the first pull with this rule starts the clock and sends nothing; later QSOs go', async () => {
  const d = desktop({ armed: false });
  const out = await d.pull([phoneRow({}, { date: '20301231' })]);
  assert.strictEqual(out.forwarded, 0, 'an upgrade never sends what is already waiting');
  assert.ok(d.lines.some((l) => /will reach the external loggers from now on/.test(l)));
  const store = JSON.parse(fs.readFileSync(path.join(d.dir, 'cloud-pull-forwarded.json'), 'utf8'));
  assert.ok(Date.parse(store.since[ACCOUNT]) > Date.parse('2026-01-01'), 'started now, per account');
  const later = await d.pull([phoneRow({}, { date: '20301231' })]);
  assert.strictEqual(later.forwarded, 1);
});

check('a sync cycle with nothing to pull also starts the clock', () => {
  const d = desktop({ armed: false });
  d.cb.onSynced();
  const store = JSON.parse(fs.readFileSync(path.join(d.dir, 'cloud-pull-forwarded.json'), 'utf8'));
  assert.ok(store.since[ACCOUNT]);
});

check('a QSO from before forwarding started (history) is not forwarded', async () => {
  const d = desktop();
  const out = await d.pull([phoneRow({}, { date: '20261020' })]);
  assert.strictEqual(out.forwarded, 0);
});

// ── never twice ────────────────────────────────────────────────────────────
check('a repeat pull does not forward again, nor does a restart with the record gone from the log', async () => {
  const dir = freshDir();
  const r = phoneRow();
  const a = desktop({ dir });
  assert.strictEqual((await a.pull([r])).forwarded, 1);
  assert.strictEqual((await a.pull([r])).forwarded, 0, 'already in the log: nothing new');
  assert.strictEqual((await a.pull([{ ...r, version: 2 }])).forwarded, 0, 'an edit is an update, not a new QSO');
  writeLog(a.logPath, []); // the user deletes it locally; the cloud sends it again
  const b = desktop({ dir });
  const out = await b.pull([r]);
  assert.strictEqual(out.forwarded, 0, 'the forwarded record survives a restart');
  assert.strictEqual(a.sent.logbook.length + b.sent.logbook.length, 1);
});

check('a conflict (server wins) never forwards', async () => {
  const d = desktop();
  const r = phoneRow();
  d.cb.onConflicts([{ uuid: r.uuid, serverFields: r.adifFields, serverVersion: 1, serverIsDeleted: false }]);
  await new Promise((res) => setImmediate(res));
  assert.strictEqual(d.sent.logbook.length, 0);
});

// ── the live path ──────────────────────────────────────────────────────────
check('live path: the phone\'s own copy of a QSO logged through this desktop is absorbed, not forwarded', async () => {
  const live = { CALL: 'K9LIVE', QSO_DATE: '20261107', TIME_ON: '150000', MODE: 'SSB', FREQ: '14.285000', BAND: '20m', STATION_CALLSIGN: ME, APP_POTACAT_UUID: uuid(9001), APP_POTACAT_VERSION: '1' };
  const d = desktop({ existing: [live] });
  const phoneCopy = { uuid: uuid(9002), version: 1, adifFields: { CALL: 'K9LIVE', QSO_DATE: '20261107', TIME_ON: '150000', MODE: 'SSB', FREQ: '14.28500', BAND: '20m', STATION_CALLSIGN: ME } };
  const out = await d.pull([phoneCopy]);
  assert.strictEqual(d.log().length, 1);
  assert.strictEqual(out.forwarded, 0, 'saveQsoRecord already forwarded it');
});

check('live path: saveQsoRecord still forwards through the same gates, with the operator\'s settings', () => {
  const main = readSrc(path.join(__dirname, '..', 'main.js')).replace(/\r\n/g, '\n');
  const save = main.slice(main.indexOf('async function saveQsoRecord(qsoData, opts) {'));
  const body = save.slice(0, save.indexOf('\n}\n'));
  assert.strictEqual((body.match(/LoggerForward\.forwardToLoggers\(qsoData, ops, loggerForwardDeps\(\)\)/g) || []).length, 1);
  assert.strictEqual((body.match(/LoggerForward\.queueClublog\(qsoData, ops, loggerForwardDeps\(\)\)/g) || []).length, 1);
  assert.ok(/return \{ success: true, resposted: didRespot \|\| false, logbookError, qrzError \};/.test(body));
  // The pull path is wired in, for the active profile.
  assert.ok(/forwardPulledQso: \(fields\) => forwardPulledQsoToLoggers\(fields\),/.test(main));
  assert.ok(/hasPairedDevice: \(\) => Array\.isArray\(settings\.pairedDevices\) && settings\.pairedDevices\.length > 0,/.test(main));
  assert.ok(/async function forwardPulledQsoToLoggers\(fields\) \{[\s\S]*?rawQsoToQsoData\(fields\)[\s\S]*?LoggerForward\.forwardToLoggers\(qsoData, settings, loggerForwardDeps\(\)\);[\s\S]*?LoggerForward\.queueClublog\(qsoData, settings, loggerForwardDeps\(\)\);/.test(main));
});

check('live path: the fan-out keeps its gates, log lines and error results', async () => {
  const sent = [];
  const lines = [];
  const d = {
    forwardToLogbook: async () => { sent.push('logbook'); throw new Error('ECONNREFUSED'); },
    sendExtraUdp: async () => { sent.push('extra'); },
    sendToQrzLogbook: async () => { sent.push('qrz'); throw new Error('bad key'); },
    log: (m) => lines.push(m), error: () => {},
  };
  const q = { callsign: 'W1AW', frequency: '14074.0', mode: 'FT8' };
  const ops = { sendToLogbook: true, logbookType: 'n1mm', logbookPort: 12060, extraUdpEnabled: true, qrzLogbook: true, qrzApiKey: 'k' };
  const r = await LoggerForward.forwardToLoggers(q, ops, d);
  assert.deepStrictEqual(sent, ['logbook', 'extra', 'qrz']);
  assert.deepStrictEqual(r, { logbookError: 'ECONNREFUSED', qrzError: 'bad key' });
  assert.ok(lines.includes('[Logbook] Forwarding QSO to n1mm at 127.0.0.1:12060: W1AW 14074.0kHz FT8'));
  assert.ok(lines.includes('[Logbook] Forwarding failed: ECONNREFUSED'));
  assert.ok(lines.includes('[Extra UDP] Broadcasting QSO to 127.0.0.1:2237 (wsjtx)'));
  sent.length = 0;
  await LoggerForward.forwardToLoggers({ ...q, skipLogbookForward: true }, ops, d);
  assert.deepStrictEqual(sent, [], 'the second record of a multi-park contact goes nowhere');
  await LoggerForward.forwardToLoggers(q, { sendToLogbook: false, logbookType: 'n1mm' }, d);
  assert.deepStrictEqual(sent, [], 'nothing enabled, nothing sent');
});

// ── every enabled forwarder ────────────────────────────────────────────────
check('each enabled forwarder gets the pulled QSO: logbook, Extra UDP, QRZ Logbook, Club Log', async () => {
  const d = desktop({ ops: {
    extraUdpEnabled: true, extraUdpHost: '127.0.0.1', extraUdpPort: '2238', extraUdpFormat: 'adif',
    qrzLogbook: true, qrzApiKey: 'KEY',
    clublogEnable: true, clublogEmail: 'a@b.c', clublogPassword: 'p', clublogCallsign: ME,
  } });
  const r = phoneRow();
  await d.pull([r]);
  const c = r.adifFields.CALL;
  assert.deepStrictEqual(calls(d.sent.logbook), [c]);
  assert.deepStrictEqual(calls(d.sent.extraUdp), [c]);
  assert.strictEqual(d.sent.extraUdp[0].port, 2238);
  assert.deepStrictEqual(calls(d.sent.qrz), [c]);
  assert.deepStrictEqual(calls(d.sent.clublog), [c]);
  assert.strictEqual(d.sent.clublog[0].uuid, r.uuid, 'Club Log dedups by the record\'s uuid');
  assert.strictEqual(d.sent.clublog[0].creds.callsign, ME);
});

check('for every logbook type (MacLoggerDX, N1MM, Log4OM, HRD, ACLog, ...) the main logbook gets it', async () => {
  for (const t of ['macloggerdx', 'n1mm', 'log4om', 'hrd', 'aclog', 'dxkeeper', 'hamrs', 'rumlogng', 'wavelog']) {
    const d = desktop({ ops: { logbookType: t } });
    await d.pull([phoneRow()]);
    assert.strictEqual(d.sent.logbook.length, 1, t);
    assert.strictEqual(d.sent.logbook[0].o.logbookType, t);
  }
});

check('forwarding off in Settings: the pull sends nothing anywhere', async () => {
  const d = desktop({ ops: { sendToLogbook: false } });
  await d.pull([phoneRow()]);
  const total = Object.values(d.sent).reduce((n, l) => n + l.length, 0);
  assert.strictEqual(total, 0);
});

// ── the rule's pieces ──────────────────────────────────────────────────────
check('rule pieces: desktop marker, own station, QSO time', () => {
  assert.ok(CPF.isDesktopRecord({ CALL: 'X', APP_POTACAT_UUID: 'u' }));
  assert.ok(CPF.isDesktopRecord({ callsign: 'X', qsodate: '1' }), 'pseudo names, any case');
  assert.ok(!CPF.isDesktopRecord({ CALL: 'X', APP_POTACAT_PASS_SESSION_ID: 's' }), 'a phone guest-pass record is not a desktop one');
  assert.ok(CPF.isOwnStation({ STATION_CALLSIGN: 'VE3/NA4DQ' }, ['NA4DQ']));
  assert.ok(!CPF.isOwnStation({ STATION_CALLSIGN: 'NA4DQX' }, ['NA4DQ']));
  assert.strictEqual(CPF.qsoTimeMs({ QSO_DATE: '20261107', TIME_ON: '1415' }), Date.UTC(2026, 10, 7, 14, 15));
  assert.ok(Number.isNaN(CPF.qsoTimeMs({ QSO_DATE: '2026-11-07', TIME_ON: '1415' })));
});

(async () => {
  console.log('Cloud pull: forward this station\'s off-grid phone QSOs to the external loggers (#267)');
  for (const t of queue) await t();
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  console.log(`\nCloud pull forward (#267): ${passed} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})();
