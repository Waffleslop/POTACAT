'use strict';
// Run answers the stations waiting on it (W5XY 2026-11-25: "after working a
// station I call CQ again instead of working the next person in line"; N8PFK
// kept calling while Run kept calling CQ).
//   lib/jtcat-run-callers.js  remembers who called us and picks who Run answers.
//   main.js                    feeds it every cycle while Run is on, and asks it
//                              before every re-armed CQ (rearmCq) and while the
//                              CQ is listening (jtcatRunCallersTick).
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');

const ROOT = path.join(__dirname, '..');
const vm = require('vm');
let passed = 0;
const failures = [];
const pending = [];
function test(name, fn) {
  pending.push(async () => {
    try { await fn(); passed++; console.log('  ok  ' + name); }
    catch (e) { failures.push(name); console.log('  FAIL ' + name + '\n       ' + String((e && e.message) || e).split('\n').join('\n       ')); }
  });
}

let R = null;
try { R = require('../lib/jtcat-run-callers'); } catch (e) { R = null; }
function lib() { assert.ok(R, 'lib/jtcat-run-callers.js exists'); return R; }
const SM = require('../lib/jtcat-state-machine');
const HuntFilters = require('../lib/jtcat-hunt-filters');

const ME = 'W5XY';
const FT8 = 15;
const T0 = 1_000_000;
const SCOPE = '20M|FT8';
const dec = (text, db, extra) => Object.assign({ text, db, df: 1200, slot: 'odd' }, extra || {});
const strongest = (list) => HuntFilters.rankCallers(list, { priority: 'strongest', myGrid: 'EM12' });

function queueWith(cycles) {
  const q = new (lib().RunCallerQueue)();
  for (const [t, results] of cycles) q.note(results, ME, t, SCOPE);
  return q;
}
function pickAt(q, nowMs, more) {
  return q.pick(Object.assign({ nowMs, windowMs: lib().windowMs(FT8), scope: SCOPE, rank: strongest }, more || {}));
}
// Start a CQ-side QSO from the picked caller the way main.js does.
function startFrom(entry) {
  const shell = { mode: 'cq', phase: 'cq', call: null, grid: null, txMsg: '', report: null, sentReport: null, myCall: ME, myGrid: 'EM12', txRetries: 0 };
  let msg = '';
  SM.advanceJtcatQso(shell, [lib().answerDecode(entry, ME)], (m) => { msg = m; }, () => {}, {});
  return { shell, msg };
}

test('several callers during a QSO: when it ends, the best is answered, not CQ', () => {
  const q = queueWith([
    [T0, [dec('W5XY N8PFK EM79', -14), dec('W5XY K1ABC FN42', -3), dec('K9XYZ W5XY -10', null)]],
    [T0 + 15000, [dec('W5XY N8PFK EM79', -12), dec('W5XY KD0AA EN34', -20)]],
  ]);
  const p = pickAt(q, T0 + 30000);
  assert.ok(p.best, 'somebody is waiting');
  assert.strictEqual(p.best.call, 'K1ABC', 'Who goes first: strongest');
  assert.strictEqual(p.ranked.length, 3);
  const { shell, msg } = startFrom(p.best);
  assert.strictEqual(shell.phase, 'cq-report');
  assert.strictEqual(shell.call, 'K1ABC');
  assert.strictEqual(msg, 'K1ABC W5XY -03');
});

test('a caller latest message wins: N8PFK re-heard keeps the newer level', () => {
  const q = queueWith([[T0, [dec('W5XY N8PFK EM79', -20)]], [T0 + 15000, [dec('W5XY N8PFK EM79', -8)]]]);
  const p = pickAt(q, T0 + 15000);
  assert.strictEqual(p.best.db, -8);
});

test('a caller who sent a report instead of a grid is answered with R+report', () => {
  const q = queueWith([[T0, [dec('W5XY N8PFK -12', -9)]]]);
  const p = pickAt(q, T0 + 15000);
  assert.strictEqual(p.best.kind, 'report');
  const { shell, msg } = startFrom(p.best);
  assert.strictEqual(shell.phase, 'cq-r-report');
  assert.strictEqual(shell.report, '-12');
  assert.strictEqual(msg, 'N8PFK W5XY R-09');
});

test('a caller still sending R+report (a QSO Run gave up on) gets a fresh report, not RR73', () => {
  const q = queueWith([[T0, [dec('W5XY N8PFK R-12', -11)]]]);
  const p = pickAt(q, T0 + 15000);
  assert.strictEqual(p.best.kind, 'rreport');
  const { shell, msg } = startFrom(p.best);
  assert.strictEqual(shell.phase, 'cq-report');
  assert.strictEqual(msg, 'N8PFK W5XY -11');
});

test('a hashed or two-call nonstandard caller is a caller', () => {
  assert.deepStrictEqual(lib().parseCaller('<W5XY> PJ4/K1ABC', ME), { call: 'PJ4/K1ABC', kind: 'bare', grid: '', report: '' });
  assert.strictEqual(lib().parseCaller('W5XY <N8PFK> EM79', ME).call, 'N8PFK');
});

test('RR73 / RRR / 73, CQs, our own echo and compound messages are not callers', () => {
  const P = lib().parseCaller;
  for (const t of ['W5XY N8PFK RR73', 'W5XY N8PFK RRR', 'W5XY N8PFK 73', 'CQ W5XY EM12', 'N8PFK W5XY -10',
    'K1ABC RR73; W5XY <N8PFK> -07', 'W5XYZ N8PFK EM79', 'W5XY K1ABC 2A EMA']) {
    assert.strictEqual(P(t, ME), null, t);
  }
});

test('a worked caller is skipped (and named for the log)', () => {
  const q = queueWith([[T0, [dec('W5XY N8PFK EM79', 0), dec('W5XY K1ABC FN42', -15)]]]);
  const p = pickAt(q, T0 + 15000, { isBlocked: (c) => (c === 'N8PFK' ? 'already worked on 20M FT8' : '') });
  assert.strictEqual(p.best.call, 'K1ABC');
  assert.deepStrictEqual(p.blocked, [{ call: 'N8PFK', why: 'already worked on 20M FT8' }]);
  assert.strictEqual(q.firstSkipNote('N8PFK'), true);
  assert.strictEqual(q.firstSkipNote('N8PFK'), false, 'logged once per Run, not every cycle');
});

test('the station just worked is never re-answered', () => {
  const q = queueWith([[T0, [dec('W5XY K1ABC FN42', 0), dec('W5XY N8PFK EM79', -15)]]]);
  const p = pickAt(q, T0 + 15000, { exclude: ['K1ABC'] });
  assert.strictEqual(p.best.call, 'N8PFK');
  q.forget('N8PFK');
  assert.strictEqual(pickAt(q, T0 + 15000, { exclude: ['K1ABC'] }).best, null);
});

test('nobody waiting gives CQ (no pick)', () => {
  const q = queueWith([[T0, [dec('CQ K1ABC FN42', 0), dec('K9XYZ N8PFK EM79', -3)]]]);
  assert.strictEqual(pickAt(q, T0 + 15000).best, null);
  assert.strictEqual(pickAt(new (lib().RunCallerQueue)(), T0).best, null);
});

test('a caller older than the window is dropped (4 periods: 60 s FT8, 30 s FT4)', () => {
  assert.strictEqual(lib().windowMs(15), 60000);
  assert.strictEqual(lib().windowMs(7.5), 30000);
  const q = queueWith([[T0, [dec('W5XY N8PFK EM79', -5)]]]);
  assert.ok(pickAt(q, T0 + 60000).best, 'still inside the window');
  assert.strictEqual(pickAt(q, T0 + 60001).best, null, 'past it');
  assert.strictEqual(q.waiting(T0 + 60001, 60000).length, 0, 'and forgotten');
});

test('a waiting station heard calling CQ, working someone else or signing off is dropped', () => {
  const q = queueWith([[T0, [dec('W5XY N8PFK EM79', -5), dec('W5XY K1ABC FN42', -5), dec('W5XY KD0AA EN34', -5)]]]);
  q.note([dec('CQ N8PFK EM79', -5, { call: 'N8PFK' }), dec('K9XYZ K1ABC -07', -5), dec('W5XY KD0AA 73', -5)], ME, T0 + 15000, SCOPE);
  assert.strictEqual(pickAt(q, T0 + 15000).best, null);
});

test('the TX slot lock applies; another band or mode is not answered; no signal floor', () => {
  const q = queueWith([[T0, [dec('W5XY N8PFK EM79', -26), dec('W5XY K1ABC FN42', -5, { slot: 'even' })]]]);
  q.note([dec('W5XY KD0AA EN34', 0)], ME, T0, '40M|FT8');
  const p = pickAt(q, T0 + 15000, { slotOk: (s) => s !== 'even', passesFloor: () => false });
  assert.strictEqual(p.best.call, 'N8PFK', 'a -26 dB caller is answered; the lib has no floor');
  assert.strictEqual(p.ranked.length, 1);
});

test('a QSO Run gave up on may be answered once more, a finished one never', () => {
  const q = new (lib().RunCallerQueue)();
  const k = 'N8PFK|20M|FT8';
  assert.strictEqual(q.mayRetry(k), false, 'never tried');
  q.noteAbandoned(k);
  assert.strictEqual(q.mayRetry(k), true, 'one more try while they keep calling');
  q.noteAbandoned(k);
  assert.strictEqual(q.mayRetry(k), false, 'given up twice: no more');
  q.noteAbandoned('K1ABC|20M|FT8');
  q.noteCompleted('K1ABC|20M|FT8');
  assert.strictEqual(q.mayRetry('K1ABC|20M|FT8'), false);
});

test('the CAT log line names the caller and why', () => {
  const line = lib().answerLogLine({ call: 'N8PFK', db: -12 }, { afterQso: true, more: 1 });
  assert.strictEqual(line, '[JTCAT] Run: answering N8PFK (-12 dB), who called during the last QSO; 1 more waiting');
});

test('Field Day: the CQ side is unchanged (state machine ladder, no queue)', () => {
  const shell = { mode: 'cq', phase: 'cq', fd: true, myExch: '2A EMA', call: null, txMsg: '', myCall: ME, myGrid: 'EM12', txRetries: 0 };
  let msg = '';
  SM.advanceJtcatQso(shell, [dec('W5XY K1ABC 6A WI', -5)], (m) => { msg = m; }, () => {}, {});
  assert.strictEqual(shell.phase, 'cq-rr73');
  assert.strictEqual(msg, 'K1ABC W5XY R 2A EMA');
  assert.strictEqual(lib().parseCaller('W5XY K1ABC 6A WI', ME), null, 'an FD exchange is not queued');
});

test('an AP-only decode is never remembered', () => {
  const q = queueWith([[T0, [dec('W5XY N8PFK EM79', -24, { ap: true }), dec('W5XY K1ABC FN42', -24, { ap: 'a2' })]]]);
  assert.strictEqual(q.waiting(T0, 60000).length, 0);
  assert.strictEqual(pickAt(q, T0).best, null);
});

test('after a QSO only a caller heard twice, or in the last T/R cycle, is answered', () => {
  const q = new (lib().RunCallerQueue)();
  q.note([dec('W5XY K1ABC FN42', -3)], ME, T0, SCOPE, 60000);              // once, then nothing
  q.note([dec('W5XY N8PFK EM79', -15)], ME, T0, SCOPE, 60000);
  q.note([], ME, T0 + 15000, SCOPE, 60000);
  q.note([dec('W5XY N8PFK EM79', -15)], ME, T0 + 30000, SCOPE, 60000);    // N8PFK twice
  q.note([], ME, T0 + 45000, SCOPE, 60000);
  const p = pickAt(q, T0 + 45000, { confirmedOnly: true });
  assert.strictEqual(p.best.call, 'N8PFK', 'the one-off K1ABC decode 45 s ago is not answered, though stronger');
  const q2 = new (lib().RunCallerQueue)();
  q2.note([dec('W5XY K1ABC FN42', -3)], ME, T0, SCOPE, 60000);
  assert.strictEqual(pickAt(q2, T0, { confirmedOnly: true }).best.call, 'K1ABC', 'heard in the cycle in hand');
  q2.note([], ME, T0 + 15000, SCOPE, 60000);
  assert.strictEqual(pickAt(q2, T0 + 15000, { confirmedOnly: true }).best.call, 'K1ABC', 'their latest period, one cycle back');
  q2.note([], ME, T0 + 30000, SCOPE, 60000);
  assert.strictEqual(pickAt(q2, T0 + 30000, { confirmedOnly: true }).best, null, 'older and heard once: not answered');
  assert.strictEqual(pickAt(q2, T0 + 30000).best.call, 'K1ABC', 'still in the window without the rule');
});

// --- main.js wiring --------------------------------------------------------
const main = readSrc(path.join(ROOT, 'main.js'));
function fnBody(name) {
  const i = main.indexOf('function ' + name + '(');
  assert.ok(i >= 0, name + ' exists');
  return main.slice(i, main.indexOf('\n}\n', i));
}

test('rearmCq answers a waiting caller before it builds a CQ', () => {
  const b = fnBody('rearmCq');
  const a = b.indexOf('jtcatRunAnswerWaiting(owner');
  assert.ok(a > 0 && a < b.indexOf('jtcatBuildCqQso('), 'asks the queue first');
});

test('Run serves callers only with "Answer stations that call me" on, auto-seq on, not Field Day, not Hound', () => {
  const b = fnBody('jtcatRunServesCallers');
  for (const s of ['jtcatFullAutoCq', 'settings.jtcatAnswerCallers !== false', '_autoSeqEnabled()', '!jtcatFdContext()', '!settings.jtcatHoundMode']) {
    assert.ok(b.includes(s), s);
  }
});

test('a session deadline check has its place above the answer in rearmCq', () => {
  const b = fnBody('rearmCq');
  const note = b.indexOf('belongs ABOVE');
  assert.ok(note > b.indexOf('jtcatFullAutoCqOwner !== owner') && note < b.indexOf('jtcatRunAnswerWaiting('));
});

test('the answer keeps the dupe policy, slot lock, ranking, SWR latch and Hold TX; no signal floor', () => {
  const b = fnBody('jtcatRunAnswerWaiting');
  assert.ok(!/JtcatSnrFloor|passesFloor/.test(b), "Hunt's signal floor is not Run's");
  for (const s of ['jtcatRunCallerBlocked(', 'confirmedOnly: true', '_jtcatQsoClock.note(best.call', 'JtcatTxSlot.workableUnderLock(', 'HuntFilters.rankCallers(', '_swrTripped', 'jtcatReplySlot(', 'JtcatRunCallers.answerLogLine(']) {
    assert.ok(b.includes(s), s);
  }
  assert.ok(!/setTxFreq\(/.test(b), 'Run keeps its TX frequency');
  const w = fnBody('jtcatRunCallerBlocked');
  for (const s of ['HuntFilters.isIgnored(', 'jtcatLogReviews.holds(', 'jtcatWorkedInfo(', 'jtcatRunCallers.mayRetry(']) assert.ok(w.includes(s), s);
});

test('both decode paths feed the queue before the done blocks re-arm', () => {
  const single = main.indexOf('jtcatRunCallersTick(data.results || []);');
  assert.ok(single > 0);
  assert.ok(single < main.indexOf("rearmCq('popout');", single), 'single-engine path: before the done block');
  const multi = main.indexOf('if (engine === ft8Engine) jtcatRunCallersTick(data.results || []);');
  assert.ok(multi > 0 && multi < main.indexOf("rearmCq('popout');", multi), 'multi-slice path: before the done block');
});

test('the queue is cleared when Run starts and stops', () => {
  assert.ok(fnBody('startFullAutoCq').includes('jtcatRunCallers.clear()'));
  assert.ok(fnBody('stopFullAutoCq').includes('jtcatRunCallers.clear()'));
});

test('the state machine skips a cycle the queue already used', () => {
  assert.ok(/if \(q && q\._skipAdvanceOnce\) \{ q\._skipAdvanceOnce = false; return; \}/.test(fnBody('advanceJtcatQso')));
});

test('listed in scripts/run-tests.js', () => {
  assert.ok(readSrc(path.join(ROOT, 'scripts', 'run-tests.js')).includes("'test/jtcat-run-callers-test.js'"));
});

// --- main.js's own functions in a vm -----------------------------------------
// The decode handler's order (both paths; the source test above checks it):
// Run's tick, the done block (session mark, rearmCq), then the QSO machine and,
// when the phase did not move, the tries counter.
function fnSrc(sig) {
  const i = main.indexOf(sig);
  if (i < 0) return '';
  return main.slice(i, main.indexOf('\n}\n', i) + 3);
}
function harness(over) {
  const clock = { t: Date.UTC(2026, 10, 25, 18, 0, 0) };
  class FakeDate extends Date {
    constructor(...a) { if (a.length) super(...a); else super(clock.t); }
    static now() { return clock.t; }
  }
  const catLog = [];
  const tx = [];
  const engine = {
    _mode: 'FT8', _txEnabled: false, _txActive: false, _lastTxPeriodKey: '', msg: '', slot: '',
    _cycleSec: () => 15,
    async setTxMessage(m) { this.msg = m; },
    tryImmediateTx() { if (this.msg) tx.push(this.msg); return true; },
    setTxSlot(s) { this.slot = s; }, setRxFreq() {},
  };
  const built = [];
  const ctx = {
    console: { log() {}, warn() {}, error() {} },
    Date: FakeDate, Map, Set, Promise, String, Number, Object, Array, JSON, Math, require,
    settings: Object.assign({ grid: 'EM12', ultracat: true }, over || {}),
    ft8Engine: engine, _currentFreqHz: 14074000, _swrTripped: false,
    freqToBand: (mhz) => (mhz >= 14 && mhz <= 14.35 ? '20m' : null),
    onAirCall: () => ME,
    sendCatLog: (l) => catLog.push(l),
    HuntFilters, JtcatTxSlot: require('../lib/jtcat-tx-slot'),
    _jtcatStateMachine: SM,
    JtcatRunCallers: R,
    jtcatRunCallers: R ? new R.RunCallerQueue() : null,
    _jtcatQsoClock: new (require('../lib/jtcat-qso-clock').JtcatQsoClock)(),
    jtcatIgnoreList: () => [],
    jtcatLogReviews: { holds: () => false },
    workedSet: new Set(),
    jtcatTxSlotLock: () => 'auto',
    remoteServer: null, jtcatPopoutWin: null, jtcatManager: null,
    popoutBroadcastQso() {}, remoteJtcatBroadcastQso() {},
    popoutJtcatOnDone: () => () => {}, remoteJtcatOnDone: () => () => {},
    jtcatPeriodUtc: (mode, ms) => String(ms),
    jtcatRunPauseAfter: () => 8, jtcatHopModeForDrainedRun: () => false, jtcatPauseRunCq() {},
    jtcatMaxQsoRetries: () => 5, JTCAT_MAX_CQ_RETRIES: 5, jtcatAutoSkipMin: () => 0,
    stopFullAutoCq() {}, jtcatChimeTxStopped() {},
    jtcatBuildCqQso: async () => { built.push('CQ'); engine.msg = 'CQ W5XY EM12'; return { mode: 'cq', phase: 'cq', call: null, grid: null, txMsg: 'CQ W5XY EM12', report: null, sentReport: null, myCall: ME, myGrid: 'EM12', txRetries: 0 }; },
  };
  ctx.jtcatWorkedInfo = (call) => ({ blocking: ctx.workedSet.has(call) });
  vm.createContext(ctx);
  const fns = [
    'function jtcatSessionKey(', 'function jtcatSessionMark(', 'function jtcatSessionHas(', 'function jtcatIsWorkedCall(',
    'function jtcatCurrentBandMode(', 'function jtcatFdContext(', 'function jtcatReplySlot(', 'function _autoSeqEnabled(',
    'async function popoutJtcatSetTxMsg(', 'function advanceJtcatQso(', 'function processPopoutJtcatQso(',
    'function jtcatHandleRetryStall(', 'async function rearmCq(',
    'function jtcatRunServesCallers(', 'function jtcatRunCallerBlocked(', 'function jtcatRunCallersWindowMs(',
    'function jtcatRunCallersTick(', 'function jtcatRunAnswerWaiting(',
  ].map(fnSrc).join('\n');
  vm.runInContext(`var popoutJtcatQso = null, remoteJtcatQso = null;
var jtcatFullAutoCq = true, jtcatFullAutoCqOwner = 'popout', jtcatFullAutoCqModifier = '';
var jtcatFullAutoCqUnanswered = 0, jtcatFullAutoCqPaused = false, jtcatFullAutoCqLastActivity = 0;
var jtcatAutoCqWorkedSession = new Set();
${fns}
this.cycle = async function (texts, periodKey) {
  const results = texts.map(([text, db]) => ({ text, db, df: 1500, slot: 'odd' }));
  if (typeof jtcatRunCallersTick === 'function') jtcatRunCallersTick(results);
  if (popoutJtcatQso && popoutJtcatQso.phase === 'done') {
    if (popoutJtcatQso.call) jtcatSessionMark(popoutJtcatQso.call);
    if (jtcatFullAutoCq && jtcatFullAutoCqOwner === 'popout') rearmCq('popout');
    else popoutJtcatQso = null;
  }
  if (popoutJtcatQso && popoutJtcatQso.phase !== 'done') {
    const phaseBefore = popoutJtcatQso.phase;
    processPopoutJtcatQso(results);
    if (popoutJtcatQso && popoutJtcatQso.phase === phaseBefore && popoutJtcatQso.phase !== 'done') {
      const qso = popoutJtcatQso;
      jtcatHandleRetryStall({ qso, mode: 'FT8', periodStartMs: periodKey, engine: ft8Engine, runMode: true, workableCount: 0,
        setTxMsg: popoutJtcatSetTxMsg, onDone: () => {}, clearQso: () => { popoutJtcatQso = null; } });
    } else if (popoutJtcatQso && popoutJtcatQso.phase !== phaseBefore) {
      popoutJtcatQso.txRetries = 0;
    }
  }
  await new Promise((r) => setImmediate(r));
};
this.setQso = (q) => { popoutJtcatQso = q; };
this.getQso = () => popoutJtcatQso;`, ctx);
  ctx.setImmediate = setImmediate;
  return { ctx, engine, catLog, tx, built, clock };
}
// One QSO with K1ABC: their R-report, our RR73 on the air, done. N8PFK calls
// all along; in the cycle where the QSO is done he is sending R-12 (the shape
// the state machine would take straight to RR73 if it saw it twice).
async function workK1abcWhileN8pfkCalls(h) {
  const { ctx, engine, clock } = h;
  ctx.setQso({ mode: 'cq', phase: 'cq-report', call: 'K1ABC', grid: 'FN42', txMsg: 'K1ABC W5XY -05', report: null, sentReport: '-05', myCall: ME, myGrid: 'EM12', txRetries: 0 });
  engine._lastTxPeriodKey = 'P0';
  await ctx.cycle([['W5XY K1ABC R-07', -5], ['W5XY N8PFK EM79', -14]], 'P1');
  assert.strictEqual(ctx.getQso().phase, 'cq-rr73');
  ctx.getQso()._txSentMsg = ctx.getQso().txMsg; engine._lastTxPeriodKey = 'P2'; clock.t += 15000;
  await ctx.cycle([], 'P2');
  assert.strictEqual(ctx.getQso().phase, 'done');
  clock.t += 15000;
  await ctx.cycle([['W5XY N8PFK R-12', -12], ['W5XY K1ABC 73', -5]], 'P3');
}

test('vm: QSO done, N8PFK answered (not CQ), no double advance, no try burned, TIME_ON from the answer', async () => {
  const h = harness();
  await workK1abcWhileN8pfkCalls(h);
  const q = h.ctx.getQso();
  assert.deepStrictEqual(h.built, [], 'no CQ built');
  assert.strictEqual(q.call, 'N8PFK');
  assert.strictEqual(q.phase, 'cq-report', 'a fresh report; the same R-12 did not also advance it to RR73');
  assert.strictEqual(q.txRetries, 0, 'the tries cap is not burned by the cycle that started it');
  assert.deepStrictEqual(h.tx, ['N8PFK W5XY -12']);
  assert.ok(h.catLog.includes('[JTCAT] Run: answering N8PFK (-12 dB), who called during the last QSO'), h.catLog.join('\n'));
  const answeredAt = h.clock.t;
  assert.strictEqual(h.ctx._jtcatQsoClock.take('N8PFK', answeredAt + 120000), answeredAt, 'TIME_ON is when Run answered');
  h.engine._lastTxPeriodKey = 'P4'; h.clock.t += 15000;
  await h.ctx.cycle([], 'P4');
  assert.strictEqual(h.ctx.getQso().txRetries, 0, 'our own TX period is not a try');
  h.clock.t += 15000;
  await h.ctx.cycle([['W5XY N8PFK R-12', -12]], 'P5');
  assert.strictEqual(h.ctx.getQso().phase, 'cq-rr73', 'their R-report to our new report finishes it');
});

test('vm: "Answer stations that call me" off is the old Run: CQ after the QSO, first match while listening', async () => {
  const h = harness({ jtcatAnswerCallers: false });
  await workK1abcWhileN8pfkCalls(h);
  assert.deepStrictEqual(h.built, ['CQ'], 'Run calls CQ, as before');
  assert.strictEqual(h.catLog.filter((l) => /Run: answering/.test(l)).length, 0);
  assert.strictEqual(h.ctx.jtcatRunCallers.waiting(h.clock.t, 60000).length, 0, 'nothing remembered');
  h.ctx.setQso(await h.ctx.jtcatBuildCqQso());
  h.clock.t += 15000;
  await h.ctx.cycle([['W5XY KD0AA EN34', -20], ['W5XY N8PFK EM79', -2]], 'P4');
  assert.strictEqual(h.ctx.getQso().call, 'KD0AA', 'the state machine takes the first decode, as before');
  const on = harness();
  on.ctx.setQso(await on.ctx.jtcatBuildCqQso());
  await on.ctx.cycle([['W5XY KD0AA EN34', -20], ['W5XY N8PFK EM79', -2]], 'P4');
  assert.strictEqual(on.ctx.getQso().call, 'N8PFK', 'on: Who goes first (strongest)');
});

test('vm: Hunt\'s signal floor does not stop Run answering its CQ', async () => {
  const h = harness({ jtcatHuntMinDb: '-10' });
  h.ctx.setQso(await h.ctx.jtcatBuildCqQso());
  await h.ctx.cycle([['W5XY N8PFK EM79', -24]], 'P1');
  assert.strictEqual(h.ctx.getQso().call, 'N8PFK');
  assert.strictEqual(h.ctx.getQso().phase, 'cq-report');
});

test('vm: nobody waiting after the QSO gives CQ', async () => {
  const h = harness();
  h.ctx.setQso({ mode: 'cq', phase: 'done', call: 'K1ABC', myCall: ME, myGrid: 'EM12', txRetries: 0 });
  await h.ctx.cycle([['CQ K9XYZ EN52', -3], ['W5XY K1ABC 73', -5]], 'P1');
  assert.deepStrictEqual(h.built, ['CQ']);
});

(async () => {
  for (const run of pending) await run();
  console.log('\n' + passed + ' passed, ' + failures.length + ' failed');
  if (failures.length) { console.log('FAILED: ' + failures.join('; ')); process.exit(1); }
})();
