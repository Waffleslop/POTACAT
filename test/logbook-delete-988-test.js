#!/usr/bin/env node
'use strict';
// #988: a QSO deleted in the Logbook came back, and another one went.
//
// The pop-out sorted its list in place and renumbered rows in display order
// after a delete, and main's delete-qso removed whatever record sat at that
// position in the file. So every delete after the first in one opening
// removed a different (usually older) QSO; edits and the paper-QSL toggle
// after a delete hit the wrong QSO too. Separately, mutateLog never wrote
// the file when the only change was removing a record with no uuid: the
// Logbook said "Invalid index" and ECHOCAT said the delete had worked.
//
// Now: the page sends the record's identity with its idx and reloads after
// a delete (renderer/qso-popout.js); main acts only on the record that
// identity names (lib/logbook-edit.js + lib/qso-identity.js); mutateLog
// writes a uuid-less removal and reports `removed`.
// Every log here is a temp file. Run: node test/logbook-delete-988-test.js
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readSrc } = require('./_src');
const QsoLog = require('../lib/qso-log');
const QsoIdentity = require('../lib/qso-identity');
const { parseAllRawQsos } = require('../lib/adif');
const { applyQsoEdit } = require('../lib/qso-edit');

let LogbookEdit = null;
try { LogbookEdit = require('../lib/logbook-edit'); } catch { LogbookEdit = null; }

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
}

const ROOT = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'potacat988-'));
let n = 0;
const CALLS = ['AA1A', 'BB2B', 'CC3C', 'DD4D', 'EE5E'];
const f = (k, v) => `<${k}:${String(v).length}>${v} `;
/** A temp log of 5 QSOs, oldest first in the file, with or without uuids. */
function freshLog(withUuid) {
  let txt = 'temp\n<EOH>\n';
  CALLS.forEach((c, i) => {
    txt += f('CALL', c) + f('QSO_DATE', '2026112' + i) + f('TIME_ON', '120000') + f('BAND', '20M') + f('MODE', 'SSB')
      + (withUuid ? f('APP_POTACAT_UUID', crypto.randomUUID()) + f('APP_POTACAT_VERSION', 1) : '') + '<EOR>\n';
  });
  const p = path.join(dir, `log${++n}.adi`);
  fs.writeFileSync(p, txt);
  return p;
}
const disk = (p) => parseAllRawQsos(p).map((q) => q.CALL);

/** main.js glue, as wired: mutateQsoLog + the get-all-qsos shape. */
function shack(logPath) {
  const journal = [];
  const mutate = (fn) => QsoLog.mutateLog(logPath, fn, { sink: (c) => journal.push(...c) });
  return {
    journal,
    getAllQsos: () => parseAllRawQsos(logPath).map((fields, idx) => ({ idx, ...fields })),
    deleteQso: (idx, identity) => LogbookEdit.deleteOne(mutate, idx, identity),
    updateQso: (idx, identity, fields) => LogbookEdit.updateOne(mutate, idx, identity, fields, applyQsoEdit),
  };
}
const newestFirst = (list) => list.slice().sort((a, b) => (b.QSO_DATE + b.TIME_ON).localeCompare(a.QSO_DATE + a.TIME_ON));

for (const withUuid of [true, false]) {
  const label = withUuid ? 'with uuids' : 'no uuids (older non-Cloud log)';

  test(`delete the 2nd and then the 3rd row of the sorted Logbook: those QSOs go, nothing else (${label})`, () => {
    assert.ok(LogbookEdit, 'lib/logbook-edit.js exists');
    const log = freshLog(withUuid);
    const s = shack(log);
    // The page as fixed: rows from get-all-qsos, shown sorted (a copy),
    // identity sent with idx, reload after each delete.
    let rows = newestFirst(s.getAllQsos());
    assert.deepStrictEqual(rows.map((q) => q.CALL), ['EE5E', 'DD4D', 'CC3C', 'BB2B', 'AA1A']);
    let row = rows[1];
    assert.strictEqual(s.deleteQso(row.idx, QsoIdentity.of(row)).success, true);
    rows = newestFirst(s.getAllQsos());
    row = rows[2];
    assert.strictEqual(row.CALL, 'BB2B');
    assert.strictEqual(s.deleteQso(row.idx, QsoIdentity.of(row)).success, true);
    assert.deepStrictEqual(disk(log), ['AA1A', 'CC3C', 'EE5E']);
  });

  test(`the old page's renumbered idx with the identity still deletes the clicked QSO (${label})`, () => {
    const log = freshLog(withUuid);
    const s = shack(log);
    // The #988 page: sorted in place, renumbered in display order after a delete.
    let all = newestFirst(s.getAllQsos());
    let row = all.find((q) => q.CALL === 'DD4D');
    assert.strictEqual(s.deleteQso(row.idx, QsoIdentity.of(row)).success, true);
    all = all.filter((q) => q !== row);
    all.forEach((q, i) => { q.idx = i; });
    row = all.find((q) => q.CALL === 'BB2B');
    assert.strictEqual(row.idx, 2, 'stale: BB2B is file record 1, the page says 2 (CC3C)');
    const r = s.deleteQso(row.idx, QsoIdentity.of(row));
    assert.strictEqual(r.success, true);
    assert.strictEqual(r.index, 1, 'found by identity');
    assert.deepStrictEqual(disk(log), ['AA1A', 'CC3C', 'EE5E'], 'BB2B gone, CC3C kept');
  });

  test(`an edit after a delete hits the QSO that was edited (${label})`, () => {
    const log = freshLog(withUuid);
    const s = shack(log);
    let all = newestFirst(s.getAllQsos());
    const del = all.find((q) => q.CALL === 'DD4D');
    assert.ok(s.deleteQso(del.idx, QsoIdentity.of(del)).success);
    // Stale numbering, as the old page held it.
    all = all.filter((q) => q !== del);
    all.forEach((q, i) => { q.idx = i; });
    const row = all.find((q) => q.CALL === 'BB2B');
    const r = s.updateQso(row.idx, QsoIdentity.of(row), { COMMENT: 'edited' });
    assert.strictEqual(r.success, true);
    const after = parseAllRawQsos(log);
    assert.strictEqual(after.find((q) => q.CALL === 'BB2B').COMMENT, 'edited');
    assert.ok(!after.find((q) => q.CALL === 'CC3C').COMMENT, 'CC3C untouched');
    // The paper-QSL toggle is an update-qso with QSL_RCVD.
    const t = s.updateQso(row.idx, QsoIdentity.of(row), { QSL_RCVD: 'Y' });
    assert.strictEqual(t.success, true);
    assert.strictEqual(parseAllRawQsos(log).find((q) => q.CALL === 'BB2B').QSL_RCVD, 'Y');
    assert.ok(!parseAllRawQsos(log).find((q) => q.CALL === 'CC3C').QSL_RCVD);
  });

  test(`a stale idx with an identity no record has is refused and nothing is written (${label})`, () => {
    const log = freshLog(withUuid);
    const s = shack(log);
    const bytes = fs.readFileSync(log);
    const mtime = fs.statSync(log).mtimeMs;
    const ghost = { CALL: 'ZZ9Z', QSO_DATE: '20261120', TIME_ON: '120000', BAND: '20M', MODE: 'SSB' };
    if (withUuid) ghost.APP_POTACAT_UUID = crypto.randomUUID();
    const d = s.deleteQso(2, ghost);
    assert.strictEqual(d.success, false);
    assert.strictEqual(d.reason, 'not-found');
    assert.strictEqual(d.error, QsoIdentity.NOT_FOUND);
    const u = s.updateQso(2, ghost, { COMMENT: 'x' });
    assert.strictEqual(u.success, false);
    assert.strictEqual(u.reason, 'not-found');
    assert.ok(fs.readFileSync(log).equals(bytes), 'file unchanged');
    assert.strictEqual(fs.statSync(log).mtimeMs, mtime, 'file not rewritten');
    assert.strictEqual(s.journal.length, 0, 'nothing journaled');
  });
}

test('deleting a record with no uuid removes it from the file (mutateLog)', () => {
  const log = freshLog(false);
  const sunk = [];
  const r = QsoLog.mutateLog(log, (q) => { q.splice(1, 1); }, { sink: (c) => sunk.push(c) });
  assert.strictEqual(r.removed, 1);
  assert.strictEqual(r.changes.length, 0, 'nothing to journal: the cloud never knew it');
  assert.strictEqual(sunk.length, 0, 'the sink is not called with nothing');
  assert.deepStrictEqual(disk(log), ['AA1A', 'CC3C', 'DD4D', 'EE5E']);
});

test('mutateLog: no change still writes nothing; an abort writes nothing', () => {
  const log = freshLog(false);
  const mtime = fs.statSync(log).mtimeMs;
  assert.strictEqual(QsoLog.mutateLog(log, () => {}).removed, 0);
  assert.strictEqual(QsoLog.mutateLog(log, () => false).removed, 0);
  assert.strictEqual(fs.statSync(log).mtimeMs, mtime);
});

test('a delete with a uuid works as before: removed, journaled once as a delete', () => {
  const log = freshLog(true);
  const s = shack(log);
  const row = s.getAllQsos()[3];
  const r = s.deleteQso(row.idx, QsoIdentity.of(row));
  assert.deepStrictEqual(r, { success: true, index: 3 });
  assert.deepStrictEqual(disk(log), ['AA1A', 'BB2B', 'CC3C', 'EE5E']);
  assert.strictEqual(s.journal.length, 1);
  assert.strictEqual(s.journal[0].action, 'delete');
  assert.strictEqual(s.journal[0].fields.APP_POTACAT_UUID, row.APP_POTACAT_UUID);
  // An older client (no identity) still deletes by index.
  assert.strictEqual(s.deleteQso(0, null).success, true);
  assert.deepStrictEqual(disk(log), ['BB2B', 'CC3C', 'EE5E']);
});

test('the ECHOCAT delete reports the real result', () => {
  // A record with no uuid: removed, and success says so.
  const log = freshLog(false);
  const s = shack(log);
  const row = s.getAllQsos()[0];
  assert.deepStrictEqual(s.deleteQso(0, QsoIdentity.fromRequest({ idx: 0, expectCall: row.CALL, expectTime: row.TIME_ON })), { success: true, index: 0 });
  assert.deepStrictEqual(disk(log), ['BB2B', 'CC3C', 'DD4D', 'EE5E']);
  // A write that removed nothing is a failure, never "deleted".
  const r = LogbookEdit.deleteOne((fn) => { fn([{ CALL: 'X' }]); return { removed: 0, changes: [] }; }, 0, null);
  assert.strictEqual(r.success, false);
  // main.js: the ECHOCAT handler answers from that result.
  const main = readSrc(path.join(ROOT, 'main.js'));
  const h = main.slice(main.indexOf("remoteServer.on('delete-qso'"), main.indexOf("remoteServer.on('log-qso'"));
  assert.ok(/LogbookEdit\.deleteOne\(mutateQsoLog, idx, identity\)/.test(h), 'ECHOCAT delete goes through LogbookEdit.deleteOne');
  assert.ok(h.indexOf('if (!r.success)') !== -1 && h.indexOf('if (!r.success)') < h.indexOf('success: true'), 'success only after r.success');
  assert.ok(/logIdx: r\.index/.test(h), 'the real position rides back as logIdx');
  assert.ok(/sendQsoDeleted\(\{ success: true, idx, /.test(h), 'idx echoes the request (the phone matches its ack by it)');
  const u = main.slice(main.indexOf("remoteServer.on('update-qso'"), main.indexOf("remoteServer.on('delete-qso'"));
  assert.ok(/LogbookEdit\.updateOne\(mutateQsoLog, idx, identity, edit, applyQsoEdit\)/.test(u));
  const rs = readSrc(path.join(ROOT, 'lib', 'remote-server.js'));
  assert.ok(/emit\('delete-qso', \{ idx: msg\.idx, identity: QsoIdentity\.fromRequest\(msg\) \}\)/.test(rs));
  assert.ok(/emit\('update-qso', \{ idx: msg\.idx, fields: msg\.fields, identity: QsoIdentity\.fromRequest\(msg\) \}\)/.test(rs));
});

test('main.js: the Logbook IPC edit and delete go through LogbookEdit with the identity', () => {
  const main = readSrc(path.join(ROOT, 'main.js'));
  const del = main.slice(main.indexOf("ipcMain.handle('delete-qso'"));
  assert.ok(/^ipcMain\.handle\('delete-qso', async \(event, idx, identity\)/.test(del));
  assert.ok(/LogbookEdit\.deleteOne\(mutateQsoLog, idx, identity\)/.test(del.slice(0, 600)));
  const upd = main.slice(main.indexOf("ipcMain.handle('update-qso'"));
  assert.ok(/\{ idx, fields: edit, identity \}/.test(upd.slice(0, 120)));
  assert.ok(/LogbookEdit\.updateOne\(mutateQsoLog, idx, identity, edit, applyQsoEdit\)/.test(upd.slice(0, 600)));
  // Every other delete counts what left the file, not what was journaled.
  for (const name of ["'delete-activation'", "'delete-duplicate-qsos'", "'delete-qsos-by-match'"]) {
    const at = main.indexOf('ipcMain.handle(' + name);
    assert.ok(at !== -1, name);
    const body = main.slice(at, main.indexOf('\n  });', at));
    assert.ok(/const \{ removed \} = mutateQsoLog\(/.test(body), name + ' uses removed');
    assert.ok(!/changes\.length/.test(body), name + ' does not count changes');
  }
  const preload = readSrc(path.join(ROOT, 'preload-qso-popout.js'));
  assert.ok(/deleteQso: \(idx, identity\) => ipcRenderer\.invoke\('delete-qso', idx, identity\)/.test(preload), 'the pop-out preload passes the identity');
});

test('renderer/qso-popout.js: sorts a copy, sends the identity, reloads after a delete', () => {
  const src = readSrc(path.join(ROOT, 'renderer', 'qso-popout.js'));
  const render = src.slice(src.indexOf('function render() {'), src.indexOf('// Sort', src.indexOf('function render() {')));
  assert.ok(!/filtered = allQsos;/.test(render), 'render never sorts allQsos itself');
  const del = src.slice(src.indexOf('// --- Delete (two-click) ---'), src.indexOf('// --- New QSO form ---'));
  assert.ok(/window\.api\.deleteQso\(idx, QsoIdentity\.of\(qso\)\)/.test(del), 'delete sends the identity');
  assert.ok(!/q\.idx = i/.test(del), 'no renumbering in display order');
  assert.ok(/allQsos = await window\.api\.getAllQsos\(\)/.test(del), 'reloads from the file after a delete');
  const updates = src.match(/window\.api\.updateQso\(\{[^}]*\}\)/g) || [];
  assert.ok(updates.length >= 2, 'inline edit and paper QSL');
  for (const u of updates) assert.ok(/identity: QsoIdentity\.of\(/.test(u), 'update sends the identity: ' + u);
  const html = readSrc(path.join(ROOT, 'renderer', 'qso-popout.html'));
  assert.ok(html.indexOf('../lib/qso-identity.js') !== -1 && html.indexOf('../lib/qso-identity.js') < html.indexOf('qso-popout.js"'), 'the page loads lib/qso-identity.js first');
});

test('renderer/remote.js (ECHOCAT Web): sends the identity and re-indexes by the real position', () => {
  const src = readSrc(path.join(ROOT, 'renderer', 'remote.js'));
  assert.ok(/type: 'update-qso', idx, fields, identity: QsoIdentity\.of\(/.test(src));
  assert.ok(/type: 'delete-qso', idx, identity: QsoIdentity\.of\(/.test(src));
  const del = src.slice(src.indexOf("case 'qso-deleted':"), src.indexOf("case 'qso-deleted':") + 900);
  assert.ok(/msg\.logIdx/.test(del), 'removes and shifts by logIdx when the shack sends it');
  const html = readSrc(path.join(ROOT, 'renderer', 'remote.html'));
  assert.ok(html.indexOf('<!-- qso-identity-js -->') !== -1, 'ECHOCAT Web gets lib/qso-identity.js inlined');
  const rs = readSrc(path.join(ROOT, 'lib', 'remote-server.js'));
  assert.ok(/html\.replace\('<!-- qso-identity-js -->'/.test(rs), 'remote-server inlines it');
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
