#!/usr/bin/env node
'use strict';
/**
 * #519: clicking a second caller in the middle of a QSO must log the station
 * actually worked, never the first one. Two operators (Discord bug-reports,
 * 2026-10-31 and 11-01) saw JTCAT log the previous station every time, from
 * the window and from GridTracker, with and without Hound.
 *
 * The window (and GridTracker, which answers through it) holds one QSO object
 * and ECHOCAT / ECHOCAT Web hold another; main advances BOTH on every decode
 * cycle, on one transmitter. These tests drive the real state machine and the
 * real QSO clock through main's flow, with a logger that keeps jtcatAutoLog's
 * guards (reports exchanged, logged once, TIME_ON from the clock).
 *
 * Run: node test/jtcat-second-caller-test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sm = require('../lib/jtcat-state-machine');
const { JtcatQsoClock } = require('../lib/jtcat-qso-clock');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message || e)); }
}

const MY = 'K3SBP';
const MYGRID = 'FM19';
const T0 = Date.UTC(2026, 10, 14, 18, 0, 0);
const at = (s) => T0 + s * 1000;
const dec = (text, db, df) => ({ text, db: db == null ? -10 : db, df: df || 1200, slot: 'even' });

// A shack: the two QSO slots main keeps, one engine, the clock and the log.
function makeShack() {
  const engine = {
    _txEnabled: false, _txMsg: '',
    setTxMessage(m) { this._txMsg = m; }, setTxSlot() {}, setRxFreq() {}, setTxFreq() {},
    tryImmediateTx() {}, txComplete() {},
  };
  const shack = { qsos: { popout: null, remote: null }, engine, clock: new JtcatQsoClock(), log: [], now: T0 };
  // jtcatAutoLog's guards, in its order.
  shack.autoLog = (q) => {
    if (!q || !q.call) return;
    if (!q.report && !q.sentReport) return;
    if (q._logged) return;
    q._logged = true;
    const started = shack.clock.take(q.call, shack.now);
    shack.log.push({ call: q.call, grid: q.grid || '', rstSent: q.sentReport || '', rstRcvd: q.report || '', timeOn: started, timeOff: shack.now });
  };
  // main.js advanceJtcatQso + process*JtcatQso, for whichever slots are live.
  shack.cycle = (sec, results) => {
    shack.now = at(sec);
    for (const surface of ['remote', 'popout']) {
      const q = shack.qsos[surface];
      if (!q || q.phase === 'done') continue;
      if (q.call) shack.clock.note(q.call, shack.now);
      sm.advanceJtcatQso(q, results, (m) => engine.setTxMessage(m), () => shack.autoLog(q), { engine });
      if (q.call && !q._logged) shack.clock.note(q.call, shack.now);
    }
  };
  // main.js jtcatSupersedeQsos, then the reply handler's rebuild of its own slot.
  shack.click = (sec, own, newCall, buildQso) => {
    shack.now = at(sec);
    const out = sm.supersedeRunningQsos(shack.qsos, newCall, own);
    for (const { surface, q, action, clear } of out) {
      if (action === 'log') shack.autoLog(q);
      if (clear && shack.qsos[surface] === q) shack.qsos[surface] = null;
    }
    shack.clock.note(newCall, shack.now);
    const q = buildQso();
    shack.qsos[own] = q;
    engine.setTxMessage(q.txMsg);
    engine._txEnabled = true;
    return out;
  };
  return shack;
}

// The QSO a fresh reply to a CQ builds (reply-cq branch of both handlers).
const replyTo = (call, grid) => ({ mode: 'reply', call, grid, phase: 'reply', txMsg: `${call} ${MY} ${MYGRID}`, report: null, sentReport: null, myCall: MY, myGrid: MYGRID, txRetries: 0 });
// The QSO a click on a station answering our CQ with a grid builds (send-report branch).
const answerGrid = (call, grid, ourRpt) => ({ mode: 'cq', call, grid, phase: 'cq-report', txMsg: `${call} ${MY} ${ourRpt}`, report: null, sentReport: ourRpt, myCall: MY, myGrid: MYGRID, txRetries: 0 });

// ---------------------------------------------------------------- pure rule
test('supersedeQso: unfinished QSO with another station is dropped, never logged', () => {
  assert.strictEqual(sm.supersedeQso({ call: 'W1AW', mode: 'reply', phase: 'r+report', report: '-10', sentReport: '-12' }, 'K1ABC'), 'drop');
  assert.strictEqual(sm.supersedeQso({ call: 'W1AW', mode: 'reply', phase: 'reply' }, 'K1ABC'), 'drop');
  assert.strictEqual(sm.supersedeQso({ call: 'W1AW', mode: 'cq', phase: 'cq-report', sentReport: '-05' }, 'K1ABC'), 'drop');
  assert.strictEqual(sm.supersedeQso({ call: 'W1AW', mode: 'cq', phase: 'cq-r-report', report: '-03', sentReport: '-05' }, 'K1ABC'), 'drop');
});
test('supersedeQso: a complete, unlogged QSO follows the existing log rule', () => {
  assert.strictEqual(sm.supersedeQso({ call: 'W1AW', mode: 'cq', phase: 'cq-rr73', report: '-08', sentReport: '-05' }, 'K1ABC'), 'log');
  assert.strictEqual(sm.supersedeQso({ call: 'W1AW', mode: 'cq', phase: 'cq-rr73', report: '-08', _logged: true }, 'K1ABC'), 'drop');
  assert.strictEqual(sm.supersedeQso({ call: 'W1AW', mode: 'reply', phase: '73', report: '-08', sentReport: '-05', _logged: true }, 'K1ABC'), 'drop');
});
test('supersedeQso: nothing to let go', () => {
  assert.strictEqual(sm.supersedeQso(null, 'K1ABC'), 'keep');
  assert.strictEqual(sm.supersedeQso({ call: null, mode: 'cq', phase: 'cq' }, 'K1ABC'), 'keep', 'a CQ / Run shell');
  assert.strictEqual(sm.supersedeQso({ call: 'W1AW', mode: 'reply', phase: 'done' }, 'K1ABC'), 'keep');
  assert.strictEqual(sm.supersedeQso({ call: 'W1AW', mode: 'reply', phase: 'r+report', report: '-10' }, 'w1aw'), 'keep', 'same station');
});
test('supersedeRunningQsos: the other surface is cleared, the own one is left to the handler', () => {
  const a = { call: 'W1AW', mode: 'reply', phase: 'r+report', report: '-10', sentReport: '-12' };
  const out = sm.supersedeRunningQsos({ popout: null, remote: a }, 'K1ABC', 'popout');
  assert.deepStrictEqual(out.map((o) => [o.surface, o.action, o.clear]), [['remote', 'drop', true]]);
  const own = sm.supersedeRunningQsos({ popout: a, remote: null }, 'K1ABC', 'popout');
  assert.deepStrictEqual(own.map((o) => [o.surface, o.action, o.clear]), [['popout', 'drop', false]]);
  assert.deepStrictEqual(sm.supersedeRunningQsos({ popout: null, remote: null }, 'K1ABC', 'remote'), []);
});

// ---------------------------------------------------------------- flows
test('window: A mid-QSO (R-report sent), click caller B, complete with B: only B is logged, with B\'s data', () => {
  const s = makeShack();
  s.click(0, 'popout', 'W1AW', () => replyTo('W1AW', 'FN31'));
  s.cycle(15, [dec(`${MY} W1AW -10`)]);
  assert.strictEqual(s.qsos.popout.phase, 'r+report');
  // B answered our earlier CQ with a grid; the operator double-clicks it.
  const out = s.click(30, 'popout', 'K1ABC', () => answerGrid('K1ABC', 'EM12', '-05'));
  assert.deepStrictEqual(out.map((o) => o.action), ['drop']);
  // A keeps sending RR73 to us; B sends its R-report.
  s.cycle(45, [dec(`${MY} W1AW RR73`), dec(`${MY} K1ABC R-08`)]);
  s.cycle(60, [dec(`${MY} W1AW RR73`)]);
  assert.strictEqual(s.log.length, 1, JSON.stringify(s.log));
  assert.deepStrictEqual(s.log[0], { call: 'K1ABC', grid: 'EM12', rstSent: '-05', rstRcvd: '-08', timeOn: at(30), timeOff: at(45) });
});

test('ECHOCAT: Hunt (remote) working A, click B in the window: A is dropped and can never be closed out', () => {
  const s = makeShack();
  s.click(0, 'remote', 'W1AW', () => replyTo('W1AW', 'FN31'));
  s.cycle(15, [dec(`${MY} W1AW -10`)]);
  const a = s.qsos.remote;
  assert.strictEqual(a.phase, 'r+report');
  // The hazard: A has reports both ways, so the retry cap would close it out and log it.
  assert.strictEqual(sm.canCloseoutQso(a), true);
  const out = s.click(30, 'popout', 'K1ABC', () => replyTo('K1ABC', 'EM12'));
  assert.deepStrictEqual(out.map((o) => [o.surface, o.action, o.clear]), [['remote', 'drop', true]]);
  assert.strictEqual(s.qsos.remote, null, 'the abandoned QSO no longer runs');
  s.cycle(45, [dec(`${MY} K1ABC -12`, -7)]);
  assert.strictEqual(s.engine._txMsg, `K1ABC ${MY} R-07`, 'TX is B\'s, not a 73 to A');
  s.cycle(60, [dec(`${MY} W1AW RR73`), dec(`${MY} K1ABC RR73`)]);
  assert.strictEqual(s.log.length, 1, JSON.stringify(s.log));
  assert.deepStrictEqual(s.log[0], { call: 'K1ABC', grid: 'EM12', rstSent: '-07', rstRcvd: '-12', timeOn: at(30), timeOff: at(60) });
  assert.strictEqual(s.engine._txMsg, `K1ABC ${MY} 73`);
});

test('ECHOCAT and ECHOCAT Web: phone working A in the window\'s absence, phone taps B: same rule', () => {
  const s = makeShack();
  s.click(0, 'remote', 'W1AW', () => replyTo('W1AW', 'FN31'));
  s.cycle(15, [dec(`${MY} W1AW -10`)]);
  s.click(30, 'remote', 'K1ABC', () => answerGrid('K1ABC', 'EM12', '-02'));
  s.cycle(45, [dec(`${MY} W1AW RR73`), dec(`${MY} K1ABC R-15`)]);
  assert.deepStrictEqual(s.log.map((r) => [r.call, r.grid, r.rstSent, r.rstRcvd]), [['K1ABC', 'EM12', '-02', '-15']]);
});

test('A already complete (our RR73 out, not yet logged) when B is clicked: A logged by the existing rule, then B', () => {
  const s = makeShack();
  s.click(0, 'popout', 'W1AW', () => ({ mode: 'cq', call: 'W1AW', grid: 'FN31', phase: 'cq-rr73', txMsg: `W1AW ${MY} RR73`, report: '-08', sentReport: '-05', myCall: MY, myGrid: MYGRID, txRetries: 0 }));
  s.click(15, 'popout', 'K1ABC', () => answerGrid('K1ABC', 'EM12', '-01'));
  s.cycle(30, [dec(`${MY} K1ABC R-09`)]);
  assert.deepStrictEqual(s.log.map((r) => [r.call, r.rstSent, r.rstRcvd]), [['W1AW', '-05', '-08'], ['K1ABC', '-01', '-09']]);
});

test('A logged and in its courtesy 73 when B is clicked: A is not logged twice', () => {
  const s = makeShack();
  s.click(0, 'popout', 'W1AW', () => replyTo('W1AW', 'FN31'));
  s.cycle(15, [dec(`${MY} W1AW -10`)]);
  s.cycle(30, [dec(`${MY} W1AW RR73`)]);
  assert.strictEqual(s.qsos.popout.phase, '73');
  s.click(45, 'popout', 'K1ABC', () => replyTo('K1ABC', 'EM12'));
  s.cycle(60, [dec(`${MY} K1ABC R-11`)]);
  assert.deepStrictEqual(s.log.map((r) => r.call), ['W1AW', 'K1ABC']);
});

test('B\'s TIME_ON is B\'s own, even when A began long before', () => {
  const s = makeShack();
  s.click(0, 'popout', 'W1AW', () => replyTo('W1AW', 'FN31'));
  for (let t = 15; t <= 120; t += 15) s.cycle(t, [dec(`${MY} W1AW -10`)]);
  s.click(135, 'popout', 'K1ABC', () => replyTo('K1ABC', 'EM12'));
  s.cycle(150, [dec(`${MY} K1ABC R-04`)]);
  assert.strictEqual(s.log.length, 1);
  assert.strictEqual(s.log[0].call, 'K1ABC');
  assert.strictEqual(s.log[0].timeOn, at(135));
});

// ---------------------------------------------------------------- guards
const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
test('main: both reply handlers supersede through the shared helper', () => {
  assert.ok(MAIN.includes("await jtcatSupersedeQsos(data.call, 'popout')"), 'window / GridTracker handler');
  assert.ok(MAIN.includes("await jtcatSupersedeQsos(call, 'remote')"), 'ECHOCAT / ECHOCAT Web / remote pop-out handler');
  const fn = MAIN.slice(MAIN.indexOf('async function jtcatSupersedeQsos('), MAIN.indexOf('function remoteJtcatOnDone('));
  assert.ok(/supersedeRunningQsos\(\s*\{ popout: popoutJtcatQso, remote: remoteJtcatQso \}/.test(fn), 'reads both slots');
  assert.ok(/popoutJtcatQso = null/.test(fn) && /remoteJtcatQso = null/.test(fn), 'clears the other slot');
  assert.ok(/_jtcatQsoClock\.note\(newCall/.test(fn), 'starts the new station\'s clock');
});

console.log(`\nJTCAT second caller (#519): ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
