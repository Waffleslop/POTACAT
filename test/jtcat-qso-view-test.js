#!/usr/bin/env node
'use strict';
// Which JTCAT QSO phase an ECHOCAT client is shown (#807 follow-up).
// Since #807 a QSO enters '73' (reply) or 'cq-rr73' (CQ) when our RR73 is
// QUEUED and is logged when it starts going out. ECHOCAT phone builds up to
// 1.5.x toast "QSO Logged" on the change into either phase, so a client whose
// hello does not declare 'jtcat-qso-logged' keeps the previous phase until the
// QSO is really logged. A QSO that never logs never shows it that phase.
// Run: node test/jtcat-qso-view-test.js
const assert = require('assert');
const path = require('path');
const WebSocket = require('ws');
const { readSrc } = require('./_src');
const V = require('../lib/jtcat-qso-view');
const { RemoteServer } = require('../lib/remote-server');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); }
}

const cq = (phase, extra) => Object.assign({ mode: 'cq', call: 'W1AW', myCall: 'K3SBP', phase, report: '-07', sentReport: '-10' }, extra);
const rp = (phase, extra) => Object.assign({ mode: 'reply', call: 'W1AW', myCall: 'K3SBP', phase, report: '-07', sentReport: '-10' }, extra);

console.log('the rule (lib/jtcat-qso-view.js)');

test('the capability name is the one ECHOCAT Web declares', () => {
  assert.strictEqual(V.CAP, 'jtcat-qso-logged');
  const web = readSrc(path.join(__dirname, '..', 'renderer', 'remote.js'));
  assert.ok(web.includes("'jtcat-qso-logged'"), 'remote.js hello lists it');
  // A remote POTACAT's JTCAT window (lib/remote-bridge.js) shows the real phase too.
  const rc = readSrc(path.join(__dirname, '..', 'lib', 'remote-client.js'));
  const hello = rc.slice(rc.indexOf('capabilities: ['), rc.indexOf(']', rc.indexOf('capabilities: [')));
  assert.ok(hello.includes("'jtcat-qso-logged'"), 'remote-client.js hello lists it');
});

test('only 73 and cq-rr73 are logging phases', () => {
  assert.ok(V.isLoggingPhase('73'));
  assert.ok(V.isLoggingPhase('cq-rr73'));
  for (const p of ['idle', 'cq', 'cq-report', 'cq-r-report', 'reply', 'r+report', 'done', 'error', undefined]) {
    assert.ok(!V.isLoggingPhase(p), p);
  }
});

test('an unlogged QSO in a logging phase is held; a logged one is not', () => {
  assert.ok(V.holdsForOldClient(cq('cq-rr73')));
  assert.ok(V.holdsForOldClient(rp('73')));
  assert.ok(!V.holdsForOldClient(cq('cq-rr73', { _logged: true })));
  assert.ok(!V.holdsForOldClient(rp('73', { _logged: true })));
  assert.ok(!V.holdsForOldClient(cq('cq-report')));
  assert.ok(!V.holdsForOldClient({ phase: 'idle' }));
  assert.ok(!V.holdsForOldClient(null));
});

test('a log write that failed is not logged', () => {
  assert.ok(V.holdsForOldClient(cq('cq-rr73', { _logged: true, _logFailed: true })));
});

test('a client that declares jtcat-qso-logged always sees the real phase', () => {
  const q = cq('cq-rr73');
  assert.strictEqual(V.qsoStateFor(q, { knowsLogged: true, shown: { call: 'W1AW', phase: 'cq-report' } }), q);
});

test('an older client keeps the phase it was last shown for that call', () => {
  const out = V.qsoStateFor(cq('cq-rr73', { txMsg: 'W1AW K3SBP RR73' }), { knowsLogged: false, shown: { call: 'W1AW', phase: 'cq-report' } });
  assert.strictEqual(out.phase, 'cq-report');
  assert.strictEqual(out.call, 'W1AW');
  assert.strictEqual(out.txMsg, 'W1AW K3SBP RR73', 'everything else is the real state');
  const r = V.qsoStateFor(rp('73'), { knowsLogged: false, shown: { call: 'W1AW', phase: 'r+report' } });
  assert.strictEqual(r.phase, 'r+report');
});

test('the held copy never changes the engine QSO object', () => {
  const q = cq('cq-rr73');
  V.qsoStateFor(q, { knowsLogged: false, shown: { call: 'W1AW', phase: 'cq-report' } });
  assert.strictEqual(q.phase, 'cq-rr73');
});

test('logged: the older client gets the real phase (its toast lands at the real log)', () => {
  const q = cq('cq-rr73', { _logged: true });
  assert.strictEqual(V.qsoStateFor(q, { knowsLogged: false, shown: { call: 'W1AW', phase: 'cq-report' } }).phase, 'cq-rr73');
});

test('no remembered phase for this call: the step before the RR73 on that ladder', () => {
  assert.strictEqual(V.qsoStateFor(cq('cq-rr73'), { knowsLogged: false, shown: null }).phase, 'cq-report');
  assert.strictEqual(V.qsoStateFor(rp('73'), { knowsLogged: false, shown: { call: 'N0CALL', phase: 'reply' } }).phase, 'r+report');
  assert.strictEqual(V.qsoStateFor(cq('cq-rr73', { fd: true }), { knowsLogged: false }).phase, 'cq');
  assert.strictEqual(V.qsoStateFor(rp('73', { fd: true }), { knowsLogged: false }).phase, 'reply');
});

test('remembered phase: only non-logging phases of a QSO with a call', () => {
  let shown = null;
  shown = V.rememberShown(shown, cq('cq'));
  assert.deepStrictEqual(shown, { call: 'W1AW', phase: 'cq' });
  shown = V.rememberShown(shown, cq('cq-report'));
  assert.deepStrictEqual(shown, { call: 'W1AW', phase: 'cq-report' });
  shown = V.rememberShown(shown, cq('cq-rr73'));
  assert.deepStrictEqual(shown, { call: 'W1AW', phase: 'cq-report' }, 'held: unchanged');
  shown = V.rememberShown(shown, cq('cq-rr73', { _logged: true }));
  assert.deepStrictEqual(shown, { call: 'W1AW', phase: 'cq-report' }, 'a logging phase is never remembered');
  shown = V.rememberShown(shown, { phase: 'idle' });
  assert.strictEqual(shown, null, 'idle forgets');
  shown = V.rememberShown({ call: 'N0CALL', phase: 'reply' }, rp('73'));
  assert.strictEqual(shown, null, 'another station forgets');
});

test('done, idle and error pass through untouched for an older client', () => {
  for (const q of [cq('done'), { phase: 'idle' }, { phase: 'error', error: 'x' }]) {
    assert.strictEqual(V.qsoStateFor(q, { knowsLogged: false, shown: { call: 'W1AW', phase: 'cq-report' } }), q);
  }
});

console.log('the wire (lib/remote-server.js)');

function fakeWs(caps) {
  const ws = { readyState: WebSocket.OPEN, _authenticated: true, sent: [], _socket: { remoteAddress: '127.0.0.1' } };
  ws.send = (wire) => ws.sent.push(JSON.parse(wire));
  ws.close = () => { ws.readyState = WebSocket.CLOSED; };
  ws._clientCapabilities = caps || [];
  return ws;
}
function serverWith(...list) {
  const rs = new RemoteServer();
  rs._client = list[0];
  for (const ws of list) rs._clients.add(ws);
  return rs;
}
const phases = (ws) => ws.sent.filter((m) => m.type === 'jtcat-qso-state').map((m) => m.phase);

test('CQ side, logged at the RR73: the old phone sees cq-rr73 only after the write', () => {
  const phone = fakeWs([]);
  const web = fakeWs(['jtcat-qso-logged']);
  const rs = serverWith(phone, web);
  const q = cq('cq', { call: null });
  rs.broadcastJtcatQsoState(q);
  q.call = 'W1AW'; q.phase = 'cq-report'; rs.broadcastJtcatQsoState(q);
  q.phase = 'cq-rr73'; rs.broadcastJtcatQsoState(q);          // RR73 queued
  rs.broadcastJtcatQsoState(q);                                // re-broadcast before TX
  assert.deepStrictEqual(phases(phone), ['cq', 'cq-report', 'cq-report', 'cq-report']);
  assert.deepStrictEqual(phases(web), ['cq', 'cq-report', 'cq-rr73', 'cq-rr73']);
  q._logged = true; rs.broadcastJtcatQsoState(q);              // remoteJtcatOnDone after the write
  assert.deepStrictEqual(phases(phone).slice(-1), ['cq-rr73']);
});

test('CQ side, halted before the RR73 went out: the old phone never sees cq-rr73', () => {
  const phone = fakeWs([]);
  const rs = serverWith(phone);
  const q = cq('cq-report');
  rs.broadcastJtcatQsoState(q);
  q.phase = 'cq-rr73'; rs.broadcastJtcatQsoState(q);
  rs.broadcastJtcatQsoState({ phase: 'idle' });
  assert.deepStrictEqual(phases(phone), ['cq-report', 'cq-report', 'idle']);
});

test('reply side, our RR73 queued: the old phone sees 73 only once logged', () => {
  const phone = fakeWs([]);
  const rs = serverWith(phone);
  const q = rp('reply');
  rs.broadcastJtcatQsoState(q);
  q.phase = '73'; rs.broadcastJtcatQsoState(q);
  assert.deepStrictEqual(phases(phone), ['reply', 'reply']);
  q._logged = true; rs.broadcastJtcatQsoState(q);
  assert.deepStrictEqual(phases(phone), ['reply', 'reply', '73']);
});

test('the cache keeps the real state; a reconnecting client gets its own view', () => {
  const phone = fakeWs([]);
  const rs = serverWith(phone);
  const q = cq('cq-report');
  rs.broadcastJtcatQsoState(q);
  q.phase = 'cq-rr73'; rs.broadcastJtcatQsoState(q);
  assert.strictEqual(rs._jtcatQsoState.phase, 'cq-rr73');
  const back = fakeWs([]);
  rs._clients.add(back);
  rs._hydrateClient(back);
  assert.deepStrictEqual(phases(back), ['cq-report']);
  const web = fakeWs(['jtcat-qso-logged']);
  rs._clients.add(web);
  rs._hydrateClient(web);
  assert.deepStrictEqual(phases(web), ['cq-rr73']);
});

console.log('main.js wiring');
const main = readSrc(path.join(__dirname, '..', 'main.js'));
const fnBody = (name) => {
  const i = main.indexOf('function ' + name + '(');
  assert.ok(i >= 0, name + ' exists');
  return main.slice(i, main.indexOf('\n}\n', i));
};

test('the phone surface re-broadcasts after the log write', () => {
  const f = fnBody('remoteJtcatOnDone');
  const a = f.indexOf('await jtcatAutoLog(qso)');
  const b = f.indexOf('remoteJtcatBroadcastQso()');
  assert.ok(a >= 0 && b > a, 'await the log, then broadcast');
});

test('a failed log write marks the QSO, so an older phone is not told it was logged', () => {
  const f = fnBody('jtcatAutoLog');
  assert.ok(/const res = await jtcatWriteLog\(qsoData, relogKeyStr\);/.test(f));
  assert.ok(/q\._logFailed = true/.test(f));
});

test('the JTCAT window keeps its own channel with the real phase', () => {
  const f = fnBody('popoutBroadcastQso');
  assert.ok(/webContents\.send\('jtcat-qso-state', popoutJtcatQso \|\| \{ phase: 'idle' \}\)/.test(f));
  assert.ok(!/JtcatQsoView|qsoStateFor/.test(f));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
