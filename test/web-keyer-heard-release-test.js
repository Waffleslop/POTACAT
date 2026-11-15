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
// Now: the release counts at the event's own timestamp, and it withdraws the
// element when it happened before the element reached his ear (start + the
// device's output latency), as long as the shack can still drop it.
// Run: node test/web-keyer-heard-release-test.js
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');

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
    if (ms) { scheduled.push({ el: ms < 2 * Math.round(1200 / wpm) ? '.' : '-' }); return LEAD_MS; }
    if (info && info.retract) scheduled[scheduled.length - 1].retracted = true;
    return undefined;
  };
  const perf = { now: () => clock.now() };
  // eslint-disable-next-line no-new-func
  const make = new Function('setTimeout', 'clearTimeout', 'performance', 'Date', 'onKey', 'cwHeardLagMs', `
    var cwDiagNote = function() {};
    ${keyerSrc}
    var k = createLocalCwKeyer(onKey);
    var ditDown = false, dahDown = false, ecMidiLearning = null;
    var ecMidiDitNote = ${DIT_NOTE}, ecMidiDahNote = ${DAH_NOTE};
    function noteCwInputLag() {}
    function ecStopMidiLearn() {}
    function updateMidiNoteDisplays() {}
    function sendPaddle(contact, state, atMs) { if (contact === 'dit') k.paddleDit(!!state, atMs); else k.paddleDah(!!state, atMs); }
    ${midiSrc}
    return { keyer: k, midi: ecHandleMidiMessage };
  `);
  const { keyer, midi } = make(clock.setTimeout, clock.clearTimeout, perf, perf, onKey, () => outputMs);
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

console.log('web keyer: a release counts when it happened and against what he hears (#244, 1.14.5)');

// 25 wpm: dit 48, space 48. Dit held from 0: dits chosen at 0, 96, 192, 288.
// The 4th sounds in the page at 305 and reaches his ear at 345.
test('"S": released at 330 (before he could hear the 4th dit), delivered 30 ms late: "..."', () => {
  assert.strictEqual(rig().play([[0, 'on', 'dit'], [330, 'off', 'dit', 30]]), '...');
});

test('"S": released at 300, delivered 40 ms late (his worst input lag): "..."', () => {
  assert.strictEqual(rig().play([[0, 'on', 'dit'], [300, 'off', 'dit', 40]]), '...');
});

test('released at 350, after the 4th dit reached his ear: "...." (he heard it, it is sent)', () => {
  assert.strictEqual(rig().play([[0, 'on', 'dit'], [350, 'off', 'dit', 2]]), '....');
});

test('"T": dah held, released at 220 before the 2nd dah could be heard (chosen 192, heard 249): "-"', () => {
  assert.strictEqual(rig().play([[0, 'on', 'dah'], [220, 'off', 'dah', 25]]), '-');
});

test('a release that reaches the page more than 100 ms after the choice is too late for the shack: kept', () => {
  // chosen 288; the release happened at 300 but the page learns at 395.
  assert.strictEqual(rig().play([[0, 'on', 'dit'], [300, 'off', 'dit', 95]]), '....');
});

test('no output latency reported: the 1.13.8 window (before it sounds in the page) still applies', () => {
  assert.strictEqual(rig({ outputMs: 0 }).play([[0, 'on', 'dit'], [300, 'off', 'dit', 0]]), '...');
  assert.strictEqual(rig({ outputMs: 0 }).play([[0, 'on', 'dit'], [312, 'off', 'dit', 0]]), '....');
});

test('a timestamp from another clock (epoch ms) is ignored: the release counts when processed', () => {
  // processed at 340 (< 345 heard): withdrawn on processing time alone
  assert.strictEqual(rig().play([[0, 'on', 'dit'], [340, 'off', 'dit', 0, Date.now()]]), '...');
});

test('held dits still repeat, and a squeeze still makes "C" in iambic B', () => {
  assert.strictEqual(rig().play([[0, 'on', 'dit'], [560, 'off', 'dit', 10]]), '......'); // 6th chosen 480, heard 537
  assert.strictEqual(rig().play([[0, 'on', 'dah'], [10, 'on', 'dit'], [470, 'off', 'dah'], [490, 'off', 'dit']]), '-.-.');
});

test('a latched element is never withdrawn, however late the release', () => {
  assert.strictEqual(rig().play([[0, 'on', 'dah'], [60, 'on', 'dit'], [90, 'off', 'dit', 30], [150, 'off', 'dah', 30]]), '-.');
});

test('page wiring: key-up and MIDI note-off pass their timeStamp, and the heard lag is the device output latency', () => {
  assert.ok(/sendPaddle\('dit', 0, e\.timeStamp\)/.test(src) && /sendPaddle\('dah', 0, e\.timeStamp\)/.test(src), 'keyboard key-up');
  assert.ok(/sendPaddle\('dit', 0, msg\.timeStamp\)/.test(src) && /sendPaddle\('dah', 0, msg\.timeStamp\)/.test(src), 'MIDI note-off');
  assert.ok(/localCwKeyer\.paddleDit\(!!state, atMs\)/.test(src), 'sendPaddle hands the time to the keyer');
  const fn = extract('cwHeardLagMs');
  assert.ok(/outputLatency/.test(fn) && /baseLatency/.test(fn), 'output latency');
  const r = extract('retractPaddleElement');
  assert.ok(/linearRampToValueAtTime\(0, nowA \+ 0\.003\)/.test(r), 'a tone already rendering fades out');
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
