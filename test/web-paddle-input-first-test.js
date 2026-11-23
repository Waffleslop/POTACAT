#!/usr/bin/env node
'use strict';
// GitHub #244 Part A: in ECHOCAT Web a paddle edge reaches the keyer first,
// and drawing pauses while a paddle over runs.
//
// LZ3AW (TS-480, 25 wpm, TinyMIDI, Chrome, 1.14.6) still heard extra
// elements in the page's own sidetone. His cw-diag line: "paddle input up to
// 59 ms late". The page's main thread was busy when the edge arrived, and
// the keyer withdraws a held element only before its sidetone starts (20 ms
// after it is chosen), so a release that late lands after the next element
// is committed. Part A changes no keying rule: the paddle keys and MIDI notes
// hand the edge to the keyer before anything else, and scope, waterfall and
// meter drawing pauses during the over so fewer edges wait behind a frame.
//
// This runs the page's REAL code (renderer/remote.js) on a fake clock.
// Run: node test/web-paddle-input-first-test.js
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
function extract(name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name + ' missing from renderer/remote.js');
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) break;
  }
  return src.slice(start, i + 1);
}
function tryExtract(name) { try { return extract(name); } catch (e) { return null; } }

// A fake clock: setTimeout/clearTimeout/performance.now all read it.
function fakeClock(lateMs) {
  let now = 0, seq = 0;
  const timers = new Map();
  const c = {
    now: () => now,
    setTimeout: (fn, ms, exact) => { const id = ++seq; timers.set(id, { at: now + Math.max(0, ms || 0) + (lateMs && exact !== true ? lateMs() : 0), fn, seq: id }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    pending: () => timers.size,
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
  return c;
}

// The DOM is off limits to the paddle handler: any touch throws.
const noDom = new Proxy({}, { get(_, k) { throw new Error('the paddle handler touched the DOM (' + String(k) + ')'); } });

console.log('#244 Part A: the paddle edge goes to the keyer first');

// The capture-phase key handler, run for real with every collaborator
// recording the order it was called in.
function keyRig({ cwAvailable = true, cwPaddleAvailable = true, focused = false } = {}) {
  const fn = tryExtract('paddleKeyFirst');
  assert.ok(fn, 'there is a paddleKeyFirst handler');
  const order = [];
  // eslint-disable-next-line no-new-func
  const make = new Function('order', 'document', 'console', 'setTimeout', `
    var cwAvailable = ${cwAvailable}, cwPaddleAvailable = ${cwPaddleAvailable};
    var ditDown = false, dahDown = false;
    function matchPaddleKey(e) { return e.key === '[' ? 'dit' : e.key === ']' ? 'dah' : null; }
    function isInputFocused() { return ${focused}; }
    function sendPaddle(contact, state) { order.push('keyer:' + contact + ':' + state); }
    function noteCwInputLag() { order.push('lag'); }
    function logPaddleDrop() { order.push('log'); }
    ${fn}
    return paddleKeyFirst;
  `);
  const deferred = [];
  const h = make(order, noDom, noDom, (f, ms, arg) => { order.push('defer'); deferred.push(() => f(arg)); });
  const ev = (type, key, extra) => Object.assign({ type, key, repeat: false, timeStamp: 1, preventDefault() { order.push('preventDefault'); } }, extra || {});
  return { h, order, ev, deferred };
}

test('the paddle keys are handled in the capture phase on window, keydown and keyup', () => {
  const block = src.slice(src.indexOf('function paddleKeyFirst('), src.indexOf("window.addEventListener('keyup', paddleKeyFirst") + 80);
  const adds = [];
  const win = { addEventListener: (type, fn, opts) => adds.push({ type, fn, opts }) };
  // eslint-disable-next-line no-new-func
  new Function('window', 'matchPaddleKey', 'isInputFocused', 'sendPaddle', 'noteCwInputLag', 'logPaddleDrop', block)(win, () => null, () => false, () => {}, () => {}, () => {});
  const kd = adds.find((a) => a.type === 'keydown'), ku = adds.find((a) => a.type === 'keyup');
  assert.ok(kd && ku, 'keydown and keyup listeners on window: ' + JSON.stringify(adds.map((a) => a.type)));
  assert.strictEqual(kd.opts && kd.opts.capture, true, 'keydown capture: true');
  assert.strictEqual(ku.opts && ku.opts.capture, true, 'keyup capture: true');
  assert.strictEqual(kd.fn, ku.fn, 'one handler for both edges');
});

test('the old bubble-phase paddle listeners on document are gone (one path per edge)', () => {
  assert.ok(!/document\.addEventListener\('keydown', function\(e\) \{\s*if \(e\.repeat\) return;\s*if \(isInputFocused\(\)\) return;\s*var contact = matchPaddleKey\(e\);/.test(src), 'old keydown listener');
  assert.ok(!/document\.addEventListener\('keyup', function\(e\) \{\s*if \(!cwAvailable\) return;\s*if \(isInputFocused\(\)\) return;\s*var contact = matchPaddleKey\(e\);/.test(src), 'old keyup listener');
});

test('press and release: the keyer has the edge before preventDefault, the lag note or anything else', () => {
  const r = keyRig();
  r.h(r.ev('keydown', '['));
  assert.deepStrictEqual(r.order, ['keyer:dit:1', 'preventDefault', 'lag']);
  r.order.length = 0;
  r.h(r.ev('keyup', '['));
  assert.deepStrictEqual(r.order, ['keyer:dit:0', 'preventDefault', 'lag']);
});

test('the handler does no DOM work and no logging (a dropped key\'s log line is deferred)', () => {
  const r = keyRig({ cwPaddleAvailable: false });
  r.h(r.ev('keydown', ']')); // would throw on any DOM or console access
  assert.deepStrictEqual(r.order, ['defer'], 'nothing keyed, the log waits');
  r.deferred.forEach((f) => f());
  assert.deepStrictEqual(r.order, ['defer', 'log']);
  const r2 = keyRig({ cwAvailable: false });
  r2.h(r2.ev('keydown', '['));
  assert.deepStrictEqual(r2.order, ['defer']);
});

test('the same rules as before: auto-repeat, a held key, typing in a box and other keys do nothing', () => {
  const r = keyRig();
  r.h(r.ev('keydown', '['));
  r.h(r.ev('keydown', '[', { repeat: true }));
  r.h(r.ev('keydown', '['));                // a second down without an up
  r.h(r.ev('keydown', 'a'));
  assert.deepStrictEqual(r.order.filter((o) => o.startsWith('keyer')), ['keyer:dit:1']);
  const f = keyRig({ focused: true });
  f.h(f.ev('keydown', '[')); f.h(f.ev('keyup', '['));
  assert.deepStrictEqual(f.order, [], 'typing [ in a text box keys nothing');
  const u = keyRig({ cwPaddleAvailable: false });
  u.h(u.ev('keyup', '['));
  assert.deepStrictEqual(u.order.slice(0, 1), ['keyer:dit:0'], 'a release is never gated');
});

// sendPaddle, run for real: the keyer before the audio-context check, the
// drawing pause, the socket, the hold keepalive and the fallback timer.
function sendRig({ stream = true } = {}) {
  const order = [];
  // eslint-disable-next-line no-new-func
  const make = new Function('order', 'setTimeout', 'clearTimeout', 'performance', `
    var cwPaddleAvailable = true, cwKeyStreamOk = ${stream}, _paddleRttSentAt = 0;
    var _paddleReleaseTimer = { dit: null, dah: null };
    var ditDown = false, dahDown = false;
    var WebSocket = { OPEN: 1 };
    var ws = { readyState: 1, send: function(m) { order.push('ws'); } };
    var localCwKeyer = { paddleDit: function(s) { order.push('keyer:dit:' + s); }, paddleDah: function(s) { order.push('keyer:dah:' + s); } };
    function ensureCwAudioCtx() { order.push('audioCtx'); }
    var cwDrawPause = { activity: function() { order.push('drawPause'); } };
    function _stopPaddleHold() { order.push('holdStop'); }
    function _startPaddleHold() { order.push('holdStart'); }
    ${extract('sendPaddle')}
    return sendPaddle;
  `);
  const sp = make(order, () => { order.push('timer'); return 1; }, () => {}, { now: () => 0 });
  return { sp, order };
}

test('sendPaddle hands the edge to the keyer before anything else', () => {
  for (const stream of [true, false]) {
    const r = sendRig({ stream });
    r.sp('dit', 1);
    assert.strictEqual(r.order[0], 'keyer:dit:true', `stream ${stream}: ${r.order.join(',')}`);
    r.order.length = 0;
    r.sp('dah', 0);
    assert.strictEqual(r.order[0], 'keyer:dah:false', `stream ${stream}: ${r.order.join(',')}`);
  }
});

test('sendPaddle marks the over for the drawing pause (after the keyer)', () => {
  const r = sendRig();
  r.sp('dit', 1);
  assert.ok(r.order.indexOf('drawPause') > 0, r.order.join(','));
});

console.log('MIDI paddle edges go straight to the keyer');

function midiRig({ learning = null } = {}) {
  const order = [];
  // eslint-disable-next-line no-new-func
  const make = new Function('order', 'localStorage', `
    var ditDown = false, dahDown = false, ecMidiLearning = ${JSON.stringify(learning)};
    var ecMidiDitNote = 60, ecMidiDahNote = 62;
    function noteCwInputLag() { order.push('lag'); }
    function ecStopMidiLearn() { order.push('learnStop'); ecMidiLearning = null; }
    function updateMidiNoteDisplays() { order.push('display'); }
    function sendPaddle(contact, state) { order.push('keyer:' + contact + ':' + state); }
    ${extract('ecHandleMidiMessage')}
    return { midi: ecHandleMidiMessage, notes: function() { return [ecMidiDitNote, ecMidiDahNote]; } };
  `);
  const ls = { setItem: (k, v) => order.push('store:' + k + '=' + v) };
  const m = make(order, ls);
  const msg = (status, note, vel) => ({ data: [status, note, vel], timeStamp: 1 });
  return Object.assign(m, { order, msg });
}

test('a dit note-on and note-off: the keyer first, the lag note after', () => {
  const r = midiRig();
  r.midi(r.msg(0x90, 60, 100));
  assert.deepStrictEqual(r.order, ['keyer:dit:1', 'lag']);
  r.order.length = 0;
  r.midi(r.msg(0x80, 60, 0));
  assert.deepStrictEqual(r.order, ['keyer:dit:0', 'lag']);
  r.order.length = 0;
  r.midi(r.msg(0x90, 62, 90)); r.midi(r.msg(0x90, 62, 0)); // dah, note-on velocity 0 = off
  assert.deepStrictEqual(r.order, ['keyer:dah:1', 'lag', 'keyer:dah:0', 'lag']);
});

test('MIDI learn still captures a note-on and keys nothing; a note-off while learning still releases', () => {
  const r = midiRig({ learning: 'dit' });
  r.midi(r.msg(0x80, 60, 0));
  assert.deepStrictEqual(r.order, ['keyer:dit:0', 'lag'], 'a release is never lost');
  r.order.length = 0;
  r.midi(r.msg(0x90, 64, 100));
  assert.ok(!r.order.some((o) => o.startsWith('keyer')), 'a learned note keys nothing: ' + r.order.join(','));
  assert.deepStrictEqual(r.notes(), [64, 62], 'the dit note is learned');
});

test('other MIDI notes key nothing', () => {
  const r = midiRig();
  r.midi(r.msg(0x90, 70, 100)); r.midi(r.msg(0xB0, 60, 100));
  assert.ok(!r.order.some((o) => o.startsWith('keyer')), r.order.join(','));
});

console.log('drawing pauses during a paddle over');

function pauseRig(opts = {}) {
  const fn = tryExtract('createCwDrawPause');
  assert.ok(fn, 'there is a createCwDrawPause');
  const clock = fakeClock();
  let held = false, resumed = 0, timersSet = 0;
  // eslint-disable-next-line no-new-func
  const create = new Function(fn + '; return createCwDrawPause;')();
  const p = create(Object.assign({
    now: clock.now, held: () => held,
    setTimer: (f, ms) => { timersSet++; return clock.setTimeout(f, ms, true); }, clearTimer: clock.clearTimeout,
    onResume: () => { resumed++; },
  }, opts));
  return { p, clock, setHeld: (h) => { held = h; }, resumed: () => resumed, timersSet: () => timersSet };
}

test('an over pauses drawing; it resumes quietMs after the last edge with both contacts open', () => {
  const r = pauseRig({ quietMs: 1200 });
  assert.strictEqual(r.p.paused, false, 'drawing until the first edge');
  r.setHeld(true); r.p.activity();
  assert.strictEqual(r.p.paused, true);
  r.clock.advanceTo(3000);
  assert.strictEqual(r.p.paused, true, 'a held contact keeps the over running');
  r.setHeld(false); r.p.activity(); // release at 3000
  r.clock.advanceTo(4100);
  assert.strictEqual(r.p.paused, true, 'a word space is not the end of the over');
  r.clock.advanceTo(4201);
  assert.strictEqual(r.p.paused, false, 'resumed after the quiet');
  assert.strictEqual(r.resumed(), 1, 'redrawn once');
});

test('every edge extends the over; one timer re-arms itself (no timer per edge)', () => {
  const r = pauseRig({ quietMs: 1200 });
  for (let t = 0; t <= 5000; t += 50) { r.clock.advanceTo(t); r.setHeld(t % 100 === 0); r.p.activity(); }
  r.setHeld(false);
  r.clock.advanceTo(6100);
  assert.strictEqual(r.p.paused, true);
  r.clock.advanceTo(6300);
  assert.strictEqual(r.p.paused, false);
  assert.ok(r.timersSet() < 12, '101 edges set ' + r.timersSet() + ' timers');
  assert.strictEqual(r.resumed(), 1);
});

test('a stop ends the pause at once; a stuck contact cannot hold it past maxHeldMs', () => {
  const r = pauseRig({ quietMs: 1200 });
  r.p.activity(); r.p.end();
  assert.strictEqual(r.p.paused, false);
  assert.strictEqual(r.resumed(), 1);
  assert.strictEqual(r.clock.pending(), 0, 'its timer is gone');
  r.p.end();
  assert.strictEqual(r.resumed(), 1, 'end with no over redraws nothing');
  const s = pauseRig({ quietMs: 1200, maxHeldMs: 10000 });
  s.setHeld(true); s.p.activity();
  s.clock.advanceTo(9000);
  assert.strictEqual(s.p.paused, true);
  s.clock.advanceTo(10001);
  assert.strictEqual(s.p.paused, false, 'a lost key-up does not freeze the scope');
});

// The drawing paths, run for real with a paused over: no canvas is touched,
// the data is still kept.
test('the scope keeps its data during an over but paints no row and no trace', () => {
  let painted = 0, drawn = 0, smoothed = 0;
  // eslint-disable-next-line no-new-func
  const make = new Function('window', `
    var scopeLatest = null, scopeSmooth = null, scopePeak = null, scopeAvg = 'light', scopePeakDecay = 'slow';
    var scopeRange = { lo: 0, hi: 255 }, scopeReadoutAt = null, activeTab = 'scope';
    var paused = true;
    function cwDrawPaused() { return paused; }
    var scopeSurfaces = [{ visible: function() { return true; }, wf: {}, trace: {} }];
    function scopePaintRow() { window.painted(); }
    function scopeShowReadout() { window.painted(); }
    function scopeAxisNow() { return {}; }
    function scopeDialHz() { return 0; }
    function scopeDrawTrace() { window.drawn(); }
    ${extract('scopeRenderFrame')}
    ${extract('scopeDrawAll')}
    return { frame: scopeRenderFrame, all: scopeDrawAll, latest: function() { return scopeLatest; }, resume: function() { paused = false; } };
  `);
  const V = { AVERAGING: { light: 1 }, PEAK_DECAY: { slow: 1 }, smoothInto() { smoothed++; }, peakInto() {}, applyRange: (b) => b };
  const s = make({ ScopeView: V, ScopeAxis: {}, painted: () => painted++, drawn: () => drawn++ });
  s.frame([1, 2, 3]); s.frame([4, 5, 6]); s.all();
  assert.strictEqual(painted, 0, 'no waterfall row while paused');
  assert.strictEqual(drawn, 0, 'no trace while paused');
  assert.strictEqual(smoothed, 2, 'the data still arrives');
  assert.deepStrictEqual(s.latest(), [4, 5, 6]);
  s.resume(); s.all();
  assert.strictEqual(drawn, 1, 'the over\'s end draws the latest picture once');
});

test('the FT8 and SSTV waterfalls skip their rows during an over', () => {
  for (const [name, vars] of [['ft8RenderWaterfall', 'var ft8WfVisible = true, ft8Waterfall = window.canvas, ft8TxFreqHz = 1500, wfPalLut = null;'],
    ['sstvPhoneDrawWfLine', 'var sstvPhoneWfVisible = true, sstvPhoneWfCanvas = window.canvas, sstvPhoneWfCtx = window.canvas.getContext();']]) {
    let touched = 0;
    const ctx = new Proxy({}, { get() { touched++; return () => ({ data: [] }); } });
    const canvas = { width: 10, height: 10, getContext: () => ctx };
    // eslint-disable-next-line no-new-func
    const fn = new Function('window', vars + ' function cwDrawPaused() { return true; } ' + extract(name) + '; return ' + name + ';')({ canvas });
    touched = 0;
    fn([1, 2, 3]);
    assert.strictEqual(touched, 0, name + ' drew during an over');
  }
});

test('the meter loop stops requesting frames during an over and the over\'s end restarts it', () => {
  const sm = extract('startMeterRendering');
  assert.ok(/if \(cwDrawPaused\(\)\) \{ meterAnimFrame = null; meterPausedByCw = true; return; \}/.test(sm), 'renderMeters skips the frame and stops');
  const resume = extract('cwDrawResume');
  assert.ok(/scopeDrawAll\(\)/.test(resume) && /if \(meterPausedByCw\) \{ meterPausedByCw = false; startMeterRendering\(\); \}/.test(resume));
  // run it: a paused over draws nothing, its end restarts the loop
  const frames = [];
  let paused = true, draws = 0;
  // eslint-disable-next-line no-new-func
  const make = new Function('requestAnimationFrame', 'cancelAnimationFrame', 'drawMeter', 'isPaused', `
    var meterAnimFrame = null, meterPausedByCw = false, rxMeterCanvas = {}, txMeterCanvas = {}, rxAnalyser = {}, txAnalyser = {};
    function cwDrawPaused() { return isPaused(); }
    function scopeDrawAll() {}
    ${sm}
    ${resume}
    return { start: startMeterRendering, resume: cwDrawResume, frame: function() { return meterAnimFrame; } };
  `);
  const m = make((f) => { frames.push(f); return frames.length; }, () => {}, () => draws++, () => paused);
  m.start();
  frames.shift()();           // first frame: paused
  assert.strictEqual(draws, 0);
  assert.strictEqual(frames.length, 0, 'no further frame requested');
  assert.strictEqual(m.frame(), null);
  paused = false; m.resume();
  frames.shift()();
  assert.strictEqual(draws, 2, 'RX and TX meters drawn again');
  assert.strictEqual(frames.length, 1, 'the loop runs again');
});

console.log('a late release, end to end (fake clock): no worse than today');

// The page's real keyer and sidetone region, sendPaddle and the capture
// handler, with a fake audio clock whose output is "rendered" as time passes
// (what is rendered is heard), a socket with delay, and the shack's real
// playout. Key events are dispatched at fake times; `lag` is how long the
// busy page held each one before the handler ran.
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
  };
  const ctx = {
    get currentTime() { return audioMs() / 1000; },
    baseLatency: 0, outputLatency: 0.040, destination: {}, state: 'running',
    createOscillator: () => ({ type: 'sine', frequency: { value: 600 }, connect() {}, start() {} }),
    createGain: () => ({ gain, connect() {} }),
  };
  return { ctx, heard, finish(t) { render(t); if (on != null) { heard.push([on, t]); on = null; } } };
}

const pageSrc = src.slice(src.indexOf('  // --- Local iambic CW keyer ---'), src.indexOf('  // Default macros'));
function e2e({ wpm = 25, netMs = 30 } = {}) {
  const clock = fakeClock();
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
  let lastDeliver = 0;
  const ws = {
    readyState: 1,
    send(json) {
      const msg = JSON.parse(json);
      if (msg.type !== 'cw-key') return;
      const at = Math.max(lastDeliver, clock.now() + netMs);
      lastDeliver = at;
      clock.setTimeout(() => shack.push(msg), at - clock.now(), true);
    },
  };
  const perf = { now: () => clock.now() };
  const keyerAt = []; // [fake time the keyer got the edge, contact, state]
  // eslint-disable-next-line no-new-func
  const make = new Function('setTimeout', 'clearTimeout', 'performance', 'Date', 'window', 'ws', 'WebSocket', 'audioCtx', 'keyerAt', `
    var cwAudioCtx = audioCtx;
    var cwWpm = ${wpm}, cwSidetoneFreq = 600, cwSidetoneVol = 0.8, cwKeyStreamOk = true;
    var cwAvailable = true, cwPaddleAvailable = true, _paddleRttSentAt = 0;
    var _paddleReleaseTimer = { dit: null, dah: null };
    var ditDown = false, dahDown = false;
    function ensureCwAudioCtx() { return cwAudioCtx; }
    function handleCwSidetone() {}
    function _stopPaddleHold() {}
    function _startPaddleHold() {}
    function matchPaddleKey(e) { return e.key === '[' ? 'dit' : e.key === ']' ? 'dah' : null; }
    function isInputFocused() { return false; }
    function logPaddleDrop() {}
    ${pageSrc}
    var realKeyer = localCwKeyer;
    localCwKeyer = {
      paddleDit: function(s) { keyerAt.push([performance.now(), 'dit', s]); realKeyer.paddleDit(s); },
      paddleDah: function(s) { keyerAt.push([performance.now(), 'dah', s]); realKeyer.paddleDah(s); },
      stop: function() { realKeyer.stop(); },
    };
    ${extract('createCwDrawPause')}
    var cwDrawPause = createCwDrawPause({ now: performance.now, held: function() { return ditDown || dahDown; },
      setTimer: setTimeout, clearTimer: clearTimeout, onResume: function() {} });
    ${extract('sendPaddle')}
    ${extract('paddleKeyFirst')}
    return { key: paddleKeyFirst, setWpm: function(v) { realKeyer.setWpm(v); }, drawPause: cwDrawPause };
  `);
  const page = make(clock.setTimeout, clock.clearTimeout, perf, perf, { CwSidetoneCommit: Commit }, ws, { OPEN: 1 }, audio.ctx, keyerAt);
  page.setWpm(wpm);
  const t0 = 100;
  clock.advanceTo(t0);
  return {
    keyerAt, page,
    // steps: [ms the contact moved, '[' | ']', 'down'|'up', ms the busy page held the event]
    play(steps, tail = 1500) {
      // Input events are dispatched in the order they happened; a busy page
      // only holds them back (each no earlier than the one before).
      let prev = 0;
      const queue = steps.slice().sort((a, b) => a[0] - b[0]).map(([at, key, dir, lag]) => {
        prev = Math.max(prev, t0 + at + (lag || 0));
        return { runAt: prev, stamp: t0 + at, key, dir };
      });
      for (const q of queue) {
        clock.advanceTo(q.runAt);
        page.key({ type: q.dir === 'down' ? 'keydown' : 'keyup', key: q.key, repeat: false, timeStamp: q.stamp, preventDefault() {} });
      }
      clock.advanceTo(clock.now() + tail);
      audio.finish(clock.now());
      return { heard: audio.heard.map(([a, b]) => b - a), air: air.map(([a, b]) => b - a) };
    },
  };
}
const DIT = 48, DAH = 144;
function word(lens) { return lens.map((d) => (Math.abs(d - DIT) <= 2 ? '.' : Math.abs(d - DAH) <= 2 ? '-' : `(${Math.round(d)})`)).join(''); }

test('a release in time: "..." heard and sent', () => {
  // dits chosen at 0, 96, 192, 288 and sounding 20 ms later; the release at
  // 300 reaches the keyer before the 4th dit sounds (308)
  const r = e2e().play([[0, '[', 'down'], [300, '[', 'up']]);
  assert.strictEqual(word(r.heard), '...'); assert.strictEqual(word(r.air), '...');
});

test('the same release held 30 ms by a busy page, after the 4th dit was committed: heard and sent alike ("....", as today)', () => {
  const r = e2e().play([[0, '[', 'down'], [300, '[', 'up', 30]]);
  assert.strictEqual(word(r.heard), word(r.air), 'the sidetone and the air agree');
  assert.strictEqual(word(r.heard), '....', 'the committed element is keyed in full, never a blip');
});

test('the handler adds no delay: the keyer gets every edge at the moment the event is dispatched', () => {
  const r = e2e();
  r.play([[0, '[', 'down', 7], [120, ']', 'down', 3], [170, '[', 'up', 12], [400, ']', 'up', 0]]);
  assert.deepStrictEqual(r.keyerAt.map(([t, c, s]) => [Math.round(t), c, s]),
    [[107, 'dit', true], [223, 'dah', true], [282, 'dit', false], [500, 'dah', false]]);
});

test('drawing is paused for the over and resumes after it; no element moves for it', () => {
  const r = e2e();
  const res = r.play([[0, ']', 'down'], [10, '[', 'down'], [470, ']', 'up'], [490, '[', 'up']], 0);
  assert.strictEqual(r.page.drawPause.paused, true, 'paused during the over');
  const r2 = e2e();
  const res2 = r2.play([[0, ']', 'down'], [10, '[', 'down'], [470, ']', 'up'], [490, '[', 'up']], 2000);
  assert.strictEqual(r2.page.drawPause.paused, false, 'resumed after it');
  assert.strictEqual(word(res2.heard), '-.-.'); assert.strictEqual(word(res2.air), '-.-.');
  void res;
});

test('random fists with random input lag up to 60 ms: every element heard is keyed, and nothing else', () => {
  let s = 244;
  const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  for (let trial = 0; trial < 150; trial++) {
    const steps = [];
    let t = 0;
    const down = { '[': false, ']': false };
    for (let i = 0; i < 8; i++) {
      t += 5 + Math.floor(rnd() * 140);
      const k = rnd() < 0.5 ? '[' : ']';
      down[k] = !down[k];
      steps.push([t, k, down[k] ? 'down' : 'up', Math.floor(rnd() * 60)]);
    }
    t += 80;
    if (down['[']) steps.push([t, '[', 'up', 0]);
    if (down[']']) steps.push([t + 1, ']', 'up', 0]);
    const r = e2e().play(steps);
    assert.strictEqual(word(r.heard), word(r.air), `trial ${trial} ${JSON.stringify(steps)}`);
  }
});

console.log('wiring');

test('this test is in the runner list', () => {
  const list = readSrc(path.join(__dirname, '..', 'scripts', 'run-tests.js'));
  assert.ok(list.includes("'test/web-paddle-input-first-test.js'"));
});

test('the cw-diag input-lag line is still measured for keys and MIDI, after the keyer', () => {
  assert.ok(/noteCwInputLag\(e\);/.test(src) && /noteCwInputLag\(msg\);/.test(src));
  const fn = extract('paddleKeyFirst');
  assert.ok(fn.indexOf('sendPaddle(') < fn.indexOf('noteCwInputLag(e)'), 'lag noted after the keyer');
});

test('a stop (STOP, mode change, socket closed) ends the drawing pause', () => {
  assert.ok(/cwDrawPause\.end\(\);/.test(extract('releaseAllPaddles')));
});

test('the page draws nothing during an over: scope, FT8 and SSTV waterfalls, meters all ask cwDrawPaused()', () => {
  for (const name of ['scopeRenderFrame', 'scopeDrawAll', 'ft8RenderWaterfall', 'sstvPhoneDrawWfLine', 'startMeterRendering']) {
    assert.ok(/cwDrawPaused\(\)/.test(extract(name)), name);
  }
  assert.ok(/meterPausedByCw = false;/.test(extract('stopMeterRendering')), 'stopping the meters forgets the pause');
});

test('nothing on the wire or at the shack changed: the keyer region still sends through the commit gate', () => {
  assert.ok(/window\.CwSidetoneCommit\.createGate\(/.test(src));
  assert.ok(!/cwDrawPause|cwDrawPaused/.test(pageSrc), 'the keyer and sidetone region does not know about drawing');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
