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
// GitHub #838 (deadeye007): a guest device's or an unpaired phone's QSOs of
// this station go too (Settings > Logbook, on unless turned off), from the
// moment that setting first ran here; a logger that refuses one (N3FJP not
// running) is tried again for that logger only, never twice once it took it.
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
function desktop({ dir = freshDir(), armed = true, armedAny = armed, cursor = true, paired = true, ops = {}, existing = [], profiles = null } = {}) {
  const logPath = path.join(dir, 'log.adi');
  if (!fs.existsSync(logPath)) writeLog(logPath, existing);
  if (armed && !fs.existsSync(path.join(dir, 'cloud-pull-forwarded.json'))) {
    const store = { since: { [ACCOUNT]: ARMED_AT }, uuids: [] };
    if (armedAny) store.sinceAny = { [ACCOUNT]: ARMED_AT }; // #838: the any-device clock
    fs.writeFileSync(path.join(dir, 'cloud-pull-forwarded.json'), JSON.stringify(store));
  }
  const lines = [];
  const sent = { logbook: [], extraUdp: [], qrz: [], clublog: [] };
  // #838: a destination set here refuses (throws), as N3FJP does when it is not running.
  const fail = { logbook: false, extraUdp: false, qrz: false };
  const settings = {
    cloudSyncEnabled: true, cloudAccessToken: 'x', cloudUser: { id: ACCOUNT },
    activeProfile: ME, myCallsign: ME,
    cloudLastSyncTimestamp: cursor ? '2026-11-05T00:00:00.000Z' : null,
    pairedDevices: paired ? [{ id: 'abc', name: 'iPhone' }] : [],
    sendToLogbook: true, logbookType: 'macloggerdx', logbookHost: '127.0.0.1', logbookPort: 2237,
    ...ops,
  };
  const deps = {
    forwardToLogbook: async (q, o) => { if (fail.logbook) throw new Error('ECONNREFUSED'); sent.logbook.push({ q, o }); },
    sendExtraUdp: async (q, host, port, format) => { if (fail.extraUdp) throw new Error('EHOSTUNREACH'); sent.extraUdp.push({ q, host, port, format }); },
    sendToQrzLogbook: async (q, o) => { if (fail.qrz) throw new Error('QRZ did not answer'); sent.qrz.push({ q, o }); },
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
    listProfiles: () => profiles || [{ call: ME, owner: ACCOUNT }],
    // What main.js forwardPulledQsoToLoggers does, with fake senders.
    forwardPulledQso: async (f, { only } = {}) => {
      const q = { callsign: f.CALL, frequency: String(parseFloat(f.FREQ) * 1000), mode: f.MODE, qsoDate: f.QSO_DATE, timeOn: f.TIME_ON, uuid: f.APP_POTACAT_UUID };
      const retry = Array.isArray(only);
      const result = await LoggerForward.forwardToLoggers(q, settings, deps, retry ? { only } : {});
      if (!retry) LoggerForward.queueClublog(q, settings, deps);
      return result;
    },
    hasPairedDevice: () => settings.pairedDevices.length > 0,
  };
  const cloud = registerCloudIpc(ctx);
  const cb = cloud.getSyncCallbacks();
  const store = () => JSON.parse(fs.readFileSync(path.join(dir, 'cloud-pull-forwarded.json'), 'utf8'));
  return { cloud, cb, pull: (rows) => cb.onPulled(rows), logPath, lines, settings, sent, fail, dir, store, log: () => parseAllRawQsos(logPath) };
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
  assert.ok(d.lines.some((l) => /logged on another device — forwarding to the external loggers/.test(l)), d.lines.join('\n'));
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

check('#838 setting off: no phone paired and nothing forwarded, as before #838', async () => {
  const d = desktop({ paired: false, ops: { forwardSyncedQsos: false } });
  const out = await d.pull([phoneRow()]);
  assert.strictEqual(out.forwarded, 0);
  assert.strictEqual(d.log().length, 1);
});

// ── Guest Pass (#553) ──────────────────────────────────────────────────────
/**
 * A contact NA4DQ made as a Guest Pass guest on another ham's station: that
 * station's desktop wrote it (main.js passGuestLogContact, buildAdifFields:
 * APP_POTACAT_UUID) straight to NA4DQ's Cloud logbook, with the mark.
 */
function guestRow({ operator = ME, station = ME, licensee = 'W7RTA' } = {}, opts) {
  const r = desktopRow({}, { ...opts, station });
  Object.assign(r.adifFields, { OPERATOR: operator, APP_POTACAT_GUEST_PASS: '1' });
  if (licensee) r.adifFields.APP_POTACAT_STATION_LICENSEE = licensee;
  return r;
}

check("a Guest Pass contact made on another ham's station reaches this station's logger, once", async () => {
  const d = desktop();
  const r = guestRow();
  const out = await d.pull([r]);
  assert.strictEqual(d.log().length, 1);
  assert.strictEqual(out.forwarded, 1);
  assert.deepStrictEqual(calls(d.sent.logbook), [r.adifFields.CALL]);
  const again = await d.pull([r]);
  assert.strictEqual(again.forwarded, 0, 'never twice');
});

check("a Guest Pass contact under the owner's call with this station as OPERATOR is ours", async () => {
  const d = desktop();
  const out = await d.pull([guestRow({ station: 'W7RTA' })]);
  assert.strictEqual(out.forwarded, 1);
});

check("the same Guest Pass contact with someone else's call is not forwarded", async () => {
  const d = desktop();
  const out = await d.pull([guestRow({ operator: 'W1AW', station: 'W1AW' }), guestRow({ operator: '', station: '' })]);
  assert.strictEqual(d.log().length, 2);
  assert.strictEqual(out.forwarded, 0);
});

check('a plain desktop record of this station (no mark) is still not forwarded', async () => {
  const d = desktop();
  const r = desktopRow({ OPERATOR: ME });
  const out = await d.pull([r, desktopRow({ APP_POTACAT_GUEST_PASS: '0' })]);
  assert.strictEqual(out.forwarded, 0);
});

check('a Guest Pass contact keeps every other gate: backfill, no paired phone, history', async () => {
  assert.strictEqual((await desktop({ cursor: false }).pull([guestRow(), guestRow()])).forwarded, 0, 'backfill forwards nothing');
  assert.strictEqual((await desktop({ paired: false, ops: { forwardSyncedQsos: false } }).pull([guestRow()])).forwarded, 0, 'no paired phone, setting off');
  assert.strictEqual((await desktop().pull([guestRow({}, { date: '20261020' })])).forwarded, 0, 'before forwarding started');
});

check("the owner's private licensee field never reaches a logger (main.js rawQsoToQsoData)", () => {
  const main = readSrc(path.join(__dirname, '..', 'main.js'));
  const i = main.indexOf('function rawQsoToQsoData(raw)');
  assert.ok(i > 0);
  const body = main.slice(i, main.indexOf('\n}\n', i));
  assert.ok(!/LICENSEE/i.test(body), 'rawQsoToQsoData must not carry APP_POTACAT_STATION_LICENSEE');
  assert.ok(!/GUEST_PASS/.test(body));
});

check("the owner's station marks every Guest Pass contact (main.js passGuestLogContact)", () => {
  const main = readSrc(path.join(__dirname, '..', 'main.js'));
  const i = main.indexOf('function passGuestLogContact(');
  const b = main.slice(i, main.indexOf('passQsoOutbox.add(', i));
  assert.ok(/qsoData\.guestPass = true;/.test(b));
  assert.ok(!/if \(passLease\) \{[^}]*guestPass/.test(b), 'the mark does not depend on the lease');
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
  assert.ok(/forwardPulledQso: \(fields, opt\) => forwardPulledQsoToLoggers\(fields, opt\),/.test(main));
  assert.ok(/hasPairedDevice: \(\) => Array\.isArray\(settings\.pairedDevices\) && settings\.pairedDevices\.length > 0,/.test(main));
  assert.ok(/async function forwardPulledQsoToLoggers\(fields, \{ only \} = \{\}\) \{[\s\S]*?rawQsoToQsoData\(fields\)[\s\S]*?LoggerForward\.forwardToLoggers\(qsoData, settings, loggerForwardDeps\(\), retry \? \{ only \} : \{\}\);[\s\S]*?if \(!retry\) LoggerForward\.queueClublog\(qsoData, settings, loggerForwardDeps\(\)\);[\s\S]*?return result;/.test(main));
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

// ── #838: any device of this station, and a retry when a logger refuses ───
check('#838 a QSO from a device never paired here (guest device) is forwarded, once', async () => {
  const d = desktop({ paired: false });
  const r = phoneRow();
  const out = await d.pull([r]);
  assert.strictEqual(out.forwarded, 1);
  assert.deepStrictEqual(calls(d.sent.logbook), [r.adifFields.CALL]);
  assert.strictEqual((await d.pull([r])).forwarded, 0, 'never twice');
  writeLog(d.logPath, []); // gone from the log, pulled again after a restart
  const again = desktop({ dir: d.dir, paired: false });
  assert.strictEqual((await again.pull([r])).forwarded, 0, 'the uuid stays recorded across a restart');
  assert.strictEqual(d.sent.logbook.length + again.sent.logbook.length, 1);
});

check('#838 first run with the setting: nothing logged before it on an unpaired device is sent', async () => {
  const d = desktop({ paired: false, armedAny: false });
  const old = phoneRow({}, { date: '20261107' }); // after the #267 clock, before this version ran
  const out = await d.pull([old]);
  assert.strictEqual(out.forwarded, 0, 'an upgrade never sends what was already logged');
  assert.ok(d.lines.some((l) => /logged on any of your devices will reach the external loggers from now on/.test(l)), d.lines.join('\n'));
  assert.ok(Date.parse(d.store().sinceAny[ACCOUNT]) > Date.parse(ARMED_AT), 'its own clock, per account');
  assert.strictEqual((await d.pull([phoneRow({}, { date: '20301231' })])).forwarded, 1, 'a QSO logged after it goes');
});

check('#838 a paired phone keeps its #267 cut-off when the any-device clock is newer', async () => {
  const d = desktop({ paired: true, armedAny: false });
  assert.strictEqual((await d.pull([phoneRow({}, { date: '20261107' })])).forwarded, 1);
});

check('#838 still never: another PC\'s record, another station, the history, a backfill', async () => {
  const d = desktop({ paired: false });
  const out = await d.pull([desktopRow(), phoneRow({}, { station: 'W1AW' }), phoneRow({}, { station: '' }), phoneRow({}, { date: '20261020' })]);
  assert.strictEqual(out.forwarded, 0);
  assert.strictEqual((await desktop({ paired: false, cursor: false }).pull([phoneRow()])).forwarded, 0, 'first sync forwards nothing');
});

check('#838 setting off: even a paired phone\'s QSO is not forwarded, and nothing is retried', async () => {
  const d = desktop({ ops: { forwardSyncedQsos: false } });
  assert.strictEqual((await d.pull([phoneRow()])).forwarded, 0);
  assert.strictEqual(Object.values(d.sent).reduce((n, l) => n + l.length, 0), 0);
});

check('#838 multi-profile: a profile forwards only its own station\'s QSOs', async () => {
  const profiles = [{ call: ME, owner: ACCOUNT }, { call: `${ME}/P`, owner: ACCOUNT }, { call: 'W9OTH', owner: 'acct-other' }];
  const d = desktop({ paired: false, profiles });
  const mine = phoneRow();
  const portable = phoneRow({}, { station: `${ME}/P` }); // the /P profile's: it pulls it itself (#245)
  const other = phoneRow({}, { station: 'W9OTH' });
  const out = await d.pull([mine, portable, other]);
  assert.deepStrictEqual(calls(d.sent.logbook), [mine.adifFields.CALL]);
  assert.strictEqual(out.forwarded, 1);
});

check('#838 a logger that refuses is tried again later, for that logger only, once it answers', async () => {
  const d = desktop({ paired: false, ops: { logbookType: 'n3fjp', qrzLogbook: true, qrzApiKey: 'K', clublogEnable: true, clublogEmail: 'a@b.c', clublogPassword: 'p' } });
  d.fail.logbook = true; // N3FJP is not running
  const r = phoneRow();
  const out = await d.pull([r]);
  assert.strictEqual(out.retrying, 1);
  assert.strictEqual(d.sent.logbook.length, 0);
  assert.strictEqual(d.sent.qrz.length, 1, 'QRZ took it');
  assert.strictEqual(d.sent.clublog.length, 1);
  const owed = d.store().pending[r.uuid];
  assert.deepStrictEqual(owed.left, ['logbook']);
  assert.strictEqual(owed.profile, ME);
  assert.ok(d.lines.some((l) => /did not reach logbook; POTACAT will try again/.test(l)));

  // Not due yet: nothing is sent.
  d.fail.logbook = false;
  const early = await d.cloud.drainForwardRetries({ now: Date.now() + 1000 });
  assert.strictEqual(early.sent, 0);
  assert.strictEqual(d.sent.logbook.length, 0);
  // A pull of the same record changes nothing.
  assert.strictEqual((await d.pull([r])).forwarded, 0);
  // Due: N3FJP answers now. Only the logbook gets it; QRZ and Club Log not again.
  const due = await d.cloud.drainForwardRetries({ now: Date.now() + 2 * 60000 });
  assert.strictEqual(due.sent, 1);
  assert.deepStrictEqual(calls(d.sent.logbook), [r.adifFields.CALL]);
  assert.strictEqual(d.sent.qrz.length, 1, 'QRZ is not sent twice');
  assert.strictEqual(d.sent.clublog.length, 1, 'Club Log is not queued twice');
  assert.strictEqual(d.store().pending[r.uuid], undefined, 'nothing owed');
  const after = await d.cloud.drainForwardRetries({ force: true });
  assert.strictEqual(after.sent, 0);
  assert.strictEqual(d.sent.logbook.length, 1, 'never twice');
});

check('#838 a retry survives a restart, and a Settings save (force) tries it at once', async () => {
  const d = desktop({ paired: false, ops: { logbookType: 'wavelog' } });
  d.fail.logbook = true;
  const r = phoneRow();
  await d.pull([r]);
  const b = desktop({ dir: d.dir, paired: false, ops: { logbookType: 'wavelog' } });
  const out = await b.cloud.drainForwardRetries({ force: true });
  assert.strictEqual(out.sent, 1);
  assert.deepStrictEqual(calls(b.sent.logbook), [r.adifFields.CALL]);
});

check('#838 a retry is dropped when the operator turns that logger off or deletes the QSO', async () => {
  const d = desktop({ paired: false, ops: { logbookType: 'n3fjp' } });
  d.fail.logbook = true;
  const a = phoneRow();
  const b = phoneRow();
  await d.pull([a, b]);
  assert.strictEqual(Object.keys(d.store().pending).length, 2);
  d.fail.logbook = false;
  // b deleted from the log; then the logger turned off.
  writeLog(d.logPath, d.log().filter((q) => q.APP_POTACAT_UUID !== b.uuid));
  const one = await d.cloud.drainForwardRetries({ force: true });
  assert.strictEqual(one.dropped, 1, 'the deleted QSO is dropped');
  assert.strictEqual(one.sent, 1);
  const e = desktop({ paired: false, ops: { sendToLogbook: false } });
  e.fail.logbook = true;
  await e.pull([phoneRow()]);
  assert.strictEqual(Object.keys(e.store().pending || {}).length, 0, 'a logger that is off is never owed');
  const f = desktop({ paired: false, ops: { logbookType: 'n3fjp' } });
  f.fail.logbook = true;
  await f.pull([phoneRow()]);
  f.settings.sendToLogbook = false;
  const out = await f.cloud.drainForwardRetries({ force: true });
  assert.strictEqual(out.dropped, 1);
  assert.strictEqual(f.sent.logbook.length, 0);
});

check('#838 a logger still refusing after three days is given up, and the log says so', async () => {
  const d = desktop({ paired: false, ops: { logbookType: 'n3fjp' } });
  d.fail.logbook = true;
  const r = phoneRow();
  await d.pull([r]);
  const out = await d.cloud.drainForwardRetries({ now: Date.now() + CPF.GIVE_UP_MS + 1000 });
  assert.strictEqual(out.waiting, 0);
  assert.strictEqual(d.store().pending[r.uuid], undefined);
  assert.ok(d.lines.some((l) => /after 3 days; POTACAT stopped trying\. Use Resend to Logbook/.test(l)), d.lines.join('\n'));
});

check('#838 another profile\'s owed retry waits for that profile', async () => {
  const d = desktop({ paired: false, ops: { logbookType: 'n3fjp' } });
  d.fail.logbook = true;
  const r = phoneRow();
  await d.pull([r]);
  d.fail.logbook = false;
  const s = d.store();
  s.pending[r.uuid].profile = 'W9OTH';
  fs.writeFileSync(path.join(d.dir, 'cloud-pull-forwarded.json'), JSON.stringify(s));
  const b = desktop({ dir: d.dir, paired: false, ops: { logbookType: 'n3fjp' } });
  const out = await b.cloud.drainForwardRetries({ force: true });
  assert.strictEqual(out.sent + out.dropped, 0);
  assert.ok(b.store().pending[r.uuid], 'still owed to W9OTH');
});

check('#838 the glue: Settings save retries now; the checkbox is on unless turned off', () => {
  const main = readSrc(path.join(__dirname, '..', 'main.js')).replace(/\r\n/g, '\n');
  assert.ok(/if \(cloudIpc && cloudIpc\.drainForwardRetries\) cloudIpc\.drainForwardRetries\(\{ force: true \}\)\.catch\(\(\) => \{\}\);/.test(main));
  const app = readSrc(path.join(__dirname, '..', 'renderer', 'app.js'));
  assert.ok(/setForwardSyncedQsos\.checked = s\.forwardSyncedQsos !== false;/.test(app));
  assert.ok(/forwardSyncedQsos: setForwardSyncedQsos \? setForwardSyncedQsos\.checked : true,/.test(app));
  const html = readSrc(path.join(__dirname, '..', 'renderer', 'index.html'));
  assert.ok(/<input type="checkbox" id="set-forward-synced-qsos" checked>/.test(html));
});

check('#838 the fan-out: `only` limits the destinations, the settings still gate each', async () => {
  const sent = [];
  const d = {
    forwardToLogbook: async () => { sent.push('logbook'); },
    sendExtraUdp: async () => { sent.push('extra'); throw new Error('EHOSTUNREACH'); },
    sendToQrzLogbook: async () => { sent.push('qrz'); },
  };
  const q = { callsign: 'W1AW', frequency: '14074.0', mode: 'FT8' };
  const ops = { sendToLogbook: true, logbookType: 'n3fjp', extraUdpEnabled: true, qrzLogbook: true, qrzApiKey: 'k' };
  const all = await LoggerForward.forwardToLoggers(q, ops, d);
  assert.deepStrictEqual(sent, ['logbook', 'extra', 'qrz']);
  assert.strictEqual(all.extraUdpError, 'EHOSTUNREACH');
  sent.length = 0;
  await LoggerForward.forwardToLoggers(q, ops, d, { only: ['extraUdp'] });
  assert.deepStrictEqual(sent, ['extra']);
  sent.length = 0;
  await LoggerForward.forwardToLoggers(q, { ...ops, qrzLogbook: false }, d, { only: ['qrz'] });
  assert.deepStrictEqual(sent, [], 'a destination turned off is never sent, even when asked');
});

// ── the rule's pieces ──────────────────────────────────────────────────────
check('rule pieces: desktop marker, own station, QSO time', () => {
  assert.ok(CPF.isDesktopRecord({ CALL: 'X', APP_POTACAT_UUID: 'u' }));
  assert.ok(CPF.isDesktopRecord({ callsign: 'X', qsodate: '1' }), 'pseudo names, any case');
  assert.ok(!CPF.isDesktopRecord({ CALL: 'X', APP_POTACAT_PASS_SESSION_ID: 's' }), 'a phone guest-pass record is not a desktop one');
  assert.ok(CPF.isGuestPassRecord({ APP_POTACAT_GUEST_PASS: '1' }));
  assert.ok(CPF.isGuestPassRecord({ app_potacat_guest_pass: '1' }), 'any case');
  assert.ok(!CPF.isGuestPassRecord({ APP_POTACAT_GUEST_PASS: '0' }));
  assert.ok(!CPF.isGuestPassRecord({ APP_POTACAT_UUID: 'u' }));
  assert.ok(CPF.isOwnGuestContact({ OPERATOR: 'NA4DQ', STATION_CALLSIGN: 'W7RTA' }, ['NA4DQ']));
  assert.ok(!CPF.isOwnGuestContact({ OPERATOR: 'W1AW', STATION_CALLSIGN: 'W7RTA' }, ['NA4DQ']));
  assert.ok(CPF.isOwnStation({ STATION_CALLSIGN: 'VE3/NA4DQ' }, ['NA4DQ']));
  assert.ok(!CPF.isOwnStation({ STATION_CALLSIGN: 'NA4DQX' }, ['NA4DQ']));
  assert.strictEqual(CPF.qsoTimeMs({ QSO_DATE: '20261107', TIME_ON: '1415' }), Date.UTC(2026, 10, 7, 14, 15));
  assert.ok(Number.isNaN(CPF.qsoTimeMs({ QSO_DATE: '2026-11-07', TIME_ON: '1415' })));
});

check('#838 rule pieces: rule 3 or the any-device cut-off, destinations, back-off, give-up', () => {
  const f = { STATION_CALLSIGN: ME, QSO_DATE: '20261110', TIME_ON: '1200' };
  const at = CPF.qsoTimeMs(f);
  const ctx = { myCalls: [ME], sinceMs: at - 1 };
  assert.ok(CPF.judgePulledQso({}, f, ctx).forward, 'paired (the default) as before');
  assert.strictEqual(CPF.judgePulledQso({}, f, { ...ctx, paired: false }).reason, 'not-paired');
  assert.ok(CPF.judgePulledQso({}, f, { ...ctx, paired: false, anyDevice: true, sinceAnyMs: at }).forward, 'at the any-device clock');
  assert.strictEqual(CPF.judgePulledQso({}, f, { ...ctx, paired: false, anyDevice: true, sinceAnyMs: at + 1 }).reason, 'before');
  assert.strictEqual(CPF.judgePulledQso({}, f, { ...ctx, paired: false, anyDevice: true }).reason, 'before', 'no any-device clock: nothing');
  assert.strictEqual(CPF.judgePulledQso({ APP_POTACAT_UUID: 'u' }, f, { ...ctx, paired: false, anyDevice: true, sinceAnyMs: 0 }).reason, 'desktop');

  assert.deepStrictEqual(CPF.enabledDestinations({ sendToLogbook: true, logbookType: 'n3fjp', extraUdpEnabled: true, qrzLogbook: true, qrzApiKey: 'k' }), ['logbook', 'extraUdp', 'qrz']);
  assert.deepStrictEqual(CPF.enabledDestinations({ sendToLogbook: true, logbookType: '', qrzLogbook: true }), [], 'no type, no key: off');
  assert.deepStrictEqual(CPF.failedDestinations({ logbookError: 'x', qrzError: undefined, extraUdpError: 'y' }), ['logbook', 'extraUdp']);
  assert.deepStrictEqual(CPF.failedDestinations(undefined), []);
  assert.deepStrictEqual([1, 2, 3, 4, 9].map((n) => CPF.retryDelayMs(n) / 60000), [1, 5, 15, 60, 60]);

  const now = 1e12;
  assert.deepStrictEqual(CPF.afterAttempt({ owner: 'a' }, [], now), { entry: null, gaveUp: false }, 'nothing failed: done');
  const one = CPF.afterAttempt({ owner: 'a', profile: ME }, ['logbook', 'bogus'], now).entry;
  assert.deepStrictEqual(one, { owner: 'a', profile: ME, left: ['logbook'], tries: 1, firstAt: now, nextAt: now + 60000 });
  const two = CPF.afterAttempt(one, ['logbook'], now + 60000).entry;
  assert.strictEqual(two.tries, 2);
  assert.strictEqual(two.firstAt, now, 'the first failure is kept');
  assert.strictEqual(two.nextAt, now + 60000 + 5 * 60000);
  const late = CPF.afterAttempt(one, ['logbook'], now + CPF.GIVE_UP_MS);
  assert.strictEqual(late.entry, null);
  assert.ok(late.gaveUp);
  assert.deepStrictEqual(CPF.retryTargets({ left: ['logbook', 'qrz'] }, { sendToLogbook: true, logbookType: 'n3fjp' }), ['logbook'], 'a destination turned off is dropped');
});

check('#838 the store: old files load, retries persist per account and profile, no QSO content', () => {
  const dir = freshDir();
  const file = path.join(dir, 'cloud-pull-forwarded.json');
  fs.writeFileSync(file, JSON.stringify({ since: { a: ARMED_AT }, uuids: ['u1'] })); // a file from before #838
  const st = new CPF.ForwardedStore(file);
  assert.ok(st.has('u1'));
  assert.ok(Number.isNaN(st.sinceAnyFor('a')));
  assert.deepStrictEqual(st.pendingFor('a', ME), []);
  assert.ok(Number.isNaN(st.nextDue()));
  st.startAnyFor('a', new Date(ARMED_AT));
  st.setPending('u2', { owner: 'a', profile: ME, left: ['logbook'], tries: 1, firstAt: 5, nextAt: 50 });
  st.setPending('u3', { owner: 'a', profile: 'W9OTH', left: ['qrz'], tries: 1, firstAt: 5, nextAt: 20 });
  const re = new CPF.ForwardedStore(file);
  assert.strictEqual(re.sinceAnyFor('a'), Date.parse(ARMED_AT));
  assert.deepStrictEqual(re.pendingFor('a', ME).map((e) => e.uuid), ['u2']);
  assert.deepStrictEqual(re.pendingFor('b', ME), []);
  assert.strictEqual(re.nextDue(), 20);
  re.setPending('u3', null);
  assert.strictEqual(new CPF.ForwardedStore(file).nextDue(), 50);
  assert.ok(!/CALL|QSO_DATE|apiKey/i.test(fs.readFileSync(file, 'utf8')));
});

(async () => {
  console.log('Cloud pull: forward this station\'s off-grid phone QSOs to the external loggers (#267)');
  for (const t of queue) await t();
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  console.log(`\nCloud pull forward (#267): ${passed} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})();
