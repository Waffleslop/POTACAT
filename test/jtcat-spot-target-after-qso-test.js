#!/usr/bin/env node
'use strict';
// #518: JTCAT called a station again with the grid after the QSO was complete
// and logged.
//
// A spot click armed a Spot Target ('armed'). The operator answered that
// station himself (double-click or Hunt) before the watcher fired, so the
// target stayed 'armed'. The QSO finished, but the done-blocks cleared only an
// 'engaged' target; the watcher then saw an armed target, no QSO, and fired on
// the station's next CQ or tail-end RR73, until the 10-minute expiry.
//
// The rule now: any finished QSO with the target's call clears the target,
// whatever its status, and the watcher refuses a worked call.
// Run: node test/jtcat-spot-target-after-qso-test.js
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const ST = require('../lib/jtcat-spot-target');
const P = require('../renderer/jtcat-parser');
const SM = require('../lib/jtcat-state-machine');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

const MY = 'W1XYZ';

// A small model of main.js's decode handler: the done-block (clear, then
// session mark) and the armed-target watcher, built on the same lib calls the
// glue uses. Returns 'fire' when the watcher would call the station.
function makeShack() {
  const s = { target: null, qso: null, session: new Set(), fired: [], log: [] };
  s.isWorked = (call) => s.session.has(P.normalizeCall(call));
  s.clear = (reason, line) => { if (!s.target) return; s.log.push(line || 'cleared (' + reason + ')'); s.target = null; };
  s.cycle = (texts) => {
    if (s.qso && s.qso.phase === 'done') {
      if (ST.qsoEndClearsTarget(s.target, s.qso.call)) s.clear('worked');
      s.session.add(P.normalizeCall(s.qso.call));
      s.qso = null;
    }
    const tgt = s.target;
    if (tgt && tgt.status === 'armed' && !s.qso) {
      const hits = texts.map((t) => P.classifySpotTargetTrigger(t, tgt.call, MY)).filter(Boolean);
      if (hits.length && ST.watcherRefusesWorked(tgt, s.isWorked)) {
        s.clear('worked', ST.refusalLogLine(tgt.call, '20M', 'FT8'));
      } else if (hits.length) {
        s.fired.push(hits[0]);
        tgt.status = 'engaged';
      }
    }
  };
  return s;
}

function finishManualQso(s, call) {
  // The operator's own reply, at its last leg: our courtesy 73 goes out.
  const q = { mode: 'reply', phase: '73', call, myCall: MY, txMsg: call + ' ' + MY + ' 73', _txSentMsg: call + ' ' + MY + ' 73' };
  const eng = { _txEnabled: true, setTxMessage() {}, setTxSlot() {} };
  SM.advanceJtcatQso(q, [], () => {}, () => {}, { engine: eng });
  assert.strictEqual(q.phase, 'done', 'the real state machine finishes the QSO');
  s.qso = q;
}

test('an armed target worked by a manual reply is cleared when that QSO finishes', () => {
  const s = makeShack();
  s.target = { call: 'K1ABC', status: 'armed' };
  finishManualQso(s, 'K1ABC');
  s.cycle([]);
  assert.strictEqual(s.target, null);
  assert.deepStrictEqual(s.log, ['cleared (worked)']);
});

test('after that QSO, the station\'s next CQ and tail-end RR73 never fire', () => {
  const s = makeShack();
  s.target = { call: 'K1ABC', status: 'armed' };
  finishManualQso(s, 'K1ABC');
  s.cycle(['CQ POTA K1ABC FN42']);
  s.cycle(['KD2XX K1ABC RR73']);
  s.cycle(['CQ K1ABC FN42', 'KD2YY K1ABC 73']);
  assert.strictEqual(s.fired.length, 0);
});

test('the watcher refuses a worked call even if the target survived', () => {
  const s = makeShack();
  s.target = { call: 'K1ABC', status: 'armed' };
  s.session.add('K1ABC'); // worked this session (or held in the Log QSO window)
  s.cycle(['CQ POTA K1ABC FN42']);
  assert.strictEqual(s.fired.length, 0);
  assert.strictEqual(s.target, null);
  assert.strictEqual(s.log.length, 1, 'one CAT line');
  assert.ok(/K1ABC already worked on 20M FT8/.test(s.log[0]), s.log[0]);
});

test('an unworked target still fires on its CQ (no regression)', () => {
  const s = makeShack();
  s.target = { call: 'K1ABC', status: 'armed' };
  s.cycle(['CQ POTA K1ABC FN42']);
  assert.strictEqual(s.fired.length, 1);
  assert.strictEqual(s.fired[0].trigger, 'cq');
});

test('a QSO with a different station leaves the target armed', () => {
  assert.strictEqual(ST.qsoEndClearsTarget({ call: 'K1ABC', status: 'armed' }, 'N0XYZ'), false);
  const s = makeShack();
  s.target = { call: 'K1ABC', status: 'armed' };
  finishManualQso(s, 'N0XYZ');
  s.cycle(['CQ K1ABC FN42']);
  assert.strictEqual(s.fired.length, 1);
});

test('qsoEndClearsTarget: either status, portable forms, empty input', () => {
  assert.strictEqual(ST.qsoEndClearsTarget({ call: 'K1ABC', status: 'armed' }, 'k1abc'), true);
  assert.strictEqual(ST.qsoEndClearsTarget({ call: 'K1ABC', status: 'engaged' }, 'K1ABC'), true);
  assert.strictEqual(ST.qsoEndClearsTarget({ call: 'K1ABC/P', status: 'armed' }, '<K1ABC>'), true);
  assert.strictEqual(ST.qsoEndClearsTarget(null, 'K1ABC'), false);
  assert.strictEqual(ST.qsoEndClearsTarget({ call: 'K1ABC' }, ''), false);
  assert.strictEqual(ST.watcherRefusesWorked({ call: 'K1ABC' }, () => false), false);
  assert.strictEqual(ST.watcherRefusesWorked(null, () => true), false);
});

// --- wiring guards (main.js is glue; the rule lives in the lib) ---
const MAIN = readSrc(path.join(__dirname, '..', 'main.js'));

test('no QSO-end clear is gated on status === engaged any more', () => {
  assert.ok(!/jtcatSpotTarget\.status === 'engaged' &&/.test(MAIN),
    'a QSO-end spot target clear still checks status === engaged');
});

test('every done-block, Skip and Cancel clears through qsoEndClearsTarget', () => {
  const uses = MAIN.match(/JtcatSpotTarget\.qsoEndClearsTarget\(jtcatSpotTarget, /g) || [];
  // done: popout + remote (single engine), popout + remote (multi-slice);
  // Skip: popout + remote; Cancel: popout + remote.
  assert.strictEqual(uses.length, 8, 'expected 8 call sites, found ' + uses.length);
  const cancelRemote = MAIN.indexOf("remoteServer.on('jtcat-cancel-qso'");
  assert.ok(cancelRemote > 0 && /qsoEndClearsTarget/.test(MAIN.slice(cancelRemote, cancelRemote + 600)),
    'the phone Cancel does not clear the spot target');
  const cancelPopout = MAIN.indexOf("ipcMain.on('jtcat-popout-cancel-qso'");
  assert.ok(cancelPopout > 0 && /qsoEndClearsTarget/.test(MAIN.slice(cancelPopout, cancelPopout + 800)),
    'the pop-out Cancel does not clear the spot target');
});

test('the watcher checks jtcatIsWorkedCall before it fires', () => {
  const at = MAIN.indexOf('// --- Spot Target watcher ---');
  assert.ok(at > 0);
  const block = MAIN.slice(at, MAIN.indexOf('// --- Auto-CQ Response ---', at));
  const refuse = block.indexOf('JtcatSpotTarget.watcherRefusesWorked(tgt, (c) => jtcatIsWorkedCall(');
  const fire = block.indexOf('fireSpotTarget(');
  assert.ok(refuse > 0, 'the watcher does not refuse worked calls');
  assert.ok(fire > refuse, 'the worked refusal must come before fireSpotTarget');
  assert.ok(/clearSpotTarget\('worked', JtcatSpotTarget\.refusalLogLine\(/.test(block),
    'a refusal clears the target with one log line');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
