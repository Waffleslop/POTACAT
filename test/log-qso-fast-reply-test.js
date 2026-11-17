#!/usr/bin/env node
'use strict';
// #732 (activation review 2026-11-17, fix 5): ECHOCAT's log-ok goes out once
// the record is on disk. It used to wait for the external loggers, QRZ
// Logbook, a QRZ lookup with no effective timeout, every respot and the SOTA
// upload, so on a weak link the phone waited tens of seconds for a QSO that
// was saved long before.
//
// lib/log-after-write.js is the rule; the source guards hold main.js to it.
// Run: node test/log-qso-fast-reply-test.js
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');

let pass = 0, fail = 0;
const pending = [];
function test(name, fn) {
  pending.push(async () => {
    try { await fn(); pass++; console.log('  ok  ' + name); }
    catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
  });
}

let LAW = null;
try { LAW = require('../lib/log-after-write'); } catch { LAW = null; }
const main = readSrc(path.join(__dirname, '..', 'main.js'));
function fnBody(sig) {
  const i = main.indexOf(sig);
  assert.ok(i >= 0, `${sig} not found`);
  const s = main.slice(i);
  return s.slice(0, s.indexOf('\n}\n'));
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

test('lib/log-after-write.js exists', () => assert.ok(LAW));

test('the reply resolves at the write, not after the slow steps', async () => {
  let slowDone = false;
  const t0 = Date.now();
  const { result, after } = await LAW.untilWritten(async (onWritten) => {
    onWritten({ uuid: 'u1' });
    await delay(300); // forwarders, QRZ lookup, respots, SOTA
    slowDone = true;
    return { success: true, resposted: true };
  });
  assert.ok(Date.now() - t0 < 200, 'resolved before the slow steps');
  assert.strictEqual(slowDone, false);
  assert.deepStrictEqual(result, { success: true, uuid: 'u1' });
  const fin = await after;
  assert.strictEqual(slowDone, true);
  assert.strictEqual(fin.resposted, true, 'the respot outcome still arrives');
});

test('a save that ends without writing answers with its own result', async () => {
  const { result } = await LAW.untilWritten(async () => ({ success: false, error: 'Duplicate save suppressed' }));
  assert.deepStrictEqual(result, { success: false, error: 'Duplicate save suppressed' });
});

test('a throw before the write is still a failure; after the write it is not', async () => {
  await assert.rejects(LAW.untilWritten(async () => { throw new Error('disk full'); }), /disk full/);
  const { result, after } = await LAW.untilWritten(async (w) => { w({}); await delay(5); throw new Error('cluster gone'); });
  assert.strictEqual(result.success, true);
  const fin = await after;
  assert.strictEqual(fin.success, true);
  assert.strictEqual(fin.afterError, 'cluster gone');
});

test('respot outcome: merged over the records, follow-up only when there is something to say', () => {
  assert.deepStrictEqual(LAW.mergeAfterResults([{ success: true }, { success: true, wwffRespotError: 'timeout' }]), { resposted: false, respotError: 'timeout' });
  assert.deepStrictEqual(LAW.mergeAfterResults([{ success: true, resposted: true }]), { resposted: true, respotError: '' });
  const reply = { success: true, callsign: 'K1ABC', reqId: 'r1', records: [{ uuid: 'u1' }], resposted: false, respotError: '' };
  assert.strictEqual(LAW.respotFollowUp(reply, { resposted: false, respotError: '' }), null);
  const f = LAW.respotFollowUp(reply, { resposted: false, respotError: 'POTA said no' });
  assert.deepStrictEqual(f, { ...reply, followUp: true, resposted: false, respotError: 'POTA said no' });
});

test('saveQsoRecord says "written" right after the disk write, before the forwarders', () => {
  const body = fnBody('async function saveQsoRecord(qsoData, opts) {');
  const write = body.indexOf('QsoLog.appendRecords(logPath');
  const signal = body.indexOf('opts.onWritten(');
  const fwd = body.indexOf('LoggerForward.forwardToLoggers(');
  assert.ok(write > 0 && signal > write && fwd > signal, 'appendRecords, then onWritten, then the forwarders');
  // The phone's logbook push is log state, not network: it goes before the forwarders too.
  const push = body.indexOf('remoteServer.sendQsoAdded(');
  assert.ok(push > write && push < fwd, 'qso-added before the forwarders');
});

test('logContact waits only for the write when asked (opts.replyOnWrite)', () => {
  const body = fnBody('async function logContact(entry, opts) {');
  assert.ok(/LogAfterWrite\.untilWritten\(/.test(body));
  assert.ok(/opts\.replyOnWrite/.test(body));
  assert.ok(/LogAfterWrite\.mergeAfterResults\b/.test(body), 'the respot outcome rides back on result.after');
});

test('log-qso replies before the slow steps and sends the respot outcome as a follow-up log-ok', () => {
  const i = main.indexOf("remoteServer.on('log-qso', async (data) => {");
  const h = main.slice(i, main.indexOf("remoteServer.on('", i + 10));
  assert.ok(/logContact\(entry, \{ origin: 'ws-log-qso', replyOnWrite: true \}\)/.test(h));
  const reply = h.indexOf('remoteServer.sendLogResult(reply)');
  const follow = h.indexOf('LogAfterWrite.respotFollowUp(');
  assert.ok(reply > 0 && follow > reply, 'reply first, follow-up after');
  assert.ok(!/await result\.after/.test(h), 'the handler never waits for the slow steps');
});

test('ECHOCAT Web shows a follow-up as a toast only, never closing the form', () => {
  const web = readSrc(path.join(__dirname, '..', 'renderer', 'remote.js'));
  const c = web.slice(web.indexOf("case 'log-ok':"), web.indexOf("case 'activator-state':"));
  const f = c.indexOf('msg.followUp');
  assert.ok(f > 0 && f < c.indexOf('closeLogSheet()'), 'followUp handled before the form is closed');
});

(async () => {
  for (const run of pending) await run();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
