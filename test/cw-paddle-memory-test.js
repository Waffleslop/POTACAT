#!/usr/bin/env node
'use strict';
// GitHub #244: a Paddle Memory setting for ECHOCAT Web's keyer
// (lib/cw-paddle-memory.js, renderer/remote.js createLocalCwKeyer).
//
// LZ3AW (TS-480, 25 wpm, Chrome on a phone, 1.14.8) hears his page sidetone
// 55-59 ms after the keyer chooses each element. A dit at 25 wpm is 48 ms, so
// his hand runs about one element behind the keyer, and the keyer's memory
// keeps touches on a paddle that, by the sound, belonged to the element
// before. The setting lets him have the memory listen only late in each
// element, or not at all. The default, 'on', is the keyer as it was.
//
// The web keyer runs here on a FAKE clock, as in
// test/web-keyer-late-release-test.js: paddle edges at exact times, the
// elements asserted. Each element sounds a 20 ms lead after the keyer chooses
// it, and a withdrawal is granted only before then (lib/cw-sidetone-commit.js).
//
// Also here: the rig controller announces its own CW transmit only once its
// hold is set, so main.js no longer logs a paddle over as "POTACAT did not key
// it" (#244, the AM-3 diagnosis).
// Run: node test/cw-paddle-memory-test.js
const assert = require('assert');
const path = require('path');
const { EventEmitter } = require('events');
const { readSrc } = require('./_src');
const Memory = require('../lib/cw-paddle-memory');
const Commit = require('../lib/cw-sidetone-commit');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message || e)); }
}

const root = path.join(__dirname, '..');
const src = readSrc(path.join(root, 'renderer', 'remote.js'));
const keyerSrc = src.slice(src.indexOf('  function createLocalCwKeyer(onKey) {'), src.indexOf('  // Phone-side sidetone is driven by the local keyer'));
assert.ok(keyerSrc.length > 1000, 'keyer source found');

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

const LEAD_MS = 20;

// lib: the module given to the keyer as the page gives it (null: the keyer
// source alone, as every older test runs it).
function rig({ wpm = 25, mode = 'iambicB', memory, lib = Memory } = {}) {
  const clock = fakeClock();
  const scheduled = [];
  const onKey = (down, ms, info) => {
    if (ms) { scheduled.push({ soundAt: clock.now() + LEAD_MS, ms, el: ms < 2 * Math.round(1200 / wpm) ? '.' : '-' }); return LEAD_MS; }
    if (info && info.retract) {
      const last = scheduled[scheduled.length - 1];
      if (!Commit.canWithdraw(last, clock.now())) return false;
      last.retracted = true;
      return true;
    }
    return undefined;
  };
  // eslint-disable-next-line no-new-func
  const make = new Function('setTimeout', 'clearTimeout', 'performance', 'Date', 'onKey', 'CwPaddleMemory', `
    var cwDiagNote = function() {};
    ${keyerSrc}
    return createLocalCwKeyer(onKey);
  `);
  const D = { now: () => clock.now() };
  const keyer = make(clock.setTimeout, clock.clearTimeout, D, D, onKey, lib || undefined);
  keyer.setWpm(wpm); keyer.setMode(mode);
  if (memory !== undefined) keyer.setMemory(memory);
  const t0 = clock.now();
  return {
    keyer,
    // [ms after start, 'dit'|'dah', true (closed) | false (open)]
    play(steps, tailMs = 800) {
      for (const [at, contact, closed] of steps) {
        clock.advanceTo(t0 + at);
        if (contact === 'dit') keyer.paddleDit(closed); else keyer.paddleDah(closed);
      }
      clock.advanceTo(clock.now() + tailMs);
      return scheduled.filter((e) => !e.retracted).map((e) => e.el).join('');
    },
    timeline() { return scheduled.map((e) => [e.soundAt - t0, e.ms, !!e.retracted]); },
  };
}

console.log('lib/cw-paddle-memory.js');

test('four settings, "on" first and the default', () => {
  assert.deepStrictEqual(Memory.MODES.map((m) => m.value), ['on', 'half', 'quarter', 'off']);
  assert.strictEqual(Memory.DEFAULT, 'on');
});

test('normalize: unknown, empty or missing values are "on"', () => {
  for (const v of [undefined, null, '', 'ON', 'late', 3, {}]) assert.strictEqual(Memory.normalize(v), 'on');
  for (const v of ['on', 'half', 'quarter', 'off']) assert.strictEqual(Memory.normalize(v), v);
});

test('remembers: when in a 144 ms dah each setting keeps a press', () => {
  const at = (v) => [0, 35, 71, 72, 107, 108, 143, 144, 190].map((ms) => Memory.remembers(v, ms, 144) ? 1 : 0).join('');
  assert.strictEqual(at('on'), '111111111');
  assert.strictEqual(at('half'), '000111111');      // from 72 ms
  assert.strictEqual(at('quarter'), '000001111');   // from 108 ms
  assert.strictEqual(at('off'), '000000000');
  assert.strictEqual(at('nonsense'), '111111111');  // unknown reads as the default
});

console.log('the web keyer, Paddle Memory "on" (the default): unchanged');

// Random paddle scripts: the keyer source alone (no module, no setting, as
// before this change) and with the module and "on" key the same elements at
// the same times, in iambic A, B and straight, at 15, 25 and 35 wpm.
test('"on" keys exactly what the keyer did without the setting, edge for edge (600 random overs)', () => {
  let seed = 244;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let n = 0; n < 600; n++) {
    const mode = ['iambicA', 'iambicB', 'straight'][n % 3];
    const wpm = [15, 25, 35][Math.floor(n / 3) % 3];
    const steps = [];
    let t = 0;
    const down = { dit: false, dah: false };
    for (let i = 0; i < 16; i++) {
      t += Math.floor(rnd() * 120) + 1;
      const c = rnd() < 0.5 ? 'dit' : 'dah';
      down[c] = !down[c];
      steps.push([t, c, down[c]]);
    }
    steps.push([t + 5, 'dit', false], [t + 6, 'dah', false]);
    const a = rig({ mode, wpm, lib: null });
    const b = rig({ mode, wpm, memory: 'on' });
    a.play(steps); b.play(steps);
    assert.deepStrictEqual(b.timeline(), a.timeline(), `over ${n} (${mode}, ${wpm} wpm) differs`);
  }
});

test('a keyer that is never told a setting is on "on"', () => {
  assert.strictEqual(rig().keyer.getMemory(), 'on');
});

test('setMemory with an unknown value is "on"', () => {
  const r = rig();
  r.keyer.setMemory('later');
  assert.strictEqual(r.keyer.getMemory(), 'on');
  r.keyer.setMemory('off');
  assert.strictEqual(r.keyer.getMemory(), 'off');
});

console.log('the web keyer at 25 wpm: dit 48 ms, dah 144 ms, space 48 ms');

// Holding dah from 0 and letting go at 150: the dah sounds 0-144 (keyer
// time), the space runs to 192, when the keyer chooses what comes next.
const DAH_ALONE = [[0, 'dah', true], [150, 'dah', false]];

test('a touch on the dit paddle early in the dah, let go again at 70 ms: "on" keeps it ("-."), the late settings and "off" do not ("-")', () => {
  const steps = [...DAH_ALONE, [30, 'dit', true], [70, 'dit', false]].sort((x, y) => x[0] - y[0]);
  assert.strictEqual(rig({ memory: 'on' }).play(steps), '-.');
  assert.strictEqual(rig({ memory: 'half' }).play(steps), '-');
  assert.strictEqual(rig({ memory: 'quarter' }).play(steps), '-');
  assert.strictEqual(rig({ memory: 'off' }).play(steps), '-');
});

test('the late window is the setting\'s: let go at up to 71 ms (half) or 107 ms (quarter) after the dah was chosen adds nothing', () => {
  for (const [memory, lastQuiet] of [['half', 71], ['quarter', 107]]) {
    for (let at = 1; at <= lastQuiet; at += 5) {
      const steps = [[0, 'dah', true], [at, 'dit', true], [Math.min(at + 13, lastQuiet + 1), 'dit', false], [150, 'dah', false]];
      // The press itself comes inside the window; it is let go before the keyer chooses.
      assert.strictEqual(rig({ memory }).play(steps), '-', `${memory}: touch at ${at} ms`);
    }
  }
});

test('a touch after the window opens is remembered as before: at 110 ms in the dah, "half" and "quarter" send "-.", "off" sends "-"', () => {
  const steps = [[0, 'dah', true], [110, 'dit', true], [130, 'dit', false], [150, 'dah', false]];
  assert.strictEqual(rig({ memory: 'half' }).play(steps), '-.');
  assert.strictEqual(rig({ memory: 'quarter' }).play(steps), '-.');
  assert.strictEqual(rig({ memory: 'on' }).play(steps), '-.');
  assert.strictEqual(rig({ memory: 'off' }).play(steps), '-');
});

test('a touch in the space after the element: every setting but "off" keeps it', () => {
  const steps = [[0, 'dah', true], [150, 'dah', false], [160, 'dit', true], [175, 'dit', false]];
  for (const m of ['on', 'half', 'quarter']) assert.strictEqual(rig({ memory: m }).play(steps), '-.', m);
  assert.strictEqual(rig({ memory: 'off' }).play(steps), '-');
});

test('a paddle still closed when the keyer chooses is sent in every setting: pressed at 30 ms, held to 250 ms: "-."', () => {
  const steps = [[0, 'dah', true], [30, 'dit', true], [150, 'dah', false], [250, 'dit', false]];
  for (const m of ['on', 'half', 'quarter', 'off']) assert.strictEqual(rig({ memory: m }).play(steps), '-.', m);
});

test('a squeezed "C" in iambic A is "-.-." in every setting', () => {
  // dah 0-144, dit 192-240, dah 288-432, dit 480-528; both let go at 540.
  const steps = [[0, 'dah', true], [10, 'dit', true], [540, 'dit', false], [540, 'dah', false]];
  for (const m of ['on', 'half', 'quarter', 'off']) assert.strictEqual(rig({ mode: 'iambicA', memory: m }).play(steps), '-.-.', m);
});

test('iambic B\'s squeeze still adds the opposite element in every setting (that is mode B, not memory)', () => {
  // dit 0-48; dah chosen at 96 with both closed; both let go at 120, inside the dah.
  const steps = [[0, 'dit', true], [1, 'dah', true], [120, 'dit', false], [120, 'dah', false]];
  for (const m of ['on', 'half', 'quarter', 'off']) {
    assert.strictEqual(rig({ mode: 'iambicB', memory: m }).play(steps), '.-.', 'B ' + m);
    assert.strictEqual(rig({ mode: 'iambicA', memory: m }).play(steps), '.-', 'A ' + m);
  }
});

test('a held "S" released before the 4th dit sounds is "..." in every setting (the withdrawal is unchanged)', () => {
  for (const m of ['on', 'half', 'quarter', 'off']) assert.strictEqual(rig({ memory: m }).play([[0, 'dit', true], [300, 'dit', false]]), '...', m);
});

test('the setting never starts an element on its own: no paddle, no element; a press from idle starts at once in every setting', () => {
  for (const m of ['on', 'half', 'quarter', 'off']) {
    assert.strictEqual(rig({ memory: m }).play([]), '', m);
    const r = rig({ memory: m });
    assert.strictEqual(r.play([[0, 'dit', true], [20, 'dit', false]]), '.', m);
    assert.strictEqual(r.timeline()[0][0], LEAD_MS, m);
  }
});

test('straight key follows the contact in every setting', () => {
  for (const m of ['on', 'half', 'quarter', 'off']) {
    const keyed = [];
    // eslint-disable-next-line no-new-func
    const k = new Function('onKey', 'CwPaddleMemory', `var cwDiagNote = function() {}; ${keyerSrc} return createLocalCwKeyer(onKey);`)((down, ms) => { if (ms === undefined) keyed.push(down); }, Memory);
    k.setMode('straight'); k.setMemory(m);
    k.paddleDit(true); k.paddleDit(false);
    assert.deepStrictEqual(keyed, [true, false], m);
  }
});

console.log('the page');

test('remote.html: the Paddle Memory list matches the module, "on" first', () => {
  const html = readSrc(path.join(root, 'renderer', 'remote.html'));
  const sel = html.slice(html.indexOf('<select class="so-select" id="so-paddle-memory">'));
  const opts = [...sel.slice(0, sel.indexOf('</select>')).matchAll(/<option value="([^"]+)">([^<]+)<\/option>/g)].map((m) => [m[1], m[2]]);
  assert.deepStrictEqual(opts, Memory.MODES.map((m) => [m.value, m.label]));
  assert.ok(html.includes('<label class="so-label" for="so-paddle-memory">Paddle Memory</label>'));
  assert.ok(!/[\u{1F300}-\u{1FAFF}]/u.test(sel.slice(0, 2000)), 'no emoji');
});

test('remote.html carries the module marker before remote.js; remote-server inlines it', () => {
  const html = readSrc(path.join(root, 'renderer', 'remote.html'));
  assert.ok(html.includes('<!-- cw-paddle-memory-js -->'));
  assert.ok(html.indexOf('<!-- cw-paddle-memory-js -->') < html.indexOf('remote.js'));
  const rs = readSrc(path.join(root, 'lib', 'remote-server.js'));
  assert.ok(/\['cw-paddle-memory-js', 'cw-paddle-memory\.js'\]/.test(rs));
});

test('the page keeps the choice per browser and hands it to its keyer', () => {
  assert.ok(src.includes("localStorage.getItem('echocat-paddle-memory')"));
  assert.ok(src.includes("localStorage.setItem('echocat-paddle-memory', paddleMemory)"));
  assert.ok(/localCwKeyer\.setMemory\(paddleMemory\)/.test(src));
  assert.ok(/paddleMemory: localCwKeyer\.getMemory\(\)/.test(src), 'the per-over diagnostic says which setting was used');
});

test('the desktop log line names a late setting, and says nothing for "on"', () => {
  const rs = readSrc(path.join(root, 'lib', 'remote-server.js'));
  assert.ok(/\(half\|quarter\|off\)\$\/\.test\(msg\.paddleMemory\) \? ` Paddle memory: \$\{msg\.paddleMemory\}\.`/.test(rs));
  const proto = readSrc(path.join(root, 'lib', 'echocat-protocol.js'));
  assert.ok(/'cw-diag':[^\n]*paddleMemory: f\.optString/.test(proto));
});

console.log('rig controller: its own CW transmit is announced after the hold is set');

test('a "ptt" listener sees the CW hold when noteTransmitting announces transmit', () => {
  const { RigController } = require('../lib/rig-controller');
  const { KenwoodCodec } = require('../lib/codecs/kenwood-codec');
  const { RIG_MODELS } = require('../lib/rig-models');
  const TS480 = RIG_MODELS['TS-480'];
  const transport = new EventEmitter();
  transport.connect = () => {}; transport.disconnect = () => {}; transport.write = () => {};
  const codec = new KenwoodCodec(TS480, () => {});
  const rig = new RigController(TS480, transport, codec);
  rig.connected = true;
  rig._target = { path: 'COM1' };
  const seen = [];
  rig.on('ptt', (on) => seen.push([on, !!rig._cwHoldTimer, rig._cwHoldUntil > Date.now()]));
  try {
    rig.noteTransmitting(2000);
    rig.noteTransmitting(2000); // already transmitting: announced once
    assert.deepStrictEqual(seen, [[true, true, true]]);
  } finally {
    if (rig._cwHoldTimer) clearTimeout(rig._cwHoldTimer);
    rig._cwHoldTimer = null;
  }
});

test('main.js treats a "ptt" with the CW hold set as POTACAT\'s own transmit', () => {
  const main = readSrc(path.join(root, 'main.js'));
  const fn = main.slice(main.indexOf('function txNoteRadioPtt('), main.indexOf('function txNoteRadioPtt(') + 1200);
  assert.ok(/controller\._cwHoldTimer/.test(fn));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
