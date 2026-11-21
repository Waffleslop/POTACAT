#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';
const { readSrc } = require('./_src');
//
// JTCAT regression suite — drives the QSO state machine, decode
// classifier, and FT8 engine mode-handling against synthetic decode
// fixtures. No live radio, no Electron.
//
// Run:  node test/jtcat-test.js
//
// Match-target: WSJT-X v2.6+ QSO sequencing. Each test documents the
// expected behavior and why; deliberate POTACAT-vs-WSJT-X departures
// are flagged.
// =====================================================================

const sm = require('../lib/jtcat-state-machine');
const path = require('path');
const fs = require('fs');

let pass = 0;
let fail = 0;
const failures = [];

function assert(cond, msg, ctx) {
  if (cond) {
    pass++;
    return;
  }
  fail++;
  failures.push({ msg, ctx });
  console.log('  ✗ ' + msg);
  if (ctx) console.log('      context:', JSON.stringify(ctx));
}
function assertEq(actual, expected, msg) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assert(ok, msg + ` (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}
function pass_(msg) {
  pass++;
}
function section(name) {
  console.log('\n=== ' + name + ' ===');
}

// ---------- Mocks ----------
function makeEngine() {
  return {
    _txEnabled: false,
    _txActive: false,
    _lastTxMsg: null,
    _lastSlot: null,
    _lastRxFreq: null,
    _tryImmediateCalled: 0,
    _txCompleteCalled: 0,
    setTxMessage(m) { this._lastTxMsg = m; },
    setTxSlot(s) { this._lastSlot = s; },
    setRxFreq(f) { this._lastRxFreq = f; },
    tryImmediateTx() { this._tryImmediateCalled++; },
    txComplete() { this._txCompleteCalled++; this._txActive = false; },
  };
}

function decode(text, opts) {
  opts = opts || {};
  return {
    text,
    df: opts.df || 1500,
    db: opts.db == null ? -10 : opts.db,
    dt: opts.dt || 0,
    slot: opts.slot || 'even',
  };
}

// Drive the state machine and capture what setTxMsg saw + whether onDone fired.
function drive(qIn, results, engine, deps) {
  let lastTx = null;
  let doneCount = 0;
  sm.advanceJtcatQso(
    qIn,
    results,
    (m) => { lastTx = m; },
    () => { doneCount++; },
    Object.assign({ engine, log: () => {} }, deps || {}),
  );
  return { q: qIn, lastTx, doneCount };
}

// ============================================================
// Group 1: REPLY-mode state transitions
// ============================================================
section('REPLY mode — happy paths');
{
  // Setup: we double-clicked W1ABC's CQ, sent "W1ABC K3SBP FN20"
  const baseQ = () => ({
    mode: 'reply',
    phase: 'reply',
    call: 'W1ABC',
    grid: 'FN42',
    txMsg: 'W1ABC K3SBP FN20',
    report: null,
    sentReport: null,
    myCall: 'K3SBP',
    myGrid: 'FN20',
    txRetries: 0,
  });

  // Step 2 → 3: they sent us a plain signal report → we send R+ourReport
  {
    const eng = makeEngine();
    const r = drive(baseQ(), [decode('K3SBP W1ABC -05', { db: -8 })], eng);
    assertEq(r.q.phase, 'r+report', 'reply → r+report on plain signal report');
    assertEq(r.lastTx, 'W1ABC K3SBP R-08', 'TX builds R-prefixed report with OUR SNR rounding');
    assertEq(r.q.report, '-05', 'captured their report');
    assertEq(r.q.sentReport, '-08', 'set our sent report');
    assertEq(r.doneCount, 0, 'no log yet (reports not both exchanged)');
  }

  // Step 3 → 5: they sent R+report straight away → advance to 73 and LOG
  {
    const eng = makeEngine();
    const r = drive(baseQ(), [decode('K3SBP W1ABC R-05', { db: -8 })], eng);
    assertEq(r.q.phase, '73', 'reply → 73 (skip r+report) when they sent R+report');
    assertEq(r.lastTx, 'W1ABC K3SBP RR73', 'TX is RR73 since their R+report confirmed');
    assertEq(r.doneCount, 0, 'not logged at their R+report: it logs when our RR73 goes out (#807)');
    assert(sm.txLogsQso(r.q, 'W1ABC K3SBP RR73') === true, 'our RR73 going on the air logs it');
  }

  // Step 4 → 5: in r+report, they confirmed with RR73 → 73 and LOG
  {
    const q = baseQ();
    q.phase = 'r+report';
    q.report = '-05';
    q.sentReport = '-08';
    q.txMsg = 'W1ABC K3SBP R-08';
    const eng = makeEngine();
    const r = drive(q, [decode('K3SBP W1ABC RR73')], eng);
    assertEq(r.q.phase, '73', 'r+report → 73 on RR73');
    assertEq(r.lastTx, 'W1ABC K3SBP 73', 'TX is courtesy 73');
    assertEq(r.doneCount, 1, 'logged at RR73');
  }

  // Variants for the RR73/RRR/73 trigger
  for (const trig of ['RR73', 'RRR', '73']) {
    const q = baseQ();
    q.phase = 'r+report';
    q.txMsg = 'W1ABC K3SBP R-08';
    const t = (trig === '73') ? 'K3SBP W1ABC 73' : 'K3SBP W1ABC ' + trig;
    const r = drive(q, [decode(t)], makeEngine());
    assertEq(r.q.phase, '73', `r+report → 73 on ${trig}`);
  }

  // Courtesy 73 cycle: the 73 has not gone out yet → wait
  {
    const q = baseQ();
    q.phase = '73';
    q.txMsg = 'W1ABC K3SBP 73';
    const eng = makeEngine();
    const r = drive(q, [], eng);
    assertEq(r.q.phase, '73', 'phase=73 stays in 73 until the 73 has been transmitted (courtesy wait)');
    assertEq(r.q._courtesyWaits, 1, 'one courtesy wait counted');
  }
  // The 73 went out (main stamps _txSentMsg at tx-start): terminate
  {
    const q = baseQ();
    q.phase = '73';
    q.txMsg = 'W1ABC K3SBP 73';
    q._txSentMsg = q.txMsg;
    const eng = makeEngine();
    const r = drive(q, [], eng);
    assertEq(r.q.phase, 'done', 'phase=73 second cycle → done');
    assertEq(eng._txEnabled, false, 'TX disabled on done');
    assertEq(eng._lastTxMsg, '', 'engine TX message cleared');
    assertEq(eng._lastSlot, 'auto', 'slot returned to auto');
  }
}

section('REPLY mode — no-advance paths');
{
  const baseQ = () => ({
    mode: 'reply',
    phase: 'reply',
    call: 'W1ABC',
    grid: 'FN42',
    txMsg: 'W1ABC K3SBP FN20',
    report: null,
    sentReport: null,
    myCall: 'K3SBP',
    myGrid: 'FN20',
    txRetries: 0,
  });

  // No decode of us+them → no advance. The "W1ABC W9ABC RR73" decode is
  // W9ABC sending RR73 to W1ABC — W1ABC is the recipient, not the sender,
  // so it doesn't count as "they picked someone else". Phase stays reply.
  {
    const r = drive(baseQ(), [decode('CQ N4XYZ EM12'), decode('W1ABC W9ABC RR73')], makeEngine());
    assertEq(r.q.phase, 'reply', 'unrelated third-party decodes do NOT trigger waiting');
  }

  // They directed at us but no report yet (only grid in reply slot — shouldn't happen but defensive)
  {
    const r = drive(baseQ(), [decode('K3SBP W1ABC')], makeEngine());
    assertEq(r.q.phase, 'reply', 'no signal report yet → no advance');
  }

  // Reply mode with no matching decode at all
  {
    const r = drive(baseQ(), [decode('CQ N0AAA EM12')], makeEngine());
    assertEq(r.q.phase, 'reply', 'no matching decode → still reply');
  }
}

section('REPLY mode — "they picked someone else" → keep calling (WSJT-X parity)');
{
  // WSJT-X parity: a busy station is NOT a reason to stop — keep calling
  // them (tail-end) regardless of where their reply to the other op lands.
  // WSJT-X has no frequency-proximity auto-halt. The v1.5.22 'waiting' hold
  // was removed 2026-06-12, and the 50 Hz "QRM guard" auto-halt (e4259ce,
  // mis-attributed to WSJT-X) was removed 2026-06-29 (Casey: WSJT-X wanted).
  const baseQ = () => ({
    mode: 'reply',
    phase: 'reply',
    call: 'W1ABC',
    grid: 'FN42',
    txMsg: 'W1ABC K3SBP FN20',
    report: null,
    sentReport: null,
    myCall: 'K3SBP',
    myGrid: 'FN20',
    txRetries: 0,
  });

  // W1ABC replied to N4XYZ on a different frequency → keep calling
  {
    const eng = makeEngine();
    eng._txEnabled = true;
    eng._txFreq = 1500;
    const r = drive(baseQ(), [decode('N4XYZ W1ABC -05', { df: 800 })], eng);
    assertEq(r.q.phase, 'reply', 'busy elsewhere on the band → still reply (keep calling)');
    assertEq(eng._txEnabled, true, 'TX stays enabled');
    assertEq(r.lastTx, null, 'TX message untouched (keeps repeating the reply)');
    assert(!r.q._heardThisCycle, 'busy decode does NOT reset the retry counter (bounded tail-ending)');
  }

  // Busy cycles count toward the cap → ceiling aborts eventually
  {
    const out = sm.decideRetryOutcome({ phase: 'reply', txRetries: 11, maxCq: 99, maxQso: 12, runMode: false, closeoutEligible: false });
    assertEq(out.action, 'abort', 'busy cycles hit the per-phase cap → abort');
  }

  // Their reply to the other op lands ON our exact TX offset → STILL keep
  // calling (this is the HI4WWA/KK4RXE case from K3SBP's 2026-06-29 report;
  // the old QRM guard wrongly aborted here).
  {
    const eng = makeEngine();
    eng._txEnabled = true;
    eng._txFreq = 1500;
    const r = drive(baseQ(), [decode('N4XYZ W1ABC -05', { df: 1500 })], eng);
    assertEq(r.q.phase, 'reply', 'busy on our exact TX offset → keep calling (no halt)');
    assertEq(eng._txEnabled, true, 'TX stays enabled — no QRM auto-halt');
    assertEq(r.q.error, undefined, 'no abort error set');
  }

  // Mid-QSO, a busy decode on our freq is likewise never a reason to stop.
  {
    const q = baseQ();
    q.phase = 'r+report';
    q.txMsg = 'W1ABC K3SBP R-07';
    const eng = makeEngine();
    eng._txEnabled = true;
    eng._txFreq = 1500;
    const r = drive(q, [decode('N4XYZ W1ABC RR73', { df: 1500 })], eng);
    assertEq(r.q.phase, 'r+report', 'mid-QSO busy decode on our freq → keep repeating');
    assertEq(eng._txEnabled, true, 'TX stays enabled mid-QSO');
  }

  // Same-cycle precedence: a direct reply to us wins over a busy decode
  {
    const eng = makeEngine();
    eng._txEnabled = true;
    eng._txFreq = 1500;
    const r = drive(baseQ(), [
      decode('N4XYZ W1ABC RR73', { df: 1500 }),  // stale busy decode
      decode('K3SBP W1ABC -05', { df: 800 }),    // …but they also answered US
    ], eng);
    assertEq(r.q.phase, 'r+report', 'direct reply to us beats a same-cycle busy decode');
  }

  // No engine TX freq available → guard safely skipped, keep calling
  {
    const eng = makeEngine(); // no _txFreq
    eng._txEnabled = true;
    const r = drive(baseQ(), [decode('N4XYZ W1ABC -05', { df: 1500 })], eng);
    assertEq(r.q.phase, 'reply', 'unknown TX offset → no QRM guard, keep calling');
  }
}

// ============================================================
// Group 1d: Stalled-QSO give-up — closeout + messages (KQ4MHD)
// ============================================================
section('Stalled QSO — canCloseoutQso eligibility matrix');
{
  const eligible = () => ({
    mode: 'reply', phase: 'r+report', call: 'W1ABC', myCall: 'K3SBP',
    report: '-05', sentReport: '-08', txMsg: 'W1ABC K3SBP R-08', txRetries: 0,
  });
  assert(sm.canCloseoutQso(eligible()) === true, 'reply/r+report with both reports → eligible');
  assert(sm.canCloseoutQso(Object.assign(eligible(), { hound: true })) === false, 'hound excluded — fox never acked, fox will not log');
  assert(sm.canCloseoutQso(Object.assign(eligible(), { fd: true })) === false, 'FD excluded');
  assert(sm.canCloseoutQso(Object.assign(eligible(), { report: null })) === false, 'no received report → not eligible');
  assert(sm.canCloseoutQso(Object.assign(eligible(), { sentReport: null })) === false, 'no sent report → not eligible');
  assert(sm.canCloseoutQso(Object.assign(eligible(), { phase: 'reply' })) === false, 'reply phase (no exchange yet) → not eligible');
  assert(sm.canCloseoutQso({ mode: 'cq', phase: 'cq-report', call: 'A1BCD', myCall: 'K3SBP', report: null, sentReport: '-06' }) === false,
    'CQ-side cq-report → not eligible (their report never received; RR73 would falsely ack)');
  assert(sm.canCloseoutQso(null) === false, 'null QSO → not eligible');
}

section('Skip to the 73 — sendFinal73 queues the 73; the log waits for it to go out (#807)');
{
  const mkQ = () => ({
    mode: 'reply', phase: 'r+report', call: 'W1ABC', myCall: 'K3SBP',
    report: '-05', sentReport: '-08', txMsg: 'W1ABC K3SBP R-08', txRetries: 0,
  });
  {
    const q = mkQ();
    let lastTx = null;
    const ok = sm.sendFinal73(q, (m) => { lastTx = m; }, { log: () => {} });
    assertEq(ok, true, 'Skip to the 73 accepted');
    assertEq(q.phase, '73', 'phase moves to the 73 leg');
    assertEq(lastTx, 'W1ABC K3SBP 73', 'the 73 is queued');
    assert(!q._logged, 'not logged when the 73 is only queued');
    assert(sm.txLogsQso(q, lastTx) === true, 'logged when the 73 goes on the air (WSJT-X: choosing Tx5)');
  }
  {
    const q = Object.assign(mkQ(), { hound: true });
    let lastTx = null;
    const ok = sm.sendFinal73(q, (m) => { lastTx = m; }, {});
    assertEq(ok, false, 'hound refused (hounds send no 73)');
    assertEq(q.phase, 'r+report', 'phase unchanged on refusal');
    assertEq(lastTx, null, 'no TX queued on refusal');
  }
  // Hands off to the EXISTING courtesy-73 leg, which tears down.
  {
    const q = mkQ();
    sm.sendFinal73(q, () => {}, {});
    const eng = makeEngine();
    eng._txEnabled = true;
    let r = drive(q, [], eng);
    assertEq(r.q.phase, '73', 'the 73 leg waits until the 73 has gone out');
    assertEq(r.q._courtesyWaits, 1, 'one courtesy wait counted');
    q._txSentMsg = q.txMsg; // the 73 went out
    r = drive(q, [], eng);
    assertEq(r.q.phase, 'done', 'cycle after the 73 went out → done');
    assertEq(r.doneCount, 0, 'the state machine itself never logs the Skip 73 (the TX-start hook does)');
    assertEq(eng._txEnabled, false, 'engine TX disabled by courtesy teardown');
    assertEq(eng._lastTxMsg, '', 'TX message cleared');
    assertEq(eng._lastSlot, 'auto', 'TX slot back to auto');
  }
  // Nonstandard call → same bracket rules as a normal 73 leg.
  {
    const JtcatParser = require('../renderer/jtcat-parser');
    const q = Object.assign(mkQ(), { call: 'PJ4/K1ABC' });
    let lastTx = null;
    sm.sendFinal73(q, (m) => { lastTx = m; }, {});
    assertEq(lastTx, JtcatParser.formatDirectedMsg('PJ4/K1ABC', 'K3SBP', '73'),
      'nonstandard call routes through formatDirectedMsg bracket rules');
    assert(sm.txLogsQso(q, lastTx) === true, 'the bracketed 73 is recognised as our 73');
  }
  // Both Skip handlers (window and ECHOCAT) send the 73 through sendFinal73
  // and never log on the press itself.
  const main = readSrc(path.join(__dirname, '..', 'main.js'));
  for (const h of ["remoteServer.on('jtcat-skip-phase'", "ipcMain.on('jtcat-popout-skip-phase'"]) {
    const at = main.indexOf(h);
    const body = main.slice(at, main.indexOf('\n  });', at));
    assert(body.includes('_jtcatStateMachine.sendFinal73('), h + ' sends the 73 through sendFinal73');
    assert(!body.includes('jtcatAutoLog('), h + ' does not log on the press; the 73 going out logs it');
    assert(!body.includes('closeoutStalledQso'), h + ' no longer uses the old closeout');
    assert(body.includes('jtcatTakeUnconfirmed('), h + ' can finish a QSO the retry cap stopped');
  }
}

section('Stalled QSO — retry cap with R+report sent and no RR73: not logged, no 73 (#807)');
{
  // We answered W1ABC's CQ; they sent a report; we advanced to r+report.
  const q = {
    mode: 'reply', phase: 'reply', call: 'W1ABC', grid: 'FN42',
    txMsg: 'W1ABC K3SBP FN20', report: null, sentReport: null,
    myCall: 'K3SBP', myGrid: 'FN20', txRetries: 0,
  };
  const eng = makeEngine();
  eng._txEnabled = true;
  drive(q, [decode('K3SBP W1ABC -05', { db: -8 })], eng);
  assertEq(q.phase, 'r+report', 'setup: reached r+report');
  // The partner repeats their report every cycle (HEARD each time) but never
  // sends RR73. Apply the policy per cycle as jtcatHandleRetryStall does.
  let out = null;
  let cycles = 0;
  let done = 0;
  let lastTx = q.txMsg;
  for (let i = 0; i < 40 && q.phase === 'r+report'; i++) {
    q._heardThisCycle = false;
    const before = q.phase;
    sm.advanceJtcatQso(q, [decode('K3SBP W1ABC -05')], (m) => { lastTx = m; }, () => { done++; }, { engine: eng, log: () => {} });
    if (q.phase !== before) break;
    cycles++;
    out = sm.decideRetryOutcome({
      phase: q.phase, txRetries: q.txRetries,
      maxCq: 15, maxQso: 12, runMode: false,
      closeoutEligible: sm.canCloseoutQso(q),
    });
    q.txRetries = out.retries;
    if (out.action !== 'continue') break;
  }
  assertEq(cycles, 12, 'cap trips on the 12th stuck cycle (default jtcatMaxQsoAttempts)');
  assertEq(out.action, 'abort', 'the cap ends the QSO the same as the other abort paths');
  assertEq(out.unconfirmed, true, 'flagged: reports both ways, their RR73 never came');
  assertEq(done, 0, 'not logged');
  assertEq(lastTx, 'W1ABC K3SBP R-08', 'no 73 queued: the last TX is still our R-report');
  assertEq(sm.giveUpMessage({ kind: 'unconfirmed', call: 'W1ABC', max: 12 }),
    'Not logged: W1ABC never sent RR73. Press Send 73 to log it.', 'operator notice');
  // main.js: the stall handler never sends a 73 and never logs.
  const main = readSrc(path.join(__dirname, '..', 'main.js'));
  const at = main.indexOf('function jtcatHandleRetryStall(');
  const body = main.slice(at, main.indexOf('\n}\n', at));
  assert(!body.includes('sendFinal73') && !body.includes('closeoutStalledQso'), 'retry cap sends no 73');
  assert(!/o\.onDone\(/.test(body), 'retry cap does not log');
  assert(body.includes("kind: 'unconfirmed'"), 'retry cap shows the not-logged notice');
  assert(body.includes('jtcatStashUnconfirmed('), 'retry cap keeps the QSO for a later Skip to the 73');
  assert(body.includes('send73: !!outcome.unconfirmed'), 'the notice offers Send 73');
  // The window and ECHOCAT Web show a Send 73 button that sends the stopped QSO's 73.
  const pop = readSrc(path.join(__dirname, '..', 'renderer', 'jtcat-popout.js'));
  assert(/if \(data\.send73\)[\s\S]{0,300}'Send 73'[\s\S]{0,200}window\.api\.jtcatSkipPhase\(\{ unconfirmed: true \}\)/.test(pop), 'JTCAT window: Send 73 button on the notice');
  const web = readSrc(path.join(__dirname, '..', 'renderer', 'remote.js'));
  assert(/if \(msg\.send73\)[\s\S]{0,400}'Send 73'[\s\S]{0,200}type: 'jtcat-skip-phase', unconfirmed: true/.test(web), 'ECHOCAT Web: Send 73 button on the notice');
  // The tries help text says the same rule: the cap never logs or sends a 73 by itself.
  const popHtml = readSrc(path.join(__dirname, '..', 'renderer', 'jtcat-popout.html'));
  assert(!/QSO is logged and a final 73 is sent/.test(popHtml), 'tries help no longer promises a log and a 73 at the cap');
  assert(/logged only when a 73 is sent or received/.test(popHtml), 'tries help states the 73 rule');
}

section('Logging rule — only when our RR73/RRR/73 goes out or theirs arrives (#807)');
{
  const cqQ = () => ({
    mode: 'cq', phase: 'cq-report', call: 'A1BCD', grid: 'AB20',
    txMsg: 'A1BCD K3SBP -06', report: null, sentReport: '-06',
    myCall: 'K3SBP', myGrid: 'FN20', txRetries: 0,
  });
  // CQ side: their R+report queues our RR73; the log waits for it to go out.
  {
    const q = cqQ();
    const r = drive(q, [decode('K3SBP A1BCD R-12')], makeEngine());
    assertEq(q.phase, 'cq-rr73', 'CQ side: their R+report → RR73 leg');
    assertEq(r.lastTx, 'A1BCD K3SBP RR73', 'CQ side: RR73 queued');
    assertEq(r.doneCount, 0, 'CQ side: NOT logged at their R+report decode');
    assert(sm.txLogsQso(q, 'A1BCD K3SBP -06') === false, 'CQ side: our report going out again does not log');
    assert(sm.txLogsQso(q, 'A1BCD K3SBP RR73') === true, 'CQ side: logs when our RR73 starts going out');
  }
  // Halting before the RR73 goes out: never logged.
  {
    const q = cqQ();
    let done = 0;
    const eng = makeEngine();
    const step = (res) => sm.advanceJtcatQso(q, res, () => {}, () => { done++; }, { engine: eng, log: () => {} });
    step([decode('K3SBP A1BCD R-12')]);
    for (let i = 0; i <= sm.COURTESY_MAX_WAIT_CYCLES && q.phase !== 'done'; i++) step([]);
    assertEq(q.phase, 'done', 'the RR73 leg closes when the RR73 never went out');
    assertEq(done, 0, 'halted before the RR73 went out: not logged');
  }
  // Reply side: their RR73 / RRR / 73 after our R+report logs on receipt,
  // and our 73 going out afterwards does not log it twice.
  for (const ack of ['RR73', 'RRR', '73']) {
    const q = {
      mode: 'reply', phase: 'r+report', call: 'W1ABC', myCall: 'K3SBP',
      report: '-05', sentReport: '-08', txMsg: 'W1ABC K3SBP R-08', txRetries: 0,
    };
    const r = drive(q, [decode('K3SBP W1ABC ' + ack)], makeEngine());
    assertEq(r.doneCount, 1, `reply side: logged on their ${ack}`);
    assertEq(r.lastTx, 'W1ABC K3SBP 73', `reply side: our 73 queued after their ${ack}`);
    q._logged = true; // what jtcatAutoLog does
    assert(sm.txLogsQso(q, 'W1ABC K3SBP 73') === false, `reply side: our 73 after their ${ack} is not a second log`);
  }
  // Reply side, their R+report (they took our report-first opener): we send
  // RR73 and log when it goes out.
  {
    const q = {
      mode: 'reply', phase: 'reply', call: 'W1ABC', myCall: 'K3SBP',
      report: null, sentReport: '-07', txMsg: 'W1ABC K3SBP -07', txRetries: 0,
    };
    const r = drive(q, [decode('K3SBP W1ABC R-12')], makeEngine());
    assertEq(r.lastTx, 'W1ABC K3SBP RR73', 'reply side: RR73 queued on their R+report');
    assertEq(r.doneCount, 0, 'reply side: their R+report alone does not log');
    assert(sm.txLogsQso(q, 'W1ABC K3SBP RR73') === true, 'reply side: our RR73 going out logs it');
  }
  // No double log: our RR73 went out (logged), then their 73 arrives.
  {
    const q = cqQ();
    drive(q, [decode('K3SBP A1BCD R-12')], makeEngine());
    assert(sm.txLogsQso(q, q.txMsg) === true, 'RR73 on the air: log');
    q._logged = true; q._txSentMsg = q.txMsg;
    const r = drive(q, [decode('K3SBP A1BCD 73')], makeEngine());
    assertEq(r.doneCount, 0, 'their 73 after our RR73 is not a second log');
    assert(sm.txLogsQso(q, q.txMsg) === false, 'a repeat of the RR73 is not a second log');
  }
  // What counts as "our 73".
  {
    const q = Object.assign(cqQ(), { phase: 'cq-rr73', report: '-12', txMsg: 'A1BCD K3SBP RR73' });
    assert(sm.txLogsQso(q, 'A1BCD K3SBP RRR') === true, 'RRR is a 73-family message');
    assert(sm.txLogsQso(q, 'A1BCD K3SBP 73') === true, '73 is a 73-family message');
    assert(sm.txLogsQso(q, 'W9XYZ K3SBP RR73') === false, 'a 73 to another station does not log this QSO');
    assert(sm.txLogsQso(q, 'A1BCD K3SBP R-06') === false, 'an R-report is not a 73');
    assert(sm.txLogsQso(q, 'CQ K3SBP FN20') === false, 'a CQ is not a 73');
    assert(sm.txLogsQso(Object.assign(q, { hound: true }), 'A1BCD K3SBP RR73') === false, 'a hound never logs on its own TX');
    assert(sm.txLogsQso(null, 'A1BCD K3SBP RR73') === false, 'no QSO: no log');
    assert(sm.txLogsQso({ mode: 'cq', phase: 'cq-rr73', call: 'A1BCD', myCall: 'K3SBP', report: null, sentReport: null },
      'A1BCD K3SBP RR73') === false, 'no report either way: nothing to log');
    const fd = { mode: 'reply', phase: '73', call: 'W1ABC', myCall: 'K3SBP', fd: true, theirExch: '6A WI' };
    assert(sm.txLogsQso(fd, 'W1ABC K3SBP RR73') === true, 'Field Day S&P: our RR73 with their exchange in hand logs');
    assert(sm.txLogsQso(Object.assign({}, fd, { theirExch: '' }), 'W1ABC K3SBP RR73') === false, 'Field Day with no exchange: no log');
  }
  // main.js wiring: the TX-start hook logs; a click on their R-report no
  // longer logs before our RR73 has gone out; supersede follows the rule.
  {
    const main = readSrc(path.join(__dirname, '..', 'main.js'));
    const at = main.indexOf('function jtcatNoteTxSent(');
    const hook = main.slice(at, main.indexOf('\n}\n', at));
    assert(hook.includes('_jtcatStateMachine.txLogsQso('), 'tx-start dispatch asks txLogsQso');
    assert(hook.includes('popoutJtcatOnDone(') && hook.includes('remoteJtcatOnDone('), 'tx-start logs through each surface\'s own log path (window keeps the Log QSO prompt)');
    let from = 0; let n = 0;
    for (;;) {
      const i = main.indexOf("nextStep === 'send-rr73'", from);
      if (i < 0) break;
      const j = main.indexOf("nextStep === 'send-r-report'", i);
      const branch = main.slice(i, j);
      assert(!branch.includes('jtcatAutoLog('), 'send-rr73 click does not log before the RR73 goes out (' + (++n) + ')');
      from = j;
    }
    assertEq(n, 2, 'both reply handlers (window and ECHOCAT) checked');
    assert(sm.replaceLogsQso({ call: 'W1AW', mode: 'cq', phase: 'cq-rr73', report: '-08', sentReport: '-05', txMsg: 'W1AW K3SBP RR73' }, 'K1ABC') === false,
      'clicking away before our RR73 went out does not log');
  }
}

section('Stalled QSO — giveUpMessage flavors');
{
  assertEq(sm.giveUpMessage({ kind: 'unconfirmed', call: 'W1ABC', max: 12 }),
    'Not logged: W1ABC never sent RR73. Press Send 73 to log it.', 'unconfirmed notice');
  assertEq(sm.giveUpMessage({ kind: 'unconfirmed', call: 'W1ABC', max: 12, run: true }),
    'Not logged: W1ABC never sent RR73. Calling CQ again.', 'unconfirmed notice in Run');
  assertEq(sm.giveUpMessage({ kind: 'abort', phase: 'cq', call: null, max: 15 }),
    'CQ: no answer after 15 calls — TX stopped.', 'cq abort');
  assertEq(sm.giveUpMessage({ kind: 'abort', phase: 'r+report', call: 'KH1/KH7Z', hound: true, max: 12 }),
    'Fox KH1/KH7Z never confirmed after 12 tries — TX stopped, not logged.', 'hound abort');
  assertEq(sm.giveUpMessage({ kind: 'abort', phase: 'cq-report', call: 'A1BCD', heard: true, max: 12 }),
    'QSO with A1BCD: gave up after 12 tries — exchange never completed. TX stopped, not logged.', 'heard-but-stuck abort');
  assertEq(sm.giveUpMessage({ kind: 'abort', phase: 'reply', call: 'W1ABC', heard: false, max: 12 }),
    'QSO with W1ABC: gave up after 12 tries — no reply heard. TX stopped, not logged.', 'silent abort');
}

// ============================================================
// Group 2: CQ-mode state transitions
// ============================================================
section('Skip — a station that never answered is abandoned, not advanced (KB2UXB)');
{
  const q = (o) => Object.assign({ mode: 'reply', phase: 'reply', call: 'AA5SG', myCall: 'KB2UXB', report: null, sentReport: null }, o);
  assert(sm.skipAbandonsQso(q()) === true, 'reply with no report from them → abandon');
  assert(sm.skipAbandonsQso(q({ phase: 'r+report' })) === true, 'r+report reached only by Skip, still no report → abandon');
  assert(sm.skipAbandonsQso(q({ sentReport: '-12' })) === true, 'Skip Grid sent our report; theirs never came → abandon');
  assert(sm.skipAbandonsQso(q({ report: '-07' })) === false, 'their report in hand → Skip advances as before');
  assert(sm.skipAbandonsQso(q({ phase: 'r+report', report: '-07', sentReport: '-10' })) === false, 'reports both ways → W8ATE closeout keeps working');
  assert(sm.skipAbandonsQso(q({ fd: true })) === false, 'Field Day keeps its own ladder');
  assert(sm.skipAbandonsQso(q({ mode: 'cq', phase: 'cq' })) === false, 'CQ side unchanged');
  const main = readSrc(path.join(__dirname, '..', 'main.js'));
  for (const h of ["remoteServer.on('jtcat-skip-phase'", "ipcMain.on('jtcat-popout-skip-phase'"]) {
    const at = main.indexOf(h);
    const body = main.slice(at, main.indexOf('\n  });', at)); // the whole handler
    assert(body.includes('_jtcatStateMachine.skipAbandonsQso(q)'), h + ' asks skipAbandonsQso before advancing');
    assert(body.indexOf('skipAbandonsQso') < body.indexOf("'R' + rpt"), h + ' abandons before the R-report advance');
  }
  const hunt = main.slice(main.indexOf("console.log(`[JTCAT Auto-CQ] Responding to"), main.indexOf("console.log(`[JTCAT Auto-CQ] Responding to") + 2500);
  assert(hunt.includes('settings.jtcatSkipTx1'), 'Hunt reads Skip Grid');
  assert(hunt.includes('jtcatDirectedMsg(best.call, myCall, huntRpt || myGrid)'), 'Hunt sends a report when Skip Grid is on');
  assert(hunt.includes('sentReport: huntRpt,'), 'Hunt records the report it sent');
}

section('CQ mode — happy path');
{
  const baseQ = () => ({
    mode: 'cq',
    phase: 'cq',
    call: null,
    grid: null,
    txMsg: 'CQ K3SBP FN20',
    report: null,
    sentReport: null,
    myCall: 'K3SBP',
    myGrid: 'FN20',
    txRetries: 0,
  });

  // Someone answers our CQ with their grid
  {
    const eng = makeEngine();
    const r = drive(baseQ(), [decode('K3SBP A1BCD AB20', { db: -6, df: 1234 })], eng);
    assertEq(r.q.phase, 'cq-report', 'cq → cq-report on grid reply');
    assertEq(r.q.call, 'A1BCD', 'captured their call');
    assertEq(r.q.grid, 'AB20', 'captured their grid');
    assertEq(r.q.sentReport, '-06', 'computed our SNR report');
    assertEq(r.lastTx, 'A1BCD K3SBP -06', 'TX is signal report, NOT another CQ');
    assertEq(eng._lastRxFreq, 1234, 'RX freq tracked to their offset');
  }

  // They acknowledge with R+report → advance to cq-rr73 + log
  {
    const q = baseQ();
    q.phase = 'cq-report';
    q.call = 'A1BCD';
    q.sentReport = '-06';
    const eng = makeEngine();
    const r = drive(q, [decode('K3SBP A1BCD R-12')], eng);
    assertEq(r.q.phase, 'cq-rr73', 'cq-report → cq-rr73 on R+report');
    assertEq(r.q.report, '-12', 'captured their report');
    assertEq(r.lastTx, 'A1BCD K3SBP RR73', 'TX is RR73');
    assertEq(r.doneCount, 0, 'not logged at their R+report decode (#807)');
    assert(sm.txLogsQso(r.q, 'A1BCD K3SBP RR73') === true, 'logs when our RR73 goes on the air');
  }

  // Their response had no report yet (heard but no advance)
  {
    const q = baseQ();
    q.phase = 'cq-report';
    q.call = 'A1BCD';
    const r = drive(q, [decode('K3SBP A1BCD AB20')], makeEngine());
    assertEq(r.q.phase, 'cq-report', 'no advance — repeated their grid, no report yet');
    assert(r.q._heardThisCycle === true, '_heardThisCycle set — flavors the give-up message (no longer resets the cap)');
  }

  // Courtesy RR73 cycle
  {
    const q = baseQ();
    q.phase = 'cq-rr73';
    const eng = makeEngine();
    const r = drive(q, [], eng);
    assertEq(r.q.phase, 'cq-rr73', 'stays — courtesy wait until the RR73 has gone out');
    assertEq(r.q._courtesyWaits, 1, 'one courtesy wait counted');
  }
  {
    const q = baseQ();
    q.phase = 'cq-rr73';
    q._txSentMsg = q.txMsg; // the RR73 went out
    const eng = makeEngine();
    const r = drive(q, [], eng);
    assertEq(r.q.phase, 'done', 'second cycle → done');
    assertEq(eng._txEnabled, false, 'TX disabled');
  }

  // Compressed reply (no Step-2 grid) — partner sends `<MY> <THEM> <±NN>`.
  // We ack with R+report and WAIT for their RR73/RRR/73 before logging: our
  // R+report is half the exchange until they confirm it (droidbot2's log,
  // 2026-11-01: logged at R+report, the other station never heard it).
  // KB2ELA-style decode, K3SBP 2026-06-01.
  {
    const eng = makeEngine();
    const r = drive(baseQ(), [decode('K3SBP A1BCD -12', { db: -6, df: 1234 })], eng);
    assertEq(r.q.phase, 'cq-r-report', 'cq → cq-r-report on compressed (no-grid) reply');
    assertEq(r.q.call, 'A1BCD', 'captured their call from compressed reply');
    assertEq(r.q.grid, '', 'grid is empty — they skipped Step 2');
    assertEq(r.q.report, '-12', 'captured their report of us');
    assertEq(r.q.sentReport, '-06', 'computed our SNR report');
    assertEq(r.lastTx, 'A1BCD K3SBP R-06', 'TX is R+our-report, NOT plain report or RR73');
    assertEq(r.doneCount, 0, 'NOT logged at our R+report — they have not confirmed');
    assertEq(eng._lastRxFreq, 1234, 'RX freq tracked to their offset');
  }
  const compressedQ = () => Object.assign(baseQ(), {
    phase: 'cq-r-report', call: 'A1BCD', grid: '', report: '-12', sentReport: '-06',
    txMsg: 'A1BCD K3SBP R-06',
  });
  for (const ack of ['RR73', 'RRR', '73']) {
    const r = drive(compressedQ(), [decode('K3SBP A1BCD ' + ack)], makeEngine());
    assertEq(r.q.phase, 'cq-rr73', `cq-r-report → courtesy leg on their ${ack}`);
    assertEq(r.lastTx, 'A1BCD K3SBP 73', `courtesy 73 after their ${ack}`);
    assertEq(r.doneCount, 1, `logged on their ${ack}`);
  }
  {
    const r = drive(compressedQ(), [decode('K3SBP A1BCD -12')], makeEngine());
    assertEq(r.q.phase, 'cq-r-report', 'their report again = they missed our R+report; keep sending it');
    assertEq(r.doneCount, 0, 'still not logged');
    assert(r.q._heardThisCycle === true, 'heard flag set');
  }
  {
    const r = drive(compressedQ(), [decode('W1XYZ A1BCD RR73')], makeEngine());
    assertEq(r.doneCount, 0, 'their RR73 to someone else does not confirm ours');
  }
  {
    // They vanish after exchanging reports: Skip sends the 73, which logs as it goes out.
    const q = compressedQ();
    assert(sm.canCloseoutQso(q) === true, 'compressed reply with reports both ways can be finished with a 73');
    let tx = '';
    assert(sm.sendFinal73(q, (m) => { tx = m; }) === true, 'Skip to the 73 runs');
    assertEq(tx, 'A1BCD K3SBP 73', 'Skip sends a final 73');
    assertEq(q.phase, 'cq-rr73', 'the 73 uses the CQ ladder courtesy leg');
    assert(sm.txLogsQso(q, tx) === true, 'and logs when it goes out');
    assert(sm.replaceLogsQso(compressedQ(), 'W9XYZ') === false, 'clicking away mid compressed reply does not log it');
  }

  // R+report should NOT be misclassified as a compressed reply — must
  // stay in the cq phase if there was no prior grid match. The R-prefix
  // means we are mid-Step-3 of the standard flow, not Step-2-skip.
  {
    const r = drive(baseQ(), [decode('K3SBP A1BCD R-12')], makeEngine());
    assertEq(r.q.phase, 'cq', 'cq stays — R-prefixed report is not a compressed Step 2');
  }
}

section('CQ mode — no advance paths');
{
  const baseQ = () => ({
    mode: 'cq', phase: 'cq', call: null, grid: null,
    txMsg: 'CQ K3SBP FN20', report: null, sentReport: null,
    myCall: 'K3SBP', myGrid: 'FN20', txRetries: 0,
  });

  // Decode contains our call but is a CQ (ignore)
  {
    const r = drive(baseQ(), [decode('CQ K3SBP FN20')], makeEngine());
    assertEq(r.q.phase, 'cq', 'ignore our own CQ in decodes');
  }
  // Bare two-call reply ("K3SBP A1BCD", no grid, no report) — a nonstandard
  // or grid-less station answering our CQ (their Tx1 has no room for a
  // locator). Advances like a grid reply with grid unknown. 2026-07-07.
  {
    const r = drive(baseQ(), [decode('K3SBP A1BCD', { db: -7 })], makeEngine());
    assertEq(r.q.phase, 'cq-report', 'bare two-call reply advances to cq-report');
    assertEq(r.q.call, 'A1BCD', 'bare reply captures the caller');
    assertEq(r.q.grid, '', 'bare reply has no grid');
    assertEq(r.lastTx, 'A1BCD K3SBP -07', 'bare reply -> signal report');
  }
  // Decode contains us but genuinely unparseable (payload-shaped garbage)
  {
    const r = drive(baseQ(), [decode('K3SBP RR73')], makeEngine());
    assertEq(r.q.phase, 'cq', 'no advance if no parseable <call> <grid>');
  }
  // Decode unrelated
  {
    const r = drive(baseQ(), [decode('CQ N4XYZ EM12')], makeEngine());
    assertEq(r.q.phase, 'cq', 'no advance on unrelated decode');
  }

  // deps.skipCall — Run mode's dupe filter. Without it Run re-works the same
  // stations forever, so the band never "drains" and the pause it depends on
  // could never trigger. Only run mode passes it: a human who pressed CQ still
  // answers whoever calls (WSJT-X parity).
  {
    const worked = new Set(['A1BCD']);
    const skipCall = (c) => worked.has(c);
    const r = drive(baseQ(), [decode('K3SBP A1BCD FN31', { db: -5 })], makeEngine(), { skipCall });
    assertEq(r.q.phase, 'cq', 'an already-worked answerer is skipped, not worked again');
    assertEq(r.q.call, null, 'skipped answerer never becomes the QSO partner');
  }
  {
    const worked = new Set(['A1BCD']);
    const skipCall = (c) => worked.has(c);
    const r = drive(baseQ(), [
      decode('K3SBP A1BCD FN31', { db: -5 }),
      decode('K3SBP N4XYZ EM12', { db: -15 }),
    ], makeEngine(), { skipCall });
    assertEq(r.q.call, 'N4XYZ', 'the next unworked answerer is taken instead');
    assertEq(r.lastTx, 'N4XYZ K3SBP -15', 'and gets a normal report reply');
  }
  {
    // Same decode, no skipCall (manual CQ / hunt) — unchanged behavior.
    const r = drive(baseQ(), [decode('K3SBP A1BCD FN31', { db: -5 })], makeEngine());
    assertEq(r.q.call, 'A1BCD', 'without skipCall the first answerer is worked as before');
  }
  {
    // A compressed report reply from a worked station is skipped too — the
    // filter reads the second token, not the message shape.
    const skipCall = (c) => c === 'A1BCD';
    const r = drive(baseQ(), [decode('K3SBP A1BCD -12', { db: -5 })], makeEngine(), { skipCall });
    assertEq(r.q.phase, 'cq', 'worked station\'s compressed reply is skipped as well');
  }
}

// ============================================================
// Group 3: Signal-report formatting (WSJT-X parity)
// ============================================================
section('Signal-report formatting');
{
  assertEq(sm.formatReport(0), '+00', 'zero → +00');
  assertEq(sm.formatReport(5), '+05', '+5 → +05');
  assertEq(sm.formatReport(-5), '-05', '-5 → -05');
  assertEq(sm.formatReport(-12.7), '-13', 'rounding -12.7 → -13');
  assertEq(sm.formatReport(20), '+20', '+20 → +20');
  // WSJT-X clamps to ±30 visually but our formatter passes through — note
  assertEq(sm.formatReport(50), '+50', 'overload reports pass through (WSJT-X clamps display only)');
}

// ============================================================
// Group 4: Decode classifier (inferReplyStep) — IN SYNC with renderer/jtcat-popout.js
// ============================================================
//
// Duplicated here so the test runs without a DOM. KEEP IN SYNC with
// the inline function in renderer/jtcat-popout.js. If you change either,
// update the other. (TODO: extract to a shared CJS module that the
// renderer also consumes via preload-bundled require.)
// The classifier is now the SHARED module (renderer/jtcat-parser.js) — the
// single source of truth the renderers and main.js also use. This test
// therefore exercises the real production code instead of a hand-copy that
// could (and did) drift. K3SBP 2026-06-10.
const { inferReplyStep, looksLikeCallsign: _jpLooksLikeCallsign } = require('../renderer/jtcat-parser');

section('Decode classifier (popout inferReplyStep)');
{
  const me = 'K3SBP';
  // CQ
  let r = inferReplyStep({ text: 'CQ W1ABC FN42' }, me);
  assertEq(r && r.step, 'reply-cq', 'CQ → reply-cq');
  assertEq(r && r.call, 'W1ABC', 'CQ → captures CQer');
  // CQ DX
  r = inferReplyStep({ text: 'CQ DX W1ABC FN42' }, me);
  assertEq(r && r.call, 'W1ABC', 'CQ DX → skips "DX" modifier');
  // Directed at us, grid reply (step 2 → we send signal report)
  r = inferReplyStep({ text: 'K3SBP W1ABC FN42' }, me);
  assertEq(r && r.step, 'send-report', 'MYCALL X GRID → send-report (the Casey bug)');
  assertEq(r && r.call, 'W1ABC', 'send-report captures sender');
  // Plain signal report → R+report
  r = inferReplyStep({ text: 'K3SBP W1ABC -05' }, me);
  assertEq(r && r.step, 'send-r-report', 'MYCALL X SNR → send-r-report');
  // R-prefixed report → RR73
  r = inferReplyStep({ text: 'K3SBP W1ABC R-05' }, me);
  assertEq(r && r.step, 'send-rr73', 'MYCALL X R-SNR → send-rr73');
  // RR73 → 73
  r = inferReplyStep({ text: 'K3SBP W1ABC RR73' }, me);
  assertEq(r && r.step, 'send-73', 'MYCALL X RR73 → send-73');
  r = inferReplyStep({ text: 'K3SBP W1ABC 73' }, me);
  assertEq(r && r.step, 'send-73', 'MYCALL X 73 → send-73');
  r = inferReplyStep({ text: 'K3SBP W1ABC RRR' }, me);
  assertEq(r && r.step, 'send-73', 'MYCALL X RRR → send-73');
  // Tail-end (NA7C bug): third-party message, click should target FROM
  r = inferReplyStep({ text: 'W4XYZ NA7C 73' }, me);
  assertEq(r && r.step, 'reply-cq', 'third-party 73 → tail-end opener');
  assertEq(r && r.call, 'NA7C', 'tail-end targets FROM (sender)');
  r = inferReplyStep({ text: 'K3ABC NA7C -12' }, me);
  assertEq(r && r.call, 'NA7C', 'mid-QSO third party → tail-end FROM');
  // Garbage / null
  r = inferReplyStep({ text: '' }, me);
  assertEq(r, null, 'empty text → null');
  r = inferReplyStep({ text: 'XYZZY ABC' }, me);
  assertEq(r, null, 'garbage → null');
  // Edge: no myCall set
  r = inferReplyStep({ text: 'K3SBP W1ABC FN42' }, '');
  assertEq(r && r.call, 'W1ABC', 'tail-end works even without myCall');
}

section('Callsign heuristic (rejects grids/reports/acks)');
{
  assertEq(_jpLooksLikeCallsign('W1ABC'), true, 'W1ABC accepted');
  assertEq(_jpLooksLikeCallsign('K3SBP'), true, 'K3SBP accepted');
  assertEq(_jpLooksLikeCallsign('VP9/AA1AC'), true, 'slash-portable accepted');
  assertEq(_jpLooksLikeCallsign('3G0Z'), true, 'digit-leading callsign accepted');
  assertEq(_jpLooksLikeCallsign('FN42'), false, 'grid rejected');
  assertEq(_jpLooksLikeCallsign('-05'), false, 'signal report rejected');
  assertEq(_jpLooksLikeCallsign('R-05'), false, 'R+report rejected');
  assertEq(_jpLooksLikeCallsign('RR73'), false, 'RR73 rejected');
  assertEq(_jpLooksLikeCallsign('73'), false, '73 too short');
  assertEq(_jpLooksLikeCallsign('CQ'), false, 'CQ rejected');
  assertEq(_jpLooksLikeCallsign('TU'), false, 'TU rejected');
}

// ============================================================
// Group 4b: Edge cases — slash-portable callsigns, digit-leading prefixes
// ============================================================
section('Edge cases — slash-portable + digit-leading callsigns');
{
  // Slash-portable in REPLY mode: theirCall = VP9/AA1AC
  const q = {
    mode: 'reply', phase: 'reply', call: 'VP9/AA1AC', grid: 'FK17',
    txMsg: 'VP9/AA1AC K3SBP FN20', report: null, sentReport: null,
    myCall: 'K3SBP', myGrid: 'FN20', txRetries: 0,
  };
  const r = drive(q, [decode('K3SBP VP9/AA1AC -05', { db: -8 })], makeEngine());
  assertEq(r.q.phase, 'r+report', 'slash-portable advances normally');
  // Slash calls are nonstandard c28: report legs carry them as a 22-bit hash,
  // shown bracketed — WSJT-X bracket rules via formatDirectedMsg. 2026-07-07.
  assertEq(r.lastTx, '<VP9/AA1AC> K3SBP R-08', 'slash-portable TX message (hashed/bracketed)');

  // Digit-leading CQer
  const cqQ = {
    mode: 'cq', phase: 'cq', call: null, grid: null,
    txMsg: 'CQ K3SBP FN20', report: null, sentReport: null,
    myCall: 'K3SBP', myGrid: 'FN20', txRetries: 0,
  };
  const cqR = drive(cqQ, [decode('K3SBP 3D2CJR RG37', { db: -10 })], makeEngine());
  assertEq(cqR.q.call, '3D2CJR', 'digit-leading callsign captured from CQ reply');
  assertEq(cqR.q.grid, 'RG37', 'grid captured');
  assertEq(cqR.q.phase, 'cq-report', 'advance to cq-report');

  // Classifier: CQ from digit-leading call
  const r2 = inferReplyStep({ text: 'CQ 3D2CJR RG37' }, 'K3SBP');
  assertEq(r2 && r2.call, '3D2CJR', 'inferReplyStep handles digit-leading CQer');

  // Classifier: directed at us from slash-portable
  const r3 = inferReplyStep({ text: 'K3SBP VP9/AA1AC FK17' }, 'K3SBP');
  assertEq(r3 && r3.step, 'send-report', 'directed-at-us with slash-portable sender → send-report');
  assertEq(r3 && r3.call, 'VP9/AA1AC', 'slash-portable preserved');
}

// ============================================================
// Group 4c: End-to-end QSO arcs
// ============================================================
section('End-to-end QSO arcs');
{
  // Full reply-mode arc: reply → r+report → 73 → done (4 cycles)
  const q = {
    mode: 'reply', phase: 'reply', call: 'W1ABC', grid: 'FN42',
    txMsg: 'W1ABC K3SBP FN20', report: null, sentReport: null,
    myCall: 'K3SBP', myGrid: 'FN20', txRetries: 0,
  };
  // Cycle 1: nothing yet
  drive(q, [], makeEngine());
  assertEq(q.phase, 'reply', 'arc-1: still in reply');
  // Cycle 2: they send our signal report
  drive(q, [decode('K3SBP W1ABC -10', { db: -12 })], makeEngine());
  assertEq(q.phase, 'r+report', 'arc-2: → r+report');
  // Cycle 3: they confirm with RR73
  let doneCount = 0;
  sm.advanceJtcatQso(q, [decode('K3SBP W1ABC RR73')], () => {}, () => { doneCount++; }, { engine: makeEngine(), log: () => {} });
  assertEq(q.phase, '73', 'arc-3: → 73');
  assertEq(doneCount, 1, 'arc-3: logged at RR73');
  // Cycle 4: courtesy wait (the 73 has not gone out yet)
  drive(q, [], makeEngine());
  assertEq(q.phase, '73', 'arc-4: courtesy wait (still 73)');
  // Cycle 5: the 73 went out → terminate
  q._txSentMsg = q.txMsg;
  const eng = makeEngine();
  drive(q, [], eng);
  assertEq(q.phase, 'done', 'arc-5: done');
  assertEq(eng._txEnabled, false, 'arc-5: engine disarmed');

  // Full CQ-mode arc: cq → cq-report → cq-rr73 → done
  const q2 = {
    mode: 'cq', phase: 'cq', call: null, grid: null,
    txMsg: 'CQ K3SBP FN20', report: null, sentReport: null,
    myCall: 'K3SBP', myGrid: 'FN20', txRetries: 0,
  };
  drive(q2, [decode('K3SBP N4XYZ EM12', { db: -8 })], makeEngine());
  assertEq(q2.phase, 'cq-report', 'cq-arc-1: → cq-report');
  let d2 = 0;
  sm.advanceJtcatQso(q2, [decode('K3SBP N4XYZ R-15')], () => {}, () => { d2++; }, { engine: makeEngine(), log: () => {} });
  assertEq(q2.phase, 'cq-rr73', 'cq-arc-2: → cq-rr73');
  assertEq(d2, 0, 'cq-arc-2: not logged at their R-report (#807)');
  assert(sm.txLogsQso(q2, q2.txMsg) === true, 'cq-arc-2: logs when the RR73 goes out');
  drive(q2, [], makeEngine()); // courtesy
  assertEq(q2.phase, 'cq-rr73', 'cq-arc-3: courtesy wait');
  q2._txSentMsg = q2.txMsg; // the RR73 went out
  drive(q2, [], makeEngine());
  assertEq(q2.phase, 'done', 'cq-arc-4: done');
}

// ============================================================
// Group 4c2: Courtesy leg waits for its own transmission (IK4IDF 2026-10-15)
// ============================================================
section('Courtesy leg — ends when the 73/RR73 has actually been transmitted');
{
  // main.js stamps q._txSentMsg at the tx-start dispatch with the message that
  // went out. Decode events arrive every period (our own TX period included),
  // so the old fixed "wait one cycle" assumed the courtesy went out in the very
  // next slot — a decode that lands after that slot's TX has started sends the
  // OLD message once more, and the two-cycle count then tore the QSO down with
  // the 73 never sent ("to end the QSO I have to double-click the report").
  const mk = () => ({
    mode: 'reply', phase: '73', call: 'W1ABC', grid: 'FN42',
    txMsg: 'W1ABC K3SBP 73', report: '-05', sentReport: '-08',
    myCall: 'K3SBP', myGrid: 'FN20', txRetries: 0,
    _txSentMsg: 'W1ABC K3SBP R-08', // the last thing that went out was the R-report
  });
  // Late decode: two cycles pass and the 73 has still not gone out — hold.
  {
    const q = mk();
    const eng = makeEngine(); eng._txEnabled = true;
    drive(q, [], eng);
    drive(q, [], eng);
    assertEq(q.phase, '73', 'the 73 leg holds while the 73 has not been transmitted');
    assertEq(eng._txEnabled, true, 'TX stays armed so the 73 goes out in the next own slot');
    assertEq(eng._lastTxMsg, null, 'the TX message is not cleared while holding');
    q._txSentMsg = q.txMsg; // tx-start of the 73
    drive(q, [], eng);
    assertEq(q.phase, 'done', 'the decode after the 73 went out closes the QSO');
    assertEq(eng._txEnabled, false, 'engine disarmed once the 73 is out');
    assertEq(eng._lastTxMsg, '', 'TX message cleared once the 73 is out');
  }
  // Still on the air: the stamp is there but the transmission has not ended.
  {
    const q = mk();
    q._txSentMsg = q.txMsg;
    const eng = makeEngine(); eng._txEnabled = true; eng._txActive = true;
    drive(q, [], eng);
    assertEq(q.phase, '73', 'a 73 still being transmitted is not torn down under itself');
    eng._txActive = false;
    drive(q, [], eng);
    assertEq(q.phase, 'done', 'done once the transmission has ended');
  }
  // Bounded: a 73 that can never go out (SWR latch, radio owned elsewhere,
  // operator TX off) still closes the QSO.
  {
    const q = mk();
    const eng = makeEngine(); eng._txEnabled = true;
    for (let i = 0; i < sm.COURTESY_MAX_WAIT_CYCLES; i++) drive(q, [], eng);
    assertEq(q.phase, '73', `still holding after ${sm.COURTESY_MAX_WAIT_CYCLES} cycles`);
    drive(q, [], eng);
    assertEq(q.phase, 'done', 'closes without the 73 after the bound');
    assertEq(eng._txEnabled, false, 'engine disarmed at the bound');
  }
  // CQ side: the RR73 leg has the same contract.
  {
    const q = {
      mode: 'cq', phase: 'cq-rr73', call: 'N4XYZ', grid: 'EM12',
      txMsg: 'N4XYZ K3SBP RR73', report: '-15', sentReport: '-08',
      myCall: 'K3SBP', myGrid: 'FN20', txRetries: 0, _txSentMsg: 'N4XYZ K3SBP -08',
    };
    const eng = makeEngine(); eng._txEnabled = true;
    drive(q, [], eng); drive(q, [], eng);
    assertEq(q.phase, 'cq-rr73', 'the RR73 leg holds while the RR73 has not been transmitted');
    q._txSentMsg = q.txMsg;
    drive(q, [], eng);
    assertEq(q.phase, 'done', 'RR73 out → done');
  }
  // Wiring: main stamps the QSO at the ONE tx-start dispatch point (both the
  // single-slice and the multi-slice handlers), right beside the per-try
  // period stamp, and the retry-stall counter leaves courtesy legs alone.
  {
    const fs = require('fs');
    const path = require('path');
    const MAIN = readSrc(path.join(__dirname, '..', 'main.js'));
    const single = MAIN.indexOf('ft8Engine._lastTxPeriodKey = jtcatPeriodUtc(modeForTx);');
    assert(single > 0 && MAIN.indexOf('jtcatNoteTxSent(data.message);', single) - single < 200,
      'single-slice tx-start stamps the courtesy message beside the try stamp');
    const multi = MAIN.indexOf("engine._lastTxPeriodKey = jtcatPeriodUtc(engine._mode || 'FT8');");
    assert(multi > 0 && MAIN.indexOf('jtcatNoteTxSent(data.message);', multi) - multi < 200,
      'multi-slice tx-start stamps the courtesy message beside the try stamp');
    const stall = MAIN.indexOf('function jtcatHandleRetryStall(o) {');
    const body = MAIN.slice(stall, stall + 1200);
    assert(/qso\.phase === '73' \|\| qso\.phase === 'cq-rr73'/.test(body),
      'the retry-stall counter returns early on courtesy legs');
  }
}

// ============================================================
// Group 4d: WSJT-X parity spot checks
// ============================================================
section('WSJT-X parity spot checks');
{
  // WSJT-X uses 4-character grids when sending, not 6. Our QSO state
  // machine assumes the txMsg already has the trimmed grid; this just
  // verifies that the test fixtures conform.
  assertEq('FN20jb'.substring(0, 4), 'FN20', '6-char grid trimmed to 4 (WSJT-X parity)');

  // WSJT-X never sends "R+00" without a leading sign — formatReport(0) = "+00"
  assertEq(sm.formatReport(0), '+00', '0 dB report is "+00", not "00"');

  // WSJT-X advances to RR73 on R-prefixed report. Our state machine
  // matches by detecting 'R-' or 'R+' in the response text.
  const q = {
    mode: 'reply', phase: 'reply', call: 'W1ABC', grid: 'FN42',
    txMsg: 'W1ABC K3SBP FN20', myCall: 'K3SBP', myGrid: 'FN20',
    report: null, sentReport: null, txRetries: 0,
  };
  drive(q, [decode('K3SBP W1ABC R+05', { db: -5 })], makeEngine());
  assertEq(q.phase, '73', 'WSJT-X parity: R+report immediately → 73 (skip r+report)');

  // Hash-collision safety: WSJT-X uses callsign hashes in long-call
  // messages; we just match raw text. Slash-portable callsigns must
  // not break the regex.
  const q2 = {
    mode: 'cq', phase: 'cq', call: null, grid: null,
    txMsg: 'CQ K3SBP FN20', myCall: 'K3SBP', myGrid: 'FN20',
    report: null, sentReport: null, txRetries: 0,
  };
  // Use a separating space pattern: "K3SBP 3B9/M0CFW MH45"
  drive(q2, [decode('K3SBP 3B9/M0CFW MH45', { db: -12 })], makeEngine());
  assertEq(q2.call, '3B9/M0CFW', 'parses slash-portable reply');
  assertEq(q2.grid, 'MH45', 'parses grid after slash-portable call');
}

// ============================================================
// Group 4e: Nonstandard callsigns — hashed <> partner (2026-07-07)
// Special-event/compound calls (GB13COL, PJ4/K1ABC) can't ride c28: mid-QSO
// decodes render them <bracketed> (or <...> unresolved), ack legs must go
// out as type 4 with the nonstandard call in FULL, and their Tx1 carries no
// grid. See docs/jtcat-wsjtx-gap-plan.md "Protocol reference".
// ============================================================
section('Nonstandard callsigns — reply-side ladder (we answered CQ GB13COL)');
{
  const baseQ = () => ({
    mode: 'reply', phase: 'reply', call: 'GB13COL', grid: '',
    txMsg: '<GB13COL> K3SBP', report: null, sentReport: null,
    myCall: 'K3SBP', myGrid: 'FN20', txRetries: 0,
  });

  // Their report arrives with THEIR call hash-bracketed → r+report,
  // and our R-report leg keeps the hash form (type 1).
  {
    const q = baseQ();
    const r = drive(q, [decode('K3SBP <GB13COL> -08', { db: -4 })], makeEngine());
    assertEq(q.phase, 'r+report', 'bracketed partner report advances to r+report');
    assertEq(r.lastTx, '<GB13COL> K3SBP R-04', 'R-report leg hashes the nonstandard call');
  }
  // Their RR73 → our 73 goes out as TYPE 4: their call in full, ours hashed.
  {
    const q = baseQ();
    q.phase = 'r+report'; q.report = '-08'; q.sentReport = '-04';
    const r = drive(q, [decode('K3SBP <GB13COL> RR73')], makeEngine());
    assertEq(q.phase, '73', 'bracketed RR73 closes the QSO');
    assertEq(r.lastTx, 'GB13COL <K3SBP> 73', '73 leg is type 4 (their call in full)');
    assertEq(r.doneCount, 1, 'logs at RR73 receipt');
  }
  // Unresolved hash: "<...>" must NOT match our partner — no advance.
  {
    const q = baseQ();
    const r = drive(q, [decode('K3SBP <...> -08')], makeEngine());
    assertEq(q.phase, 'reply', 'unresolved <...> does not advance the QSO');
    assertEq(r.lastTx, null, 'no TX change on unresolved hash');
  }
}

section('Nonstandard callsigns — CQ-side ladder (GB13COL answers our CQ)');
{
  const q = {
    mode: 'cq', phase: 'cq', call: null, grid: null,
    txMsg: 'CQ K3SBP FN20', report: null, sentReport: null,
    myCall: 'K3SBP', myGrid: 'FN20', txRetries: 0,
  };
  // Their Tx1 is a bare type-4 two-call (no room for a grid), our own call
  // rendered as a hash: "<K3SBP> GB13COL".
  const eng = makeEngine();
  let r = drive(q, [decode('<K3SBP> GB13COL', { db: -7, df: 1740 })], eng);
  assertEq(q.phase, 'cq-report', 'bare bracketed reply advances to cq-report');
  assertEq(q.call, 'GB13COL', 'captures the nonstandard caller');
  assertEq(q.grid, '', 'no grid from a nonstandard caller');
  assertEq(r.lastTx, '<GB13COL> K3SBP -07', 'report leg hashes the nonstandard call');
  assertEq(eng._lastRxFreq, 1740, 'RX freq follows the caller');
  // Their R-report → our RR73 goes out as type 4 (their call in full) + log.
  r = drive(q, [decode('K3SBP <GB13COL> R-03')], makeEngine());
  assertEq(q.phase, 'cq-rr73', 'bracketed R-report advances to cq-rr73');
  assertEq(r.lastTx, 'GB13COL <K3SBP> RR73', 'RR73 leg is type 4 (their call in full)');
  assertEq(r.doneCount, 0, 'not logged until the RR73 goes out (#807)');
  assert(sm.txLogsQso(q, 'GB13COL <K3SBP> RR73') === true, 'the type-4 RR73 going out logs it');
}

// ============================================================
// Group 4f: Skip Grid — report-first reply (WSJT-X "disable Tx1", 2026-07-07)
// main.js builds the opening reply as "THEIRCALL MYCALL -NN" (report, no
// grid) with sentReport pre-set; the ladder then closes one cycle early.
// ============================================================
section('Skip Grid — report-first reply');
{
  const q = {
    mode: 'reply', phase: 'reply', call: 'W1ABC', grid: 'FN42',
    txMsg: 'W1ABC K3SBP -07', report: null, sentReport: '-07',
    myCall: 'K3SBP', myGrid: 'FN20', txRetries: 0,
  };
  const r = drive(q, [decode('K3SBP W1ABC R-12', { db: -3 })], makeEngine());
  assertEq(q.phase, '73', 'skip-grid: their R-report goes straight to 73');
  assertEq(r.lastTx, 'W1ABC K3SBP RR73', 'skip-grid: we close with RR73');
  assertEq(q.sentReport, '-07', 'sentReport preserves the report we actually transmitted');
  assertEq(q.report, '-12', 'their report captured');
  assertEq(r.doneCount, 0, 'skip-grid: not logged at their R-report (#807)');
  assert(sm.txLogsQso(q, 'W1ABC K3SBP RR73') === true, 'skip-grid: logs when our RR73 goes out');
}
{
  // Partner ignores our report-opener and sends a plain report (treated it
  // like a Tx1) — we advance to R+report and our sent report is the NEW one.
  const q = {
    mode: 'reply', phase: 'reply', call: 'W1ABC', grid: '',
    txMsg: 'W1ABC K3SBP -07', report: null, sentReport: '-07',
    myCall: 'K3SBP', myGrid: 'FN20', txRetries: 0,
  };
  const r = drive(q, [decode('K3SBP W1ABC -02', { db: -5 })], makeEngine());
  assertEq(q.phase, 'r+report', 'plain report still advances to r+report');
  assertEq(r.lastTx, 'W1ABC K3SBP R-05', 'R+report carries the fresh estimate');
  assertEq(q.sentReport, '-05', 'sentReport updated to what we now transmit');
}

// ============================================================
// Group 4g: Hound mode — FT8 DXpedition, old-style Fox/Hound (2026-07-07)
// q.hound is set by main.js when jtcatHoundMode is on. Rules: fox dual
// messages ("K1ABC RR73; W9XYZ <KH1/KH7Z> -08") are parsed segment-wise so
// the other hound's payload can't advance our QSO; when the fox answers, our
// TX QSYs to the fox's frequency for the R+rpt leg; RR73 logs and stops TX
// with NO 73 courtesy.
// ============================================================
section('Hound mode — fox dual messages + QSY + no-73 close');
{
  const baseQ = () => ({
    mode: 'reply', phase: 'reply', call: 'KH7Z', grid: '',
    txMsg: 'KH7Z K3SBP FN20', report: null, sentReport: null,
    myCall: 'K3SBP', myGrid: 'FN20', txRetries: 0, hound: true,
  });

  // Fox report in a dual message: our segment carries the report, the other
  // hound's RR73 must NOT close our QSO. TX QSYs to the fox's frequency.
  {
    const q = baseQ();
    const eng = makeEngine();
    eng._lastTxFreq = null;
    eng.setTxFreq = function(f) { this._lastTxFreq = f; };
    const r = drive(q, [decode('W9XYZ RR73; K3SBP <KH7Z> -13', { db: -9, df: 460 })], eng);
    assertEq(q.phase, 'r+report', 'dual-message report advances to r+report');
    assertEq(r.lastTx, 'KH7Z K3SBP R-09', 'R+rpt leg carries OUR measurement of the fox');
    assertEq(eng._lastTxFreq, 460, 'TX QSYs to the fox frequency for the R+rpt leg');
    assertEq(r.doneCount, 0, 'other hound\'s RR73 does not log our QSO');
  }
  // Fox RR73 in a dual message closes our QSO: log, no 73 courtesy, TX off.
  {
    const q = baseQ();
    q.phase = 'r+report'; q.report = '-13'; q.sentReport = '-09';
    const eng = makeEngine();
    const r = drive(q, [decode('K3SBP RR73; W2ABC <KH7Z> -04', { db: -9 })], eng);
    assertEq(q.phase, 'done', 'fox RR73 closes the hound QSO immediately');
    assertEq(r.doneCount, 1, 'logs on RR73');
    assertEq(eng._txEnabled, false, 'TX disabled — no 73 courtesy in a fox pileup');
    assertEq(eng._lastTxMsg, '', 'TX message cleared');
  }
  // Fox jumps straight to RR73 while we are still in the reply phase
  // (missed report cycle) — still close out and log.
  {
    const q = baseQ();
    const eng = makeEngine();
    const r = drive(q, [decode('K3SBP KH7Z RR73', { db: -9 })], eng);
    assertEq(q.phase, 'done', 'RR73 in reply phase closes the hound QSO');
    assertEq(r.doneCount, 1, 'logs on direct RR73');
  }
  // Dual message addressed to two OTHER hounds — no advance at all.
  {
    const q = baseQ();
    const r = drive(q, [decode('W9XYZ RR73; W2ABC <KH7Z> -04', { db: -9 })], makeEngine());
    assertEq(q.phase, 'reply', 'dual message for other hounds does not advance');
    assertEq(r.doneCount, 0, 'and does not log');
  }
  // Standard (non-hound) QSOs are unaffected: RR73 still gets a 73 courtesy.
  {
    const q = baseQ();
    delete q.hound;
    q.phase = 'r+report'; q.report = '-13'; q.sentReport = '-09';
    const r = drive(q, [decode('K3SBP KH7Z RR73', { db: -9 })], makeEngine());
    assertEq(q.phase, '73', 'non-hound QSO still sends the 73 courtesy');
    assertEq(r.lastTx, 'KH7Z K3SBP 73', 'courtesy 73 message unchanged');
  }
}

// ============================================================
// Compound messages outside Hound mode (K3SBP 2026-09-26): an ordinary
// operator running a multi-answer mode sent "K3SBP RR73; AI5MM <AF0E> -14" —
// RR73 to us and a report to AI5MM in one transmission. The sender's call is
// only in the second half, so the plain "our call, their call" match missed it
// and POTACAT kept sending R-02.
// ============================================================
section('Compound messages (non-hound) — our half from our partner counts');
{
  const baseQ = () => ({
    mode: 'reply', phase: 'r+report', call: 'AF0E', grid: '',
    txMsg: 'AF0E K3SBP R-02', report: '-11', sentReport: '-02',
    myCall: 'K3SBP', myGrid: 'FN20', txRetries: 0,
  });
  // His exact decode: RR73 to us rides on a report to AI5MM.
  {
    const q = baseQ();
    const r = drive(q, [decode('K3SBP RR73; AI5MM <AF0E> -14', { db: -10 })], makeEngine());
    assertEq(q.phase, '73', 'our RR73 half closes the QSO (73 courtesy follows)');
    assertEq(r.doneCount, 1, 'logs on the compound RR73');
    assertEq(r.lastTx, 'AF0E K3SBP 73', 'courtesy 73 to the sender');
  }
  // Our half is the REPORT half: "AI5MM RR73; K3SBP <AF0E> -14" in the reply phase.
  {
    const q = baseQ();
    q.phase = 'reply'; q.report = null; q.sentReport = null; q.txMsg = 'AF0E K3SBP FN20';
    const r = drive(q, [decode('AI5MM RR73; K3SBP <AF0E> -14', { db: -8 })], makeEngine());
    assertEq(q.phase, 'r+report', 'the report half for us advances to r+report');
    assertEq(q.report, '-14', 'their report to us is read from our half');
    assertEq(r.lastTx, 'AF0E K3SBP R-08', 'R+report with our measurement');
  }
  // A compound from SOMEONE ELSE that happens to include our call: no advance.
  {
    const q = baseQ();
    const r = drive(q, [decode('K3SBP RR73; AI5MM <W9XYZ> -14', { db: -10 })], makeEngine());
    assertEq(q.phase, 'r+report', 'a compound from another station does not close our QSO');
    assertEq(r.doneCount, 0, 'and does not log');
  }
  // A compound from our partner addressed to two OTHER stations: no advance.
  {
    const q = baseQ();
    const r = drive(q, [decode('W1AW RR73; AI5MM <AF0E> -14', { db: -10 })], makeEngine());
    assertEq(q.phase, 'r+report', 'our partner working two others does not advance us');
    assertEq(r.doneCount, 0, 'and does not log');
  }
  // Plain RR73 is unchanged.
  {
    const q = baseQ();
    const r = drive(q, [decode('K3SBP AF0E RR73', { db: -10 })], makeEngine());
    assertEq(q.phase, '73', 'plain RR73 still closes the QSO');
    assertEq(r.doneCount, 1, 'and logs');
  }
}

// ============================================================
// Own-TX echo guard (N3VD 2026-07-10): a radio looping transmit audio back
// to the decoder (IC-7300 + MONI) produced decodes of OUR OWN messages. The
// order-blind contains-both-calls matchers accepted them: cq-report read our
// own report back via the optional-R regex and auto-logged sent==rcvd with
// no QSO completed — 8 times in a row.
// ============================================================
section('Own-TX echo guard — addressed-to-us matching (N3VD)');
{
  // N3VD's exact scenario: CQ answered by AD9AR, we sent "AD9AR N3VD -11",
  // the next decode batch contains only our own echo.
  const cqQ = () => ({
    mode: 'cq', phase: 'cq-report', call: 'AD9AR', grid: 'EM69',
    txMsg: 'AD9AR N3VD -11', report: null, sentReport: '-11',
    myCall: 'N3VD', myGrid: 'EM17', txRetries: 0,
  });
  {
    const q = cqQ();
    const r = drive(q, [decode('AD9AR N3VD -11', { db: -2 })], makeEngine());
    assertEq(q.phase, 'cq-report', 'own echo does NOT advance cq-report');
    assertEq(r.doneCount, 0, 'own echo does NOT log');
    assertEq(q.report, null, 'own report is NOT recorded as theirs');
  }
  // Echo and the partner's REAL R-report in the same batch → their report wins.
  {
    const q = cqQ();
    const r = drive(q, [
      decode('AD9AR N3VD -11', { db: -2 }),
      decode('N3VD AD9AR R-05', { db: -12 }),
    ], makeEngine());
    assertEq(q.phase, 'cq-rr73', 'real R-report still advances');
    assertEq(q.report, '-05', 'THEIR report recorded, not our echo');
    assertEq(r.doneCount, 0, 'the real R-report queues the RR73; the log waits for it to go out (#807)');
  }
  // Leniency preserved: plain (R-less) report addressed to us still advances.
  {
    const q = cqQ();
    const r = drive(q, [decode('N3VD AD9AR -05', { db: -12 })], makeEngine());
    assertEq(q.phase, 'cq-rr73', 'plain report addressed to us still advances');
    assertEq(q.report, '-05', 'plain report captured');
    assertEq(r.doneCount, 0, 'and logs only when the RR73 goes out (#807)');
  }
  // Reply mode + Skip Grid: our echoed opener carries a report — must not
  // advance with our own report recorded as theirs.
  {
    const q = {
      mode: 'reply', phase: 'reply', call: 'W1ABC', grid: '',
      txMsg: 'W1ABC K3SBP -15', report: null, sentReport: '-15',
      myCall: 'K3SBP', myGrid: 'FN20', txRetries: 0,
    };
    const r = drive(q, [decode('W1ABC K3SBP -15', { db: -1 })], makeEngine());
    assertEq(q.phase, 'reply', 'Skip-Grid own echo does not advance reply phase');
    assertEq(r.doneCount, 0, 'and does not log');
  }
  // Straggler RR73 addressed to us while we are back in CQ phase: RR73
  // satisfies [A-R]{2}\d{2} but is NOT a grid — must not start a phantom QSO.
  {
    const q = {
      mode: 'cq', phase: 'cq', call: null, grid: null,
      txMsg: 'CQ N3VD EM17', report: null, sentReport: null,
      myCall: 'N3VD', myGrid: 'EM17', txRetries: 0,
    };
    const r = drive(q, [decode('N3VD W9XYZ RR73', { db: -9 })], makeEngine());
    assertEq(q.phase, 'cq', 'straggler RR73 does not start a QSO');
    assertEq(q.grid, null, 'RR73 is not captured as a grid');
    assertEq(r.doneCount, 0, 'no log');
  }
}

section('Own-TX echo guard — engine drops echo decodes (REAL lib/ft8-engine.js)');
{
  const Module = require('module');
  const origLoad = Module.prototype.require;
  Module.prototype.require = function (id) {
    if (id === 'worker_threads') {
      return {
        Worker: class FakeWorker {
          constructor() { this._listeners = {}; }
          on(ev, fn) { this._listeners[ev] = fn; }
          postMessage() {}
          terminate() {}
        },
      };
    }
    return origLoad.apply(this, arguments);
  };
  let Ft8Engine;
  try { Ft8Engine = require('../lib/ft8-engine'); } catch { /* skipped below */ }
  Module.prototype.require = origLoad;

  if (Ft8Engine && Ft8Engine.Ft8Engine) {
    const engine = new Ft8Engine.Ft8Engine();
    engine._txMessage = 'AD9AR N3VD -11';
    let got = null;
    engine.on('decode', (d) => { got = d; });
    const logs = [];
    engine.on('log', (m) => logs.push(m));
    engine._onWorkerMessage({
      type: 'decode-result',
      results: [
        { text: 'AD9AR N3VD -11', db: -2, dt: 0.1, df: 350 },   // our echo
        { text: 'N3VD AD9AR R-05', db: -12, dt: 0.2, df: 1420 }, // the partner
      ],
    });
    assert(!!got, 'decode event emitted');
    assertEq(got.results.length, 1, 'own-TX echo filtered from results');
    assertEq(got.results[0].text, 'N3VD AD9AR R-05', 'partner decode survives');
    assert(logs.some((m) => /own-TX echo/.test(m)), 'diagnostic log line emitted');
    // No TX message set → nothing filtered.
    engine._txMessage = '';
    got = null;
    engine._onWorkerMessage({
      type: 'decode-result',
      results: [{ text: 'AD9AR N3VD -11', db: -2, dt: 0.1, df: 350 }],
    });
    assertEq(got.results.length, 1, 'no filtering when not transmitting');
  } else {
    console.log('  (engine echo-filter tests skipped — could not load engine)');
  }
}

// ============================================================
// Group 5: FT8 engine mode handling
// ============================================================
section('FT8 engine — mode handling (FT8/FT4/FT2)');
{
  // Load the engine module. Constructor needs a worker path that exists
  // OR we override _workerReady to avoid spawning the worker thread.
  // Easier: stub the Worker constructor.
  const Module = require('module');
  const origLoad = Module.prototype.require;
  // Stub worker_threads so loading ft8-engine.js doesn't spawn anything.
  Module.prototype.require = function (id) {
    if (id === 'worker_threads') {
      return {
        Worker: class FakeWorker {
          constructor() { this._listeners = {}; }
          on(ev, fn) { this._listeners[ev] = fn; }
          postMessage() {}
          terminate() {}
        },
      };
    }
    return origLoad.apply(this, arguments);
  };
  let Ft8Engine;
  try {
    Ft8Engine = require('../lib/ft8-engine');
  } catch (e) {
    console.log('  (skipping engine tests — could not load:', e.message + ')');
  }
  Module.prototype.require = origLoad;

  if (Ft8Engine && Ft8Engine.Ft8Engine) {
    const engine = new Ft8Engine.Ft8Engine();
    // Defaults
    assertEq(engine._mode, 'FT8', 'default mode is FT8');
    // FT8 cycle = 15s
    assertEq(engine._cycleSec && engine._cycleSec(), 15, 'FT8 cycle = 15s');
    // Switch to FT4
    if (typeof engine.setMode === 'function') {
      engine.setMode('FT4');
      assertEq(engine._mode, 'FT4', 'setMode("FT4") sets _mode');
      assertEq(engine._cycleSec(), 7.5, 'FT4 cycle = 7.5s');
      engine.setMode('FT2');
      assertEq(engine._mode, 'FT2', 'setMode("FT2") sets _mode');
      assertEq(engine._cycleSec(), 3.8, 'FT2 cycle = 3.8s');
      engine.setMode('garbage');
      assertEq(engine._mode, 'FT8', 'unknown mode falls back to FT8');
    }
  } else {
    console.log('  (engine API surface unexpected — skipped runtime tests)');
  }
}

// ============================================================
// Group 6: Pre-encode race (the bug we fixed tonight)
// ============================================================
section('Pre-encode race — concurrent setTxFreq + setTxMessage');
{
  // Build a minimal engine-shaped object that exercises _preEncode.
  // We're testing the BEHAVIOR contract documented in the fix:
  //   - When setTxFreq is called before setTxMessage with both async,
  //     the FINAL _txEncodedMsg/_txEncodedFreq must match the LATEST
  //     values, not whatever was current at the first encode dispatch.
  //
  // We simulate the engine's _preEncode logic inline (matching
  // lib/ft8-engine.js) so the test exercises the algorithm
  // deterministically — synchronous-promise scheduling.
  const inflightEncodes = [];
  let _txMessage = 'OLD K3SBP FN20';
  let _txFreq = 1500;
  let _txEncodedMsg = null;
  let _txEncodedFreq = null;
  let _txEncoding = false;
  let _preEncodePromise = null;
  let _reEncodePending = false;

  function fakeEncode(msg, freq) {
    return new Promise((resolve) => {
      inflightEncodes.push({ msg, freq, resolve });
    });
  }

  function _preEncode() {
    if (!_txMessage) return Promise.resolve();
    if (_txEncoding) {
      _reEncodePending = true;
      return _preEncodePromise || Promise.resolve();
    }
    _txEncoding = true;
    _reEncodePending = false;
    const msgAtDispatch = _txMessage;
    const freqAtDispatch = _txFreq;
    _preEncodePromise = fakeEncode(msgAtDispatch, freqAtDispatch).then(() => {
      _txEncodedMsg = msgAtDispatch;
      _txEncodedFreq = freqAtDispatch;
      _txEncoding = false;
      _preEncodePromise = null;
      const drifted = _txMessage !== msgAtDispatch || _txFreq !== freqAtDispatch;
      if (_reEncodePending || drifted) {
        _reEncodePending = false;
        return _preEncode();
      }
    });
    return _preEncodePromise;
  }

  // setTxFreq with cache-invalidate
  function setTxFreq(hz) {
    _txFreq = hz;
    if (_txEncodedFreq !== _txFreq) _preEncode();
  }
  // setTxMessage triggers preEncode
  function setTxMessage(msg) {
    _txMessage = msg;
    return _preEncode();
  }

  // ============================================================
  // Group: ARRL FIELD DAY exchange (class + section, no dB report)
  // Sequence (CQ side K3SBP, S&P side W1ABC):
  //   CQ FD K3SBP FN20 / K3SBP W1ABC 6A WI / W1ABC K3SBP R 2A EMA / K3SBP W1ABC RR73
  // ============================================================
  section('FIELD DAY — CQ side');
  {
    const baseQ = () => ({
      mode: 'cq', phase: 'cq', call: null, myCall: 'K3SBP', myGrid: 'FN20',
      fd: true, myExch: '2A EMA', txMsg: 'CQ FD K3SBP FN20', txRetries: 0,
    });

    // Answerer's exchange → we send R+exchange, capture their class/section, log
    {
      const eng = makeEngine();
      const r = drive(baseQ(), [decode('K3SBP W1ABC 6A WI', { df: 1490 })], eng);
      assertEq(r.q.phase, 'cq-rr73', 'FD CQ: exchange received → cq-rr73');
      assertEq(r.q.call, 'W1ABC', 'FD CQ: captured answerer call');
      assertEq(r.q.theirClass, '6A', 'FD CQ: captured their class');
      assertEq(r.q.theirSection, 'WI', 'FD CQ: captured their section');
      assertEq(r.q.theirExch, '6A WI', 'FD CQ: captured their exchange');
      assertEq(r.lastTx, 'W1ABC K3SBP R 2A EMA', 'FD CQ: TX our R+exchange');
      assertEq(r.doneCount, 1, 'FD CQ: logs when both exchanges known');
      assertEq(eng._lastRxFreq, 1490, 'FD CQ: RX freq locked to answerer');
    }

    // 2-digit transmitter count + multi-char section
    {
      const r = drive(baseQ(), [decode('K3SBP N0ABC 16C NNJ')], makeEngine());
      assertEq(r.q.theirExch, '16C NNJ', 'FD CQ: 2-digit count + 3-char section');
      assertEq(r.lastTx, 'N0ABC K3SBP R 2A EMA', 'FD CQ: TX R+exchange (2-digit case)');
    }

    // cq-rr73 courtesy: wait one cycle, then done
    {
      const eng = makeEngine();
      const q = baseQ();
      q.phase = 'cq-rr73';
      const r1 = drive(q, [], eng);
      assertEq(r1.q.phase, 'cq-rr73', 'FD CQ: cq-rr73 first cycle waits');
      q._txSentMsg = q.txMsg; // the R+exchange went out
      const r2 = drive(q, [], eng);
      assertEq(r2.q.phase, 'done', 'FD CQ: cq-rr73 second cycle → done');
      assertEq(eng._txEnabled, false, 'FD CQ: TX disabled on done');
      assertEq(eng._lastTxMsg, '', 'FD CQ: TX message cleared on done');
    }

    // Negatives: a standard grid reply and someone else's CQ must not advance
    {
      const r = drive(baseQ(), [decode('K3SBP W1ABC EN37')], makeEngine());
      assertEq(r.q.phase, 'cq', 'FD CQ: standard grid reply does not advance FD QSO');
      const r2 = drive(baseQ(), [decode('CQ FD W1ABC FN42')], makeEngine());
      assertEq(r2.q.phase, 'cq', "FD CQ: another station's CQ FD does not advance");
    }
  }

  section('FIELD DAY — S&P side');
  {
    const baseQ = () => ({
      mode: 'reply', phase: 'reply', call: 'W1ABC', myCall: 'K3SBP', myGrid: 'FN20',
      fd: true, myExch: '2A EMA', txMsg: 'W1ABC K3SBP 2A EMA', txRetries: 0,
    });

    // Their R+exchange → we send RR73, capture their class/section, log
    {
      const r = drive(baseQ(), [decode('K3SBP W1ABC R 6A WI')], makeEngine());
      assertEq(r.q.phase, '73', 'FD S&P: R+exchange received → 73');
      assertEq(r.q.theirClass, '6A', 'FD S&P: captured their class');
      assertEq(r.q.theirSection, 'WI', 'FD S&P: captured their section');
      assertEq(r.lastTx, 'W1ABC K3SBP RR73', 'FD S&P: TX RR73');
      assertEq(r.doneCount, 0, 'FD S&P: not logged at their R+exchange (#807)');
      assert(sm.txLogsQso(r.q, 'W1ABC K3SBP RR73') === true, 'FD S&P: logs when our RR73 goes out');
    }

    // Late RR73 (we missed their R+exchange) still closes the QSO with a 73
    {
      const r = drive(baseQ(), [decode('K3SBP W1ABC RR73')], makeEngine());
      assertEq(r.q.phase, '73', 'FD S&P: late RR73 → 73');
      assertEq(r.lastTx, 'W1ABC K3SBP 73', 'FD S&P: TX courtesy 73 on late RR73');
    }

    // 73 courtesy: wait one cycle, then done
    {
      const eng = makeEngine();
      const q = baseQ();
      q.phase = '73';
      drive(q, [], eng);
      assertEq(q.phase, '73', 'FD S&P: 73 first cycle waits');
      q._txSentMsg = q.txMsg; // the 73 went out
      drive(q, [], eng);
      assertEq(q.phase, 'done', 'FD S&P: 73 second cycle → done');
      assertEq(eng._lastTxMsg, '', 'FD S&P: TX message cleared on done');
    }

    // They work another op — on our TX offset or anywhere → keep calling
    // (WSJT-X parity; no QRM auto-halt, matching the standard reply path).
    {
      const eng = makeEngine();
      eng._txFreq = 1500;
      const r = drive(baseQ(), [decode('N9OTH W1ABC 3A IL', { df: 1500 })], eng);
      assertEq(r.q.phase, 'reply', 'FD S&P: busy on our offset → keep calling (no halt)');
      assertEq(r.q.error, undefined, 'FD S&P: no abort error');
    }
    {
      const eng = makeEngine();
      eng._txFreq = 1500;
      const r = drive(baseQ(), [decode('N9OTH W1ABC 3A IL', { df: 2200 })], eng);
      assertEq(r.q.phase, 'reply', 'FD S&P: busy far from TX keeps calling');
    }
  }

  // Async because the engine's _preEncode returns a promise that we
  // resolve from outside via inflightEncodes[].resolve(). DO NOT await
  // setTxMessage directly — that would deadlock.
  (async () => {
    try {
      // -- Test 1: baseline (no race)
      const p0 = setTxMessage('OLD K3SBP FN20');
      // Microtask flush so _preEncode schedules and pushes to inflightEncodes.
      await new Promise((r) => setImmediate(r));
      const first = inflightEncodes.shift();
      assert(!!first, 'baseline: first encode dispatched');
      assertEq(first && first.msg, 'OLD K3SBP FN20', 'baseline: first encode msg');
      first.resolve();
      await p0;
      assertEq(_txEncodedMsg, 'OLD K3SBP FN20', 'baseline: _txEncodedMsg after resolve');
      assertEq(_txEncoding, false, 'baseline: _txEncoding cleared');

      // -- Test 2: the race
      _txEncodedMsg = null; _txEncodedFreq = null;
      setTxFreq(1234);                            // dispatches encode with OLD msg @ 1234
      await new Promise((r) => setImmediate(r));
      const race1 = inflightEncodes.shift();
      assert(!!race1, 'race: first encode dispatched (from setTxFreq)');
      assertEq(race1 && race1.msg, 'OLD K3SBP FN20', 'race: first encode used the STALE message at dispatch');
      // While that's in flight, the user/click handler updates the message.
      const p2 = setTxMessage('NEW K3SBP FN20');  // _txEncoding=true → sets _reEncodePending
      assertEq(_reEncodePending, true, 'race: _reEncodePending flagged during in-flight');
      // Resolve the stale encode
      race1.resolve();
      await new Promise((r) => setImmediate(r));
      // The fix should have queued a re-encode with the NEW message.
      const race2 = inflightEncodes.shift();
      assert(!!race2, 'race: second encode auto-queued by drift detection');
      if (race2) {
        assertEq(race2.msg, 'NEW K3SBP FN20', 'race fix: second encode uses LATEST message');
        assertEq(race2.freq, 1234, 'race fix: second encode keeps the new freq');
        race2.resolve();
      }
      await p2;
      assertEq(_txEncodedMsg, 'NEW K3SBP FN20', 'race fix: final _txEncodedMsg is the LATEST message');
      assertEq(_txEncodedFreq, 1234, 'race fix: final _txEncodedFreq is the LATEST freq');

      // -- Test 3: multiple drift cycles converge
      // Trigger setTxMessage then immediately again before first resolves.
      _txEncodedMsg = null; _txEncodedFreq = null;
      const pA = setTxMessage('A K3SBP FN20');
      const pB = setTxMessage('B K3SBP FN20');
      const pC = setTxMessage('C K3SBP FN20');
      await new Promise((r) => setImmediate(r));
      // Only the first dispatch should have actually issued an encode;
      // B and C should have set _reEncodePending without dispatching.
      const dispatched = inflightEncodes.shift();
      assertEq(dispatched && dispatched.msg, 'A K3SBP FN20', 'multi-drift: first dispatch is A');
      assertEq(inflightEncodes.length, 0, 'multi-drift: no concurrent dispatches');
      dispatched.resolve();
      await new Promise((r) => setImmediate(r));
      // After A resolves, drift detected → re-encode for the LATEST (C).
      const second = inflightEncodes.shift();
      assertEq(second && second.msg, 'C K3SBP FN20', 'multi-drift: convergence to LATEST (C)');
      second.resolve();
      await Promise.all([pA, pB, pC]);
      assertEq(_txEncodedMsg, 'C K3SBP FN20', 'multi-drift: final state is C');

      // -- Per-phase TX cap policy (decideRetryOutcome) --
      // Hard cap since 2026-07 (KQ4MHD report): EVERY non-advancing cycle
      // counts, heard or not. The old heard-reset let a partner repeating a
      // non-advancing message (their grid, their report) pin retries at 0
      // and hang the QSO forever.
      section('decideRetryOutcome — per-phase TX cap policy');
      const D = sm.decideRetryOutcome;
      assertEq(D({ phase: 'reply', txRetries: 5, maxCq: 15, maxQso: 12, runMode: false, closeoutEligible: false }),
        { retries: 6, action: 'continue' }, 'heard-but-stuck cycles count toward the hard per-phase cap (KQ4MHD)');
      assertEq(D({ phase: 'reply', txRetries: 3, maxCq: 15, maxQso: 12, runMode: false, closeoutEligible: false }),
        { retries: 4, action: 'continue' }, 'under the cap increments and continues');
      assertEq(D({ phase: 'r+report', txRetries: 11, maxCq: 15, maxQso: 12, runMode: false, closeoutEligible: false }),
        { retries: 12, action: 'abort' }, 'cap without exchanged reports aborts when not in run mode');
      assertEq(D({ phase: 'r+report', txRetries: 11, maxCq: 15, maxQso: 12, runMode: true, closeoutEligible: false }),
        { retries: 12, action: 'rearm' }, 'cap re-arms CQ in run mode');
      assertEq(D({ phase: 'r+report', txRetries: 11, maxCq: 15, maxQso: 12, runMode: false, closeoutEligible: true }),
        { retries: 12, action: 'abort', unconfirmed: true }, 'cap with reports both ways: stops unlogged, flagged unconfirmed (#807)');
      assertEq(D({ phase: 'r+report', txRetries: 11, maxCq: 15, maxQso: 12, runMode: true, closeoutEligible: true }),
        { retries: 12, action: 'rearm', unconfirmed: true }, 'run mode re-arms CQ, unlogged (#807)');
      assertEq(D({ phase: 'r+report', txRetries: 3, maxCq: 15, maxQso: 12, runMode: false, closeoutEligible: true }),
        { retries: 4, action: 'continue' }, 'reports both ways never trip the cap early');
      assertEq(D({ phase: 'cq', txRetries: 99, maxCq: 15, maxQso: 12, runMode: true, closeoutEligible: false }),
        { retries: 0, action: 'continue' }, 'cq phase never aborts in run mode (CQ forever)');
      assertEq(D({ phase: 'cq', txRetries: 14, maxCq: 15, maxQso: 12, runMode: false, closeoutEligible: false }),
        { retries: 15, action: 'abort' }, 'manual CQ aborts at maxCq');
      assertEq(D({ phase: 'reply', txRetries: 2, maxCq: 15, maxQso: 3, runMode: false, closeoutEligible: false }),
        { retries: 3, action: 'abort' }, 'configurable max attempts (X=3) aborts at 3');
      assertEq(D({ phase: 'reply', txRetries: 2, maxCq: 15, maxQso: 3, runMode: true, closeoutEligible: false }),
        { retries: 3, action: 'rearm' }, 'configurable X re-arms CQ in run mode');

      // -- Run-mode drained-band pause (decideRunCqPause) --
      // Run used to call CQ into an empty band until the 30-minute attended
      // watchdog killed it. It now stops transmitting once nobody has answered
      // for N CQs AND no unworked station is calling CQ. BOTH conditions are
      // load-bearing: unanswered CQs alone would pause on a busy band where
      // the operator simply isn't being heard (stations are there — keep
      // calling), and an empty caller list alone would pause during a lull
      // mid-pileup.
      section('decideRunCqPause — pause only when the band is genuinely drained');
      const P = sm.decideRunCqPause;
      assertEq(P({ unansweredCqs: 8, maxUnanswered: 8, workableCallers: 0 }),
        { action: 'pause' }, 'cap reached with nobody new calling → pause');
      assertEq(P({ unansweredCqs: 20, maxUnanswered: 8, workableCallers: 0 }),
        { action: 'pause' }, 'well past the cap still pauses');
      assertEq(P({ unansweredCqs: 7, maxUnanswered: 8, workableCallers: 0 }),
        { action: 'continue' }, 'under the cap keeps calling even on a dead band');
      assertEq(P({ unansweredCqs: 30, maxUnanswered: 8, workableCallers: 1 }),
        { action: 'continue' }, 'one workable caller is enough to keep calling (weak-signal case)');
      assertEq(P({ unansweredCqs: 99, maxUnanswered: 0, workableCallers: 0 }),
        { action: 'continue' }, 'maxUnanswered 0 disables the pause entirely (legacy behavior)');
      assertEq(P({ unansweredCqs: 8, maxUnanswered: 8 }),
        { action: 'pause' }, 'missing workableCallers counts as none');
      assertEq(P({}), { action: 'continue' }, 'empty input never pauses');

      // -- Try-counter gate (shouldCountRetry) --
      // A try = a TRANSMISSION. Decode events land every period (including
      // our own TX period and deferred-TX periods); counting each burned the
      // cap twice per QSO cycle — "tries 5" gave up after 3 transmissions
      // (KQ4MHD 2026-08-04).
      section('shouldCountRetry — tries count transmissions, not periods');
      const G = sm.shouldCountRetry;
      assertEq(G({ periodKey: '01:00:15', txPeriodKey: '', lastCountedTxPeriod: '' }),
        false, 'no TX yet → nothing to count');
      assertEq(G({ periodKey: '01:00:00', txPeriodKey: '01:00:00', lastCountedTxPeriod: '' }),
        false, 'TX period\'s own decode → reply window still open, no count');
      assertEq(G({ periodKey: '01:00:15', txPeriodKey: '01:00:00', lastCountedTxPeriod: '' }),
        true, 'the period after a TX counts that TX once');
      assertEq(G({ periodKey: '01:00:30', txPeriodKey: '01:00:00', lastCountedTxPeriod: '01:00:00' }),
        false, 'deferred/held TX periods do not re-count the same TX');
      assertEq(G({ periodKey: '01:00:45', txPeriodKey: '01:00:30', lastCountedTxPeriod: '01:00:00' }),
        true, 'a new TX counts again on its following period');
      // Full QSO-cycle walk: 5 tries = 5 transmissions (TX every other
      // period), not ceil(5/2) = 3 as the old per-period counter produced.
      {
        let counted = 0, lastCounted = '';
        let txPk = '';
        for (let p = 0; p < 10; p++) {
          const pk = '02:00:' + String(p * 15).padStart(2, '0');
          if (p % 2 === 0) txPk = pk; // our TX slot
          if (G({ periodKey: pk, txPeriodKey: txPk, lastCountedTxPeriod: lastCounted })) {
            counted++;
            lastCounted = txPk;
          }
        }
        assertEq(counted, 5, '10 periods / 5 transmissions → exactly 5 tries counted');
      }

      // -- Test 4: drive the REAL lib/ft8-engine.js _preEncode + setTxMessage
      // pipeline with a stubbed encodeMessage, so the algorithm-level
      // simulation above is corroborated by the actual code on disk.
      await testRealEnginePreEncode();

      // -- Test 6: Hunt answers a SPOTTED activator's plain CQ.
      testHuntSpottedFilter();
      testHuntEventFilter();

      // -- Test 7: FTx mode hopping policy (Barry 2026-09-07).
      testModeHop();

      // -- Test 5: Hold TX Freq — auto calls blocked, operator moves honored
      // and re-pinned (WSJT-X "Hold Tx Freq" parity; KF0U 2026-07-17).
      await testHoldTxFreq();
    } catch (err) {
      console.error('  pre-encode race test threw:', err);
      fail++;
    }
    finish();
  })();
}

async function testHoldTxFreq() {
  section('Hold TX Freq — engine gate & operator override (REAL lib/ft8-engine.js)');
  // ft8-engine is already require-cached by testRealEnginePreEncode with the
  // worker_threads stub in place, so a plain require is safe here.
  const Ft8Engine = require('../lib/ft8-engine');
  const eng = new Ft8Engine.Ft8Engine();
  eng._workerReady = true;
  const logs = [];
  eng.on('log', (m) => logs.push(m));

  // 1. Hold ON blocks a plain (auto) setTxFreq.
  eng.setHoldTxFreq(true);
  eng.setTxFreq(2200);
  assertEq(eng._txFreq, 1500, 'hold on: auto setTxFreq blocked, stays at default 1500');
  assert(logs.some((m) => m.includes('ignored') && m.includes('Hold TX Freq')),
    'hold on: blocked call logs the ignore reason');

  // 2. Operator move bypasses the hold AND re-pins.
  logs.length = 0;
  eng.setTxFreq(2200, { operator: true });
  assertEq(eng._txFreq, 2200, 'hold on: operator move honored');
  // 3. …and emits the pin-confirm log naming the new offset.
  assert(logs.some((m) => m.includes('2200') && m.includes('operator')),
    'hold on: operator move logs the new pinned offset');
  // Subsequent auto call parks at the operator value, not the old default.
  eng.setTxFreq(700);
  assertEq(eng._txFreq, 2200, 'hold on: later auto call still blocked — 2200 is the new pin');

  // 5. Clamps still apply on the operator path.
  eng.setTxFreq(50, { operator: true });
  assertEq(eng._txFreq, 100, 'operator move clamps low (50 → 100)');
  eng.setTxFreq(5000, { operator: true });
  assertEq(eng._txFreq, 3000, 'operator move clamps high (5000 → 3000)');

  // 4. Hold OFF: both variants move (operator option inert).
  eng.setHoldTxFreq(false);
  eng.setTxFreq(900);
  assertEq(eng._txFreq, 900, 'hold off: plain setTxFreq moves');
  eng.setTxFreq(1100, { operator: true });
  assertEq(eng._txFreq, 1100, 'hold off: operator variant also moves');

  // 6. Pre-encode invalidation fires on an operator move under hold.
  const inflight = [];
  eng.encodeMessage = function (text, freq) {
    return new Promise((resolve) => inflight.push({ text, freq, resolve }));
  };
  eng._txMessage = 'CQ K3SBP FN20';
  eng._txEncodedMsg = 'CQ K3SBP FN20';
  eng._txEncodedFreq = eng._txFreq;
  eng.setHoldTxFreq(true);
  eng.setTxFreq(1800, { operator: true });
  await new Promise((r) => setImmediate(r));
  assert(inflight.length >= 1, 'operator move under hold dispatches a re-encode');
  if (inflight.length) {
    assertEq(inflight[0].freq, 1800, 're-encode targets the operator frequency');
    inflight[0].resolve(new Float32Array(180000));
  }
  await new Promise((r) => setImmediate(r));
}

async function testRealEnginePreEncode() {
  section('Pre-encode race — REAL lib/ft8-engine.js');
  // Stub worker_threads BEFORE require
  const Module = require('module');
  const origLoad = Module.prototype.require;
  Module.prototype.require = function (id) {
    if (id === 'worker_threads') {
      return {
        Worker: class FakeWorker {
          constructor() { this._listeners = {}; }
          on(ev, fn) { this._listeners[ev] = fn; }
          postMessage() {}
          terminate() {}
        },
      };
    }
    return origLoad.apply(this, arguments);
  };
  delete require.cache[require.resolve('../lib/ft8-engine')]; // force re-load with stub
  let Ft8Engine;
  try {
    Ft8Engine = require('../lib/ft8-engine');
  } catch (e) {
    assert(false, 'could not load lib/ft8-engine.js: ' + e.message);
    Module.prototype.require = origLoad;
    return;
  }
  Module.prototype.require = origLoad;

  const engine = new Ft8Engine.Ft8Engine();
  engine._workerReady = true;
  const inflight = [];
  engine.encodeMessage = function (text, freq) {
    return new Promise((resolve) => inflight.push({ text, freq, resolve }));
  };

  // Race: setTxFreq before setTxMessage
  engine._txMessage = 'OLD K3SBP FN20';
  engine._txFreq = 1500;
  engine._txEncodedMsg = null;
  engine._txEncodedFreq = null;

  engine.setTxFreq(1234); // triggers _preEncode with OLD msg
  const p = engine.setTxMessage('NEW K3SBP FN20'); // sets pending re-encode
  await new Promise((r) => setImmediate(r));
  assert(inflight.length >= 1, 'real engine: first encode dispatched');
  if (inflight.length) {
    const first = inflight.shift();
    assertEq(first.text, 'OLD K3SBP FN20', 'real engine: first encode saw the stale message at dispatch');
    // Provide samples — engine truncates to FT8_TX_SAMPLES
    first.resolve(new Float32Array(180000));
  }
  await new Promise((r) => setImmediate(r));
  assert(inflight.length >= 1, 'real engine: second encode queued by drift detection');
  if (inflight.length) {
    const second = inflight.shift();
    assertEq(second.text, 'NEW K3SBP FN20', 'real engine: second encode uses LATEST message');
    assertEq(second.freq, 1234, 'real engine: second encode uses LATEST freq');
    second.resolve(new Float32Array(180000));
  }
  await p;
  await new Promise((r) => setImmediate(r));
  assertEq(engine._txEncodedMsg, 'NEW K3SBP FN20', 'real engine: final encoded msg is LATEST');
  assertEq(engine._txEncodedFreq, 1234, 'real engine: final encoded freq is LATEST');
  assertEq(engine._txEncoding, false, 'real engine: _txEncoding cleared after settle');
  assertEq(engine._reEncodePending, false, 'real engine: _reEncodePending cleared after settle');
}

function testHuntSpottedFilter() {
  section('Hunt filter — spotted activators calling a plain CQ');
  const m = sm.matchesHuntFilter;

  // The rule that already existed, unchanged.
  assert(m('CQ POTA K1ABC FN42', 'pota') === true, 'CQ POTA still matches POTA hunt');
  assert(m('CQ SOTA W6XYZ DM07', 'sota') === true, 'CQ SOTA still matches SOTA hunt');
  assert(m('CQ K1ABC FN42', 'all') === true, 'any CQ matches All CQs');
  assert(m('CQ FD W1AW 2A EMA', 'fd') === true, 'CQ FD matches Field Day hunt');
  assert(m('CQ K1ABC FN42', 'pota') === false, 'plain CQ from an UNSPOTTED station is not POTA');

  // The feature: a plain CQ from someone the spot list places at a park.
  // Most activators never send the POTA modifier — it costs characters and
  // buys them nothing — so this was an entire activation the hunt could hear
  // and would not answer (2026-09-02).
  assert(m('CQ K1ABC FN42', 'pota', { spottedSigs: ['POTA'] }) === true,
    'plain CQ from a POTA-spotted station matches POTA hunt');
  assert(m('CQ DX K1ABC FN42', 'pota', { spottedSigs: ['POTA'] }) === true,
    'CQ DX from a POTA-spotted station matches too (any CQ wording)');
  assert(m('CQ W6XYZ DM07', 'sota', { spottedSigs: ['SOTA'] }) === true,
    'plain CQ from a SOTA-spotted station matches SOTA hunt');

  // ...and it stays a PROGRAM filter: the right program, or no match.
  assert(m('CQ K1ABC FN42', 'pota', { spottedSigs: ['SOTA'] }) === false,
    'a SOTA-spotted station does not satisfy POTA hunt');
  assert(m('CQ K1ABC FN42', 'sota', { spottedSigs: ['POTA'] }) === false,
    'a POTA-spotted station does not satisfy SOTA hunt');
  assert(m('CQ K1ABC FN42', 'pota', { spottedSigs: ['WWFF', 'POTA'] }) === true,
    'an n-fer spotted in several programs matches on the one being hunted');

  // Never answer something that is not a CQ. "Whether or not they called CQ
  // POTA" is about the CQ's wording — calling a station who is mid-QSO with
  // somebody else is how you QRM the activation you came to work.
  assert(m('K1ABC W9XYZ -12', 'pota', { spottedSigs: ['POTA'] }) === false,
    'a report addressed to another station is never a hunt candidate');
  assert(m('K1ABC W9XYZ RR73', 'pota', { spottedSigs: ['POTA'] }) === false,
    'a spotted activator\'s RR73 to someone else is not answered (no tail-ending)');
  assert(m('CQCQ K1ABC', 'all') === false, 'malformed CQ without a space is not a CQ');

  // The operator can switch it off and get the literal-modifier rule back.
  assert(m('CQ K1ABC FN42', 'pota', { spottedSigs: ['POTA'], spottedEnabled: false }) === false,
    'setting off: a spotted plain CQ is not matched');
  assert(m('CQ POTA K1ABC FN42', 'pota', { spottedSigs: [], spottedEnabled: false }) === true,
    'setting off: an explicit CQ POTA still matches');

  // Field Day is not a spotting program — never spot-matched.
  assert(m('CQ K1ABC FN42', 'fd', { spottedSigs: ['POTA'] }) === false,
    'Field Day hunt is never satisfied by a spot');
}

function testHuntEventFilter() {
  section('Hunt filter — event stations still needed (Route 66 / 13 Colonies)');
  const m = sm.matchesHuntFilter;

  // The station qualifies, not the message: main supplies eventNeeded from
  // the same needed/new-slot/worked classification the decode badge shows.
  assert(m('CQ W6K EM15', 'event', { eventNeeded: true }) === true,
    'plain CQ from a needed event station matches Event hunt');
  assert(m('CQ NA W6K EM15', 'event', { eventNeeded: true }) === true,
    'CQ with any wording matches (CQ NA)');
  assert(m('CQ POTA W6K EM15', 'event', { eventNeeded: true, spottedSigs: ['POTA'] }) === true,
    'an event station that also calls CQ POTA matches');
  assert(m('CQ W6K EM15', 'event', { eventNeeded: false }) === false,
    'a worked (or non-event) station is not answered');
  assert(m('CQ W6K EM15', 'event') === false,
    'no opts at all → not needed → not answered (never a default yes)');
  assert(m('CQ W6AB CM87', 'event', { eventNeeded: false }) === false,
    'an ordinary W6 call is not an event station');

  // Still a CQ-only hunt: a needed station mid-QSO with someone else is
  // left alone — same no-tail-ending rule as the spotted-activator hunt.
  assert(m('W6K K3SBP -10', 'event', { eventNeeded: true }) === false,
    'a report from a needed station to someone else is never answered');
  assert(m('W6K K3SBP RR73', 'event', { eventNeeded: true }) === false,
    'a needed station\'s RR73 to someone else is not tail-ended');

  // eventNeeded means nothing to the other modes.
  assert(m('CQ W6K EM15', 'pota', { eventNeeded: true }) === false,
    'event-needed does not satisfy POTA hunt');
  assert(m('CQ W6K EM15', 'fd', { eventNeeded: true }) === false,
    'event-needed does not satisfy Field Day hunt');
  assert(m('CQ W6K EM15', 'all', { eventNeeded: false }) === true,
    'All CQs is unaffected by eventNeeded');
}

function finish() {
  console.log('\n' + '='.repeat(60));
  console.log(`Results: ${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log('\nFAILURES:');
    for (const f of failures) console.log('  - ' + f.msg);
    process.exit(1);
  } else {
    console.log('All tests passed.');
    process.exit(0);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// FTx mode hopping (lib/jtcat-modehop.js) — Barry's "FT4/FT2 are deserted"
// request, 2026-09-07. Policy only; main.js owns the QSY.
function testModeHop() {
  section('Mode hop — idle-driven FT8/FT4/FT2 carousel');
  const mh = require('../lib/jtcat-modehop');

  // -- The minutes→periods conversion is the whole reason the setting is in
  // minutes. A single "12 periods" would be 3 minutes on FT8 and 45 seconds
  // on FT2; "3 minutes" has to mean three minutes in every mode.
  assertEq(mh.periodsForMinutes(3, 'FT8'), 12, '3 min of FT8 = 12 periods');
  assertEq(mh.periodsForMinutes(3, 'FT4'), 24, '3 min of FT4 = 24 periods');
  assertEq(mh.periodsForMinutes(3, 'FT2'), 48, '3 min of FT2 = 48 periods (3.8s cycle, rounded up)');
  assertEq(mh.periodsForMinutes(0, 'FT8'), 1, 'a zero/garbage idle time still waits one period');
  assertEq(mh.periodsForMinutes(-5, 'FT8'), 1, 'a negative idle time still waits one period');

  // -- Chip order must not become hop order, or two operators with the same
  // three modes enabled walk them differently.
  assertEq(mh.normalizeModes(['FT2', 'FT8', 'FT4']), ['FT8', 'FT4', 'FT2'], 'modes come back in canonical order');
  assertEq(mh.normalizeModes(['ft4', 'FT4']), ['FT4'], 'lowercase accepted, duplicates collapsed');
  assertEq(mh.normalizeModes(['FT8', 'JS8', 'WSPR', 'PSK31']), ['FT8'], 'non-FT-family modes are dropped');
  assertEq(mh.normalizeModes(null), [], 'a missing list is an empty list, not a throw');

  // -- Carousel.
  assertEq(mh.nextMode(['FT8', 'FT4', 'FT2'], 'FT8'), 'FT4', 'FT8 steps to FT4');
  assertEq(mh.nextMode(['FT8', 'FT4', 'FT2'], 'FT2'), 'FT8', 'the last mode wraps to the first');
  assertEq(mh.nextMode(['FT8', 'FT2'], 'FT8'), 'FT2', 'a two-mode set skips the mode between them');
  assertEq(mh.nextMode(['FT8'], 'FT8'), null, 'a one-mode set has nowhere to go');
  // Sitting on a mode you excluded: enter the set rather than refuse.
  assertEq(mh.nextMode(['FT4', 'FT2'], 'FT8'), 'FT4', 'a mode outside the set enters at the first member');

  const base = { enabled: true, modes: ['FT8', 'FT4', 'FT2'], current: 'FT8', quietPeriods: 12, quietThreshold: 12, hopsSinceContact: 0 };
  const D = (over) => mh.decideModeHop({ ...base, ...over });

  assertEq(D({ enabled: false }).action, 'stay', 'disabled never hops');
  assertEq(D({ enabled: false }).reason, 'off', 'disabled reports off');
  // "on but nowhere to go" is a different operator-visible state from "off".
  assertEq(D({ modes: ['FT8'] }).reason, 'need-two-modes', 'one enabled mode reports need-two-modes');
  assertEq(D({ current: 'JS8' }).reason, 'not-ft-family', 'JS8 is never hopped out of');
  assertEq(D({ current: 'WSPR' }).reason, 'not-ft-family', 'WSPR is never hopped out of (it has its own band hop)');
  assertEq(D({ current: 'PSK31' }).reason, 'not-ft-family', 'PSK31 is never hopped out of');
  assertEq(D({ quietPeriods: 11 }).reason, 'not-idle-yet', 'one period short of the threshold does not hop');
  assertEq(D({ quietPeriods: 11 }).action, 'stay', 'one period short of the threshold stays');

  const hop = D({});
  assertEq(hop.action, 'hop', 'idle at threshold hops');
  assertEq(hop.mode, 'FT4', 'idle FT8 hops to FT4');
  assertEq(hop.lap, false, 'the first hop of a lap is not a completed lap');

  // -- Lap: three enabled modes, three hops with nobody workable anywhere.
  // The hop still happens (bands open again; the carousel should keep
  // turning) but it flags the lap so the ULTRACAT Hunt→CQ fallback — the
  // operator's OTHER answer to a dead band — stops being starved by it.
  const lapped = D({ hopsSinceContact: 3 });
  assertEq(lapped.action, 'hop', 'a completed lap still hops');
  assertEq(lapped.lap, true, 'a completed lap is flagged');
  assertEq(lapped.reason, 'idle-lap-complete', 'a completed lap says so in the reason');
  assertEq(D({ hopsSinceContact: 2 }).lap, false, 'two hops of a three-mode set is not yet a lap');
  // A lap while RUNNING is different: we have called CQ into every mode and
  // nobody came back, so the carousel stops and lets run mode pause. A lap
  // while merely hunting keeps circling, because listening costs nothing.
  assertEq(D({ hopsSinceContact: 3, runActive: true }).action, 'stay', 'a completed lap in run mode stops hopping');
  assertEq(D({ hopsSinceContact: 3, runActive: true }).reason, 'lap-complete-run-should-pause', 'and says why, so run mode can pause');
  assertEq(D({ hopsSinceContact: 2, runActive: true }).action, 'hop', 'a run mid-lap still hops');
  assertEq(D({ hopsSinceContact: 3, runActive: false }).action, 'hop', 'a completed lap while only hunting keeps circling');
  // Lap length follows the ENABLED set, not FT_MODES.
  assertEq(D({ modes: ['FT8', 'FT4'], hopsSinceContact: 2 }).lap, true, 'a two-mode set laps after two hops');

  // -- Availability is the caller's job: main passes only modes that have a
  // dial on the current band, so 6m (no FT2 watering hole) simply never
  // offers FT2 rather than hopping to a frequency that does not exist.
  assertEq(D({ modes: ['FT8', 'FT4'], current: 'FT4' }).mode, 'FT8', '6m-style set (no FT2) wraps FT4 back to FT8');
}
