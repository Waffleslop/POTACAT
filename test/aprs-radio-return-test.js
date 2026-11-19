#!/usr/bin/env node
'use strict';
// APRS phase 2: the radio goes back to its frequency and mode when listening
// stops, including after a crash or a quit (lib/aprs-radio-return.js). The
// place is persisted BEFORE the radio is tuned; the marker is cleared only by
// the radio's own readback, never by a command having been sent; a radio the
// operator moved since is left where they put it.
// Run: node test/aprs-radio-return-test.js

const assert = require('assert');
const R = require('../lib/aprs-radio-return');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

const HOME = { freqHz: 14074000, mode: 'DIGU', rigId: 'rig-1' };
const APRS = 144390000;

/** A disk that survives a "crash" (a new controller on the same disk) and logs every call in order. */
function world() {
  const w = { disk: null, events: [] };
  w.make = () => R.createRadioReturn({
    load: () => (w.disk ? JSON.parse(JSON.stringify(w.disk)) : null),
    save: (m) => { w.disk = m ? JSON.parse(JSON.stringify(m)) : null; w.events.push(m ? 'save:' + m.state : 'clear'); },
    tune: (hz, mode) => w.events.push('tune:' + hz + ':' + (mode || '')),
    now: () => 1000,
  });
  return w;
}

console.log('APRS radio return');

test('the place is written to disk before the radio is tuned', () => {
  const w = world();
  const c = w.make();
  c.begin({ ...HOME, listenHz: APRS }, () => w.events.push('tune-to-aprs'));
  assert.deepStrictEqual(w.events, ['save:listening', 'tune-to-aprs']);
  assert.strictEqual(w.disk.freqHz, 14074000);
  assert.strictEqual(w.disk.mode, 'DIGU');
  assert.strictEqual(w.disk.listenHz, APRS);
});

test('stop: the radio goes back to the frequency and mode it had, and the marker clears on the readback', () => {
  const w = world();
  const c = w.make();
  c.begin({ ...HOME, listenHz: APRS }, () => {});
  w.events.length = 0;
  assert.strictEqual(c.end(APRS), 'returned');
  assert.deepStrictEqual(w.events, ['save:returning', 'tune:14074000:DIGU']);
  assert.ok(w.disk, 'the marker stays until the radio confirms');
  assert.strictEqual(c.onReadback(14074000, { rigId: 'rig-1' }), 'confirmed');
  assert.strictEqual(w.disk, null);
});

test('crash while listening: the next start puts the radio back on its first readback', () => {
  const w = world();
  w.make().begin({ ...HOME, listenHz: APRS }, () => {});
  // ...POTACAT dies here. A new run:
  w.events.length = 0;
  const c2 = w.make();
  assert.ok(c2.pending(), 'the marker survived');
  assert.strictEqual(c2.onReadback(APRS, { rigId: 'rig-1' }), 'returned');
  assert.deepStrictEqual(w.events, ['save:returning', 'tune:14074000:DIGU']);
  assert.strictEqual(c2.onReadback(14074000, { rigId: 'rig-1' }), 'confirmed');
  assert.strictEqual(w.disk, null);
});

test('quit while listening: the return is sent at quit; a radio that took it clears the marker at the next start', () => {
  const w = world();
  const c = w.make();
  c.begin({ ...HOME, listenHz: APRS }, () => {});
  assert.strictEqual(c.end(APRS), 'returned'); // gracefulCleanup, CAT still open
  w.events.length = 0;
  const c2 = w.make();
  assert.strictEqual(c2.onReadback(14074000, { rigId: 'rig-1' }), 'confirmed');
  assert.deepStrictEqual(w.events, ['clear']);
});

test('quit where the return never reached the radio: the next start sends it again', () => {
  const w = world();
  const c = w.make();
  c.begin({ ...HOME, listenHz: APRS }, () => {});
  c.end(APRS);
  w.events.length = 0;
  const c2 = w.make();
  assert.strictEqual(c2.onReadback(APRS, { rigId: 'rig-1' }), 'returned');
  assert.deepStrictEqual(w.events, ['save:returning', 'tune:14074000:DIGU']);
});

test('a radio the operator moved since is left where they put it (stop, and the next start)', () => {
  const w = world();
  const c = w.make();
  c.begin({ ...HOME, listenHz: APRS }, () => {});
  w.events.length = 0;
  assert.strictEqual(c.end(146520000), 'left-alone');
  assert.deepStrictEqual(w.events, ['clear']);
  const w2 = world();
  w2.make().begin({ ...HOME, listenHz: APRS }, () => {});
  w2.events.length = 0;
  assert.strictEqual(w2.make().onReadback(7074000, { rigId: 'rig-1' }), 'left-alone');
  assert.deepStrictEqual(w2.events, ['clear']);
});

test('nothing happens while listening, or with no marker', () => {
  const w = world();
  const c = w.make();
  assert.strictEqual(c.onReadback(APRS, { rigId: 'rig-1' }), 'none');
  c.begin({ ...HOME, listenHz: APRS }, () => {});
  w.events.length = 0;
  assert.strictEqual(c.onReadback(APRS, { rigId: 'rig-1', listening: true }), 'none');
  assert.deepStrictEqual(w.events, []);
});

test('another rig on the CAT link is never moved by this rig\'s marker', () => {
  const w = world();
  w.make().begin({ ...HOME, listenHz: APRS }, () => {});
  w.events.length = 0;
  assert.strictEqual(w.make().onReadback(APRS, { rigId: 'rig-2' }), 'other-rig');
  assert.deepStrictEqual(w.events, []);
  assert.ok(w.disk);
});

test('a return that never lands is tried three times, then given up (the marker is kept for the next start)', () => {
  const w = world();
  const c = w.make();
  c.begin({ ...HOME, listenHz: APRS }, () => {});
  c.end(APRS);
  const out = [];
  for (let i = 0; i < 5; i++) out.push(c.onReadback(APRS, { rigId: 'rig-1' }));
  assert.deepStrictEqual(out, ['returned', 'returned', 'returned', 'gave-up', 'gave-up']);
  assert.ok(w.disk);
});

test('listening again after a pause keeps the FIRST place (a resume never saves 144.390 as home)', () => {
  const w = world();
  const c = w.make();
  c.begin({ ...HOME, listenHz: APRS }, () => {});
  c.begin({ freqHz: APRS, mode: 'FM', rigId: 'rig-1', listenHz: APRS }, () => {});
  assert.strictEqual(w.disk.freqHz, 14074000);
  assert.strictEqual(w.disk.mode, 'DIGU');
  assert.strictEqual(w.disk.state, 'listening');
});

test('drop() forgets the marker without tuning (Winlink took the radio and owns the return)', () => {
  const w = world();
  const c = w.make();
  c.begin({ ...HOME, listenHz: APRS }, () => {});
  w.events.length = 0;
  c.drop();
  assert.deepStrictEqual(w.events, ['clear']);
});

test('stopped while the tune to APRS is still in flight (dial still home): the return is sent and the marker kept', () => {
  // Switch on, then off (or the window closed, or quit) inside the 4 s the
  // start waits for the readback: the dial still reads home, but the tune to
  // 144.390 is already on its way. Treating that as "moved by the operator"
  // cleared the marker and left the radio on 144.390 when the tune landed.
  const w = world();
  const c = w.make();
  c.begin({ ...HOME, listenHz: APRS }, () => {});
  w.events.length = 0;
  assert.strictEqual(c.end(HOME.freqHz), 'returned');
  assert.deepStrictEqual(w.events, ['save:returning', 'tune:14074000:DIGU']);
  assert.ok(w.disk, 'the marker stays until the radio confirms');
  // The late tune lands on 144.390: the next readback sends the radio home again.
  assert.strictEqual(c.onReadback(APRS, { rigId: 'rig-1' }), 'returned');
  assert.strictEqual(c.onReadback(HOME.freqHz, { rigId: 'rig-1' }), 'confirmed');
  assert.strictEqual(w.disk, null);
});

test('a marker with no frequency is never acted on', () => {
  const w = world();
  w.disk = { state: 'listening', freqHz: 0, mode: '', listenHz: APRS, rigId: 'rig-1' };
  assert.strictEqual(w.make().onReadback(APRS, { rigId: 'rig-1' }), 'left-alone');
  assert.strictEqual(w.disk, null);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
