#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';
//
// WSPR beacon scheduler regression suite. Run: node test/wspr-scheduler-test.js
//
// Pure timing/decision logic — deterministic via an injected rng and explicit
// nowMs. Covers slot math, the TX% draw, per-slot single-fire, and PTT timing.

const assert = require('assert');
const S = require('../lib/wspr/scheduler');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fail++; console.log(`FAIL  ${name}\n      ${e.message}`); }
}

// A slot boundary on the 2-min grid. Epoch (0) is itself a slot start.
const SLOT = S.SLOT_MS; // 120000

// ---- slot math ---------------------------------------------------------
check('slotNumber / slotStartMs / msIntoSlot align to the 2-min grid', () => {
  assert.strictEqual(S.slotNumber(0), 0);
  assert.strictEqual(S.slotNumber(SLOT), 1);
  assert.strictEqual(S.slotNumber(SLOT + 5000), 1);
  assert.strictEqual(S.slotStartMs(SLOT + 5000), SLOT);
  assert.strictEqual(S.msIntoSlot(SLOT + 5000), 5000);
});

check('TX duration is 110.592 s and ends inside the 120 s slot', () => {
  assert.strictEqual(S.TX_DURATION_MS, 110592);
  assert.ok(S.PTT_LEAD_MS + S.TX_DURATION_MS < SLOT, 'TX runs past the slot!');
});

// ---- TX window timing --------------------------------------------------
check('txWindowForSlotStart: PTT on at +1s, off at +1s+110.592s', () => {
  const w = S.txWindowForSlotStart(10 * SLOT);
  assert.strictEqual(w.slotNumber, 10);
  assert.strictEqual(w.pttOnMs, 10 * SLOT + 1000);
  assert.strictEqual(w.pttOffMs, 10 * SLOT + 1000 + 110592);
});

check('nextTxWindow rolls to next slot once past the start window', () => {
  // Early in slot 3 -> this slot.
  let w = S.nextTxWindow(3 * SLOT + 500);
  assert.strictEqual(w.slotNumber, 3);
  // Past slot 3's PTT-lead -> slot 4.
  w = S.nextTxWindow(3 * SLOT + 1500);
  assert.strictEqual(w.slotNumber, 4);
  // Exactly at the boundary -> this slot.
  w = S.nextTxWindow(3 * SLOT);
  assert.strictEqual(w.slotNumber, 3);
});

// ---- TX% decision ------------------------------------------------------
check('shouldTransmitSlot honors 0% and 100% deterministically', () => {
  const never = () => { throw new Error('rng must not be called at 0/100%'); };
  assert.strictEqual(S.shouldTransmitSlot(0, never), false);
  assert.strictEqual(S.shouldTransmitSlot(100, never), true);
});

check('shouldTransmitSlot uses the rng threshold at intermediate %', () => {
  assert.strictEqual(S.shouldTransmitSlot(20, () => 0.10), true);  // 0.10 < 0.20
  assert.strictEqual(S.shouldTransmitSlot(20, () => 0.50), false); // 0.50 >= 0.20
  assert.strictEqual(S.shouldTransmitSlot(20, () => 0.20), false); // boundary, exclusive
});

check('TX% ~ long-run transmit fraction (statistical sanity)', () => {
  // Deterministic LCG so the test is reproducible.
  let seed = 12345;
  const rng = () => { seed = (1103515245 * seed + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  let tx = 0;
  const N = 10000;
  for (let i = 0; i < N; i++) if (S.shouldTransmitSlot(25, rng)) tx++;
  const frac = tx / N;
  assert.ok(frac > 0.22 && frac < 0.28, `25% TX gave ${(frac * 100).toFixed(1)}%`);
});

// ---- stateful scheduler ------------------------------------------------
check('disabled scheduler never fires', () => {
  const sch = new S.WsprScheduler({ txPct: 100 });
  assert.strictEqual(sch.tick(1000), null); // not enabled
});

check('100% scheduler fires once per slot, at slot start window only', () => {
  const sch = new S.WsprScheduler({ txPct: 100, dBm: 30 });
  sch.setEnabled(true);
  // Early in slot 5 -> fires.
  const plan = sch.tick(5 * SLOT + 200);
  assert.ok(plan, 'expected a TX plan');
  assert.strictEqual(plan.slotNumber, 5);
  assert.strictEqual(plan.pttOnMs, 5 * SLOT + 1000);
  assert.strictEqual(plan.pttOffMs, 5 * SLOT + 1000 + 110592);
  assert.strictEqual(plan.dBm, 30);
  assert.strictEqual(plan.leadMs, 800); // 1000 - 200
  // Second tick in the SAME slot -> no re-fire.
  assert.strictEqual(sch.tick(5 * SLOT + 400), null);
});

check('scheduler ignores ticks past the start window (missed slot)', () => {
  const sch = new S.WsprScheduler({ txPct: 100 });
  sch.setEnabled(true);
  // 3 s into the slot is past TX_LATEST_START_MS (2 s) -> no fire.
  assert.strictEqual(sch.tick(7 * SLOT + 3000), null);
  // Next slot, early -> fires.
  const plan = sch.tick(8 * SLOT + 100);
  assert.ok(plan && plan.slotNumber === 8);
});

check('listen slot (rng says no) does not fire; next TX slot does', () => {
  // rng alternates: first slot listen, draw >= threshold; force decisions.
  const draws = [0.9, 0.1]; let i = 0;
  const sch = new S.WsprScheduler({ txPct: 50, rng: () => draws[i++ % draws.length] });
  sch.setEnabled(true);
  assert.strictEqual(sch.tick(2 * SLOT + 100), null);       // 0.9 >= 0.5 -> listen
  const plan = sch.tick(3 * SLOT + 100);                    // 0.1 < 0.5 -> tx
  assert.ok(plan && plan.slotNumber === 3);
});

check('decideSlot draws exactly once per slot (idempotent)', () => {
  let calls = 0;
  const sch = new S.WsprScheduler({ txPct: 50, rng: () => { calls++; return 0.1; } });
  sch.setEnabled(true);
  sch.decideSlot(4 * SLOT + 100);
  sch.decideSlot(4 * SLOT + 50000); // same slot
  assert.strictEqual(calls, 1, `rng called ${calls} times in one slot`);
  sch.decideSlot(5 * SLOT + 100);   // new slot
  assert.strictEqual(calls, 2);
});

check('setEnabled(false) resets fire/decision latches', () => {
  const sch = new S.WsprScheduler({ txPct: 100 });
  sch.setEnabled(true);
  assert.ok(sch.tick(9 * SLOT + 100));   // fires slot 9
  assert.strictEqual(sch.tick(9 * SLOT + 200), null);
  sch.setEnabled(false);
  sch.setEnabled(true);
  // Re-enabled: same slot 9 can fire again (latch was reset).
  assert.ok(sch.tick(9 * SLOT + 300));
});

console.log(`\nWSPR scheduler: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
