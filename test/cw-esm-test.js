#!/usr/bin/env node
'use strict';
// #741 Enter Sends Message: the state machine (lib/cw-esm.js).
// Run: node test/cw-esm-test.js
const assert = require('assert');
const E = require('../lib/cw-esm');
const B = require('../lib/cw-banks');
let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push([name, fn]); }

const RUN = B.defaultsFor('run');
const SP = B.defaultsFor('sp');

// A fake logger: records what was keyed, logged and cancelled, in order.
function rig({ bank = RUN, logOk = true, logDelayMs = 0, ctx = {} } = {}) {
  const events = [];
  const io = {
    bank: () => bank,
    expand: (t, c) => B.expandVars(t, Object.assign({ myState: 'PA', park: 'US-1234' }, ctx, c)),
    log: async () => {
      events.push('log');
      if (logDelayMs) await new Promise((r) => setTimeout(r, logDelayMs));
      if (logOk instanceof Error) throw logOk;
      return logOk;
    },
    send: (t) => events.push('send:' + t),
    cancel: () => events.push('cancel'),
  };
  io.events = events;
  return io;
}

test('the gate: only with ESM on, in CW, from the call field', () => {
  assert.strictEqual(E.active({ enabled: true, mode: 'CW', field: 'call' }), true);
  assert.strictEqual(E.active({ enabled: true, mode: 'CWR', field: 'call' }), true);
  assert.strictEqual(E.active({ enabled: true, mode: 'CW-R', field: 'call' }), true);
  assert.strictEqual(E.active({ enabled: false, mode: 'CW', field: 'call' }), false, 'ESM off');
  assert.strictEqual(E.active({ mode: 'CW', field: 'call' }), false, 'ESM unset = off by default');
  assert.strictEqual(E.active({ enabled: 'true', mode: 'CW', field: 'call' }), false, 'only a real true turns it on');
  for (const m of ['SSB', 'USB', 'FM', 'FT8', 'RTTY', '', undefined]) {
    assert.strictEqual(E.active({ enabled: true, mode: m, field: 'call' }), false, 'mode ' + m);
  }
  for (const f of ['rst-sent', 'rst-rcvd', 'state', 'p2p', 'freq', 'notes', '', undefined]) {
    assert.strictEqual(E.active({ enabled: true, mode: 'CW', field: f }), false, 'field ' + f);
  }
});

test('Run: empty call sends CQ, again and again, and never logs', async () => {
  const s = E.createSession('run');
  const io = rig();
  assert.strictEqual(s.cue(''), 'CQ');
  await s.enter({ call: '' }, io);
  await s.enter({ call: '  ' }, io);
  assert.deepStrictEqual(io.events, ['send:CQ POTA DE {MYCALL} {MYCALL} K', 'send:CQ POTA DE {MYCALL} {MYCALL} K']);
});

test('Run: call typed sends their call + exchange (F5 + F2); Enter again logs, then TU (F3)', async () => {
  const s = E.createSession('run');
  const io = rig();
  assert.strictEqual(s.cue('w1aw'), 'EXCH');
  const r1 = await s.enter({ call: 'w1aw' }, io);
  assert.strictEqual(r1.sent, 'W1AW 5NN PA');
  assert.strictEqual(s.cue('W1AW'), 'TU+LOG');
  const r2 = await s.enter({ call: 'W1AW' }, io);
  assert.strictEqual(r2.logged, true);
  assert.deepStrictEqual(io.events, ['send:W1AW 5NN PA', 'log', 'send:TU 73 {MYCALL}']);
  assert.strictEqual(s.cue(''), 'CQ', 'back to CQ after the contact');
});

test('Run: a park-to-park contact sends F7 (5NN + state + my park) in place of F2', async () => {
  const s = E.createSession('run');
  const io = rig();
  await s.enter({ call: 'K3SBP', p2p: true }, io);
  assert.deepStrictEqual(io.events, ['send:K3SBP 5NN PA US-1234']);
});

test('Run: a call corrected after the exchange logs, then sends the corrected call + TU', async () => {
  const s = E.createSession('run');
  const io = rig();
  await s.enter({ call: 'W1AX' }, io);
  await s.enter({ call: 'W1AW' }, io);
  assert.deepStrictEqual(io.events, ['send:W1AX 5NN PA', 'log', 'send:W1AW TU 73 {MYCALL}']);
});

test('Run: a partial call sends what is typed + AGN and never logs', async () => {
  const s = E.createSession('run');
  const io = rig();
  await s.enter({ call: 'W1?' }, io);
  await s.enter({ call: '?' }, io);
  await s.enter({ call: 'W1' }, io);
  assert.deepStrictEqual(io.events, ['send:W1? AGN?', 'send:AGN?', 'send:W1 AGN?']);
  assert.ok(!io.events.includes('log'));
});

test('S&P: empty call sends nothing and asks for the call', async () => {
  const s = E.createSession('sp');
  const io = rig({ bank: SP });
  const r = await s.enter({ call: '' }, io);
  assert.strictEqual(r.focus, 'call');
  assert.deepStrictEqual(io.events, []);
});

test('S&P: my call (F4), then log and my exchange (F2)', async () => {
  const s = E.createSession('sp');
  const io = rig({ bank: SP, ctx: { myState: 'VA' } });
  assert.strictEqual(s.cue('N1MM'), 'MYCALL');
  await s.enter({ call: 'N1MM' }, io);
  assert.strictEqual(s.cue('N1MM'), 'EXCH+LOG');
  const r = await s.enter({ call: 'N1MM' }, io);
  assert.strictEqual(r.logged, true);
  assert.deepStrictEqual(io.events, ['send:{MYCALL}', 'log', 'send:5NN VA']);
  assert.strictEqual(s.cue('K1ABC'), 'MYCALL', 'a new contact starts over');
});

test('S&P: a call still partial at the exchange asks AGN and does not log', async () => {
  const s = E.createSession('sp');
  const io = rig({ bank: SP });
  await s.enter({ call: 'N1?' }, io);
  await s.enter({ call: 'N1?' }, io);
  assert.deepStrictEqual(io.events, ['send:{MYCALL}', 'send:AGN?']);
});

test('a failed log sends no TU, keeps the state, and Enter again retries the log', async () => {
  const s = E.createSession('run');
  const io = rig({ logOk: false });
  await s.enter({ call: 'W1AW' }, io);
  const r = await s.enter({ call: 'W1AW' }, io);
  assert.strictEqual(r.logged, false);
  assert.deepStrictEqual(io.events, ['send:W1AW 5NN PA', 'log']);
  assert.strictEqual(s.cue('W1AW'), 'TU+LOG');
  const io2 = rig({ logOk: new Error('disk full') });
  await s.enter({ call: 'W1AW' }, io2);
  assert.deepStrictEqual(io2.events, ['log'], 'a throwing log sends nothing either');
  const sp = E.createSession('sp');
  const io3 = rig({ bank: SP, logOk: 'yes' });
  await sp.enter({ call: 'N1MM' }, io3);
  await sp.enter({ call: 'N1MM' }, io3);
  assert.deepStrictEqual(io3.events, ['send:{MYCALL}', 'log'], 'S&P: anything but true is a failed log, no exchange');
});

test('never logs twice: Enter while the log is saving is ignored', async () => {
  const s = E.createSession('run');
  const io = rig({ logDelayMs: 30 });
  await s.enter({ call: 'W1AW' }, io);
  const a = s.enter({ call: 'W1AW' }, io);
  const b = await s.enter({ call: 'W1AW' }, io);
  await a;
  assert.strictEqual(b.ignored, true);
  assert.deepStrictEqual(io.events, ['send:W1AW 5NN PA', 'log', 'send:TU 73 {MYCALL}']);
});

test('Esc aborts through the one cancel path, at once', async () => {
  const s = E.createSession('run');
  const io = rig();
  await s.enter({ call: '' }, io);
  s.abort(io);
  assert.deepStrictEqual(io.events, ['send:CQ POTA DE {MYCALL} {MYCALL} K', 'cancel']);
  const throwing = { cancel: () => { throw new Error('x'); } };
  s.abort(throwing); // never throws into the key handler
});

test('an empty key sends nothing (never half a message)', async () => {
  const bank = B.defaultsFor('run');
  bank[1] = { label: 'EXCH', text: '' };
  const s = E.createSession('run');
  const io = rig({ bank });
  let missing = null;
  io.onMissing = (m) => { missing = m; };
  const r = await s.enter({ call: 'W1AW' }, io);
  assert.deepStrictEqual(r.missing, ['EXCH']);
  assert.deepStrictEqual(missing, ['EXCH']);
  assert.deepStrictEqual(io.events, []);
  assert.strictEqual(s.cue('W1AW'), 'EXCH', 'state did not move');
});

test('call shape: complete calls and comma lists', () => {
  for (const c of ['W1AW', 'K3SBP', 'VE3/K3SBP', 'K3SBP/P', 'G4BFG', '2E0ABC', 'K3SBP, W1AW', '9A1A']) assert.ok(E.isCompleteCall(c), c);
  for (const c of ['', 'W1', 'W1?', '?', 'ABC', '123', 'K3SBP,', 'K3SBP,W?']) assert.ok(!E.isCompleteCall(c), c);
});

(async () => {
  for (const [name, fn] of queue) {
    try { await fn(); passed++; console.log('  ok  ' + name); }
    catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
  }
  console.log(`\nCW Enter Sends Message: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
