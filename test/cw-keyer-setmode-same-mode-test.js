#!/usr/bin/env node
'use strict';
// ECHOCAT Web: a settings or config echo does not cut a CW over when the
// keyer mode is unchanged (found while investigating #244; Casey 2026-11-24:
// "stop cancelling a CW over when the mode has not changed").
//
// The page applies the keyer mode from every cw-config-ack and every
// settings message, changed or not. Its keyer's setMode() used to cancel an
// over in progress on every call, so a routine echo cut tones and elements
// mid-over. Same mode is now a no-op; a real mode change still cancels.
//
// Runs the page's REAL keyer and sidetone code (renderer/remote.js, from
// "Local iambic CW keyer" to "Default macros") with a fake audio clock, a
// fake socket and the shack's real playout (lib/cw-key-playout.js), the same
// harness as test/cw-sidetone-air-agree-test.js, and compares what the
// operator HEARD with what went on the AIR.
// Run: node test/cw-keyer-setmode-same-mode-test.js
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const { CwKeyPlayout } = require('../lib/cw-key-playout');
const Commit = require('../lib/cw-sidetone-commit');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

const src = readSrc(path.join(__dirname, '..', 'renderer', 'remote.js'));
const pageSrc = src.slice(src.indexOf('  // --- Local iambic CW keyer ---'), src.indexOf('  // Default macros'));
assert.ok(pageSrc.length > 1000, 'page keyer region found');

function fakeClock() {
  let now = 0, seq = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { at: now + Math.max(0, ms || 0), fn, seq: id }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    advanceTo(t) {
      for (;;) {
        let next = null;
        for (const [id, tm] of timers) if (tm.at <= t && (!next || tm.at < next[1].at || (tm.at === next[1].at && tm.seq < next[1].seq))) next = [id, tm];
        if (!next) break;
        timers.delete(next[0]);
        now = Math.max(now, next[1].at);
        next[1].fn();
      }
      now = Math.max(now, t);
    },
  };
}

// A gain AudioParam rendered up to the audio clock before every change:
// rendered output is what the operator hears.
const QUANTUM_MS = 128 / 48000 * 1000;
function fakeAudio(clock) {
  const audioMs = () => Math.floor(clock.now() / QUANTUM_MS) * QUANTUM_MS;
  const heard = [];
  let renderedTo = 0, on = null;
  const ev = [];
  function valueAt(x) {
    let prev = { t: 0, v: 0 };
    for (const e of ev) {
      if (e.t <= x) { prev = e; continue; }
      if (e.type === 'ramp') return prev.v + (e.v - prev.v) * ((x - prev.t) / Math.max(1e-9, e.t - prev.t));
      return prev.v;
    }
    return prev.v;
  }
  function render(toMs) {
    for (let x = renderedTo; x < toMs; x += 0.25) {
      const g = valueAt(x) > 0.01;
      if (g && on == null) on = x;
      if (!g && on != null) { heard.push([on, x]); on = null; }
    }
    renderedTo = Math.max(renderedTo, toMs);
  }
  const sortEv = () => ev.sort((a, b) => a.t - b.t);
  const gain = {
    setValueAtTime(v, tSec) { render(audioMs()); ev.push({ type: 'set', t: tSec * 1000, v }); sortEv(); },
    linearRampToValueAtTime(v, tSec) { render(audioMs()); ev.push({ type: 'ramp', t: tSec * 1000, v }); sortEv(); },
    cancelScheduledValues(tSec) { render(audioMs()); const t = tSec * 1000; for (let i = ev.length - 1; i >= 0; i--) if (ev[i].t >= t) ev.splice(i, 1); },
    cancelAndHoldAtTime(tSec) { render(audioMs()); const t = tSec * 1000; const v = valueAt(t); for (let i = ev.length - 1; i >= 0; i--) if (ev[i].t >= t) ev.splice(i, 1); ev.push({ type: 'set', t, v }); sortEv(); },
    get value() { return valueAt(audioMs()); },
  };
  const ctx = {
    get currentTime() { return audioMs() / 1000; },
    baseLatency: 0, outputLatency: 0.040,
    destination: {},
    createOscillator: () => ({ type: 'sine', frequency: { value: 600 }, connect() {}, start() {} }),
    createGain: () => ({ gain, connect() {} }),
  };
  return { ctx, heard, finish(t) { render(t); if (on != null) { heard.push([on, t]); on = null; } } };
}

// The page + a 30 ms network + the shack.
function rig({ wpm = 25, mode = 'iambicB' } = {}) {
  const clock = fakeClock();
  const audio = fakeAudio(clock);
  const air = [];
  let keyedAt = null;
  const shack = new CwKeyPlayout({
    output: (e) => {
      if (e.down && keyedAt == null) keyedAt = clock.now();
      else if (!e.down && keyedAt != null) { air.push([keyedAt, clock.now()]); keyedAt = null; }
    },
    now: clock.now, setTimer: clock.setTimeout, clearTimer: clock.clearTimeout, bufferMs: 120,
  });
  let lastDeliver = 0;
  const wire = [];
  const ws = {
    readyState: 1,
    send(json) {
      const msg = JSON.parse(json);
      if (msg.type !== 'cw-key') return;
      wire.push(msg);
      const at = Math.max(lastDeliver, clock.now() + 30);
      lastDeliver = at;
      clock.setTimeout(() => shack.push(msg), at - clock.now());
    },
  };
  const perf = { now: () => clock.now() };
  // eslint-disable-next-line no-new-func
  const make = new Function('setTimeout', 'clearTimeout', 'performance', 'Date', 'window', 'ws', 'WebSocket', 'audioCtx', `
    var cwAudioCtx = audioCtx;
    var cwWpm = ${wpm}, cwSidetoneFreq = 600, cwSidetoneVol = 0.8, cwKeyStreamOk = true;
    function ensureCwAudioCtx() { return cwAudioCtx; }
    function handleCwSidetone() {}
    ${pageSrc}
    return localCwKeyer;
  `);
  const keyer = make(clock.setTimeout, clock.clearTimeout, perf, perf, { CwSidetoneCommit: Commit }, ws, { OPEN: 1 }, audio.ctx);
  keyer.setWpm(wpm); keyer.setMode(mode);
  const t0 = 100;
  clock.advanceTo(t0);
  return {
    keyer,
    // steps: [ms after start, action]; action is 'dit'/'dah' with pressed,
    // or a function run against the keyer (a message arriving)
    play(steps, tailMs = 1500) {
      for (const [at, what, pressed] of steps) {
        clock.advanceTo(t0 + at);
        if (what === 'dit') keyer.paddleDit(pressed);
        else if (what === 'dah') keyer.paddleDah(pressed);
        else what(keyer);
      }
      clock.advanceTo(clock.now() + tailMs);
      audio.finish(clock.now());
      return { heard: audio.heard.map(([a, b]) => b - a), air: air.map(([a, b]) => b - a), wire };
    },
  };
}

const DIT = 48, DAH = 144; // 25 wpm
function word(lens) {
  return lens.map((d) => (Math.abs(d - DIT) <= 2 ? '.' : Math.abs(d - DAH) <= 2 ? '-' : `(${Math.round(d)})`)).join('');
}
function agree(r, expect) {
  const h = word(r.heard), a = word(r.air);
  assert.strictEqual(h, a, `heard "${h}" but the air sent "${a}"`);
  if (expect !== undefined) assert.strictEqual(h, expect, `heard and sent "${h}", expected "${expect}"`);
}

// What the page applies to its keyer for each message (renderer/remote.js,
// case 'cw-config-ack' and the two settings handlers).
const cwConfigAck = (msg) => (k) => {
  if (msg.wpm) k.setWpm(msg.wpm);
  if (msg.mode) k.setMode(msg.mode);
  if (typeof msg.swap === 'boolean') k.setSwap(msg.swap);
};
const settings = (s) => (k) => {
  if (s.cwKeyerMode) k.setMode(s.cwKeyerMode);
  if (typeof s.cwSwapPaddles === 'boolean') k.setSwap(s.cwSwapPaddles);
};

console.log('ECHOCAT Web: a settings or config echo with the same mode leaves the over alone');

// 25 wpm, dah held from 0: dahs sound at 20, 212, 404 (each 144 ms, 48 ms space);
// a message at 80 lands in the middle of the first dah.
test('baseline: dah held for three dahs, no message: "---" heard and sent', () => {
  agree(rig().play([[0, 'dah', true], [500, 'dah', false]]), '---');
});

test('a cw-config-ack with the same mode, wpm and swap mid-dah: the over survives ("---")', () => {
  const r = rig().play([[0, 'dah', true], [80, cwConfigAck({ wpm: 25, mode: 'iambicB', swap: false })], [500, 'dah', false]]);
  agree(r, '---');
  assert.ok(!r.wire.some((m) => m.cancel), 'no cancel on the wire: ' + JSON.stringify(r.wire));
});

test('a settings message with the same mode mid-dah: the over survives ("---")', () => {
  const r = rig().play([[0, 'dah', true], [80, settings({ cwKeyerMode: 'iambicB', cwSwapPaddles: false })], [500, 'dah', false]]);
  agree(r, '---');
  assert.ok(!r.wire.some((m) => m.cancel), 'no cancel on the wire: ' + JSON.stringify(r.wire));
});

test('same mode in the space between elements: the next element is still keyed ("---")', () => {
  // the first dah ends at 164 (page time); the space runs to 212
  agree(rig().play([[0, 'dah', true], [180, cwConfigAck({ mode: 'iambicB' })], [190, settings({ cwKeyerMode: 'iambicB' })], [500, 'dah', false]]), '---');
});

test('an iambic B squeeze for "C" with echoes in the middle keeps its bonus dit ("-.-.")', () => {
  agree(rig().play([[0, 'dah', true], [10, 'dit', true], [150, cwConfigAck({ wpm: 25, mode: 'iambicB' })],
    [300, settings({ cwKeyerMode: 'iambicB' })], [470, 'dah', false], [490, 'dit', false]]), '-.-.');
});

test('iambic A: an echo with iambicA mid-over leaves it alone ("---")', () => {
  agree(rig({ mode: 'iambicA' }).play([[0, 'dah', true], [80, cwConfigAck({ mode: 'iambicA' })], [500, 'dah', false]]), '---');
});

console.log('a real mode change still cancels the over, as before');

test('cw-config-ack switching iambicB -> iambicA mid-dah: the dah is cut on both, nothing more keyed', () => {
  const r = rig().play([[0, 'dah', true], [80, cwConfigAck({ mode: 'iambicA' })], [500, 'dah', false]]);
  assert.strictEqual(r.heard.length, 1, 'heard ' + JSON.stringify(r.heard));
  assert.strictEqual(r.air.length, 1, 'air ' + JSON.stringify(r.air));
  assert.ok(r.heard[0] < DAH - 2, 'tone cut, heard ' + r.heard[0]);
  assert.ok(r.air[0] < DAH - 2, 'air cut, keyed ' + r.air[0]);
  assert.ok(r.wire.some((m) => m.cancel), 'a cancel went on the wire');
});

test('settings switching iambicB -> straight mid-dah: the dah is cut on both', () => {
  const r = rig().play([[0, 'dah', true], [80, settings({ cwKeyerMode: 'straight' })], [500, 'dah', false]]);
  assert.strictEqual(r.heard.length, 1); assert.strictEqual(r.air.length, 1);
  assert.ok(r.heard[0] < DAH - 2 && r.air[0] < DAH - 2, `heard ${r.heard[0]}, keyed ${r.air[0]}`);
});

test('after a real change, the same mode again is a no-op and the new mode is in force', () => {
  // switch to iambicA while idle, echo iambicA mid-squeeze: iambic A has no bonus dit
  const r = rig().play([[-50, cwConfigAck({ mode: 'iambicA' })], [0, 'dah', true], [10, 'dit', true],
    [150, settings({ cwKeyerMode: 'iambicA' })], [400, 'dah', false], [420, 'dit', false]]);
  agree(r, '-.-');
});

test('an unknown mode is ignored and does not cancel', () => {
  agree(rig().play([[0, 'dah', true], [80, cwConfigAck({ mode: 'bogus' })], [500, 'dah', false]]), '---');
});

console.log('page wiring');

test('cw-config-ack and both settings handlers apply the mode through localCwKeyer.setMode', () => {
  const ack = src.slice(src.indexOf("case 'cw-config-ack':"), src.indexOf('break;', src.indexOf("case 'cw-config-ack':")));
  assert.ok(/localCwKeyer\.setMode\(msg\.mode\)/.test(ack), 'cw-config-ack calls setMode');
  assert.ok(!/localCwKeyer\.stop\(/.test(ack), 'cw-config-ack never stops the keyer');
  const n = (src.match(/localCwKeyer\.setMode\(cwMode\)/g) || []).length;
  assert.ok(n >= 2, 'both settings handlers call setMode, found ' + n);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
