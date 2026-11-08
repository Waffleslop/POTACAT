#!/usr/bin/env node
'use strict';
// GitHub #244, LZ3AW on 1.13.8: a TinyMIDI paddle on ECHOCAT Web sends extra
// dots and dashes at 25 wpm. His cw-diag line: the sidetone reached the
// speaker 54 ms after the keyer chose each element (38 ms of it the device's
// output), keyer timers late 3 ms on average, paddle input up to 24 ms late.
// At 25 wpm the dit and the space are 48 ms each, so the keyer decided
// "still held, one more" before he could hear the element he was releasing
// on, and before his release had even reached the page.
//
// The web keyer (renderer/remote.js createLocalCwKeyer) and the page's MIDI
// handler (ecHandleMidiMessage) run here on a FAKE clock: MIDI note on/off
// messages are replayed at exact times and the elements keyed are asserted.
// The sidetone voice is modelled as the page's scheduler does it: each
// element sounds a 20 ms lead after the keyer chooses it.
// Run: node test/web-keyer-late-release-test.js
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

// A fake clock: setTimeout/clearTimeout/performance.now/Date.now all read it.
function fakeClock() {
  let now = 1000, seq = 0;
  const timers = new Map();
  const clock = {
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
  return clock;
}

const DIT_NOTE = 60, DAH_NOTE = 62;
const LEAD_MS = 20; // schedulePaddleElement's lead for a new streak

// One web keyer + the page's MIDI handler on a fake clock. Elements are
// recorded when they would START TO SOUND (choice + lead); a withdrawn one
// never does.
function rig({ wpm = 25, mode = 'iambicB' } = {}) {
  const clock = fakeClock();
  const scheduled = []; // { soundAt, el, retracted }
  const onKey = (down, ms, info) => {
    if (ms) { scheduled.push({ soundAt: clock.now() + LEAD_MS, el: ms < 2 * Math.round(1200 / wpm) ? '.' : '-' }); return LEAD_MS; }
    if (info && info.retract) {
      const last = scheduled[scheduled.length - 1];
      assert.ok(last && last.soundAt > clock.now(), 'a withdrawn element had not begun to sound');
      last.retracted = true;
    }
    return undefined;
  };
  const perf = { now: () => clock.now() };
  const D = { now: () => clock.now() };
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
  const { keyer, midi } = make(clock.setTimeout, clock.clearTimeout, perf, D, onKey);
  keyer.setWpm(wpm); keyer.setMode(mode);
  const t0 = clock.now();
  return {
    // [ms after start, 'on'|'off'|'on0' (note-on velocity 0), 'dit'|'dah']
    play(steps, tailMs = 800) {
      for (const [at, kind, contact] of steps) {
        clock.advanceTo(t0 + at);
        const note = contact === 'dit' ? DIT_NOTE : DAH_NOTE;
        const data = kind === 'on' ? [0x90, note, 100] : kind === 'on0' ? [0x90, note, 0] : [0x80, note, 0];
        midi({ data, timeStamp: 0 });
      }
      clock.advanceTo(clock.now() + tailMs);
      return scheduled.filter((e) => !e.retracted).map((e) => e.el).join('');
    },
    scheduled,
  };
}

console.log('web keyer: late release of a held paddle (#244)');

// 25 wpm: dit 48 ms, dah 144 ms, space 48 ms. Holding dit from 0 the keyer
// chooses dits at 0, 96, 192 and decides the 4th at 288; that 4th dit would
// sound at 308.
test('"S" held on the dit paddle, released 12 ms after the 4th dit was chosen but before it sounds: "..."', () => {
  assert.strictEqual(rig().play([[0, 'on', 'dit'], [300, 'off', 'dit']]), '...');
});

test('the same release with note-on velocity 0 as the note-off: "..."', () => {
  assert.strictEqual(rig().play([[0, 'on', 'dit'], [300, 'on0', 'dit']]), '...');
});

test('a release after the 4th dit has begun to sound keys it: "...." (honest iambic, nothing clipped)', () => {
  assert.strictEqual(rig().play([[0, 'on', 'dit'], [312, 'off', 'dit']]), '....');
});

test('a release inside the space, before the choice, is unchanged: "..."', () => {
  assert.strictEqual(rig().play([[0, 'on', 'dit'], [270, 'off', 'dit']]), '...');
});

test('"T" held on the dah paddle, released just after the 2nd dah was chosen: "-"', () => {
  // dah 144 + space 48: the 2nd dah is chosen at 192 and sounds at 212.
  assert.strictEqual(rig().play([[0, 'on', 'dah'], [205, 'off', 'dah']]), '-');
});

test('MIDI note-on repeats while the contact is held do not latch an extra element', () => {
  // Some MIDI bridges resend note-on while a key is down.
  assert.strictEqual(rig().play([[0, 'on', 'dit'], [20, 'on', 'dit'], [120, 'on', 'dit'], [250, 'on', 'dit'], [270, 'off', 'dit']]), '...');
});

test('a squeeze for "C" in iambic B is still "-.-." when the hold on its last dit opens before it sounds', () => {
  // Chosen: dah 0, dit 192, dah 288 (both held), dit 480 (dit held). The
  // dit opens at 490, before that dit sounds (500): it is withdrawn, and
  // iambic B's squeeze bonus after the both-held dah supplies the dit.
  const out = rig({ mode: 'iambicB' }).play([[0, 'on', 'dah'], [10, 'on', 'dit'], [470, 'off', 'dah'], [490, 'off', 'dit']]);
  assert.strictEqual(out, '-.-.');
});

test('iambic A: "N" with the dah released just after the latched dit is chosen keeps the dit', () => {
  // "N" (-.): dah from 0, dit pressed during it (latched); dah released at
  // 200, just after the keyer chose the dit (192) on the latch: kept.
  assert.strictEqual(rig({ mode: 'iambicA' }).play([[0, 'on', 'dah'], [100, 'on', 'dit'], [150, 'off', 'dit'], [200, 'off', 'dah']]), '-.');
});

test('a LATCHED element is never withdrawn (dot memory: a tap during the dah still sends its dit)', () => {
  // dah held 0..150, dit tapped 60..90: the dit is latched and sent even
  // though both contacts are open by the time it is chosen.
  assert.strictEqual(rig().play([[0, 'on', 'dah'], [60, 'on', 'dit'], [90, 'off', 'dit'], [150, 'off', 'dah']]), '-.');
});

test('a withdrawn held element hands over to the other paddle still held', () => {
  // dit and dah both down; dah released 6 ms after the keyer chose a dah
  // on its hold: the keyer chooses again and the dit paddle, still held,
  // keys a dit instead.
  // dit at 0 (dit pressed first), dah pressed at 30 -> latched dah at 96,
  // then dit (held) at 288, dah (held) at 384: dah released at 390.
  const r = rig({ mode: 'iambicA' });
  const out = r.play([[0, 'on', 'dit'], [30, 'on', 'dah'], [390, 'off', 'dah'], [470, 'off', 'dit']]);
  assert.strictEqual(out, '.-..');
});

test('two quick dot taps are still "I" and a held dot still repeats', () => {
  assert.strictEqual(rig().play([[0, 'on', 'dit'], [30, 'off', 'dit'], [100, 'on', 'dit'], [130, 'off', 'dit']]), '..');
  assert.strictEqual(rig().play([[0, 'on', 'dit'], [500, 'off', 'dit']]), '......');
});

test('page wiring: the keyer is told when each element sounds, and a withdrawal cancels its tone and its shack keying', () => {
  assert.ok(/var lead = onKey\(true, isDit \? ditMs\(\) : dahMs\(\)/.test(src), 'keyer reads the lead from onKey');
  assert.ok(/var lead = schedulePaddleElement\(durMs\); cwDiagNote\('ahead', lead\); return lead;/.test(src), 'onKey returns the sidetone lead');
  assert.ok(/if \(info && info\.retract\) \{ retractPaddleElement\(\); return; \}/.test(src), 'onKey routes a withdrawal');
  const fn = extract('retractPaddleElement');
  assert.ok(/cancelScheduledValues\(paddleLastAt\)/.test(fn), 'drops only the withdrawn tone');
  assert.ok(/type: 'cw-key', at: cwStreamLastAt - 1, down: false, cancel: true/.test(fn), 'cancels the element at the shack');
});

test('shack playout: the cancelling key-up drops the withdrawn element and keeps the one before it', () => {
  const { CwKeyPlayout } = require('../lib/cw-key-playout');
  const clock = fakeClock();
  const out = [];
  const p = new CwKeyPlayout({ output: (e) => out.push([e.down, e.timestamp]), now: clock.now, setTimer: clock.setTimeout, clearTimer: clock.clearTimeout, bufferMs: 120 });
  const t = clock.now();
  p.push({ at: 0, down: true, ms: 48 });          // dit 1
  clock.advanceTo(t + 96);
  p.push({ at: 96, down: true, ms: 48 });         // dit 2 (to be withdrawn)
  clock.advanceTo(t + 104);
  p.push({ at: 95, down: false, cancel: true });  // the page's cancel: at = slot - 1
  clock.advanceTo(t + 1000);
  const downs = out.filter((e) => e[0]).length;
  assert.strictEqual(downs, 1, 'only the first dit keyed the radio');
  assert.strictEqual(out[out.length - 1][0], false, 'key is up');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
