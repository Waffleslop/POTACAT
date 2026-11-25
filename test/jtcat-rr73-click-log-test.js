#!/usr/bin/env node
'use strict';
// #1060: a QSO that finished on the air (their RR73, our 73) was not logged
// when the operator clicked their RR73 while the JTCAT window (or ECHOCAT) was
// busy with another station or a CQ. The 73 QSO was built with no reports and
// jtcatAutoLog skipped it ("no signal reports exchanged") without a word.
// Now the reports from that station's earlier exchange (heard and sent on
// this band and mode) fill it, and with none on record the window says so.
// Run: node test/jtcat-rr73-click-log-test.js
const assert = require('assert');
const path = require('path');
const vm = require('vm');
const { readSrc } = require('./_src');

let passed = 0, failed = 0;
const pending = [];
function test(name, fn) {
  pending.push(async () => {
    try { await fn(); passed++; console.log('  ok  ' + name); }
    catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.message || e)); }
  });
}

const main = readSrc(path.join(__dirname, '..', 'main.js'));
let Exchange = null;
try { Exchange = require('../lib/jtcat-exchange-history'); } catch { /* not on this tree */ }

// ---------------------------------------------------------------------------
// The pure module
// ---------------------------------------------------------------------------
function needModule() { assert.ok(Exchange, 'lib/jtcat-exchange-history.js exists'); }

test('notes their report to us and ours to them, without the R, per band and mode', () => {
  needModule();
  const h = new Exchange.JtcatExchangeHistory({ now: () => 0 });
  assert.ok(h.noteHeard('K3SBP W1BBB -07', 'K3SBP', '20m', 'FT8'));
  assert.ok(h.noteSent('W1BBB K3SBP R-12', 'K3SBP', '20M', 'ft8'));
  assert.deepStrictEqual(h.get('w1bbb', '20M', 'FT8'), { report: '-07', sentReport: '-12' });
  assert.deepStrictEqual(h.get('W1BBB', '40M', 'FT8'), { report: '', sentReport: '' }, 'another band is another contact');
  assert.deepStrictEqual(h.get('W1BBB', '20M', 'FT4'), { report: '', sentReport: '' }, 'another mode is another contact');
  h.noteHeard('K3SBP W1BBB R+02', 'K3SBP', '20m', 'FT8');
  assert.strictEqual(h.get('W1BBB', '20m', 'FT8').report, '+02', 'the latest wins; an R-report is their report too');
});

test('ignores what is not a report exchanged with us', () => {
  needModule();
  const h = new Exchange.JtcatExchangeHistory({ now: () => 0 });
  assert.ok(!h.noteHeard('W1BBB K3SBP -12', 'K3SBP', '20m', 'FT8'), 'our own TX decoded back (N3VD echo) is not their report');
  assert.ok(!h.noteHeard('K9XYZ W1BBB -07', 'K3SBP', '20m', 'FT8'), 'a report to another station');
  assert.ok(!h.noteHeard('K3SBP W1BBB FN42', 'K3SBP', '20m', 'FT8'), 'a grid');
  assert.ok(!h.noteHeard('K3SBP W1BBB RR73', 'K3SBP', '20m', 'FT8'), 'RR73 is not a report');
  assert.ok(!h.noteHeard('CQ W1BBB FN42', 'K3SBP', '20m', 'FT8'));
  assert.ok(!h.noteHeard('K3SBP <...> -07', 'K3SBP', '20m', 'FT8'), 'an unresolved hash');
  assert.ok(!h.noteSent('K3SBP W1BBB -07', 'K3SBP', '20m', 'FT8'), 'a decode is not something we sent');
  assert.ok(!h.noteSent('CQ K3SBP FN20', 'K3SBP', '20m', 'FT8'));
  assert.ok(!h.noteSent('W1BBB K3SBP 73', 'K3SBP', '20m', 'FT8'));
  assert.ok(!h.noteHeard('K3SBP W1BBB -07', '', '20m', 'FT8'), 'no call of our own, nothing noted');
  assert.strictEqual(h.size, 0);
});

test('a compound message counts only the half addressed to us; hashed calls unwrap', () => {
  needModule();
  const h = new Exchange.JtcatExchangeHistory({ now: () => 0 });
  assert.ok(h.noteHeard('W9AAA RR73; K3SBP <KH1/KH7Z> -12', 'K3SBP', '20m', 'FT8'));
  assert.strictEqual(h.get('KH1/KH7Z', '20m', 'FT8').report, '-12');
  assert.strictEqual(h.get('W9AAA', '20m', 'FT8').report, '');
  assert.ok(h.noteHeard('K3SBP/P <GB13COL> -03', 'K3SBP', '20m', 'FT8'), 'our portable call still matches');
  assert.strictEqual(h.get('GB13COL', '20m', 'FT8').report, '-03');
});

test('forgets after the TTL (the re-log cool-down by default) and caps its size', () => {
  needModule();
  let t = 0;
  const h = new Exchange.JtcatExchangeHistory({ now: () => t, max: 2 });
  assert.strictEqual(Exchange.DEFAULT_TTL_MS, 15 * 60 * 1000);
  h.noteHeard('K3SBP A1AA -01', 'K3SBP', '20m', 'FT8');
  h.noteHeard('K3SBP B1BB -02', 'K3SBP', '20m', 'FT8');
  h.noteHeard('K3SBP C1CC -03', 'K3SBP', '20m', 'FT8');
  assert.strictEqual(h.size, 2);
  assert.strictEqual(h.get('A1AA', '20m', 'FT8').report, '', 'oldest dropped');
  t = Exchange.DEFAULT_TTL_MS + 1;
  assert.strictEqual(h.get('C1CC', '20m', 'FT8').report, '');
});

test('fillMissingReports fills only empty fields', () => {
  needModule();
  const q = { report: null, sentReport: '-09' };
  assert.deepStrictEqual(Exchange.fillMissingReports(q, { report: '-07', sentReport: '-12' }), ['report']);
  assert.deepStrictEqual(q, { report: '-07', sentReport: '-09' }, 'a report the QSO holds is never replaced');
  assert.deepStrictEqual(Exchange.fillMissingReports(q, { report: '', sentReport: '' }), []);
  assert.ok(Exchange.hasReports(q) && !Exchange.hasReports({}));
});

// ---------------------------------------------------------------------------
// The issue's scenario, on main.js's own code: the window's 73 branch and
// ECHOCAT's, the tx-start dispatch, jtcatAutoLog and the log write.
// ---------------------------------------------------------------------------
function fnSrc(sig) {
  const i = main.indexOf(sig);
  if (i < 0) return '';
  return main.slice(i, main.indexOf('\n}\n', i) + 3);
}
// The `if (phase === '73') { ... }` branch of a reply handler.
function block73(startMarker) {
  const i = main.indexOf(startMarker);
  assert.ok(i >= 0, 'found ' + startMarker);
  const j = main.indexOf("    } else if (phase === 'reply') {", i);
  return main.slice(i, j) + '    }\n';
}

function harness() {
  const logged = [];
  const notices = [];
  const catLog = [];
  const engine = {
    _mode: 'FT8', _txEnabled: false, msg: '', immediate: true,
    async setTxMessage(m) { this.msg = m; },
    // The 73 starts going out: main's tx-start dispatch.
    tryImmediateTx() { if (this.immediate && this.msg) ctx.jtcatNoteTxSent(this.msg, ctx.jtcatCurrentBandMode(this)); return true; },
  };
  const ctx = {
    console: { log() {}, warn() {}, error() {} },
    Date, Map, Set, Promise, String, Number, Object, Array, JSON, Math,
    settings: { grid: 'FN20', myCallsign: 'K3SBP' },
    wsjtx: null, remoteServer: null, jtcatManager: null,
    _currentFreqHz: 14074000, _jtcatExpectedDialHz: 0,
    freqToBand: (mhz) => (mhz >= 14 && mhz <= 14.35 ? '20m' : mhz >= 7 && mhz <= 7.3 ? '40m' : null),
    ft8Engine: engine,
    sendCatLog: (l) => catLog.push(l),
    onAirCall: () => 'K3SBP',
    jtcatHeardGrids: new (require('../lib/heard-grids').HeardGrids)(),
    RelogGuard: require('../lib/jtcat-relog-guard'),
    _jtcatRecentLogs: new Map(),
    _jtcatQsoClock: new (require('../lib/jtcat-qso-clock').JtcatQsoClock)(),
    _jtcatStateMachine: require('../lib/jtcat-state-machine'),
    NferRefs: require('../lib/nfer-refs'),
    _nferLogged: new Map(),
    HuntedPark: { findHuntedRefs: () => null },
    JtcatAutoRespot: { applyAutoRespot: () => false },
    lastMergedSpots: [],
    echoCatLogSource: () => '',
    jtcatLogReviews: { add() { throw new Error('no review in this test'); } },
    logContact: async (rec) => { logged.push(rec); return { success: true, records: [] }; },
    jtcatPopoutWin: { isDestroyed: () => false, webContents: { send: (ch, p) => { if (ch === 'jtcat-dupe-warning') notices.push(p); } } },
    popoutBroadcastQso() {}, remoteJtcatBroadcastQso() {},
    async remoteJtcatSetTxMsg(m) { await engine.setTxMessage(m); },
    jtcatDirectedMsg: (to, from, p) => `${to} ${from} ${p}`,
  };
  if (Exchange) {
    ctx.JtcatExchange = Exchange;
    ctx.jtcatExchangeHistory = new Exchange.JtcatExchangeHistory();
  }
  vm.createContext(ctx);
  const fns = [
    'function jtcatCurrentBandMode(', 'function jtcatFdContext(', 'async function jtcatAutoLog(',
    'function jtcatAutoRespotPlan(', 'async function jtcatWriteLog(', 'function jtcatNoteTxSent(',
    'function popoutJtcatOnDone(', 'function remoteJtcatOnDone(',
    // #1060 helpers (absent before the fix)
    'function jtcatSliceBandMode(', 'function jtcatRecoverExchange(',
  ].map(fnSrc).join('\n');
  const popout73 = block73("    if (phase === '73') {\n      // Send 73 courtesy");
  const remote73 = block73("    if (phase === '73') {\n      const prev = remoteJtcatQso;");
  vm.runInContext(`var popoutJtcatQso = null, remoteJtcatQso = null;
${fns}
async function popoutClick73(data, myCall, myGrid, replyEngine) {
  const phase = '73'; const txMsg = jtcatDirectedMsg(data.call, myCall, '73'); const replySliceId = data.sliceId || 'default';
${popout73}
}
async function remoteClick73(call, myCall, myGrid, targetEngine, sliceId) {
  const phase = '73'; const txMsg = jtcatDirectedMsg(call, myCall, '73'); const sliceKey = sliceId || 'default';
  const theirGrid = jtcatHeardGrids.get(call) || '';
  const fireReply = () => targetEngine.tryImmediateTx();
${remote73}
}
this.popoutClick73 = popoutClick73; this.remoteClick73 = remoteClick73;
this.setQso = (s, q) => { if (s === 'popout') popoutJtcatQso = q; else remoteJtcatQso = q; };
this.getQso = (s) => (s === 'popout' ? popoutJtcatQso : remoteJtcatQso);
this.jtcatNoteTxSent = jtcatNoteTxSent; this.jtcatCurrentBandMode = jtcatCurrentBandMode;`, ctx);
  // What main does on the air before the click: their report decoded (the
  // decode loop's note) and our R+report going out (the tx-start note).
  ctx.exchangeWithB = () => {
    if (ctx.jtcatExchangeHistory) ctx.jtcatExchangeHistory.noteHeard('K3SBP W1BBB -07', 'K3SBP', '20m', 'FT8');
    ctx.jtcatNoteTxSent('W1BBB K3SBP R-12', { band: '20M', mode: 'FT8' });
  };
  return { ctx, engine, logged, notices, catLog, exchangeWithB: ctx.exchangeWithB };
}
const busyWithA = () => ({ mode: 'reply', call: 'W2AAA', grid: 'EM12', phase: 'r+report', txMsg: 'W2AAA K3SBP R-03',
  report: '-05', sentReport: '-03', myCall: 'K3SBP', myGrid: 'FN20', txRetries: 1 });
const callingCq = () => ({ mode: 'cq', call: null, grid: null, phase: 'cq', txMsg: 'CQ K3SBP FN20', report: null, sentReport: null, myCall: 'K3SBP', myGrid: 'FN20', txRetries: 0 });

for (const surface of ['popout', 'remote']) {
  const click = (h) => (surface === 'popout'
    ? h.ctx.popoutClick73({ call: 'W1BBB' }, 'K3SBP', 'FN20', h.engine)
    : h.ctx.remoteClick73('W1BBB', 'K3SBP', 'FN20', h.engine, undefined));
  const name = surface === 'popout' ? 'JTCAT window' : 'ECHOCAT';

  for (const [busy, mk] of [['another station', busyWithA], ['a CQ', callingCq]]) {
    for (const immediate of [true, false]) {
      test(`${name}, busy with ${busy}: clicking W1BBB's RR73 after their exchange logs W1BBB once, with its reports (73 ${immediate ? 'goes out at once' : 'goes out later'})`, async () => {
        const h = harness();
        h.engine.immediate = immediate;
        h.exchangeWithB();
        h.ctx.setQso(surface, mk());
        await click(h);
        if (!immediate) { h.engine.immediate = true; h.engine.tryImmediateTx(); } // the 73's slot comes round
        h.engine.tryImmediateTx(); // and goes out again (a repeat): still one log
        await new Promise((r) => setImmediate(r));
        assert.strictEqual(h.logged.length, 1, `W1BBB logged once (logged ${h.logged.length}); CAT log: ${h.catLog.join(' | ')}`);
        const rec = h.logged[0];
        assert.strictEqual(rec.callsign, 'W1BBB');
        assert.strictEqual(rec.rstRcvd, '-07', 'their report to us');
        assert.strictEqual(rec.rstSent, '-12', 'our report to them');
        assert.strictEqual(rec.band, '20m');
        assert.strictEqual(h.notices.length, 0, 'no notice');
        assert.strictEqual(h.ctx.getQso(surface)._logged, true);
        assert.strictEqual(h.engine.msg, 'W1BBB K3SBP 73', 'what is transmitted is unchanged');
      });
    }
  }

  test(`${name}: no report exchange on record: not logged, and the window says so`, async () => {
    const h = harness();
    h.ctx.setQso(surface, busyWithA());
    await click(h);
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(h.logged.length, 0, 'not logged');
    assert.strictEqual(h.notices.length, 1, `one notice (got ${h.notices.length})`);
    assert.strictEqual(h.notices[0].message, 'W1BBB not logged');
    assert.ok(/No signal reports with W1BBB on 20M FT8/.test(h.notices[0].sub), h.notices[0].sub);
    assert.strictEqual(h.engine.msg, 'W1BBB K3SBP 73', 'the 73 still goes out');
  });

  test(`${name}: an exchange on another band does not count`, async () => {
    const h = harness();
    h.ctx.jtcatExchangeHistory && h.ctx.jtcatExchangeHistory.noteHeard('K3SBP W1BBB -07', 'K3SBP', '40m', 'FT8');
    h.ctx.jtcatNoteTxSent('W1BBB K3SBP R-12', { band: '40M', mode: 'FT8' });
    h.ctx.setQso(surface, callingCq());
    await click(h);
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(h.logged.length, 0);
    assert.strictEqual(h.notices.length, 1);
  });

  test(`${name}: clicking the RR73 again after it was logged does not log twice`, async () => {
    const h = harness();
    h.exchangeWithB();
    h.ctx.setQso(surface, busyWithA());
    await click(h);
    await click(h);                 // same QSO object: _logged carries over
    h.ctx.setQso(surface, null);    // QSO over and cleared, then a third click
    await click(h);
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(h.logged.length, 1, `logged once (logged ${h.logged.length})`);
    assert.strictEqual(h.notices.filter((n) => /not logged$/.test(n.message) && !/again/.test(n.message)).length, 0, 'never told "no reports"');
    assert.ok(h.notices.some((n) => n.message === 'W1BBB not logged again'), 'the re-log guard says it was already logged');
  });

  test(`${name}: the same station's own QSO keeps its reports and logs when the 73 goes out`, async () => {
    const h = harness();
    h.exchangeWithB();
    h.ctx.setQso(surface, { mode: 'reply', call: 'W1BBB', grid: 'FN31', phase: 'r+report', txMsg: 'W1BBB K3SBP R-10',
      report: '-04', sentReport: '-10', myCall: 'K3SBP', myGrid: 'FN20', txRetries: 0 });
    await click(h);
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(h.logged.length, 1);
    assert.strictEqual(h.logged[0].rstRcvd, '-04', "the QSO's own reports win");
    assert.strictEqual(h.logged[0].rstSent, '-10');
  });
}

test('Field Day: the 73 click is unchanged (no reports filled, no notice)', async () => {
  const h = harness();
  h.ctx.settings.jtcatFdMode = true; h.ctx.settings.jtcatFdExch = '2A EPA';
  h.exchangeWithB();
  h.ctx.setQso('popout', busyWithA());
  await h.ctx.popoutClick73({ call: 'W1BBB' }, 'K3SBP', 'FN20', h.engine);
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(h.logged.length, 0);
  assert.strictEqual(h.notices.length, 0);
});

// ---------------------------------------------------------------------------
// Wiring (source text)
// ---------------------------------------------------------------------------
test('main: every decode notes reports heard (both decode paths); every tx-start notes what we sent (both)', () => {
  assert.strictEqual((main.match(/jtcatExchangeHistory\.noteHeard\(r\.text, exchMyCall, /g) || []).length, 2, 'single-slice and multi-slice decode loops');
  assert.ok(/jtcatNoteTxSent\(data\.message, jtcatCurrentBandMode\(ft8Engine\)\);/.test(main), 'single-slice tx-start');
  assert.ok(/jtcatNoteTxSent\(data\.message, \{ band: [^\n]*mode: engine\._mode \|\| 'FT8' \}\);/.test(main), 'multi-slice tx-start');
  assert.strictEqual((main.match(/jtcatNoteTxSent\(data\.message\);/g) || []).length, 0, 'no tx-start without band and mode');
  const nt = fnSrc('function jtcatNoteTxSent(');
  assert.ok(/jtcatExchangeHistory\.noteSent\(message, onAirCall\(\), bandMode\.band, bandMode\.mode\)/.test(nt));
});

test('main: both 73 branches recover the exchange before the 73 can go out', () => {
  const p = block73("    if (phase === '73') {\n      // Send 73 courtesy");
  const r = block73("    if (phase === '73') {\n      const prev = remoteJtcatQso;");
  assert.ok(p.indexOf('jtcatRecoverExchange(popoutJtcatQso, data.sliceId, replyEngine)') >= 0);
  assert.ok(p.indexOf('jtcatRecoverExchange(') < p.indexOf('setTxMessage('), 'window: before the message is set');
  assert.ok(r.indexOf('jtcatRecoverExchange(remoteJtcatQso, sliceId, targetEngine)') >= 0);
  assert.ok(r.indexOf('jtcatRecoverExchange(') < r.indexOf('remoteJtcatSetTxMsg('), 'ECHOCAT: before the message is set');
  assert.ok(!/isRemoteMode\(\)/.test(fnSrc('function jtcatRecoverExchange(')), 'no isRemoteMode branch');
});

(async () => {
  for (const t of pending) await t();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
