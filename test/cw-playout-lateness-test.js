'use strict';
// #244 diagnostic (2026-11-17): the paddle playout measures how late each key
// edge fires and logs one summary line per over. Measuring only: the edges
// must key at exactly the times they keyed before the measuring code.
const assert = require('assert');
const { test } = require('node:test');
const { CwKeyPlayout, formatPlayoutSummary } = require('../lib/cw-key-playout');

// A fake clock whose timers can fire late: lag(due) is added to a timer due
// at that time, the way a busy main process or Windows timer granularity would.
function lateClock(lag) {
  let now = 1000;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { due: now + Math.max(0, ms), fn, id }); return id; },
    clearTimer: (id) => { timers.delete(id); },
    advance(ms) {
      const target = now + ms;
      for (;;) {
        let next = null;
        for (const t of timers.values()) {
          if (t.due <= target && (!next || t.due < next.due || (t.due === next.due && t.id < next.id))) next = t;
        }
        if (!next) break;
        timers.delete(next.id);
        now = Math.max(now, next.due + (lag ? lag(next.due) : 0));
        next.fn();
      }
      now = Math.max(now, target);
    },
  };
}

// The playout with the measuring hooks switched off: what it did before.
class UnmeasuredPlayout extends CwKeyPlayout {
  _noteEdgeFired() {}
  _flushOver() {}
}

// "CQ" at 20 WPM (60 ms dit) from a page keyer, arriving with network jitter,
// then a pause, then "K" as a second over.
function runOver(Cls, lag) {
  const clk = lateClock(lag);
  const edges = [];
  const logs = [];
  const p = new Cls({ output: (e) => edges.push([e.down, e.timestamp]), now: clk.now, setTimer: clk.setTimer, clearTimer: clk.clearTimer, bufferMs: 120, log: (l) => logs.push(l) });
  const d = 60;
  // C = -.-.  Q = --.-  (client times, element lengths)
  const els = [
    [0, 3 * d], [4 * d, d], [6 * d, 3 * d], [10 * d, d],
    [14 * d, 3 * d], [18 * d, 3 * d], [22 * d, d], [24 * d, 3 * d],
  ];
  const jitter = [0, 30, 5, 80, 10, 0, 45, 20];
  for (let i = 0; i < els.length; i++) {
    const arrive = 1000 + els[i][0] + jitter[i];
    clk.advance(Math.max(0, arrive - clk.now()));
    p.push({ at: 500_000 + els[i][0], down: true, ms: els[i][1] });
  }
  clk.advance(4000);
  // K = -.-
  const k = [[0, 3 * d], [4 * d, d], [6 * d, 3 * d]];
  for (let i = 0; i < k.length; i++) {
    p.push({ at: 600_000 + k[i][0], down: true, ms: k[i][1] });
    clk.advance(k[i + 1] ? k[i + 1][0] - k[i][0] : 0);
  }
  clk.advance(4000);
  return { edges, logs, p };
}

const LAG = (due) => [0, 3, 12, 1, 0, 25, 2, 0, 15, 4][Math.floor(due / 7) % 10];

test('measuring changes no edge: same keying with and without it, on time and with late timers', () => {
  for (const lag of [null, LAG]) {
    const measured = runOver(CwKeyPlayout, lag).edges;
    const plain = runOver(UnmeasuredPlayout, lag).edges;
    assert.deepStrictEqual(measured, plain);
    assert.strictEqual(measured.length, 22, '11 elements, 22 edges');
  }
});

test('edges key at the scheduled times the playout had before this diagnostic', () => {
  // Recorded from the playout on origin/master (before #244's diagnostic), no timer lag.
  const expected = [
    [true, 1120], [false, 1300], [true, 1360], [false, 1420], [true, 1480], [false, 1660],
    [true, 1720], [false, 1780], [true, 1960], [false, 2140], [true, 2200], [false, 2380],
    [true, 2440], [false, 2500], [true, 2560], [false, 2740],
    [true, 6580], [false, 6760], [true, 6820], [false, 6880], [true, 6940], [false, 7120],
  ];
  assert.deepStrictEqual(runOver(CwKeyPlayout, null).edges, expected);
});

test('one summary line per over, after the key goes idle, with the measured lateness', () => {
  const late = runOver(CwKeyPlayout, LAG);
  const onTime = runOver(CwKeyPlayout, null);
  const lines = late.logs.filter((l) => /paddle playout, last over/.test(l));
  assert.strictEqual(lines.length, 2, late.logs.join(' | '));
  // Lateness seen from outside: each edge's time with lag minus its time without.
  const diffs = late.edges.map((e, i) => e[1] - onTime.edges[i][1]);
  assert.ok(diffs.some((v) => v > 10), 'the lag makes some edges more than 10 ms late');
  assert.strictEqual(lines[0], formatPlayoutSummary(diffs.slice(0, 16), []));
  assert.strictEqual(lines[1], formatPlayoutSummary(diffs.slice(16), []));
  assert.match(lines[0], /^\[CW\] paddle playout, last over: 16 edges, late median \d+ ms, max \d+ ms, \d+ over 10 ms$/);
  assert.match(lines[1], /^\[CW\] paddle playout, last over: 6 edges, /);
  const onTimeLines = onTime.logs.filter((l) => /paddle playout/.test(l));
  assert.deepStrictEqual(onTimeLines, [
    '[CW] paddle playout, last over: 16 edges, late median 0 ms, max 0 ms, 0 over 10 ms',
    '[CW] paddle playout, last over: 6 edges, late median 0 ms, max 0 ms, 0 over 10 ms',
  ]);
});

test('summary line: median, max, count over 10 ms, and the key-line set times when there are any', () => {
  assert.strictEqual(
    formatPlayoutSummary([1, 0, 1, 23, 11, 1, 12], []),
    '[CW] paddle playout, last over: 7 edges, late median 1 ms, max 23 ms, 3 over 10 ms');
  assert.strictEqual(
    formatPlayoutSummary([0, 4, 10, 2], [1, 3, 2, 9]),
    '[CW] paddle playout, last over: 4 edges, late median 3 ms, max 10 ms, 0 over 10 ms; key line set median 3 ms, max 9 ms');
});

test('key-line set times join the over they happen in, and are ignored outside one', () => {
  const clk = lateClock(null);
  const logs = [];
  const p = new CwKeyPlayout({ output: () => {}, now: clk.now, setTimer: clk.setTimer, clearTimer: clk.clearTimer, bufferMs: 120, log: (l) => logs.push(l) });
  p.noteLineSetMs(50); // no over yet (the local keyer shares the key port)
  p.push({ at: 0, down: true, ms: 60 });
  clk.advance(130);
  p.noteLineSetMs(2);
  clk.advance(60);
  p.noteLineSetMs(4);
  clk.advance(3000);
  assert.deepStrictEqual(logs, ['[CW] paddle playout, last over: 2 edges, late median 0 ms, max 0 ms, 0 over 10 ms; key line set median 3 ms, max 4 ms']);
});

test('stop() reports the over at once', () => {
  const clk = lateClock(null);
  const logs = [];
  const p = new CwKeyPlayout({ output: () => {}, now: clk.now, setTimer: clk.setTimer, clearTimer: clk.clearTimer, bufferMs: 100, log: (l) => logs.push(l) });
  p.push({ at: 0, down: true, ms: 60 });
  p.push({ at: 120, down: true, ms: 60 });
  clk.advance(110);
  p.stop();
  assert.strictEqual(logs.length, 1, logs.join(' | '));
  assert.match(logs[0], /last over: 1 edges/);
});
