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
let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failures.push(name); console.log('  FAIL ' + name + '\n       ' + String(e.message).split('\n').join('\n       ')); }
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

test('the floor and the TX slot lock apply; another band or mode is not answered', () => {
  const q = queueWith([[T0, [dec('W5XY N8PFK EM79', -22), dec('W5XY K1ABC FN42', -5, { slot: 'even' })]]]);
  q.note([dec('W5XY KD0AA EN34', 0)], ME, T0, '40M|FT8');
  const p = pickAt(q, T0 + 15000, { passesFloor: (db) => db >= -20, slotOk: (s) => s !== 'even' });
  assert.strictEqual(p.best, null);
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

test('the answer keeps the dupe policy, floor, slot lock, ranking, SWR latch and Hold TX', () => {
  const b = fnBody('jtcatRunAnswerWaiting');
  for (const s of ['jtcatRunCallerBlocked(', 'JtcatSnrFloor.passes(', 'JtcatTxSlot.workableUnderLock(', 'HuntFilters.rankCallers(', '_swrTripped', 'jtcatReplySlot(', 'JtcatRunCallers.answerLogLine(']) {
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

console.log('\n' + passed + ' passed, ' + failures.length + ' failed');
if (failures.length) { console.log('FAILED: ' + failures.join('; ')); process.exit(1); }
