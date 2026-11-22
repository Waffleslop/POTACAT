#!/usr/bin/env node
'use strict';
// #733 (activation review 2026-11-17, fix 6): log-qso is idempotent by uuid.
// A phone that never heard log-ok (it slept, the link dropped) resends the
// same QSO under the same uuid. The desktop wrote a second ADIF record with
// that uuid (saveQsoRecord passed appendRecords existing: [], so the
// collision check never ran), and the next Cloud reconcile gave the copy a
// fresh uuid and pushed it: a duplicate in the log and in the Cloud.
//
// Now: an in-memory uuid index kept in step with the log (lib/qso-log.js),
// a reply book (lib/log-qso-replay.js), and the log-qso handler answers a
// known uuid with the first reply without writing.
// Run: node test/log-qso-idempotent-test.js
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readSrc } = require('./_src');
const QsoLog = require('../lib/qso-log');
const { buildAdifFields } = require('../lib/adif-writer');

let pass = 0, fail = 0;
const pending = [];
function test(name, fn) {
  pending.push(async () => {
    try { await fn(); pass++; console.log('  ok  ' + name); }
    catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
  });
}
let Replay = null;
try { Replay = require('../lib/log-qso-replay'); } catch { Replay = null; }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logqso-idem-'));
let n = 0;
function freshLog() { const p = path.join(dir, `log${++n}.adi`); fs.writeFileSync(p, ''); return p; }
const qso = (uuid, extra) => buildAdifFields(Object.assign({
  callsign: 'K1ABC', frequency: '14285', band: '20m', mode: 'SSB', qsoDate: '20261117', timeOn: '000030',
  rstSent: '59', rstRcvd: '57', sig: 'POTA', sigInfo: 'US-0001', mySig: 'POTA', mySigInfo: 'US-1234', uuid,
}, extra || {}));

test('lib/log-qso-replay.js exists and qso-log has a uuid index', () => {
  assert.ok(Replay, 'lib/log-qso-replay.js');
  assert.strictEqual(typeof QsoLog.hasUuid, 'function');
  assert.strictEqual(typeof QsoLog.findByUuid, 'function');
});

test('the uuid index follows appends, edits and deletes', () => {
  const log = freshLog();
  const u1 = crypto.randomUUID();
  const u2 = crypto.randomUUID();
  assert.strictEqual(QsoLog.hasUuid(log, u1), false);
  QsoLog.appendRecords(log, [qso(u1)]);
  assert.strictEqual(QsoLog.hasUuid(log, u1), true, 'append');
  QsoLog.mutateLog(log, (qsos) => { qsos.push({ ...qso(u2) }); });
  assert.strictEqual(QsoLog.hasUuid(log, u2), true, 'create through mutateLog');
  QsoLog.mutateLog(log, (qsos) => qsos.filter((q) => q.APP_POTACAT_UUID !== u1));
  assert.strictEqual(QsoLog.hasUuid(log, u1), false, 'delete');
  // Another program appended to the file: the index notices and rebuilds.
  const u3 = crypto.randomUUID();
  const other = freshLog();
  QsoLog.appendRecords(other, [qso(u3)]);
  fs.appendFileSync(log, fs.readFileSync(other, 'utf8').replace(/^[\s\S]*?<EOH>/i, ''));
  assert.strictEqual(QsoLog.hasUuid(log, u3), true, 'outside write picked up');
  assert.deepStrictEqual(QsoLog.findByUuid(log, u2).map((q) => q.APP_POTACAT_UUID), [u2]);
});

test('a second append with a uuid already in the log never writes that uuid twice', () => {
  const log = freshLog();
  const u = crypto.randomUUID();
  QsoLog.appendRecords(log, [qso(u)]);
  // The old save path passed existing: [] (no check). Without `existing` the
  // index does the check, with no re-read of the log.
  const again = qso(u);
  QsoLog.appendRecords(log, [again]);
  const all = QsoLog.readLog(log);
  assert.strictEqual(all.filter((q) => q.APP_POTACAT_UUID === u).length, 1, 'one record holds the uuid');
  assert.notStrictEqual(again.APP_POTACAT_UUID, u, 'the copy got its own uuid');
  // So the Cloud reconcile (ensureIdentities) has nothing to re-mint: it never turns one record into two.
  assert.deepStrictEqual(QsoLog.ensureIdentities(log), []);
});

test('reply book: a known uuid gets the first reply, under the new reqId', async () => {
  const book = Replay.createReplyBook();
  const u = crypto.randomUUID();
  const c1 = await book.claim(u, () => null);
  assert.ok(c1.release && !c1.prior, 'first time: write it');
  book.remember(u, { success: true, callsign: 'K1ABC', uuid: u, records: [{ uuid: u }], reqId: 'r1' });
  c1.release();
  const c2 = await book.claim(u, () => null);
  assert.ok(c2.prior, 'second time: no write');
  const again = Replay.replayReply(c2.prior, 'r2');
  assert.deepStrictEqual(again, { success: true, callsign: 'K1ABC', uuid: u, records: [{ uuid: u }], reqId: 'r2', alreadyLogged: true });
  // A later respot outcome is kept for a replay too.
  book.patch(u, { resposted: true });
  assert.strictEqual((await book.claim(u, () => null)).prior.resposted, true);
});

test('reply book: a resend while the first is still saving waits for it, never writes twice', async () => {
  const book = Replay.createReplyBook();
  const u = crypto.randomUUID();
  const first = await book.claim(u, () => null);
  let secondDone = false;
  const second = book.claim(u, () => null).then((c) => { secondDone = true; return c; });
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(secondDone, false, 'waits');
  book.remember(u, { success: true, uuid: u });
  first.release();
  assert.ok((await second).prior);
  // A failed save remembers nothing: the resend tries again.
  const v = crypto.randomUUID();
  const f = await book.claim(v, () => null);
  f.release();
  assert.ok((await book.claim(v, () => null)).release);
});

test('reply book: no uuid means no check (records without a uuid behave as before)', async () => {
  const book = Replay.createReplyBook();
  const c = await book.claim('', () => { throw new Error('must not look'); });
  assert.ok(c.release && !c.prior);
});

test('after a restart: the reply is rebuilt from the log record', () => {
  const log = freshLog();
  const u = crypto.randomUUID();
  QsoLog.appendRecords(log, [qso(u, { state: 'NJ', gridsquare: 'FN20', name: 'Ann' })]);
  const reply = Replay.replyFromLogRecords(QsoLog.findByUuid(log, u), { operator: 'K3SBP', cloudJournal: true });
  assert.strictEqual(reply.success, true);
  assert.strictEqual(reply.callsign, 'K1ABC');
  assert.strictEqual(reply.uuid, u);
  assert.strictEqual(reply.cloudJournal, true);
  assert.deepStrictEqual(reply.records, [{
    uuid: u, callsign: 'K1ABC', sig: 'POTA', sigInfo: 'US-0001', mySig: 'POTA', mySigInfo: 'US-1234', operator: 'K3SBP',
    frequency: '14285', band: '20m', mode: 'SSB', state: 'NJ', gridsquare: 'FN20', name: 'Ann',
  }]);
  assert.strictEqual(Replay.replyFromLogRecords([], {}), null);
});

test('main.js: log-qso claims the uuid before logging, replays a known one, remembers the reply', () => {
  const main = readSrc(path.join(__dirname, '..', 'main.js'));
  const i = main.indexOf("remoteServer.on('log-qso', async (data) => {");
  const h = main.slice(i, main.indexOf("remoteServer.on('", i + 10));
  const claim = h.indexOf('logQsoReplies.claim(');
  const log = h.indexOf('await logContact(entry');
  assert.ok(claim > 0 && claim < log, 'claim before logContact');
  assert.ok(/Replay\.replayReply\(/.test(h), 'a known uuid is answered from the book');
  assert.ok(/logQsoReplies\.remember\(/.test(h));
  assert.ok(/release\(\)/.test(h), 'the claim is released on every path');
  const save = main.slice(main.indexOf('async function saveQsoRecord(qsoData, opts) {'));
  const body = save.slice(0, save.indexOf('\n}\n'));
  assert.ok(!/existing: \[\]/.test(body), 'the save path no longer skips the uuid collision check');
});

(async () => {
  for (const run of pending) await run();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
