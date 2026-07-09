#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';
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
function drive(qIn, results, engine) {
  let lastTx = null;
  let doneCount = 0;
  sm.advanceJtcatQso(
    qIn,
    results,
    (m) => { lastTx = m; },
    () => { doneCount++; },
    { engine, log: () => {} },
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
    assertEq(r.doneCount, 1, 'logged at first R+report');
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

  // Courtesy 73 cycle: phase=73 first call → wait one cycle
  {
    const q = baseQ();
    q.phase = '73';
    q.txMsg = 'W1ABC K3SBP 73';
    const eng = makeEngine();
    const r = drive(q, [], eng);
    assertEq(r.q.phase, '73', 'phase=73 first cycle stays in 73 (courtesy wait)');
    assertEq(r.q._courtesySent, true, '_courtesySent flag set');
  }
  // Second cycle: terminate
  {
    const q = baseQ();
    q.phase = '73';
    q._courtesySent = true;
    q.txMsg = 'W1ABC K3SBP 73';
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

  // Busy decode does not reset retries → ceiling aborts eventually
  {
    const out = sm.decideRetryOutcome({ phase: 'reply', txRetries: 11, heard: false, maxCq: 99, maxQso: 12, runMode: false });
    assertEq(out.action, 'abort', 'unheard busy cycles hit the per-QSO ceiling → abort');
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
// Group 2: CQ-mode state transitions
// ============================================================
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
    assertEq(r.doneCount, 1, 'logged at R+report');
  }

  // Their response had no report yet (heard but no advance)
  {
    const q = baseQ();
    q.phase = 'cq-report';
    q.call = 'A1BCD';
    const r = drive(q, [decode('K3SBP A1BCD AB20')], makeEngine());
    assertEq(r.q.phase, 'cq-report', 'no advance — repeated their grid, no report yet');
    assert(r.q._heardThisCycle === true, '_heardThisCycle set so retries don\'t expire');
  }

  // Courtesy RR73 cycle
  {
    const q = baseQ();
    q.phase = 'cq-rr73';
    const eng = makeEngine();
    const r = drive(q, [], eng);
    assertEq(r.q.phase, 'cq-rr73', 'first cycle stays — courtesy wait');
    assertEq(r.q._courtesySent, true, '_courtesySent set');
  }
  {
    const q = baseQ();
    q.phase = 'cq-rr73';
    q._courtesySent = true;
    const eng = makeEngine();
    const r = drive(q, [], eng);
    assertEq(r.q.phase, 'done', 'second cycle → done');
    assertEq(eng._txEnabled, false, 'TX disabled');
  }

  // Compressed reply (no Step-2 grid) — partner sends `<MY> <THEM> <±NN>`.
  // We ack with R+report and jump straight to cq-rr73 + log. Matches the
  // KB2ELA-style decode that previously sat ignored for entire cycles
  // because the grid-only matcher couldn't see it. K3SBP 2026-06-01.
  {
    const eng = makeEngine();
    const r = drive(baseQ(), [decode('K3SBP A1BCD -12', { db: -6, df: 1234 })], eng);
    assertEq(r.q.phase, 'cq-rr73', 'cq → cq-rr73 on compressed (no-grid) reply');
    assertEq(r.q.call, 'A1BCD', 'captured their call from compressed reply');
    assertEq(r.q.grid, '', 'grid is empty — they skipped Step 2');
    assertEq(r.q.report, '-12', 'captured their report of us');
    assertEq(r.q.sentReport, '-06', 'computed our SNR report');
    assertEq(r.lastTx, 'A1BCD K3SBP R-06', 'TX is R+our-report, NOT plain report or RR73');
    assertEq(r.doneCount, 1, 'logged immediately on compressed-reply advance');
    assertEq(eng._lastRxFreq, 1234, 'RX freq tracked to their offset');
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
  // Cycle 4: courtesy wait
  drive(q, [], makeEngine());
  assertEq(q.phase, '73', 'arc-4: courtesy wait (still 73)');
  // Cycle 5: terminate
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
  assertEq(d2, 1, 'cq-arc-2: logged at R-report');
  drive(q2, [], makeEngine()); // courtesy
  assertEq(q2.phase, 'cq-rr73', 'cq-arc-3: courtesy wait');
  drive(q2, [], makeEngine());
  assertEq(q2.phase, 'done', 'cq-arc-4: done');
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
  assertEq(r.doneCount, 1, 'logs when both reports are in hand');
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
  assertEq(r.doneCount, 1, 'logs at R-report receipt');
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
      assertEq(r.doneCount, 1, 'FD S&P: logs on RR73');
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

      // -- ULTRACAT: Full Auto CQ retry-outcome policy (decideRetryOutcome) --
      section('ULTRACAT decideRetryOutcome — Full Auto CQ retry policy');
      const D = sm.decideRetryOutcome;
      assertEq(D({ phase: 'reply', txRetries: 5, heard: true, maxCq: 15, maxQso: 12, runMode: false }),
        { retries: 0, action: 'continue' }, 'heard partner resets retries and continues');
      assertEq(D({ phase: 'reply', txRetries: 3, heard: false, maxCq: 15, maxQso: 12, runMode: false }),
        { retries: 4, action: 'continue' }, 'miss under limit increments and continues');
      assertEq(D({ phase: 'r+report', txRetries: 11, heard: false, maxCq: 15, maxQso: 12, runMode: false }),
        { retries: 12, action: 'abort' }, 'QSO retry limit aborts when not in run mode');
      assertEq(D({ phase: 'r+report', txRetries: 11, heard: false, maxCq: 15, maxQso: 12, runMode: true }),
        { retries: 12, action: 'rearm' }, 'QSO retry limit re-arms CQ in run mode');
      assertEq(D({ phase: 'cq', txRetries: 99, heard: false, maxCq: 15, maxQso: 12, runMode: true }),
        { retries: 0, action: 'continue' }, 'cq phase never aborts in run mode (CQ forever)');
      assertEq(D({ phase: 'cq', txRetries: 14, heard: false, maxCq: 15, maxQso: 12, runMode: false }),
        { retries: 15, action: 'abort' }, 'manual CQ aborts at maxCq');
      assertEq(D({ phase: 'reply', txRetries: 2, heard: false, maxCq: 15, maxQso: 3, runMode: false }),
        { retries: 3, action: 'abort' }, 'configurable max attempts (X=3) aborts at 3');
      assertEq(D({ phase: 'reply', txRetries: 2, heard: false, maxCq: 15, maxQso: 3, runMode: true }),
        { retries: 3, action: 'rearm' }, 'configurable X re-arms CQ in run mode');

      // -- Test 4: drive the REAL lib/ft8-engine.js _preEncode + setTxMessage
      // pipeline with a stubbed encodeMessage, so the algorithm-level
      // simulation above is corroborated by the actual code on disk.
      await testRealEnginePreEncode();
    } catch (err) {
      console.error('  pre-encode race test threw:', err);
      fail++;
    }
    finish();
  })();
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
