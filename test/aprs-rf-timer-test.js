#!/usr/bin/env node
'use strict';
// APRS: the timed radio beacon (lib/aprs-rf-timer.js), 2 m only, off by
// default, never under 10 minutes, never on a pick or an open, a skipped
// round waits a full interval, and it is the click's own beacon: the same
// run and gate. Fake clock; no radio.
// Run: node test/aprs-rf-timer-test.js

const assert = require('assert');
const T = require('../lib/aprs-rf-timer');
const B = require('../lib/aprs-beacon');
const G = require('../lib/aprs-rf-gate');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); }
}
const MIN = 60000;

// A model of main's glue (aprsRfTimerSchedule / aprsRfTimerDue) on a fake
// clock, so the rules are tested as main applies them: armed whenever nothing
// is pending, one setTimeout, the due check, a full interval after each round.
function station(o = {}) {
  const s = { t: 1e9, interval: o.interval || 0, band: o.band || '2m', windowOpen: true, listenOn: true, listenState: 'listening', busy: false,
    gateOk: true, lastAt: o.lastAt || 0, lastTryAt: 0, armedAt: 0, dueAt: 0, sent: [], skipped: [] };
  s.schedule = () => {
    const pending = !!s.dueAt;
    s.dueAt = 0;
    if (!pending) s.armedAt = s.t;
    const p = T.plan({ intervalMin: s.interval, band: s.band, windowOpen: s.windowOpen, lastAt: Math.max(s.lastAt, s.lastTryAt), armedAt: s.armedAt, now: s.t });
    if (p.on) s.dueAt = s.t + p.dueMs;
    return p;
  };
  s.stop = () => { s.dueAt = 0; };
  s.advance = (ms) => {
    const end = s.t + ms;
    while (s.dueAt && s.dueAt <= end) {
      s.t = s.dueAt; s.dueAt = 0;
      s.lastTryAt = s.t;
      const skip = T.dueCheck({ band: s.band, listenOn: s.listenOn, listenState: s.listenState, busy: s.busy });
      if (skip) s.skipped.push(skip.reason);
      else if (s.gateOk) { s.sent.push(s.t); s.lastAt = s.t; } else s.skipped.push('gate');
      s.schedule();
    }
    s.t = end;
  };
  return s;
}

console.log('APRS radio beacon timer (2 m only)');

test('off by default: no setting, no timer', () => {
  assert.strictEqual(B.beaconSettings({}).rfIntervalMin, 0);
  assert.deepStrictEqual(T.plan({ intervalMin: undefined, band: '2m', windowOpen: true, now: 0 }), { on: false, reason: 'off' });
});

test('never more often than every 10 minutes, whatever is asked', () => {
  assert.strictEqual(T.intervalMinutes(1), 10);
  assert.strictEqual(T.intervalMinutes(9.4), 10);
  assert.strictEqual(T.intervalMinutes(45), 30);
  assert.strictEqual(T.intervalMinutes(-5), 0);
  assert.deepStrictEqual(B.settingsPatch({ rfIntervalMin: 2 }), { aprsRfBeaconIntervalMin: 10 }, 'the window pick, cleaned');
  assert.deepStrictEqual(B.settingsPatch({ rfIntervalMin: 0 }), { aprsRfBeaconIntervalMin: 0 });
  assert.deepStrictEqual(T.INTERVALS, [0, 10, 20, 30]);
  const s = station({ interval: 1 });
  s.schedule();
  s.advance(60 * MIN);
  for (let i = 1; i < s.sent.length; i++) assert.ok(s.sent[i] - s.sent[i - 1] >= 10 * MIN);
  assert.strictEqual(s.sent.length, 6);
});

test('picking an interval never sends at once: the first beacon is one full interval later', () => {
  const s = station({ interval: 10, lastAt: 1e9 - 3600000 }); // the last radio beacon an hour ago
  s.schedule();
  s.advance(0);
  assert.deepStrictEqual(s.sent, []);
  s.advance(10 * MIN - 1);
  assert.deepStrictEqual(s.sent, [], 'not one ms early');
  s.advance(1);
  assert.strictEqual(s.sent.length, 1);
});

test('opening the window with an interval saved never sends at once', () => {
  const s = station({ interval: 20 });
  s.windowOpen = false; s.schedule();
  assert.strictEqual(s.dueAt, 0, 'closed: no timer');
  s.t += 3 * 3600000;
  s.windowOpen = true; s.stop(); s.schedule();
  s.advance(20 * MIN - 1);
  assert.deepStrictEqual(s.sent, []);
  s.advance(1);
  assert.strictEqual(s.sent.length, 1);
});

test('30 m: no timer at all; back on 2 m it starts one interval on, never at once', () => {
  const p = T.plan({ intervalMin: 10, band: '30m', windowOpen: true, now: 0 });
  assert.deepStrictEqual(p, { on: false, reason: 'band', sentence: T.SENTENCES.band });
  assert.ok(/2 m only/.test(T.SENTENCES.band));
  const s = station({ interval: 10, band: '30m' });
  s.schedule();
  s.advance(60 * MIN);
  assert.deepStrictEqual(s.sent, [], 'never on 30 m');
  s.band = '2m'; s.schedule(); // main's aprsRfTimerSync on the band change
  s.advance(10 * MIN - 1);
  assert.deepStrictEqual(s.sent, []);
  s.advance(1);
  assert.strictEqual(s.sent.length, 1);
  assert.deepStrictEqual(T.dueCheck({ band: '30m', listenOn: true, listenState: 'listening' }).reason, 'band', 'a due round on 30 m is skipped');
});

test('due while not listening, busy, or refused by the gate: skipped, and the next try is a full interval later', () => {
  const s = station({ interval: 10 });
  s.schedule();
  s.listenOn = false;
  s.advance(10 * MIN);
  assert.deepStrictEqual(s.skipped, ['listen']);
  s.listenOn = true;
  s.advance(10 * MIN - 1);
  assert.deepStrictEqual(s.sent, [], 'turning listening on does not send early');
  s.advance(1);
  assert.strictEqual(s.sent.length, 1);
  s.busy = true; s.advance(10 * MIN); assert.strictEqual(s.skipped[1], 'busy');
  s.busy = false; s.gateOk = false; s.advance(10 * MIN); assert.strictEqual(s.skipped[2], 'gate');
  assert.strictEqual(s.sent.length, 1);
});

test('a click moves the next timed beacon back; a restart counts from the saved last time', () => {
  const s = station({ interval: 10 });
  s.schedule();
  s.advance(7 * MIN);
  s.lastAt = s.t; s.schedule(); // a confirmed click, then main re-plans with the timer pending
  s.advance(10 * MIN - 1);
  assert.deepStrictEqual(s.sent, []);
  s.advance(1);
  assert.strictEqual(s.sent.length, 1);
  assert.strictEqual(T.lastAtFrom({ aprsRfBeaconLastAt: 5000 }, 9000), 5000);
  assert.strictEqual(T.lastAtFrom({ aprsRfBeaconLastAt: 99999 }, 9000), 9000, 'never in the future');
  assert.strictEqual(T.lastAtFrom({}, 9000), 0);
});

test('the window closing stops it', () => {
  const s = station({ interval: 10 });
  s.schedule();
  s.windowOpen = false; s.stop(); s.schedule();
  s.advance(60 * MIN);
  assert.deepStrictEqual(s.sent, []);
});

test('the timed beacon is the click\'s beacon: the gate refuses it the same way', () => {
  const st = { windowOpen: true, listenOn: false, listenState: 'off', band: '2m', settingsCall: 'K3SBP', aprsHz: 144390000, dialHz: 144390000, radioOwner: 'none', modemFound: true, inFlight: false };
  assert.strictEqual(G.readiness(st).reason, 'listen');
  assert.strictEqual(T.dueCheck({ band: '2m', listenOn: false, listenState: 'off' }).reason, 'listen');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
