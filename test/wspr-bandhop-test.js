#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';
// WSPR band-hop schedule regression. Run: node test/wspr-bandhop-test.js

const assert = require('assert');
const B = require('../lib/wspr/bandhop');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fail++; console.log(`FAIL  ${name}\n      ${e.message}`); }
}

const BANDS = ['40m', '20m', '15m'];

check('round-robins one band per slot', () => {
  assert.strictEqual(B.bandForSlot(0, BANDS), '40m');
  assert.strictEqual(B.bandForSlot(1, BANDS), '20m');
  assert.strictEqual(B.bandForSlot(2, BANDS), '15m');
  assert.strictEqual(B.bandForSlot(3, BANDS), '40m'); // wraps
  assert.strictEqual(B.bandForSlot(7, BANDS), '20m');
});

check('dwell holds each band for N cycles', () => {
  assert.strictEqual(B.bandForSlot(0, BANDS, 2), '40m');
  assert.strictEqual(B.bandForSlot(1, BANDS, 2), '40m'); // dwell 2
  assert.strictEqual(B.bandForSlot(2, BANDS, 2), '20m');
  assert.strictEqual(B.bandForSlot(3, BANDS, 2), '20m');
  assert.strictEqual(B.bandForSlot(4, BANDS, 2), '15m');
});

check('nextBand returns the following slot band', () => {
  assert.strictEqual(B.nextBand(0, BANDS), '20m');
  assert.strictEqual(B.nextBand(2, BANDS), '40m'); // wraps
});

check('bandChangesNext is true on hop, false within dwell', () => {
  assert.strictEqual(B.bandChangesNext(0, BANDS, 1), true);   // 40m -> 20m
  assert.strictEqual(B.bandChangesNext(0, BANDS, 2), false);  // 40m -> 40m (dwell)
  assert.strictEqual(B.bandChangesNext(1, BANDS, 2), true);   // 40m -> 20m
});

check('single band never changes', () => {
  assert.strictEqual(B.bandForSlot(5, ['20m']), '20m');
  assert.strictEqual(B.bandChangesNext(5, ['20m'], 1), false);
});

check('empty / null bands -> null', () => {
  assert.strictEqual(B.bandForSlot(3, []), null);
  assert.strictEqual(B.bandForSlot(3, null), null);
  assert.strictEqual(B.nextBand(3, []), null);
});

check('deterministic across "restart" (same slot -> same band)', () => {
  for (let s = 0; s < 50; s++) assert.strictEqual(B.bandForSlot(s, BANDS), B.bandForSlot(s, BANDS));
});

check('negative slot indices are safe', () => {
  assert.strictEqual(typeof B.bandForSlot(-1, BANDS), 'string');
  assert.ok(BANDS.includes(B.bandForSlot(-7, BANDS)));
});

// ---- #766: never hop while our own beacon transmits ---------------------
// The decode that drives the hop finishes about 15 s into the next slot. When
// that slot is ours to transmit, a hop retuned the radio mid-frame.
// runHop mirrors main.js maybeHopBand: tuneRadio only on a 'hop' decision.
function runHop(state, { slot, engine, scheduler, nowMs, currentBand, bands = ['40m', '20m'], dwell = 1 }) {
  const d = B.decideHop({
    slot, bands, dwell,
    txActive: !!(engine && engine._txActive),
    txSlot: !!(scheduler && scheduler.isTxSlot(nowMs)),
    pending: state.pending,
    currentBand,
  });
  state.pending = d.pending;
  if (d.action === 'hop') state.tuned.push(d.band);
  if (d.action === 'hold') state.held.push(d.reason);
  return d;
}
const fakeSched = (tx) => ({ isTxSlot: () => tx });
const newState = () => ({ pending: false, tuned: [], held: [] });

check('#766 engine transmitting: no tuneRadio call, hop held', () => {
  const st = newState();
  const d = runHop(st, { slot: 0, engine: { _txActive: true }, scheduler: fakeSched(false), currentBand: '40m' });
  assert.strictEqual(d.action, 'hold');
  assert.deepStrictEqual(st.tuned, []);
  assert.strictEqual(st.pending, true);
  assert.strictEqual(st.held[0], 'transmitting this slot');
});

check('#766 not transmitting, listen slot: hops as before', () => {
  const st = newState();
  const d = runHop(st, { slot: 0, engine: { _txActive: false }, scheduler: fakeSched(false), currentBand: '40m' });
  assert.strictEqual(d.action, 'hop');
  assert.deepStrictEqual(st.tuned, ['20m']);
  assert.strictEqual(st.pending, false);
});

check('#766 our TX slot decided but not keyed yet: held', () => {
  const st = newState();
  const d = runHop(st, { slot: 0, engine: { _txActive: false }, scheduler: fakeSched(true), currentBand: '40m' });
  assert.strictEqual(d.action, 'hold');
  assert.deepStrictEqual(st.tuned, []);
});

check('#766 held hop happens at the next eligible decode', () => {
  const st = newState();
  runHop(st, { slot: 0, engine: { _txActive: true }, scheduler: fakeSched(true), currentBand: '40m' });
  // Next decode, slot 1: still a TX slot (TX % over 50), so still held.
  runHop(st, { slot: 1, engine: { _txActive: true }, scheduler: fakeSched(true), currentBand: '40m' });
  assert.deepStrictEqual(st.tuned, []);
  // Slot 2 is a listen slot: the schedule wants 20m for slot 3; hop now.
  const d = runHop(st, { slot: 2, engine: { _txActive: false }, scheduler: fakeSched(false), currentBand: '40m' });
  assert.strictEqual(d.action, 'hop');
  assert.deepStrictEqual(st.tuned, ['20m']);
  assert.strictEqual(st.pending, false);
});

check('#766 held hop with dwell > 1 catches up where the schedule would stay', () => {
  // dwell 2 over 40m/20m: slots 0,1 = 40m, 2,3 = 20m. The hop due at slot 1 (to 20m)
  // is held; at slot 2 bandChangesNext is false, but the radio is still on 40m.
  const st = newState();
  runHop(st, { slot: 1, dwell: 2, engine: { _txActive: true }, scheduler: fakeSched(true), currentBand: '40m' });
  assert.deepStrictEqual(st.tuned, []);
  const d = runHop(st, { slot: 2, dwell: 2, engine: { _txActive: false }, scheduler: fakeSched(false), currentBand: '40m' });
  assert.strictEqual(d.action, 'hop');
  assert.deepStrictEqual(st.tuned, ['20m']);
});

check('#766 held hop drops when the radio is already on the band the schedule wants', () => {
  const st = newState();
  st.pending = true;
  const d = runHop(st, { slot: 2, dwell: 2, engine: { _txActive: false }, scheduler: fakeSched(false), currentBand: '20m' });
  assert.strictEqual(d.action, 'stay');
  assert.deepStrictEqual(st.tuned, []);
  assert.strictEqual(st.pending, false);
});

check('#766 dwell with nothing pending still stays put', () => {
  const st = newState();
  const d = runHop(st, { slot: 0, dwell: 2, engine: { _txActive: false }, scheduler: fakeSched(false), currentBand: '40m' });
  assert.strictEqual(d.action, 'stay');
  assert.deepStrictEqual(st.tuned, []);
});

console.log(`\nWSPR band-hop: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
