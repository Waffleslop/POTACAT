#!/usr/bin/env node
'use strict';
// #244 diagnostic: the ECHOCAT Web page keyer's timing record of one over
// (lib/cw-keyer-timing-diag.js, Casey 2026-11-24 "build 244 diag").
//
// LZ3AW hears extra dots and dashes from a paddle. Suspected, unproven on a
// real phone: the keyer chooses each element about 20 ms before it sounds,
// he releases on what he hears, and the phone plays it about 40 ms late. The
// record measures that per over and the desktop logs one line.
//
// It must change NOTHING that is keyed. Part 1 proves it: the page's REAL
// keyer and sidetone code (renderer/remote.js, from "Local iambic CW keyer"
// to "Default macros") runs the same paddle sequences twice, with the record
// present and with it absent, on a fake audio clock, a fake socket and the
// shack's real playout (the harness of test/cw-sidetone-air-agree-test.js).
// The sidetone edges, the cw-key messages and the edges keyed on the air
// must be identical: same times, same order.
// Part 2 checks what the page sends; part 3 the summary maths and the line.
// Run: node test/cw-keyer-timing-diag-test.js
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const { CwKeyPlayout } = require('../lib/cw-key-playout');
const Commit = require('../lib/cw-sidetone-commit');
const Diag = require('../lib/cw-keyer-timing-diag');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

const src = readSrc(path.join(__dirname, '..', 'renderer', 'remote.js'));
const pageSrc = src.slice(src.indexOf('  // --- Local iambic CW keyer ---'), src.indexOf('  // Default macros'));
assert.ok(pageSrc.length > 1000, 'page keyer region found');

// `late(now, ms)`: how late a timer fires. It depends only on when the timer
// was set and for how long, never on how many timers exist, so the record's
// own timer cannot shift anyone else's lateness.
function fakeClock(late) {
  let now = 0, seq = 0;
  const timers = new Map();
  return {
    now: () => now,
    // exact: the shack and the network (only the page's timers run late)
    setTimeout: (fn, ms, exact) => {
      const id = ++seq;
      ms = Math.max(0, ms || 0);
      timers.set(id, { at: now + ms + (late && !exact ? late(now, ms) : 0), fn, seq: id });
      return id;
    },
    clearTimeout: (id) => { timers.delete(id); },
    advanceTo(t) {
      for (let guard = 0; ; guard++) {
        if (guard > 200000) throw new Error('the clock is not advancing at ' + now);
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
// A busy phone: each timer 0-15 ms late.
function phoneLate(now, ms) {
  let h = (Math.round(now * 8) * 2654435761 + Math.round(ms * 8) * 40503) >>> 0;
  h ^= h >>> 13; h = Math.imul(h, 1274126177) >>> 0; h ^= h >>> 16;
  return h % 16;
}

// A gain AudioParam rendered up to the audio clock before every change:
// rendered output is what the operator hears.
const QUANTUM_MS = 128 / 48000 * 1000;
function fakeAudio(clock, latency) {
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
    destination: {},
    createOscillator: () => ({ type: 'sine', frequency: { value: 600 }, connect() {}, start() {} }),
    createGain: () => ({ gain, connect() {} }),
  };
  if (latency) { ctx.baseLatency = latency.base; ctx.outputLatency = latency.output; }
  return { ctx, heard, finish(t) { render(t); if (on != null) { heard.push([on, t]); on = null; } } };
}

// The page + a 30 ms network + the shack. `diag: false` builds the page
// without the record (window.CwKeyerTimingDiag absent), as a page whose
// inlining failed would be.
function rig({ wpm = 25, mode = 'iambicB', diag = true, late = null, latency = { base: 0.005, output: 0.040 } } = {}) {
  const clock = fakeClock(late);
  const audio = fakeAudio(clock, latency);
  const air = [];
  let keyedAt = null;
  const shack = new CwKeyPlayout({
    output: (e) => {
      if (e.down && keyedAt == null) keyedAt = clock.now();
      else if (!e.down && keyedAt != null) { air.push([keyedAt, clock.now()]); keyedAt = null; }
    },
    now: clock.now, setTimer: (fn, ms) => clock.setTimeout(fn, ms, true), clearTimer: clock.clearTimeout, bufferMs: 120,
  });
  let lastDeliver = 0;
  const wire = [], timing = [];
  const ws = {
    readyState: 1,
    send(json) {
      const msg = JSON.parse(json);
      if (msg.type === 'cw-timing') { timing.push({ sentAt: clock.now(), msg }); return; }
      if (msg.type !== 'cw-key') return;
      wire.push({ sentAt: clock.now(), msg });
      const at = Math.max(lastDeliver, clock.now() + 30);
      lastDeliver = at;
      clock.setTimeout(() => shack.push(msg), at - clock.now(), true);
    },
  };
  const perf = { now: () => clock.now() };
  const win = { CwSidetoneCommit: Commit };
  if (diag) win.CwKeyerTimingDiag = Diag;
  // eslint-disable-next-line no-new-func
  const make = new Function('setTimeout', 'clearTimeout', 'performance', 'Date', 'window', 'ws', 'WebSocket', 'audioCtx', `
    var cwAudioCtx = audioCtx;
    var cwWpm = ${wpm}, cwSidetoneFreq = 600, cwSidetoneVol = 0.8, cwKeyStreamOk = true;
    function ensureCwAudioCtx() { return cwAudioCtx; }
    function handleCwSidetone() {}
    ${pageSrc}
    return localCwKeyer;
  `);
  const keyer = make(clock.setTimeout, clock.clearTimeout, perf, perf, win, ws, { OPEN: 1 }, audio.ctx);
  keyer.setWpm(wpm); keyer.setMode(mode);
  const t0 = 100;
  clock.advanceTo(t0);
  return {
    keyer, t0, timing,
    // steps: [ms after start, 'dit' | 'dah' | fn(keyer), pressed]
    play(steps, tailMs = 3000) {
      for (const [at, what, pressed] of steps) {
        clock.advanceTo(t0 + at);
        if (what === 'dit') keyer.paddleDit(pressed);
        else if (what === 'dah') keyer.paddleDah(pressed);
        else what(keyer);
      }
      clock.advanceTo(clock.now() + tailMs);
      audio.finish(clock.now());
      return { heard: audio.heard, air, wire, timing, now: clock.now() };
    },
  };
}

const DIT = 48, DAH = 144; // 25 wpm
function word(spans) {
  return spans.map(([a, b]) => b - a).map((d) => (Math.abs(d - DIT) <= 2 ? '.' : Math.abs(d - DAH) <= 2 ? '-' : `(${Math.round(d)})`)).join('');
}

// ---------------------------------------------------------------------------
console.log('1. the record changes no keying: same sequences with and without it');

// Everything keyed, with its time: the sidetone on/off edges, each cw-key
// message with the time it was sent, and the edges keyed on the air.
function keyed(r) {
  return { heard: r.heard, wire: r.wire, air: r.air };
}
function identical(opts, steps, label) {
  const on = rig(Object.assign({}, opts, { diag: true })).play(steps);
  const off = rig(Object.assign({}, opts, { diag: false })).play(steps);
  assert.deepStrictEqual(keyed(on), keyed(off), (label || '') + ' keyed differently with the record: ' + word(on.heard) + ' vs ' + word(off.heard));
  assert.strictEqual(off.timing.length, 0, 'the page without the record sent a cw-timing');
  return on;
}

const FIXED = [
  ['one dit tap', [[0, 'dit', true], [30, 'dit', false]]],
  ['one dah tap', [[0, 'dah', true], [60, 'dah', false]]],
  ['dah held for three dahs', [[0, 'dah', true], [500, 'dah', false]]],
  ['dit held for "S", released in time', [[0, 'dit', true], [250, 'dit', false]]],
  ['dit held, released before the 4th dit sounds (withdrawn)', [[0, 'dit', true], [275, 'dit', false]]],
  ['dit held, released just after the 4th dit sounds (kept)', [[0, 'dit', true], [296, 'dit', false]]],
  ['dah held, released just after the 2nd dah sounds', [[0, 'dah', true], [220, 'dah', false]]],
  ['squeeze for "C", both released during the last dit', [[0, 'dah', true], [60, 'dit', true], [420, 'dah', false], [425, 'dit', false]]],
  ['squeeze released mid-element (iambic B adds one)', [[0, 'dit', true], [5, 'dah', true], [120, 'dit', false], [125, 'dah', false]]],
  ['dot memory: a dit tapped inside a dah', [[0, 'dah', true], [60, 'dit', true], [90, 'dit', false], [130, 'dah', false]]],
  ['a contact bounce on the dit', [[0, 'dit', true], [3, 'dit', false], [6, 'dit', true], [40, 'dit', false]]],
  ['two words 700 ms apart', [[0, 'dit', true], [130, 'dit', false], [900, 'dah', true], [1300, 'dah', false]]],
  ['STOP mid-dah', [[0, 'dah', true], [80, (k) => k.stop()], [300, 'dah', false]]],
  ['a real mode change mid-over', [[0, 'dah', true], [200, (k) => k.setMode('iambicA')], [400, 'dah', false]]],
  ['a speed change mid-over', [[0, 'dit', true], [150, (k) => k.setWpm(18)], [600, 'dit', false]]],
  ['swapped paddles', [[0, (k) => k.setSwap(true)], [10, 'dit', true], [400, 'dit', false]]],
];
for (const mode of ['iambicB', 'iambicA', 'straight']) {
  test(`${mode}: ${FIXED.length} fixed sequences, identical sidetone, wire and air`, () => {
    for (const [name, steps] of FIXED) identical({ mode }, steps, `[${name}]`);
  });
}
test('the same with phone timers 0-15 ms late', () => {
  for (const mode of ['iambicB', 'iambicA']) for (const [name, steps] of FIXED) identical({ mode, late: phoneLate }, steps, `[${mode} ${name}]`);
});
test('the same at 18 and 35 wpm, and on a browser with no latency figures', () => {
  for (const wpm of [18, 35]) for (const [name, steps] of FIXED) identical({ wpm }, steps, `[${wpm} wpm ${name}]`);
  for (const [name, steps] of FIXED) identical({ latency: null }, steps, `[no latency ${name}]`);
});

// Random paddle sequences (seeded): presses and releases of both contacts.
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}
function randomSteps(r) {
  const steps = [];
  let t = 0, dit = false, dah = false;
  const n = 6 + Math.floor(r() * 24);
  for (let i = 0; i < n; i++) {
    t += 1 + Math.floor(r() * (r() < 0.15 ? 900 : 160));
    if (r() < 0.5) { dit = !dit; steps.push([t, 'dit', dit]); } else { dah = !dah; steps.push([t, 'dah', dah]); }
  }
  t += 20 + Math.floor(r() * 200);
  if (dit) steps.push([t, 'dit', false]);
  if (dah) steps.push([t + 3, 'dah', false]);
  return steps;
}
test('300 random paddle sequences, iambic A and B, on-time and late timers: identical', () => {
  const r = rng(244);
  let elements = 0, overs = 0;
  for (let i = 0; i < 300; i++) {
    const steps = randomSteps(r);
    const on = identical({ mode: i % 2 ? 'iambicA' : 'iambicB', late: i % 3 ? phoneLate : null, wpm: [25, 20, 30][i % 3] }, steps, `[random ${i}]`);
    elements += on.air.length;
    overs += on.timing.length;
  }
  assert.ok(elements > 2000, 'the random sequences keyed too little to prove anything: ' + elements);
  assert.ok(overs >= 300, 'every random sequence reported at least one over: ' + overs);
});

// ---------------------------------------------------------------------------
console.log('2. what the page sends');

// 25 wpm, dah held from 0: dahs sound at 20, 212, 404 (each 144 ms, 48 ms space).
test('one over, one cw-timing, about 2 s after the last paddle edge', () => {
  const r = rig().play([[0, 'dah', true], [500, 'dah', false]]);
  assert.strictEqual(word(r.heard), '---');
  assert.strictEqual(r.timing.length, 1, JSON.stringify(r.timing));
  const sinceRelease = r.timing[0].sentAt - (100 + 500);
  assert.ok(sinceRelease >= 2000 && sinceRelease <= 2100, 'sent ' + sinceRelease + ' ms after the release');
});

test('its numbers: 3 elements, mode, wpm, lead about 20 ms, the latency, the release 96 ms into the last dah', () => {
  const m = rig().play([[0, 'dah', true], [500, 'dah', false]]).timing[0].msg;
  assert.strictEqual(m.type, 'cw-timing');
  assert.strictEqual(m.elements, 3);
  assert.strictEqual(m.measured, 3);
  assert.strictEqual(m.withdrawn, 0);
  assert.strictEqual(m.edges, 2);
  assert.strictEqual(m.mode, 'iambicB');
  assert.strictEqual(m.wpm, 25);
  assert.strictEqual(m.afterReleaseN, 0);
  assert.ok(!('afterReleaseMaxMs' in m), 'no "by how many ms" when nothing was chosen after the release');
  assert.ok(m.leadMinMs >= 17 && m.leadMaxMs <= 21 && m.leadMinMs <= m.leadMedMs && m.leadMedMs <= m.leadMaxMs, JSON.stringify(m));
  assert.strictEqual(m.baseLatencyMs, 5);
  assert.strictEqual(m.outputLatencyMinMs, 40);
  assert.strictEqual(m.outputLatencyMaxMs, 40);
  assert.ok(Math.abs(m.lastReleaseAfterStartMs - 96) <= 3, 'release 500, third dah at 404: ' + m.lastReleaseAfterStartMs);
});

test('the suspected case: released 8 ms after the 2nd dah began, 40 ms before the phone played it', () => {
  const r = rig().play([[0, 'dah', true], [220, 'dah', false]]);
  assert.strictEqual(word(r.heard), '--', 'the element had started, so it is keyed in full (the rule of #796, unchanged)');
  const m = r.timing[0].msg;
  assert.strictEqual(m.elements, 2);
  assert.ok(m.lastReleaseAfterStartMs >= 5 && m.lastReleaseAfterStartMs <= 11, String(m.lastReleaseAfterStartMs));
  assert.ok(m.lastReleaseAfterStartMs < m.baseLatencyMs + m.outputLatencyMaxMs, 'he let go before he could have heard it');
  assert.ok(/2 elements, iambicB 25 wpm; 0 chosen after the last release; lead min\/med\/max \d+\/\d+\/\d+ ms; output latency 45 ms \(base 5 \+ output 40\); last release \d+ ms after the last element's start$/.test(Diag.formatLine(m)), Diag.formatLine(m));
});

test('an element taken back before it sounded is counted as withdrawn, not as an element', () => {
  const r = rig().play([[0, 'dah', true], [200, 'dah', false]]); // the 2nd dah is chosen near 192 and would sound at 212
  assert.strictEqual(word(r.heard), '-');
  const m = r.timing[0].msg;
  assert.strictEqual(m.elements, 1);
  assert.strictEqual(m.withdrawn, 1);
  assert.strictEqual(r.wire.filter((w) => w.msg.down).length, 1, 'and one element went to the shack');
});

test('iambic B squeeze released mid-element: the added element is chosen after the last release', () => {
  const r = rig().play([[0, 'dit', true], [5, 'dah', true], [120, 'dit', false], [125, 'dah', false]]);
  const m = r.timing[0].msg;
  assert.strictEqual(m.elements, r.heard.length);
  assert.ok(m.afterReleaseN >= 1, JSON.stringify(m));
  assert.ok(m.afterReleaseMinMs > 0 && m.afterReleaseMaxMs >= m.afterReleaseMinMs, JSON.stringify(m));
});

test('two overs more than 2 s apart: two messages, each with its own count', () => {
  const r = rig().play([[0, 'dit', true], [30, 'dit', false], [3000, 'dah', true], [3500, 'dah', false]]);
  assert.deepStrictEqual(r.timing.map((t) => t.msg.elements), [1, 3]);
  assert.deepStrictEqual(r.timing.map((t) => t.msg.edges), [2, 2]);
});

test('keying that goes on past 2 s is ONE over, reported when it ends', () => {
  const steps = [];
  for (let i = 0; i < 12; i++) { steps.push([i * 400, 'dah', true]); steps.push([i * 400 + 60, 'dah', false]); }
  const r = rig().play(steps);
  assert.strictEqual(r.timing.length, 1, JSON.stringify(r.timing.map((t) => t.sentAt)));
  assert.strictEqual(r.timing[0].msg.elements, 12);
  assert.ok(r.timing[0].sentAt >= 100 + 11 * 400 + 60 + 2000);
});

test('straight key, and a browser with no latency figures', () => {
  assert.strictEqual(rig({ mode: 'straight' }).play([[0, 'dit', true], [300, 'dit', false]]).timing.length, 0, 'no iambic element, no line');
  const m = rig({ latency: null }).play([[0, 'dit', true], [30, 'dit', false]]).timing[0].msg;
  assert.ok(!('baseLatencyMs' in m) && !('outputLatencyMaxMs' in m), JSON.stringify(m));
  assert.ok(/output latency unknown/.test(Diag.formatLine(m)), Diag.formatLine(m));
});

test('the message carries numbers and the mode name only, and fits the protocol schema', () => {
  const P = require('../lib/echocat-protocol');
  const r = rig().play([[0, 'dah', true], [60, 'dit', true], [420, 'dah', false], [425, 'dit', false]]);
  const m = r.timing[0].msg;
  for (const k of Object.keys(m)) {
    if (k === 'type' || k === 'mode') continue;
    assert.strictEqual(typeof m[k], 'number', k);
    assert.ok(P.MESSAGES['cw-timing'].fields[k], 'field ' + k + ' is in the schema');
  }
  assert.ok(P.validate(m, P.Dir.C2S).ok, JSON.stringify(P.validate(m, P.Dir.C2S)));
  assert.ok(JSON.stringify(m).length < 400, 'small: ' + JSON.stringify(m).length + ' bytes');
});

// ---------------------------------------------------------------------------
console.log('3. the summary maths and the log line');

function snap(elements, edges, extra) {
  return Object.assign({
    elements: elements.map(([chosenMs, leadMs, out]) => ({ chosenMs, startAudioMs: chosenMs + leadMs, leadMs, outputLatencyMs: out === undefined ? 38 : out })),
    edges: edges.map(([atMs, contact, pressed]) => ({ atMs, contact, pressed })),
    total: elements.length, withdrawn: 0,
  }, extra || {});
}
const INFO = { mode: 'iambicA', wpm: 25, baseLatencySec: 0.005 };

test('elements chosen after the last release are counted, with by how much', () => {
  // chosen at 0, 100, 200, 300; the dit is released at 150
  const s = Diag.summarize(snap([[0, 20], [100, 20], [200, 18], [300, 25]], [[0, 'dit', true], [150, 'dit', false]]), INFO);
  assert.strictEqual(s.elements, 4);
  assert.strictEqual(s.afterReleaseN, 2);
  assert.strictEqual(s.afterReleaseMinMs, 50);
  assert.strictEqual(s.afterReleaseMaxMs, 150);
  assert.deepStrictEqual([s.leadMinMs, s.leadMedMs, s.leadMaxMs], [18, 20, 25]);
  assert.strictEqual(s.lastReleaseAfterStartMs, 150 - 325);
  assert.strictEqual(Diag.formatLine(Diag.toMessage(s)),
    "[CW] page keyer timing, last over: 4 elements, iambicA 25 wpm; 2 chosen after the last release (+50 to +150 ms); lead min/med/max 18/20/25 ms; output latency 43 ms (base 5 + output 38); last release 175 ms before the last element's start");
});

test('a synthetic late release: chosen at 300, sounds at 320, released at 332', () => {
  const s = Diag.summarize(snap([[0, 20], [100, 20], [200, 20], [300, 20]], [[0, 'dit', true], [332, 'dit', false]]), INFO);
  assert.strictEqual(s.afterReleaseN, 0, 'the extra element was chosen BEFORE the release');
  assert.strictEqual(s.afterReleaseMinMs, null);
  assert.strictEqual(s.lastReleaseAfterStartMs, 12, 'and the release came 12 ms after its sidetone start, inside the 43 ms output latency');
  assert.strictEqual(Diag.formatLine(Diag.toMessage(s)),
    "[CW] page keyer timing, last over: 4 elements, iambicA 25 wpm; 0 chosen after the last release; lead min/med/max 20/20/20 ms; output latency 43 ms (base 5 + output 38); last release 12 ms after the last element's start");
});

test('one element chosen after a late release: the count is 1 and the line gives the one figure', () => {
  // released at 290; one more element is chosen at 300 (a latched or squeeze element)
  const s = Diag.summarize(snap([[0, 20], [100, 20], [200, 20], [300, 20]], [[0, 'dit', true], [10, 'dah', true], [280, 'dah', false], [290, 'dit', false]]), INFO);
  assert.strictEqual(s.afterReleaseN, 1);
  assert.strictEqual(s.afterReleaseMinMs, 10);
  assert.strictEqual(s.afterReleaseMaxMs, 10);
  assert.ok(/; 1 chosen after the last release \(\+10 ms\); /.test(Diag.formatLine(Diag.toMessage(s))), Diag.formatLine(Diag.toMessage(s)));
});

test('the last release is the last release of either contact; presses after it do not count', () => {
  const s = Diag.summarize(snap([[0, 20], [400, 20]], [[0, 'dit', true], [50, 'dit', false], [390, 'dah', true]]), INFO);
  assert.strictEqual(s.afterReleaseN, 1);
  assert.strictEqual(s.afterReleaseMaxMs, 350);
});

test('median of an even count; no release; no latency figures; a latency that moved', () => {
  const s = Diag.summarize(snap([[0, 10, NaN], [100, 20, NaN], [200, 30, NaN], [300, 44, NaN]], []), { mode: 'iambicB', wpm: 30 });
  assert.strictEqual(s.leadMedMs, 25);
  assert.strictEqual(s.afterReleaseN, 0);
  assert.strictEqual(s.lastReleaseAfterStartMs, null);
  assert.strictEqual(s.baseLatencyMs, null);
  assert.strictEqual(s.outputLatencyMaxMs, null);
  const msg = Diag.toMessage(s);
  assert.ok(!('lastReleaseAfterStartMs' in msg) && !('baseLatencyMs' in msg), 'unknowns are left out of the message');
  assert.strictEqual(Diag.formatLine(msg),
    '[CW] page keyer timing, last over: 4 elements, iambicB 30 wpm; no paddle release seen; lead min/med/max 10/25/44 ms; output latency unknown');
  const moved = Diag.summarize(snap([[0, 20, 38], [100, 20, 46]], [[0, 'dit', true], [90, 'dit', false]]), { mode: 'iambicB', wpm: 25 });
  assert.ok(/output latency 46 ms \(base unknown \+ output 38-46\)/.test(Diag.formatLine(Diag.toMessage(moved))), Diag.formatLine(Diag.toMessage(moved)));
});

test('nothing keyed: no summary', () => {
  assert.strictEqual(Diag.summarize(snap([], [[0, 'dit', true], [300, 'dit', false]]), INFO), null);
  assert.strictEqual(Diag.summarize(null, INFO), null);
});

test('the record is a ring: bounded, oldest dropped, cleared per over', () => {
  const rec = Diag.createRecorder({ elementCap: 4, edgeCap: 3 });
  for (let i = 0; i < 10; i++) rec.element(i * 100, i * 100 + 20, 20, 0.038);
  for (let i = 0; i < 5; i++) { rec.edge(0, true, i * 10); rec.edge(0, false, i * 10 + 5); }
  let s = rec.snapshot();
  assert.deepStrictEqual(s.elements.map((e) => e.chosenMs), [600, 700, 800, 900]);
  assert.strictEqual(s.total, 10);
  assert.deepStrictEqual(s.edges.map((e) => e.atMs), [35, 40, 45]);
  assert.deepStrictEqual(s.edges.map((e) => e.pressed), [false, true, false]);
  const sum = Diag.summarize(s, INFO);
  assert.strictEqual(sum.elements, 10);
  assert.strictEqual(sum.measured, 4);
  assert.ok(/10 elements \(last 4 measured\), iambicA 25 wpm/.test(Diag.formatLine(Diag.toMessage(sum))), Diag.formatLine(Diag.toMessage(sum)));
  // a withdrawal takes back the newest, across the wrap
  rec.withdrawn();
  s = rec.snapshot();
  assert.deepStrictEqual(s.elements.map((e) => e.chosenMs), [600, 700, 800]);
  assert.strictEqual(s.total, 9);
  assert.strictEqual(s.withdrawn, 1);
  rec.element(1000, 1020, 20, 0.038);
  assert.deepStrictEqual(rec.snapshot().elements.map((e) => e.chosenMs), [600, 700, 800, 1000]);
  assert.strictEqual(rec.lastAt(), 1000);
  rec.clear();
  assert.deepStrictEqual(rec.snapshot(), { elements: [], edges: [], total: 0, withdrawn: 0 });
  assert.strictEqual(rec.lastAt(), -1);
  rec.withdrawn(); // nothing to take back
  assert.strictEqual(rec.snapshot().total, 0);
});

test('a repeated contact state is not an edge (key auto-repeat, a release-all)', () => {
  const rec = Diag.createRecorder();
  rec.edge(0, false, 1); rec.edge(1, false, 2);            // releases with nothing down
  rec.edge(0, true, 10); rec.edge(0, true, 40); rec.edge(0, true, 70); // auto-repeat
  rec.edge(1, true, 80);
  rec.edge(0, false, 100); rec.edge(0, false, 101);
  assert.deepStrictEqual(rec.snapshot().edges, [
    { atMs: 10, contact: 'dit', pressed: true },
    { atMs: 80, contact: 'dah', pressed: true },
    { atMs: 100, contact: 'dit', pressed: false },
  ]);
});

test('the log line copies no text from the message: numbers and three mode names only', () => {
  const line = Diag.formatLine({
    type: 'cw-timing', elements: 'K3SBP', mode: 'CQ CQ DE K3SBP', wpm: '25<script>', text: 'CQ POTA', call: 'LZ3AW',
    afterReleaseN: 1, afterReleaseMaxMs: 'x', leadMinMs: {}, leadMedMs: [], leadMaxMs: 1e12, lastReleaseAfterStartMs: -1e12,
  });
  assert.ok(!/K3SBP|LZ3AW|CQ|POTA|script/.test(line), line);
  assert.strictEqual(line, "[CW] page keyer timing, last over: ? elements, ? ? wpm; 1 chosen after the last release (? ms); lead min/med/max ?/?/600000 ms; output latency unknown; last release 600000 ms before the last element's start");
  assert.ok(Diag.formatLine(null).startsWith('[CW] page keyer timing, last over: ? elements'));
  assert.ok(Diag.formatLine({ elements: 2, withdrawn: 3, lastReleaseAfterStartMs: 0 }).endsWith('; 3 withdrawn before sounding'));
});

test('the desktop logs one line per over, at most every 1.5 s', () => {
  require('./ws-stub-if-missing');
  const { RemoteServer } = require('../lib/remote-server');
  const rs = Object.create(RemoteServer.prototype);
  require('events').EventEmitter.call(rs);
  const logs = [];
  rs.on('log', (m) => logs.push(m));
  const ws = { _authenticated: true, readyState: 1 };
  rs._client = ws;
  const msg = rig().play([[0, 'dah', true], [220, 'dah', false]]).timing[0].msg;
  rs._handleMessage(ws, msg);
  rs._handleMessage(ws, msg);
  assert.strictEqual(logs.length, 1, JSON.stringify(logs));
  assert.strictEqual(logs[0], Diag.formatLine(msg));
  assert.ok(logs[0].startsWith('[CW] page keyer timing, last over: 2 elements, iambicB 25 wpm; '), logs[0]);
});

// ---------------------------------------------------------------------------
console.log('4. wiring');

test('ECHOCAT Web inlines lib/cw-keyer-timing-diag.js and a guest who may key may report', () => {
  const rs = readSrc(path.join(__dirname, '..', 'lib', 'remote-server.js'));
  assert.ok(/\['cw-keyer-timing-diag-js', 'cw-keyer-timing-diag\.js'\]/.test(rs), 'remote-server inlines it');
  const html = readSrc(path.join(__dirname, '..', 'renderer', 'remote.html'));
  assert.ok(html.includes('<!-- cw-keyer-timing-diag-js -->'), 'remote.html has the marker');
  assert.ok(html.indexOf('<!-- cw-keyer-timing-diag-js -->') < html.indexOf('remote.js'), 'before remote.js');
  assert.ok(require('../lib/guest-pass-authority').isGuestAllowed('cw-timing'));
  const doc = readSrc(path.join(__dirname, '..', 'docs', 'echocat-protocol.md'));
  assert.ok(/\| `cw-timing` \| C→S \| Diagnostic only/.test(doc), 'docs/echocat-protocol.md has the row');
});

test('the keyer is told nothing: the record is written after the keyer and the sidetone have acted', () => {
  // the paddle edge reaches the keyer first
  assert.ok(/paddleDit: function\(pressed\) \{ swap \? handleDah\(pressed\) : handleDit\(pressed\); if \(typeof cwTimingEdge === 'function'\) cwTimingEdge\(0, pressed\); \}/.test(pageSrc));
  assert.ok(/paddleDah: function\(pressed\) \{ swap \? handleDit\(pressed\) : handleDah\(pressed\); if \(typeof cwTimingEdge === 'function'\) cwTimingEdge\(1, pressed\); \}/.test(pageSrc));
  // the element is recorded by the measuring hook that runs once its sidetone is scheduled
  assert.ok(/var lead = schedulePaddleElement\(durMs\); cwDiagNote\('ahead', lead\);/.test(pageSrc));
  assert.ok(/if \(kind === 'ahead'\) cwTimingElement\(paddleLastAt \* 1000, ms\);/.test(pageSrc));
  assert.strictEqual((pageSrc.match(/cwTimingElement\(/g) || []).length, 2, 'one call, one definition');
  // nothing in the keyer or the sidetone reads the record back
  const uses = pageSrc.match(/cwTiming[A-Za-z]*\b[^\n]*/g) || [];
  const reads = uses.filter((u) => /cwTiming\.(snapshot|lastAt)\(/.test(u));
  const flush = pageSrc.slice(pageSrc.indexOf('function cwTimingFlush()'), pageSrc.indexOf('function cancelPaddleTones()'));
  for (const u of reads) assert.ok(flush.includes(u.trim().slice(0, 40)), 'the record is read outside the flush: ' + u);
  assert.ok(reads.length >= 2, 'the flush reads it');
});

test('no logging and no allocation per element or per edge', () => {
  const lib = readSrc(path.join(__dirname, '..', 'lib', 'cw-keyer-timing-diag.js'));
  assert.ok(!/console\./.test(lib), 'the module never logs');
  const hooks = pageSrc.slice(pageSrc.indexOf('function cwTimingEdge('), pageSrc.indexOf('function cwTimingFlush()'));
  assert.ok(hooks.length > 100 && !/console\.|\[\]|\{\s*[a-zA-Z]+:|JSON\.|new /.test(hooks), 'the page hooks only write numbers and arm one timer');
  assert.ok((hooks.match(/if \(!cwTimingTimer\) cwTimingTimer = setTimeout\(cwTimingFlush, 2000\);/g) || []).length === 2, 'one timer per over, armed only when none is running');
  const rec = lib.slice(lib.indexOf('element: function ('), lib.indexOf('lastAt: function ()'));
  assert.ok(rec.length > 200 && !/\[\]|\.push\(|new |\{\s*[a-zA-Z]+:/.test(rec), 'element(), withdrawn() and edge() write into arrays made once');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
