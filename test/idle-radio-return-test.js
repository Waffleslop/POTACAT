#!/usr/bin/env node
'use strict';
// #1051 (Discord 2026-11-24, FLEX on macOS): Idle Mode WSPR left the radio on
// 14.0956 DIGU after the operator came back, instead of 14.260 USB. Only the
// SSTV branch put the radio back. Every idle mode that moves the radio now puts
// it back through one path (lib/idle-radio-return.js), exactly where it found
// it, and never over the operator's own choice.
//
// The radio here is a fake: tune() records what was sent and moves the dial.
// Run: node test/idle-radio-return-test.js

const assert = require('assert');
const IdleReturn = require('../lib/idle-radio-return');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message || e)); }
}

/** A fake radio, a fake settings store and a clock. */
function rig({ hz = 14260000, mode = 'USB', filterWidth = 2700 } = {}) {
  const r = { hz, mode, filterWidth, sent: [], logs: [], store: null, t: 1000000 };
  r.ret = IdleReturn.createIdleReturn({
    load: () => r.store,
    save: (m) => { r.store = m ? JSON.parse(JSON.stringify(m)) : null; },
    tune: (place) => { r.sent.push({ ...place }); r.hz = place.freqHz; r.mode = place.mode; },
    now: () => r.t,
    log: (s) => r.logs.push(s),
  });
  /** The idle session tunes the radio (its window, a hop, a sunrise change). */
  r.idleTune = (khz, m = 'DIGU') => { r.ret.noteDial(khz * 1000); r.hz = khz * 1000; r.mode = m; };
  r.wait = (ms) => { r.t += ms; };
  return r;
}

// The dial each idle mode puts the radio on (main.js triggerAutoSstv).
const MODES = {
  WSPR: { khz: 14095.6, mode: 'DIGU' },
  PSK31: { khz: 14070, mode: 'DIGU' },
  JTTY: { khz: 14090, mode: 'DIGU' },
  SSTV: { khz: 14230, mode: 'USB' },
  JS8: { khz: 14078, mode: 'DIGU' },
};

for (const [label, dial] of Object.entries(MODES)) {
  test(`${label}: the radio goes back to its frequency, mode and filter when idle ends`, () => {
    const r = rig();
    r.ret.begin({ home: { freqHz: 14260000, mode: 'USB', filterWidth: 2700 }, rigId: 'flex', label });
    r.idleTune(dial.khz, dial.mode);
    r.wait(60 * 60 * 1000);
    assert.strictEqual(r.ret.watch(r.hz), 'none', 'the session on its own dial is not the operator');
    const res = r.ret.end({ nowHz: r.hz, nowMode: r.mode, connected: true });
    assert.strictEqual(res, 'returned');
    assert.deepStrictEqual(r.sent, [{ freqHz: 14260000, mode: 'USB', filterWidth: 2700 }]);
    assert.strictEqual(r.hz, 14260000);
    assert.strictEqual(r.mode, 'USB');
    assert.ok(r.logs.some((l) => /from 14\.\d{4} MHz .* to 14\.2600 MHz USB/.test(l)), 'one line with from and to: ' + r.logs.join(' | '));
    // The next readback at home confirms it and clears the marker.
    r.wait(4000);
    assert.strictEqual(r.ret.onReadback(14260000, { rigId: 'flex', active: false }), 'confirmed');
    assert.strictEqual(r.store, null);
  });

  test(`${label}: the operator moved the radio during idle: no snap back, the home is dropped and the log says why`, () => {
    const r = rig();
    r.ret.begin({ home: { freqHz: 14260000, mode: 'USB' }, rigId: 'flex', label });
    r.idleTune(dial.khz, dial.mode);
    r.wait(20000);
    // A knob turn in SmartSDR: 7.185 LSB.
    const res = r.ret.end({ nowHz: 7185000, nowMode: 'LSB', connected: true });
    assert.strictEqual(res, 'left-alone');
    assert.deepStrictEqual(r.sent, []);
    assert.strictEqual(r.store, null);
    assert.ok(r.logs.some((l) => /stays on 7\.1850 MHz/.test(l) && /does not go back/.test(l)), r.logs.join(' | '));
  });

  test(`${label}: an operator action (a spot click, a transmit) ends idle without a snap back`, () => {
    const r = rig();
    r.ret.begin({ home: { freqHz: 14260000, mode: 'USB' }, rigId: 'flex', label });
    r.idleTune(dial.khz, dial.mode);
    r.wait(20000);
    r.ret.operatorTook('a spot click', r.hz);
    assert.strictEqual(r.ret.end({ nowHz: r.hz, nowMode: r.mode, connected: true }), 'none');
    assert.deepStrictEqual(r.sent, []);
    assert.strictEqual(r.store, null);
    assert.ok(r.logs.some((l) => /a spot click/.test(l)));
  });
}

test('within a small tolerance: a few hundred Hz off the idle dial still counts as where idle put it', () => {
  const r = rig();
  r.ret.begin({ home: { freqHz: 14260000, mode: 'USB' }, rigId: 'x' });
  r.idleTune(14095.6);
  assert.strictEqual(r.ret.end({ nowHz: 14095600 + 400, connected: true }), 'returned');
  const r2 = rig();
  r2.ret.begin({ home: { freqHz: 14260000, mode: 'USB' }, rigId: 'x' });
  r2.idleTune(14095.6);
  assert.strictEqual(r2.ret.end({ nowHz: 14074000, connected: true }), 'left-alone', '14.074 FT8 is the operator\'s');
});

test('a WSPR band hop or a sunrise band change during idle is still the session: it goes back from the last band', () => {
  const r = rig({ hz: 3850000, mode: 'LSB' });
  r.ret.begin({ home: { freqHz: 3850000, mode: 'LSB' }, rigId: 'x', label: 'WSPR' });
  r.idleTune(14095.6);
  r.wait(120000);
  r.idleTune(7038.6);
  r.wait(120000);
  assert.strictEqual(r.ret.watch(7038600), 'none');
  assert.strictEqual(r.ret.end({ nowHz: 7038600, nowMode: 'DIGU', connected: true }), 'returned');
  assert.deepStrictEqual(r.sent[0], { freqHz: 3850000, mode: 'LSB' });
});

test('the radio is already home (SSTV on a radio without 20 m or 40 m never tuned): nothing is sent', () => {
  const r = rig();
  r.ret.begin({ home: { freqHz: 14260000, mode: 'USB' }, rigId: 'x', label: 'SSTV' });
  assert.strictEqual(r.ret.end({ nowHz: 14260000, nowMode: 'USB', connected: true }), 'home');
  assert.deepStrictEqual(r.sent, []);
  assert.strictEqual(r.store, null);
});

test('no place to go back to (no reading of the radio at the start): nothing is saved, nothing is sent', () => {
  const r = rig();
  r.ret.begin({ home: { freqHz: 0, mode: '' }, rigId: 'x' });
  assert.strictEqual(r.store, null);
  r.idleTune(14095.6);
  assert.strictEqual(r.ret.end({ nowHz: 14095600, connected: true }), 'none');
  assert.deepStrictEqual(r.sent, []);
});

// ── the operator moves the radio outside POTACAT while idle runs ────────────

test('watch: a knob turn away from the idle dial is the operator (after the settle time)', () => {
  const r = rig();
  r.ret.begin({ home: { freqHz: 14260000, mode: 'USB' }, rigId: 'x' });
  r.idleTune(14095.6);
  // The poll may still bring back the old dial just after the tune: not a move.
  r.wait(1000);
  assert.strictEqual(r.ret.watch(14260000), 'none', 'a stale readback of home right after the tune');
  assert.strictEqual(r.ret.watch(14095600), 'none');
  r.wait(IdleReturn.SETTLE_MS + 1);
  assert.strictEqual(r.ret.watch(14095650), 'none', 'still on the idle dial');
  assert.strictEqual(r.ret.watch(14250000), 'moved');
});

test('watch: tuning back home by hand after the idle tune is the operator too', () => {
  const r = rig();
  r.ret.begin({ home: { freqHz: 14260000, mode: 'USB' }, rigId: 'x' });
  r.idleTune(14095.6);
  r.wait(IdleReturn.SETTLE_MS + 1);
  assert.strictEqual(r.ret.watch(14095600), 'none');
  assert.strictEqual(r.ret.watch(14260000), 'moved');
});

test('watch: a session that never moved the radio sees the home readback as no move', () => {
  const r = rig();
  r.ret.begin({ home: { freqHz: 14260000, mode: 'USB' }, rigId: 'x' });
  r.wait(IdleReturn.SETTLE_MS + 1);
  assert.strictEqual(r.ret.watch(14260000), 'none');
  assert.strictEqual(r.ret.watch(14260010), 'none');
});

// ── the radio disconnected during idle ───────────────────────────────────────

test('disconnected when idle ends: nothing is sent now; on reconnect it goes back only if still on the idle dial', () => {
  const r = rig();
  r.ret.begin({ home: { freqHz: 14260000, mode: 'USB' }, rigId: 'flex' });
  r.idleTune(14095.6);
  assert.strictEqual(r.ret.end({ nowHz: 0, connected: false }), 'pending');
  assert.deepStrictEqual(r.sent, []);
  assert.ok(r.store && r.store.state === 'ended', 'kept for the reconnect');
  r.wait(60000);
  assert.strictEqual(r.ret.onReadback(14095600, { rigId: 'flex', active: false }), 'returned');
  assert.deepStrictEqual(r.sent, [{ freqHz: 14260000, mode: 'USB' }]);
});

test('disconnected when idle ends, and the operator moved the radio before it came back: left where it is', () => {
  const r = rig();
  r.ret.begin({ home: { freqHz: 14260000, mode: 'USB' }, rigId: 'flex' });
  r.idleTune(14095.6);
  r.ret.end({ nowHz: 0, connected: false });
  assert.strictEqual(r.ret.onReadback(21300000, { rigId: 'flex', active: false }), 'left-alone');
  assert.deepStrictEqual(r.sent, []);
  assert.strictEqual(r.store, null);
});

test('a different radio connects after idle ended: never tuned', () => {
  const r = rig();
  r.ret.begin({ home: { freqHz: 14260000, mode: 'USB' }, rigId: 'flex' });
  r.idleTune(14095.6);
  r.ret.end({ nowHz: 0, connected: false });
  assert.strictEqual(r.ret.onReadback(14095600, { rigId: 'ic7300', active: false }), 'other-rig');
  assert.deepStrictEqual(r.sent, []);
});

test('a readback during a running session is the watch, never a return', () => {
  const r = rig();
  r.ret.begin({ home: { freqHz: 14260000, mode: 'USB' }, rigId: 'flex' });
  r.idleTune(14095.6);
  assert.strictEqual(r.ret.onReadback(14095600, { rigId: 'flex', active: true }), 'none');
  assert.deepStrictEqual(r.sent, []);
});

// ── quit and crash ───────────────────────────────────────────────────────────

test('the place is on disk before the radio moves, so a crash during idle is put right at the next start', () => {
  const r = rig();
  r.ret.begin({ home: { freqHz: 14260000, mode: 'USB' }, rigId: 'flex' });
  assert.ok(r.store && r.store.home.freqHz === 14260000, 'saved at begin');
  r.idleTune(14095.6);
  assert.ok(r.store.dials.includes(14095600), 'the idle dial is saved too');
  // Crash. A new run with the same store: the first readback finishes the job.
  const store = r.store;
  const r2 = rig({ hz: 14095600, mode: 'DIGU' });
  r2.store = store;
  assert.strictEqual(r2.ret.onReadback(14095600, { rigId: 'flex', active: false }), 'returned');
  assert.deepStrictEqual(r2.sent, [{ freqHz: 14260000, mode: 'USB' }]);
});

test('a return that did not land is tried again on later readbacks, at most a few times', () => {
  const r = rig();
  r.ret.begin({ home: { freqHz: 14260000, mode: 'USB' }, rigId: 'flex' });
  r.idleTune(14095.6);
  r.ret.end({ nowHz: 14095600, connected: true });   // quit: sent, maybe lost
  assert.strictEqual(r.store.state, 'returning');
  // A readback right after the send is the radio not caught up yet: wait.
  assert.strictEqual(r.ret.onReadback(14095600, { rigId: 'flex', active: false }), 'none');
  let res;
  for (let i = 0; i < IdleReturn.MAX_TRIES + 2; i++) {
    r.wait(IdleReturn.RETURN_SETTLE_MS + 1);
    res = r.ret.onReadback(14095600, { rigId: 'flex', active: false });
    if (res === 'gave-up') break;
  }
  assert.strictEqual(res, 'gave-up');
  assert.strictEqual(r.sent.length, IdleReturn.MAX_TRIES);
  assert.strictEqual(r.store, null, 'given up: the marker is gone, nothing more is sent');
});

test('a new idle session over a return still pending keeps the FIRST home (an idle dial is never home)', () => {
  const r = rig();
  r.ret.begin({ home: { freqHz: 14260000, mode: 'USB' }, rigId: 'flex' });
  r.idleTune(14095.6);
  r.ret.end({ nowHz: 0, connected: false });
  // Reconnected later still on the WSPR dial, and the next idle session starts there.
  r.ret.begin({ home: { freqHz: 14095600, mode: 'DIGU' }, rigId: 'flex' });
  assert.strictEqual(r.store.home.freqHz, 14260000);
  assert.strictEqual(r.ret.end({ nowHz: 14095600, connected: true }), 'returned');
  assert.strictEqual(r.sent[0].freqHz, 14260000);
});

// ── outside tuning counts as activity before idle starts ─────────────────────

test('dial activity: a frequency or mode change is activity; the same reading again is not', () => {
  const w = IdleReturn.createDialActivity();
  assert.strictEqual(w.note(14260000, 'USB'), false, 'the first reading is the baseline');
  assert.strictEqual(w.note(14260000, 'USB'), false);
  assert.strictEqual(w.note(14260020, 'USB'), false, 'under the step: a reading jitter');
  assert.strictEqual(w.note(14262000, 'USB'), true, 'a knob turn');
  assert.strictEqual(w.note(14262000, 'LSB'), true, 'a mode change');
  assert.strictEqual(w.note(14262000, ''), false, 'no mode reading is not a change');
  assert.strictEqual(w.note(0, 'LSB'), false, 'no frequency (disconnected) is not a change');
});

test('dial activity: slow tuning in small steps still counts once it adds up', () => {
  const w = IdleReturn.createDialActivity();
  w.note(7030000, 'CW');
  let moved = false;
  for (let i = 1; i <= 20; i++) moved = w.note(7030000 + i * 10, 'CW') || moved;
  assert.strictEqual(moved, true);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
