#!/usr/bin/env node
'use strict';
// GitHub #244 (Casey 2026-11-19): ECHOCAT Web's sidetone and the air always
// agree. The page may withdraw an element only BEFORE its sidetone starts;
// once the sidetone has started, the element is committed and is keyed on
// the air in full. LZ3AW (TS-480, 25 wpm, Chrome on a phone, 1.14.6) heard
// extra elements in the page's own sidetone that never went on the air: a
// release that reached the page after the tone had started still withdrew
// the element, which cut the tone into a blip while the shack dropped it.
//
// This runs the page's REAL keyer and sidetone code (renderer/remote.js,
// from "Local iambic CW keyer" to "Default macros") with a fake AudioContext
// whose gain is "rendered" as time passes (what is rendered is heard and
// cannot be taken back), a fake socket with network delay, and the shack's
// real playout (lib/cw-key-playout.js). It compares what the operator HEARD
// with what went on the AIR.
// Run: node test/cw-sidetone-air-agree-test.js
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

// One clock for the page, its audio and the shack. Timers may fire late
// (a busy phone): lateMs() is added to each.
function fakeClock(lateMs) {
  let now = 0, seq = 0;
  const timers = new Map();
  return {
    now: () => now,
    // exact: the shack and the network (only the page's timers run late)
    setTimeout: (fn, ms, exact) => { const id = ++seq; timers.set(id, { at: now + Math.max(0, ms || 0) + (lateMs && !exact ? lateMs() : 0), fn, seq: id }); return id; },
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

// A gain AudioParam whose output is rendered up to the audio clock before
// every change: rendered output is what the operator hears.
const QUANTUM_MS = 128 / 48000 * 1000;
function fakeAudio(clock) {
  const audioMs = () => Math.floor(clock.now() / QUANTUM_MS) * QUANTUM_MS;
  const heard = [];     // [startMs, endMs]
  let renderedTo = 0, on = null;
  const ev = [];        // { type: 'set'|'ramp', t (ms), v }
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
    baseLatency: 0, outputLatency: 0.040, // LZ3AW's phone: 40 ms of device output
    destination: {},
    createOscillator: () => ({ type: 'sine', frequency: { value: 600 }, connect() {}, start() {} }),
    createGain: () => ({ gain, connect() {} }),
  };
  return { ctx, heard, finish(t) { render(t); if (on != null) { heard.push([on, t]); on = null; } } };
}

// The page + the network + the shack.
//   netMs(msg, i): one-way delay of the i-th cw-key message (in order, as TCP)
function rig({ wpm = 25, mode = 'iambicB', netMs = () => 30, timerLateMs = null } = {}) {
  const clock = fakeClock(timerLateMs);
  const audio = fakeAudio(clock);
  const air = [];
  let keyedAt = null;
  const shack = new CwKeyPlayout({
    output: (e) => {
      if (e.down && keyedAt == null) keyedAt = clock.now();
      else if (!e.down && keyedAt != null) { air.push([keyedAt, clock.now()]); keyedAt = null; }
    },
    now: clock.now, setTimer: (fn, ms) => clock.setTimeout(fn, ms, true), clearTimer: clock.clearTimeout, bufferMs: 120,
  });
  let n = 0, lastDeliver = 0;
  const wire = [];
  const ws = {
    readyState: 1,
    send(json) {
      const msg = JSON.parse(json);
      if (msg.type !== 'cw-key') return;
      wire.push(Object.assign({ sentAt: clock.now() }, msg));
      const at = Math.max(lastDeliver, clock.now() + netMs(msg, n++));
      lastDeliver = at;
      clock.setTimeout(() => shack.push(msg), at - clock.now(), true);
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
    clock, ws, shack, wire,
    // steps: [ms after start, 'dit'|'dah', pressed, eventTimeStamp (ms after start, optional)]
    play(steps, tailMs = 1500) {
      for (const [at, contact, pressed, ts] of steps) {
        clock.advanceTo(t0 + at);
        const stamp = ts != null ? t0 + ts : undefined;
        if (contact === 'dit') keyer.paddleDit(pressed, stamp);
        else if (contact === 'dah') keyer.paddleDah(pressed, stamp);
        else if (contact === 'stop') keyer.stop();
        else if (contact === 'disconnect') { ws.readyState = 3; }
        else if (contact === 'shack-stop') { shack.stop(); }
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
  r.heard.forEach((d, i) => assert.ok(Math.abs(d - r.air[i]) <= 2, `element ${i + 1}: heard ${d.toFixed(1)} ms, keyed ${r.air[i].toFixed(1)} ms`));
}

console.log('#244: the sidetone and the air agree (page keyer + fake audio + network + shack playout)');

// 25 wpm, dit held from 0: dits chosen at 0, 96, 192, 288; the page sounds
// them 20 ms later (20, 116, 212, 308).
test('a withdrawal BEFORE the sidetone starts: nothing heard, nothing on the air ("S" = "...")', () => {
  agree(rig().play([[0, 'dit', true], [300, 'dit', false]]), '...');
});

test('a release processed AFTER the 4th dit started to sound: heard in full and keyed in full ("....")', () => {
  // processed at 312, 4 ms into the tone; the contact opened at 300
  agree(rig().play([[0, 'dit', true], [312, 'dit', false, 300]]), '....');
});

test('the same with no event timestamp: committed, both "...."', () => {
  agree(rig().play([[0, 'dit', true], [320, 'dit', false]]), '....');
});

test('"T": dah released after the 2nd dah started to sound: "--" on both', () => {
  // dah chosen at 0 (sounds 20), 2nd at 192 (sounds 212)
  agree(rig().play([[0, 'dah', true], [220, 'dah', false, 200]]), '--');
});

test('"T": dah released before the 2nd dah sounds: "-" on both', () => {
  agree(rig().play([[0, 'dah', true], [205, 'dah', false]]), '-');
});

test('a squeeze for "C" in iambic B: the last dit\'s hold opens before it sounds, the squeeze bonus keeps it: "-.-."', () => {
  agree(rig().play([[0, 'dah', true], [10, 'dit', true], [470, 'dah', false], [490, 'dit', false]]), '-.-.');
});

test('a squeeze for "C" in iambic B, the dit released just after the last dit started: "-.-." (never "-.-" + a blip)', () => {
  agree(rig().play([[0, 'dah', true], [10, 'dit', true], [470, 'dah', false], [506, 'dit', false, 495]]), '-.-.');
});

test('iambic A squeeze released inside the last element: no bonus, nothing clipped', () => {
  agree(rig({ mode: 'iambicA' }).play([[0, 'dah', true], [10, 'dit', true], [400, 'dah', false], [420, 'dit', false]]), '-.-');
});

test('dot memory: a dit tapped during a dah is latched and sent ("-." on both), never withdrawn', () => {
  agree(rig().play([[0, 'dah', true], [60, 'dit', true], [90, 'dit', false], [150, 'dah', false]]), '-.');
});

test('a withdrawn held element hands over to the other paddle still held (iambic A ".-..")', () => {
  // dit 0, latched dah 96, dit (held) 288, dah (held) chosen 384 sounds 404;
  // dah opens at 390: withdrawn, the held dit keys instead.
  agree(rig({ mode: 'iambicA' }).play([[0, 'dit', true], [30, 'dah', true], [390, 'dah', false], [470, 'dit', false]]), '.-..');
});

test('the page sends an element when its sidetone starts, never a withdrawal', () => {
  const r = rig().play([[0, 'dit', true], [300, 'dit', false], [600, 'dah', true], [610, 'dah', false]]);
  assert.ok(!r.wire.some((m) => m.cancel), 'no cancel on the wire: ' + JSON.stringify(r.wire));
  assert.strictEqual(r.wire.filter((m) => m.down).length, 4);
});

test('busy phone: every keyer timer fires 0-15 ms late, and the two still agree', () => {
  let s = 7;
  const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  for (let rel = 280; rel <= 330; rel += 3) {
    agree(rig({ timerLateMs: () => rnd() * 15 }).play([[0, 'dit', true], [rel, 'dit', false]]));
  }
});

test('network jitter up to 100 ms (inside the shack\'s buffer): still agree', () => {
  let s = 11;
  const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  agree(rig({ netMs: () => 20 + rnd() * 100 }).play([[0, 'dah', true], [10, 'dit', true], [470, 'dah', false], [506, 'dit', false]]), '-.-.');
});

test('random fists: over 300 random paddle sequences, every element heard is keyed, and nothing else', () => {
  let s = 2026;
  const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  for (let trial = 0; trial < 300; trial++) {
    const steps = [];
    let t = 0;
    const down = { dit: false, dah: false };
    for (let i = 0; i < 8; i++) {
      t += 5 + Math.floor(rnd() * 140);
      const c = rnd() < 0.5 ? 'dit' : 'dah';
      down[c] = !down[c];
      steps.push([t, c, down[c], down[c] ? undefined : t - Math.floor(rnd() * 40)]);
    }
    t += 5 + Math.floor(rnd() * 60);
    if (down.dit) steps.push([t, 'dit', false]);
    if (down.dah) steps.push([t + 1, 'dah', false]);
    const mode = rnd() < 0.5 ? 'iambicA' : 'iambicB';
    const r = rig({ mode, timerLateMs: () => rnd() * 10, netMs: () => 20 + rnd() * 60 }).play(steps);
    try { agree(r); } catch (e) { throw new Error(`trial ${trial} (${mode}) ${JSON.stringify(steps)}: ${e.message}`); }
  }
});

console.log('safety stops cut both together');

test('STOP mid-dah: the tone stops and the shack cuts its dah at the same point', () => {
  // dah sounds 20..164; STOP at 100 (80 ms in)
  const r = rig().play([[0, 'dah', true], [100, 'stop']]);
  assert.strictEqual(r.heard.length, 1); assert.strictEqual(r.air.length, 1);
  assert.ok(Math.abs(r.heard[0] - 80) <= 3, 'heard ' + r.heard[0]);
  assert.ok(Math.abs(r.air[0] - r.heard[0]) <= 3, `heard ${r.heard[0]} ms, keyed ${r.air[0]} ms`);
});

test('STOP before a chosen element sounds: neither side has it', () => {
  // dit held: the 2nd dit is chosen at 96 and sounds at 116; STOP at 100
  const r = rig().play([[0, 'dit', true], [100, 'stop']]);
  assert.strictEqual(word(r.heard), '.'); assert.strictEqual(word(r.air), '.');
});

test('STOP whose cancel reaches the shack after its cut point: the shack keys up on arrival, it never completes the element', () => {
  // the dah sounds at the page 20..164 and on the air about 165..309; STOP
  // at 100 (cut point 245 on the air); the cancel takes 180 ms and arrives
  // at 280, 35 ms after it
  const r = rig({ netMs: (m) => (m.cancel ? 180 : 30) }).play([[0, 'dah', true], [100, 'stop']]);
  assert.strictEqual(r.air.length, 1);
  assert.ok(r.air[0] < DAH - 2, 'the dah was cut, keyed ' + r.air[0] + ' ms');
});

test('the socket closes while a paddle is held: the next element is neither heard nor sent, the keyer stops', () => {
  // dits sound at 20 and 116; the socket is gone at 150; the 3rd dit (chosen
  // 192) cannot be sent at its commit, so its tone never starts.
  const r = rig().play([[0, 'dit', true], [150, 'disconnect'], [700, 'dit', false]]);
  agree(r, '..');
});

test('the shack drops the client (disconnect) mid-element: it keys up at once, and the page stopping cuts its tone', () => {
  const r = rig().play([[0, 'dah', true], [100, 'disconnect'], [100, 'stop'], [100, 'shack-stop']]);
  assert.ok(r.heard.length === 1 && r.heard[0] < DAH - 2, 'tone cut: ' + r.heard);
  assert.ok(r.air.every((d) => d < DAH - 2), 'air never completes an element after the stop: ' + r.air);
});

console.log('shack playout: the same rule for a late cancel');

function playout() {
  const clock = fakeClock();
  const out = [];
  const p = new CwKeyPlayout({ output: (e) => out.push([e.down, clock.now()]), now: clock.now, setTimer: clock.setTimeout, clearTimer: clock.clearTimeout, bufferMs: 120 });
  return { clock, out, p };
}

test('a late withdrawal (at before the element) of an element already on the air: played whole', () => {
  const { clock, out, p } = playout();
  p.push({ at: 0, down: true, ms: 48 });          // 120..168
  clock.advanceTo(96); p.push({ at: 96, down: true, ms: 48 }); // 216..264
  clock.advanceTo(230); p.push({ at: 95, down: false, cancel: true });
  clock.advanceTo(1000);
  assert.deepStrictEqual(out, [[true, 120], [false, 168], [true, 216], [false, 264]]);
});

test('a late stop that cut the element part-way at the client: keyed up on arrival, not completed', () => {
  const { clock, out, p } = playout();
  p.push({ at: 0, down: true, ms: 144 });         // 120..264
  clock.advanceTo(230); p.push({ at: 80, down: false, cancel: true }); // its cut point was 200
  clock.advanceTo(1000);
  assert.deepStrictEqual(out, [[true, 120], [false, 230]]);
});

test('a late stop of a straight-key down keys up on arrival (it used to wait for the 3 s limit)', () => {
  const { clock, out, p } = playout();
  p.push({ at: 0, down: true });                  // 120
  clock.advanceTo(400); p.push({ at: 100, down: false, cancel: true });
  clock.advanceTo(5000);
  assert.deepStrictEqual(out, [[true, 120], [false, 400]]);
});

test('a stop in time cuts the element at its own point (where the client\'s tone stopped)', () => {
  const { clock, out, p } = playout();
  p.push({ at: 0, down: true, ms: 144 });         // 120..264
  clock.advanceTo(100); p.push({ at: 80, down: false, cancel: true });
  clock.advanceTo(1000);
  assert.deepStrictEqual(out, [[true, 120], [false, 200]]);
});

console.log('lib/cw-sidetone-commit.js');

test('canWithdraw: only before the tone starts (with the render guard), never once sent', () => {
  const el = { soundAt: 100 };
  assert.strictEqual(Commit.canWithdraw(el, 90), true);
  assert.strictEqual(Commit.canWithdraw(el, 95), false, 'inside the guard');
  assert.strictEqual(Commit.canWithdraw(el, 101), false, 'sounding');
  assert.strictEqual(Commit.canWithdraw({ soundAt: 100, committed: true }, 10), false, 'sent');
  assert.strictEqual(Commit.canWithdraw(null, 0), false);
});

test('cutAt: the same point in the element where the tone stopped', () => {
  const el = { at: 5000, ms: 144, soundAt: 200 };
  assert.strictEqual(Commit.cutAt(el, 280), 5080);
  assert.strictEqual(Commit.cutAt(el, 150), 4999, 'not yet sounding: dropped whole');
  assert.strictEqual(Commit.cutAt(el, 400), null, 'already over');
  assert.strictEqual(Commit.cutAt(null, 1), null);
});

test('gate: sends at the commit, withdraws only before it, and reports a lost send', () => {
  const clock = fakeClock();
  const sent = [], lost = [];
  let open = true;
  const g = Commit.createGate({ now: clock.now, setTimer: clock.setTimeout, clearTimer: clock.clearTimeout,
    send: (m) => { if (!open) return false; sent.push([clock.now(), m]); return true; }, onLost: (el) => lost.push(el) });
  g.element(0, 48, 20);
  assert.strictEqual(sent.length, 0, 'nothing sent at the choice');
  clock.advanceTo(10);
  assert.strictEqual(g.withdraw(), true);
  clock.advanceTo(100);
  assert.strictEqual(sent.length, 0, 'a withdrawn element is never sent');
  g.element(100, 48, 220);
  clock.advanceTo(216);
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0][0], 215, 'sent at the commit (start - guard)');
  assert.strictEqual(g.withdraw(), false, 'sent: kept');
  open = false;
  g.element(196, 48, 316);
  clock.advanceTo(400);
  assert.strictEqual(lost.length, 1, 'a send that failed at the commit is reported');
});

test('gate: a late commit timer cannot outvote the clock: a tone that started is kept', () => {
  const clock = fakeClock(() => 30); // timers 30 ms late
  const sent = [];
  const g = Commit.createGate({ now: clock.now, setTimer: clock.setTimeout, clearTimer: clock.clearTimeout, send: (m) => { sent.push(m); return true; } });
  g.element(0, 48, 20);
  clock.advanceTo(25); // the tone started at 20; the timer has not fired
  assert.strictEqual(g.withdraw(), false);
  assert.strictEqual(sent.length, 1, 'committed and sent on the spot');
});

console.log('page wiring');

test('ECHOCAT Web inlines lib/cw-sidetone-commit.js', () => {
  const rs = readSrc(path.join(__dirname, '..', 'lib', 'remote-server.js'));
  assert.ok(/\['cw-sidetone-commit-js', 'cw-sidetone-commit\.js'\]/.test(rs), 'remote-server inlines it');
  const html = readSrc(path.join(__dirname, '..', 'renderer', 'remote.html'));
  assert.ok(html.includes('<!-- cw-sidetone-commit-js -->'), 'remote.html has the marker');
  assert.ok(/window\.CwSidetoneCommit\.createGate\(/.test(src), 'remote.js uses the gate');
});

test('the page stops its keyer when the socket closes', () => {
  const start = src.indexOf('function onWsClosed(');
  const fn = src.slice(start, src.indexOf('\n  }\n', start));
  assert.ok(/__echocatReleasePaddles\(false\)/.test(fn), 'onWsClosed releases the paddles');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
