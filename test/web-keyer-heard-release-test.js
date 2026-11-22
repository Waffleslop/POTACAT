#!/usr/bin/env node
'use strict';
// GitHub #244, LZ3AW's retest on 1.14.5 (2026-11-15): the TinyMIDI paddle on
// ECHOCAT Web still sends extra dots and dashes at 25 wpm. His cw-diag lines:
// the sidetone reached the speaker 57 ms after the keyer chose each element,
// 40 ms of it the device's output; paddle input up to 40 ms late. The 1.13.8
// rule withdrew a held element only if the release was PROCESSED before the
// element began to sound in the page (a ~20 ms window), so a release he made
// before he could hear the element, but which reached the page 40 ms late,
// kept it.
//
// 1.14.5 made the release count at the event's own timestamp and withdraw the
// element when it happened before the element reached his ear (start + the
// device's output latency). That withdrew elements whose tone had already
// started: the page cut its tone into a blip while the shack dropped the
// element, the extra elements LZ3AW heard on 1.14.6 only in his own sidetone.
//
// Casey 2026-11-19: the sidetone and the air always agree. An element may be
// withdrawn only before its sidetone starts (lib/cw-sidetone-commit.js);
// once it sounds it is keyed in full, whatever the release's timestamp. These
// cases now assert that rule; test/cw-sidetone-air-agree-test.js runs the
// page's own audio and the shack side by side.
// Run: node test/web-keyer-heard-release-test.js
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const Commit = require('../lib/cw-sidetone-commit');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

const src = readSrc(path.join(__dirname, '..', 'renderer', 'remote.js'));
const keyerSrc = src.slice(src.indexOf('  function createLocalCwKeyer(onKey) {'), src.indexOf('  // Phone-side sidetone is driven by the local keyer'));
function extract(name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name + ' missing');
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) break;
  }
  return src.slice(start, i + 1);
}
const midiSrc = extract('ecHandleMidiMessage');

function fakeClock() {
  let now = 1000, seq = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { at: now + Math.max(0, ms || 0), fn }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    advanceTo(t) {
      for (;;) {
        let next = null;
        for (const [id, tm] of timers) if (tm.at <= t && (!next || tm.at < next[1].at)) next = [id, tm];
        if (!next) break;
        timers.delete(next[0]);
        now = next[1].at;
        next[1].fn();
      }
      now = t;
    },
  };
}

const DIT_NOTE = 60, DAH_NOTE = 62;
const LEAD_MS = 17;        // his cw-diag: 57 ms choice-to-speaker, 40 of it the device
const OUTPUT_MS = 40;

// The web keyer + the page's real MIDI handler on a fake clock, with a device
// output latency. Steps: [real time of the contact change, 'on'|'off',
// 'dit'|'dah', delivered late by ms, timeStamp override].
function rig({ wpm = 25, mode = 'iambicB', outputMs = OUTPUT_MS } = {}) {
  const clock = fakeClock();
  const scheduled = [];
  const onKey = (down, ms, info) => {
    if (ms) { scheduled.push({ soundAt: clock.now() + LEAD_MS, el: ms < 2 * Math.round(1200 / wpm) ? '.' : '-' }); return LEAD_MS; }
    if (info && info.retract) {
      const last = scheduled[scheduled.length - 1];
      if (!Commit.canWithdraw(last, clock.now())) return false;
      last.retracted = true;
      return true;
    }
    return undefined;
  };
  const perf = { now: () => clock.now() };
  // eslint-disable-next-line no-new-func
  const make = new Function('setTimeout', 'clearTimeout', 'performance', 'Date', 'onKey', `
    var cwDiagNote = function() {};
    ${keyerSrc}
    var k = createLocalCwKeyer(onKey);
    var ditDown = false, dahDown = false, ecMidiLearning = null;
    var ecMidiDitNote = ${DIT_NOTE}, ecMidiDahNote = ${DAH_NOTE};
    function noteCwInputLag() {}
    function ecStopMidiLearn() {}
    function updateMidiNoteDisplays() {}
    function sendPaddle(contact, state) { if (contact === 'dit') k.paddleDit(!!state); else k.paddleDah(!!state); }
    ${midiSrc}
    return { keyer: k, midi: ecHandleMidiMessage };
  `);
  void outputMs; // the device's output latency no longer moves the commit point
  const { keyer, midi } = make(clock.setTimeout, clock.clearTimeout, perf, perf, onKey);
  keyer.setWpm(wpm); keyer.setMode(mode);
  const t0 = clock.now();
  return {
    play(steps, tailMs = 800) {
      const evs = steps.map(([at, kind, contact, lateMs = 0, ts]) => ({ at, kind, contact, deliver: at + lateMs, ts }))
        .sort((a, b) => a.deliver - b.deliver);
      for (const e of evs) {
        clock.advanceTo(t0 + e.deliver);
        const note = e.contact === 'dit' ? DIT_NOTE : DAH_NOTE;
        const data = e.kind === 'on' ? [0x90, note, 100] : [0x80, note, 0];
        midi({ data, timeStamp: e.ts !== undefined ? e.ts : t0 + e.at });
      }
      clock.advanceTo(clock.now() + tailMs);
      return scheduled.filter((x) => !x.retracted).map((x) => x.el).join('');
    },
  };
}

console.log('web keyer: a late release never takes back an element that has started to sound (#244, 2026-11-19)');

// 25 wpm: dit 48, space 48. Dit held from 0: dits chosen at 0, 96, 192, 288.
// The 4th sounds in the page at 305 (it is committed from 300, the guard).
test('"S": released at 330, delivered 30 ms late (after the 4th dit started): "...." on both sides', () => {
  assert.strictEqual(rig().play([[0, 'on', 'dit'], [330, 'off', 'dit', 30]]), '....');
});

test('"S": released at 280, delivered 15 ms late (before the 4th dit sounds): "..."', () => {
  assert.strictEqual(rig().play([[0, 'on', 'dit'], [280, 'off', 'dit', 15]]), '...');
});

test('released at 300 but delivered 40 ms late: its timestamp does not reach back, "...."', () => {
  assert.strictEqual(rig().play([[0, 'on', 'dit'], [300, 'off', 'dit', 40]]), '....');
});

test('released at 350, after the 4th dit reached his ear: "...." (he heard it, it is sent)', () => {
  assert.strictEqual(rig().play([[0, 'on', 'dit'], [350, 'off', 'dit', 2]]), '....');
});

test('"T": dah held, released at 220, delivered 25 ms late (the 2nd dah sounds at 209): "--"', () => {
  assert.strictEqual(rig().play([[0, 'on', 'dah'], [220, 'off', 'dah', 25]]), '--');
});

test('"T": dah released at 195, in time (before the 2nd dah sounds): "-"', () => {
  assert.strictEqual(rig().play([[0, 'on', 'dah'], [195, 'off', 'dah', 2]]), '-');
});

test('a release that reaches the page long after the choice: kept', () => {
  // chosen 288; the release happened at 300 but the page learns at 395.
  assert.strictEqual(rig().play([[0, 'on', 'dit'], [300, 'off', 'dit', 95]]), '....');
});

test('the window is the page\'s own sidetone start, whatever the device\'s output latency', () => {
  assert.strictEqual(rig({ outputMs: 0 }).play([[0, 'on', 'dit'], [295, 'off', 'dit', 0]]), '...');
  assert.strictEqual(rig({ outputMs: 200 }).play([[0, 'on', 'dit'], [295, 'off', 'dit', 0]]), '...');
  assert.strictEqual(rig({ outputMs: 200 }).play([[0, 'on', 'dit'], [312, 'off', 'dit', 0]]), '....');
});

test('held dits still repeat, and a squeeze still makes "C" in iambic B', () => {
  assert.strictEqual(rig().play([[0, 'on', 'dit'], [560, 'off', 'dit', 10]]), '......'); // 6th chosen 480, heard 537
  assert.strictEqual(rig().play([[0, 'on', 'dah'], [10, 'on', 'dit'], [470, 'off', 'dah'], [490, 'off', 'dit']]), '-.-.');
});

test('a latched element is never withdrawn, however late the release', () => {
  assert.strictEqual(rig().play([[0, 'on', 'dah'], [60, 'on', 'dit'], [90, 'off', 'dit', 30], [150, 'off', 'dah', 30]]), '-.');
});

test('page wiring: no heard-lag window and no timestamps; a tone that started is never faded out', () => {
  assert.ok(!/cwHeardLagMs|HEARD_LAG_MAX_MS|RETRACT_RF_MAX_MS/.test(src), 'the heard-lag window is gone');
  assert.ok(/localCwKeyer\.paddleDit\(!!state\);/.test(src), 'sendPaddle hands only the contact state');
  const r = extract('retractPaddleElement');
  assert.ok(!/cancelAndHoldAtTime|nowA/.test(r), 'no cut of a tone already rendering');
});

console.log('shack playout: a withdrawal that arrives late');

test('a cancel that arrives after its element began at the shack: the element plays whole, later timing unmoved', () => {
  const { CwKeyPlayout } = require('../lib/cw-key-playout');
  const clock = fakeClock();
  const out = [];
  const logs = [];
  const p = new CwKeyPlayout({ output: (e) => out.push([e.down, e.timestamp]), now: clock.now, setTimer: clock.setTimeout, clearTimer: clock.clearTimeout, bufferMs: 120, log: (l) => logs.push(l) });
  const t = clock.now();
  p.push({ at: 0, down: true, ms: 48 });            // plays 120..168
  clock.advanceTo(t + 96);
  p.push({ at: 96, down: true, ms: 48 });           // plays 216..264
  clock.advanceTo(t + 230);                          // the 2nd is on the air
  const bufBefore = p.bufferMs;
  p.push({ at: 95, down: false, cancel: true });    // too late
  clock.advanceTo(t + 1000);
  const edges = out.map((e) => [e[0], e[1] - t]);
  assert.deepStrictEqual(edges, [[true, 120], [false, 168], [true, 216], [false, 264]], 'both dits whole');
  assert.strictEqual(p.bufferMs, bufBefore, 'the buffer did not grow for a cancel');
  assert.ok(logs.some((l) => /withdrawn element reached the shack/.test(l)), 'logged');
});

test('a cancel in time still drops the withdrawn element (unchanged)', () => {
  const { CwKeyPlayout } = require('../lib/cw-key-playout');
  const clock = fakeClock();
  const out = [];
  const p = new CwKeyPlayout({ output: (e) => out.push(e.down), now: clock.now, setTimer: clock.setTimeout, clearTimer: clock.clearTimeout, bufferMs: 120 });
  const t = clock.now();
  p.push({ at: 0, down: true, ms: 48 });
  clock.advanceTo(t + 96);
  p.push({ at: 96, down: true, ms: 48 });
  clock.advanceTo(t + 190);                          // 100 ms after the choice; it plays at 216
  p.push({ at: 95, down: false, cancel: true });
  clock.advanceTo(t + 1000);
  assert.strictEqual(out.filter(Boolean).length, 1);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
