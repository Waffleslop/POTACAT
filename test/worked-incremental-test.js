#!/usr/bin/env node
'use strict';
// #731: every logged QSO re-sent the whole worked-QSO history to the active
// ECHOCAT client. On a weak cell link during an activation that is a large
// payload after every contact. A client whose hello lists 'worked-incremental'
// now gets the full list once per connection (and again after a full-log
// change: import, edit, delete, reload); after each logged QSO it gets only
// worked-today (and qso-added where it applies). A client without the flag
// keeps exactly the older sends.
// Run: node test/worked-incremental-test.js
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const { RemoteServer } = require('../lib/remote-server');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

function utcDay(ms) {
  const d = new Date(ms);
  return d.getUTCFullYear() + String(d.getUTCMonth() + 1).padStart(2, '0') + String(d.getUTCDate()).padStart(2, '0');
}
const TODAY = utcDay(Date.now());

function fakeWs(capabilities) {
  return {
    readyState: 1,
    _clientCapabilities: capabilities,
    _authenticated: true,
    sent: [],
    send(json) { this.sent.push(JSON.parse(json)); },
  };
}

function serverFor(ws) {
  const srv = Object.create(RemoteServer.prototype);
  srv._workedQsos = null;
  srv._workedQsosCache = null;
  srv._workedTodayCache = null;
  srv._client = ws;
  srv._clients = new Set([ws]);
  srv.emit = () => {};
  srv._sendTo = function (w, obj) { w.send(JSON.stringify(obj)); };
  return srv;
}

/** A small history, then the same history with one more QSO (what logContact sends). */
function history(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(['K' + i + 'ABC', [{ date: TODAY, ref: 'US-' + (1000 + i), band: '20M', mode: 'CW' }]]);
  return out;
}

const full = (ws) => ws.sent.filter((m) => m.type === 'worked-qsos');
const today = (ws) => ws.sent.filter((m) => m.type === 'worked-today');

/** Connect (hydrate + main's client-connected resend), then log two QSOs. */
function connectAndLogTwo(caps) {
  const ws = fakeWs(caps);
  const srv = serverFor(ws);
  srv._workedQsos = history(3);
  srv._workedQsosKey = srv._keyOf(srv._workedQsos); // the list as last pushed (startup load)
  srv._sendWorkedQsosCapped(ws);     // hydrate
  srv._sendWorkedToday(ws);
  srv.sendWorkedQsos(history(3));    // main.js client-connected: same list
  const atConnect = full(ws).length;
  srv.sendWorkedQsos(history(4));    // logContact
  srv.sendWorkedQsos(history(5));    // logContact again
  return { ws, srv, atConnect };
}

test('worked-incremental client: one full list at connect, none per logged QSO', () => {
  const { ws, atConnect } = connectAndLogTwo(['qso-delta', 'worked-incremental']);
  assert.strictEqual(atConnect, 1, 'expected the full list once at connect');
  assert.strictEqual(full(ws).length, 1, 'full worked-qsos re-sent after a logged QSO: ' + full(ws).length + ' sends');
});

test('worked-incremental client still gets worked-today after each logged QSO, with the new call', () => {
  const { ws } = connectAndLogTwo(['worked-incremental']);
  const t = today(ws);
  assert.ok(t.length >= 3, 'worked-today not sent per QSO');
  const last = t[t.length - 1].entries.map((e) => e.call);
  assert.ok(last.includes('K4ABC'), 'the newest QSO is missing from worked-today');
});

test('chunked + worked-incremental client: one chunked set at connect, none per QSO', () => {
  const { ws } = connectAndLogTwo(['chunked-worked-qsos', 'worked-incremental']);
  assert.strictEqual(full(ws).length, 1);
  assert.strictEqual(full(ws)[0].chunk, 0);
});

test('client without the flag: exactly the older sends (full list after every logged QSO)', () => {
  const { ws, atConnect } = connectAndLogTwo(['qso-delta']);
  assert.strictEqual(atConnect, 1);
  assert.strictEqual(full(ws).length, 3, 'legacy client lost its per-QSO resend');
  assert.deepStrictEqual(full(ws)[2].entries, history(5));
  assert.strictEqual(today(ws).length, 4);
});

test('legacy chunked client: a full chunked set after every logged QSO, as before', () => {
  const { ws } = connectAndLogTwo(['chunked-worked-qsos']);
  assert.strictEqual(full(ws).length, 3);
});

test('worked-incremental client gets the full list again after a full-log change', () => {
  const { ws, srv } = connectAndLogTwo(['worked-incremental']);
  srv.sendWorkedQsos(history(2), { fullLogChange: true }); // e.g. two QSOs deleted
  assert.strictEqual(full(ws).length, 2);
  assert.deepStrictEqual(full(ws)[1].entries, history(2));
});

test('a full-log change sends nothing new to a client without the flag', () => {
  const { ws, srv } = connectAndLogTwo([]);
  const before = ws.sent.length;
  srv.sendWorkedQsos(history(2), { fullLogChange: true });
  assert.strictEqual(ws.sent.length, before);
  // ...and the next connection hydrates from the reloaded list.
  assert.deepStrictEqual(srv._workedQsos, history(2));
});

test('a new connection with the flag gets the full list again', () => {
  const { srv } = connectAndLogTwo(['worked-incremental']);
  const ws2 = fakeWs(['worked-incremental']);
  srv._client = ws2;
  srv._sendWorkedQsosCapped(ws2);
  srv.sendWorkedQsos(srv._workedQsos);
  assert.strictEqual(full(ws2).length, 1);
  assert.deepStrictEqual(full(ws2)[0].entries, history(5));
});

test('main.js pushes the reloaded list as a full-log change', () => {
  const src = readSrc(path.join(__dirname, '..', 'main.js'));
  const fn = src.slice(src.indexOf('function loadWorkedQsos()'), src.indexOf('function rebuildWorkedRoster()'));
  assert.ok(/remoteServer\.sendWorkedQsos\(\[\.\.\.workedQsos\.entries\(\)\], \{ fullLogChange: true \}\)/.test(fn), 'loadWorkedQsos does not tell the remote server');
});

test('ECHOCAT Web declares worked-incremental and merges worked-today into its worked map', () => {
  const src = readSrc(path.join(__dirname, '..', 'renderer', 'remote.js'));
  const hello = src.slice(src.indexOf("type: 'hello'"), src.indexOf("type: 'hello'") + 3000);
  assert.ok(/capabilities:\s*\[[^\]]*'worked-incremental'/.test(hello), 'web hello lacks worked-incremental');
  const wt = src.slice(src.indexOf("case 'worked-today': {"), src.indexOf("case 'worked-qsos-skipped'"));
  assert.ok(/workedQsos\.set\(call, list\)/.test(wt), 'worked-today no longer merges into workedQsos');
});

// ECHOCAT Web merges each qso-added record into its worked map with the same
// entry rule as the full list (lib/worked-entry.js), so a back-dated QSO shows
// with no reconnect and nothing counts twice.
const fs = require('fs');
const os = require('os');
const WorkedEntry = require('../lib/worked-entry');
const WorkedMatrix = require('../lib/worked-matrix');
const { parseWorkedQsos } = require('../lib/adif');
const { freqToBand } = require('../lib/bands');

const REC = { CALL: 'w1aw', QSO_DATE: '20240105', BAND: '40m', MODE: 'SSB', SUBMODE: 'LSB', SIG_INFO: 'us-0001', MY_SIG_INFO: 'us-4567', STATE: 'ct', LOTW_QSL_RCVD: 'Y' };

test('a back-dated qso-added shows in the worked matrix with no reconnect', () => {
  const map = new Map([['W1AW', [{ date: TODAY, ref: '', myRef: '', band: '20M', mode: 'CW' }]]]);
  assert.strictEqual(WorkedEntry.mergeRecord(map, { idx: 7, ...REC }), 'W1AW');
  const m = WorkedMatrix.buildWorkedMatrix(WorkedMatrix.entriesForCall(map, 'W1AW'));
  const phone = m.rows.find((r) => r.family === 'phone');
  assert.strictEqual(phone.cells['40m'], 'confirmed', '40m phone missing from the matrix');
  assert.strictEqual(m.total, 2);
});

test('a duplicate qso-added (the full list already carried it) does not double-count', () => {
  const map = new Map();
  WorkedEntry.mergeRecord(map, REC);
  WorkedEntry.mergeRecord(map, REC);
  assert.strictEqual(map.get('W1AW').length, 1);
  // ...nor after the worked-today copy of the same QSO arrived first.
  const map2 = new Map([['W1AW', [{ date: '20240105', ref: 'US-0001', band: '40M', mode: 'SSB' }]]]);
  WorkedEntry.mergeRecord(map2, REC);
  assert.strictEqual(map2.get('W1AW').length, 1);
  assert.strictEqual(map2.get('W1AW')[0].myRef, 'US-4567', 'the fuller entry should replace the worked-today copy');
  assert.strictEqual(WorkedMatrix.buildWorkedMatrix(WorkedMatrix.entriesForCall(map2, 'W1AW')).total, 1);
});

test('qso-added builds exactly the entry the full list builds (one rule)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wi-'));
  const file = path.join(dir, 'log.adi');
  const adif = (r) => Object.entries(r).map(([k, v]) => `<${k}:${String(v).length}>${v}`).join('') + '<EOR>\n';
  const noBand = { CALL: 'K2XX', QSO_DATE: '20250101', FREQ: '7.074', MODE: 'MFSK', SUBMODE: 'FT4' };
  fs.writeFileSync(file, '<EOH>\n' + adif(REC) + adif(noBand));
  const full = parseWorkedQsos(file);
  const live = new Map();
  WorkedEntry.mergeRecord(live, REC, freqToBand);
  WorkedEntry.mergeRecord(live, noBand, freqToBand);
  assert.deepStrictEqual([...live.entries()], [...full.entries()]);
  assert.deepStrictEqual(full.get('W1AW')[0], { date: '20240105', ref: 'US-0001', myRef: 'US-4567', band: '40M', mode: 'SSB', state: 'CT', confirmed: true });
  assert.strictEqual(full.get('K2XX')[0].mode, 'FT4');
  assert.strictEqual(full.get('K2XX')[0].freqBand, '40M');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ECHOCAT Web gets the helper and merges qso-added (it lists qso-delta, which is what sends qso-added)', () => {
  const web = readSrc(path.join(__dirname, '..', 'renderer', 'remote.js'));
  const hello = web.slice(web.indexOf("type: 'hello'"), web.indexOf("type: 'hello'") + 3000);
  assert.ok(/capabilities:\s*\[[^\]]*'qso-delta'/.test(hello));
  const qa = web.slice(web.indexOf("case 'qso-added':"), web.indexOf("case 'qso-updated':"));
  assert.ok(/WorkedEntry\.mergeRecord\(workedQsos, msg\.data\)/.test(qa), 'qso-added does not merge into workedQsos');
  const html = readSrc(path.join(__dirname, '..', 'renderer', 'remote.html'));
  assert.ok(html.includes('<!-- worked-entry-js -->'));
  assert.ok(html.indexOf('<!-- adif-mode-js -->') < html.indexOf('<!-- worked-entry-js -->'), 'worked-entry needs AdifMode loaded first');
  assert.ok(readSrc(path.join(__dirname, '..', 'lib', 'remote-server.js')).includes("['worked-entry-js', 'worked-entry.js']"));
});

console.log(`\nWorked incremental (#731): ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
