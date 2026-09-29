#!/usr/bin/env node
'use strict';
// AB1EX (FT-710, 1.10.24/25), 2026-09-27: "Auto sequencing repeats or hangs
// in an unpredictable fashion ... repeating last message vs moving on", and
// "ignoring FT8 no reply attempt limit"; 1.10.13 was fine. His log: the
// decode of each reply came back 1-1.5 s AFTER the next transmission had
// started (the multi-pass decoder, #87, is several times slower on his PC),
// so every step went out once more with the old message, and the retry
// counter compared the clock at arrival with the TX it had just stamped,
// called every stall "reply still pending", and never counted a try.
//   1. While transmitting, the FT8 decode gets a time budget that ends
//      before the next slot; out of time it keeps the one-pass results.
//   2. A decode carries the start of the slot its audio came from, and the
//      retry counter uses that, never the clock at arrival.
// Run: node test/ft8-decode-deadline-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { Ft8Engine } = require('../lib/ft8-engine');
const sm = require('../lib/jtcat-state-machine');

let pass = 0, fail = 0, skip = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
const ROOT = path.join(__dirname, '..');
const ADDON = path.join(ROOT, 'lib', 'ft8_native', 'build', 'Release', 'ft8_native.node');
const MAIN = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const WORKER = fs.readFileSync(path.join(ROOT, 'lib', 'ft8-worker.js'), 'utf8');

console.log('FT8 decode deadline');

test('no budget while only listening (a listener loses nothing by waiting)', () => {
  const e = new Ft8Engine();
  e._txEnabled = false; e._txMessage = '';
  assert.strictEqual(e._decodeBudgetMs(14200, 15000), 0);
  e._txEnabled = true; e._txMessage = '';
  assert.strictEqual(e._decodeBudgetMs(14200, 15000), 0, 'TX enabled with nothing to send');
});

test('in a QSO the budget ends before the next slot, leaving room for the reply', () => {
  const e = new Ft8Engine();
  e._txEnabled = true; e._txMessage = 'K5MGY AB1EX R-08';
  const b = e._decodeBudgetMs(1_000_000_000 * 15 + 14200, 15000); // 800 ms before the boundary
  assert.ok(b > 300 && b < 800, `budget ${b} ms`);
  assert.strictEqual(e._decodeBudgetMs(15000 * 7 + 14950, 15000), 100, 'never below the floor');
  assert.strictEqual(e._decodeBudgetMs(15000 * 7 + 300, 15000), 100, 'already past the boundary: floor');
});

test('a decode that lands in the next slot still names the slot its audio came from', () => {
  const e = new Ft8Engine();
  const slotStart = Math.floor(Date.now() / 15000) * 15000 - 15000; // the previous slot
  e._decodeJobSlots.set(7, 'even');
  e._decodeJobPeriods.set(7, slotStart);
  let got = null;
  e.on('decode', (d) => { got = d; });
  e._onWorkerMessage({ type: 'decode-result', id: 7, results: [{ text: 'AB1EX K5MGY -01', db: -1, dt: 0.1, df: 1100 }], stats: { ms: 1900, passes: 3, outOfTime: false } });
  assert.ok(got, 'no decode event');
  assert.strictEqual(got.periodStartMs, slotStart);
  assert.strictEqual(got.slot, 'even');
});

test('a late decode is said in the log while transmitting', () => {
  const e = new Ft8Engine();
  e._mode = 'FT8'; e._txEnabled = true; e._txMessage = 'K5MGY AB1EX R-08';
  const logs = [];
  e.on('log', (m) => logs.push(m));
  e._decodeJobSlots.set(9, 'even');
  e._decodeJobPeriods.set(9, Math.floor(Date.now() / 15000) * 15000 - 15000);
  e._onWorkerMessage({ type: 'decode-result', id: 9, results: [], stats: { ms: 2100, passes: 3, outOfTime: false } });
  assert.ok(logs.some((m) => /into the next slot/.test(m) && /2100 ms/.test(m)), logs.join(' | '));
});

// The retry counter's view of AB1EX's QSO: TX in odd slots, decode of each
// even slot arriving either before (fast PC) or after (his PC) the next TX.
function countTries(late, periods) {
  const key = (p) => 'P' + p;
  let txPk = '', counted = '', tries = 0;
  for (let p = 1; p <= periods; p++) {
    if (p % 2 === 1) {
      // Our TX in odd period p. On the fast path the decode of p-1 arrived
      // before it; on the late path it arrives just after it was stamped.
      if (late && p > 1) {
        txPk = key(p);
        if (sm.shouldCountRetry({ periodKey: key(p - 1), txPeriodKey: txPk, lastCountedTxPeriod: counted })) { counted = txPk; tries++; }
      } else {
        txPk = key(p);
      }
    } else if (!late) {
      if (sm.shouldCountRetry({ periodKey: key(p), txPeriodKey: txPk, lastCountedTxPeriod: counted })) { counted = txPk; tries++; }
    }
    // Decode of our own TX period (odd): same key as the TX, never a try.
    if (p % 2 === 1 && sm.shouldCountRetry({ periodKey: key(p), txPeriodKey: txPk, lastCountedTxPeriod: counted })) {
      counted = txPk; tries++;
    }
  }
  return tries;
}

test('tries count once per transmission whether the decode is early or late', () => {
  // Five transmissions (periods 1,3,5,7,9) and the four reply windows after
  // the first four have been listened to by period 9.
  assert.strictEqual(countTries(false, 9), 4, 'fast PC');
  assert.strictEqual(countTries(true, 9), 4, 'decode after the next TX started');
  // What 1.10.24 did: the clock at arrival names the TX just stamped.
  let tries = 0;
  for (let p = 3; p <= 9; p += 2) if (sm.shouldCountRetry({ periodKey: 'P' + p, txPeriodKey: 'P' + p, lastCountedTxPeriod: '' })) tries++;
  assert.strictEqual(tries, 0, 'the arrival-clock key can never count a late decode');
});

test('main counts tries by the decoded slot at every call site (source guard)', () => {
  assert.ok(/function jtcatPeriodUtc\(mode, atMs\)/.test(MAIN), 'jtcatPeriodUtc must take the period time');
  assert.ok(/const pk = jtcatPeriodUtc\(o\.mode, o\.periodStartMs\)/.test(MAIN), 'jtcatHandleRetryStall must use the decode period');
  const calls = MAIN.split('jtcatHandleRetryStall({').slice(1);
  assert.strictEqual(calls.length, 4, 'four decode paths');
  for (const c of calls) assert.ok(/periodStartMs: data\.periodStartMs/.test(c.slice(0, 200)), 'a call site does not pass periodStartMs');
});

test('the worker hands the budget to the native decoder (source guard)', () => {
  assert.ok(/nativeDecode\(samples, 'FT8', msg\.myCall \|\| '', msg\.dxCall \|\| '', msg\.budgetMs \|\| 0\)/.test(WORKER));
  assert.ok(/results, stats \}/.test(WORKER), 'decode stats must reach the engine');
});

if (!fs.existsSync(ADDON)) {
  skip++;
  console.log('  skip native budget checks (addon not built: npm run build-ft8)');
} else {
  const n = require(ADDON);
  // A busy synthetic slot: 25 signals in noise.
  let s = 0x2545f491;
  const rnd = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) + 0.5) / 4294967296;
  };
  const gauss = () => Math.sqrt(-2 * Math.log(rnd())) * Math.cos(2 * Math.PI * rnd());
  const x = new Float32Array(180000);
  for (let i = 0; i < x.length; i++) x[i] = 0.3 * gauss();
  const calls = ['K1ABC', 'W9XYZ', 'N0AAA', 'K5MGY', 'AC0ZO', 'W1AW', 'K3SBP', 'N3FMC', 'KQ4VUU', 'KW4FM', 'LZ3AW', 'OH7DSQ', 'W4MPT'];
  for (let k = 0; k < 25; k++) {
    const text = `${calls[k % calls.length]} ${calls[(k + 5) % calls.length]} ${['FN20', 'EM64', 'EN37', 'DM79', 'FN42'][k % 5]}`;
    const w = n.encode(text, 300 + k * 95, 'FT8');
    const g = 0.02 + 0.05 * rnd();
    const off = 6000 + Math.floor(rnd() * 3000);
    for (let i = 0; i < w.length && off + i < x.length; i++) x[off + i] += g * w[i];
  }
  const full = n.decode(x, 'FT8', '', '', 0);
  const cut = n.decode(x, 'FT8', '', '', 1);

  test('unlimited: all passes, never out of time, reports its time', () => {
    assert.strictEqual(full.outOfTime, false);
    assert.ok(full.passes >= 1 && full.passes <= 3, `passes ${full.passes}`);
    assert.ok(typeof full.ms === 'number' && full.ms >= 0);
  });

  test('out of time: one pass, still the one-pass decodes, and faster', () => {
    assert.strictEqual(cut.outOfTime, true);
    assert.strictEqual(cut.passes, 1);
    assert.ok(cut.length >= Math.floor(full.length * 0.6), `${cut.length} of ${full.length} decodes kept`);
    const fullTexts = new Set(full.map((r) => r.text));
    for (const r of cut) assert.ok(fullTexts.has(r.text), `budgeted decode "${r.text}" not in the full decode`);
    assert.ok(cut.ms <= full.ms + 5, `budgeted ${cut.ms.toFixed(0)} ms vs full ${full.ms.toFixed(0)} ms`);
  });

  test('a signal-free slot stays empty under a budget', () => {
    const q = new Float32Array(180000);
    for (let i = 0; i < q.length; i++) q[i] = 0.3 * gauss();
    assert.strictEqual(n.decode(q, 'FT8', 'AB1EX', 'K5MGY', 1).length, 0);
  });
}

console.log(`\nFT8 decode deadline: ${pass} passed, ${fail} failed${skip ? `, ${skip} skipped` : ''}`);
process.exit(fail ? 1 : 0);
