#!/usr/bin/env node
'use strict';
// SSB-over-DATA keys only once the radio reports the DATA mode, and puts the
// voice mode back only after unkeying, confirmed (k8iko IC-7410: ~0.5 s off
// the start of every over; 9y4dg: left in DIGI LSB after a release).
// Run: node test/ptt-data-mode-order-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const S = require('../lib/ptt-mode-swap');

let pass = 0, fail = 0;
const queue = [];
function test(name, fn) { queue.push([name, fn]); }

function harness(reports) {
  // reports: [{ atMs, mode, data }] — what the radio says, and when.
  let now = 1000;
  const asks = [];
  const read = () => {
    let last = null;
    for (const r of reports) if (r.atMs <= now) last = { mode: r.mode, data: r.data, at: r.atMs };
    return last;
  };
  return {
    now: () => now, asks,
    o: { read, ask: () => asks.push(now), now: () => now, sleep: async (ms) => { now += ms; } },
  };
}

test('DATA names: USB-D, PKTUSB, DIGU, DATA-U are data; USB, LSB, FM are not', () => {
  for (const m of ['USB-D', 'LSB-D1', 'PKTUSB', 'PKTLSB', 'DIGU', 'DIGL', 'DATA-U', 'DIGFM']) assert.ok(S.isDataModeName(m), m);
  for (const m of ['USB', 'LSB', 'FM', 'AM', 'CW']) assert.ok(!S.isDataModeName(m), m);
});

test('the key-down waits for the radio to report DATA, then goes', async () => {
  const h = harness([{ atMs: 900, mode: 'USB', data: false }, { atMs: 1300, mode: 'USB-D', data: true }]);
  const r = await S.confirmMode({ ...h.o, since: 1000, accept: (_m, x) => !!x.data, timeoutMs: 1000, stepMs: 100 });
  assert.strictEqual(r.ok, true);
  assert.ok(r.waitedMs >= 300 && r.waitedMs < 400, 'keyed ' + r.waitedMs + ' ms after the swap');
  assert.ok(h.asks.length >= 2, 'it asked the radio');
});

test('a report from before the swap does not count', async () => {
  const h = harness([{ atMs: 500, mode: 'USB-D', data: true }]);
  const r = await S.confirmMode({ ...h.o, since: 1000, accept: (_m, x) => !!x.data, timeoutMs: 500, stepMs: 100 });
  assert.strictEqual(r.ok, false);
});

test('a radio that never confirms keys anyway after the timeout (the caller logs it)', async () => {
  const h = harness([{ atMs: 1100, mode: 'USB', data: false }]);
  const r = await S.confirmMode({ ...h.o, since: 1000, accept: (_m, x) => !!x.data, timeoutMs: 800, stepMs: 100 });
  assert.strictEqual(r.ok, false);
  assert.ok(r.waitedMs >= 800 && r.waitedMs < 1000);
  assert.strictEqual(r.mode, 'USB');
});

test('a release during the wait cancels the key-down', async () => {
  const h = harness([]);
  let released = false;
  setTimeout(() => {}, 0);
  const p = S.confirmMode({ ...h.o, since: 1000, accept: () => true, timeoutMs: 1000, stepMs: 100, cancelled: () => released });
  released = true;
  const r = await p;
  assert.strictEqual(r.cancelled, true);
});

test('the restore matches the voice mode itself, never its DATA form', () => {
  assert.ok(S.voiceModeMatches('LSB', 'LSB'));
  assert.ok(!S.voiceModeMatches('LSB', 'LSB-D'));
  assert.ok(!S.voiceModeMatches('LSB', 'PKTLSB'));
  assert.ok(!S.voiceModeMatches('LSB', 'USB'));
  assert.ok(S.voiceModeMatches('FM', 'FM'));
});

const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
test('main: an SSB-over-DATA key-down goes through the confirm, not straight to the radio', () => {
  const i = main.indexOf('function handleRemotePtt(state, opts = {}) {');
  const body = main.slice(i, main.indexOf('\nfunction _isEffectivelyTransmitting', i));
  assert.ok(/_dataSwapSince = Date\.now\(\);\n\s*\/\/ anchorNow/.test(body), 'the swap time is taken before the mode is sent');
  assert.ok(/if \(state && _dataSwapSince\) \{[\s\S]{0,400}pttKeyAfterDataMode\(_dataSwapSince/.test(body));
  assert.ok(!/setTimeout\(\(\) => \{ if \(cat && cat\.connected\) gatedSetTransmit\(state, pttEmission\); \}, _civPttDelayMs\)/.test(body), 'the old fixed 120 ms delay is gone');
});

test('main: on release the unkey goes out before the restore, and the restore is confirmed', () => {
  const i = main.indexOf('function handleRemotePtt(state, opts = {}) {');
  const body = main.slice(i, main.indexOf('\nfunction _isEffectivelyTransmitting', i));
  const unkey = body.indexOf('gatedSetTransmit(state, pttEmission);\n      }');
  const restore = body.indexOf('if (!state && _ssbModeBeforePtt) {');
  assert.ok(unkey > 0 && restore > unkey, 'unkey first');
  assert.ok(/pttConfirmRestore\(restoreMode, restoreFreq, _restoreIcom, restoreSince\)/.test(body));
});

test('codecs report the DATA flag read back from the radio (Icom 1A 06, Kenwood DA)', () => {
  const civ = fs.readFileSync(path.join(__dirname, '..', 'lib', 'codecs', 'civ-codec.js'), 'utf8');
  const kw = fs.readFileSync(path.join(__dirname, '..', 'lib', 'codecs', 'kenwood-codec.js'), 'utf8');
  assert.ok(/this\._dataReportAt = Date\.now\(\);/.test(civ) && /askDataState\(\)/.test(civ));
  assert.ok(/this\._dataReportAt = Date\.now\(\);/.test(kw) && /askDataState\(\)/.test(kw));
});

test('a normal Icom keys at its 120 ms minimum, not on the next 100 ms step', async () => {
  // The radio answers 1A 06 about 30 ms after it is asked.
  const h = harness([{ atMs: 1030, mode: 'USB', data: true }]);
  const r = await S.confirmMode({ ...h.o, since: 1000, accept: (_m, x) => !!x.data, timeoutMs: 800, stepMs: 25, askEveryMs: 100, minWaitMs: 120 });
  assert.strictEqual(r.ok, true);
  assert.ok(r.waitedMs >= 120 && r.waitedMs <= 140, 'keyed ' + r.waitedMs + ' ms after the swap');
});

test('the fast read loop asks the radio only every askEveryMs', async () => {
  const h = harness([]);
  await S.confirmMode({ ...h.o, since: 1000, accept: () => false, timeoutMs: 800, stepMs: 25, askEveryMs: 100 });
  assert.ok(h.asks.length >= 8 && h.asks.length <= 9, h.asks.length + ' asks in 800 ms');
});

test('main: the key-down confirm reads every 25 ms and asks every 100 ms', () => {
  assert.ok(/const PTT_DATA_CONFIRM_STEP_MS = 25;/.test(main));
  assert.ok(/stepMs: PTT_DATA_CONFIRM_STEP_MS, askEveryMs: PTT_DATA_CONFIRM_ASK_MS/.test(main));
});

test('main: SSTV starts its audio after PTT really went out, not on a fixed 200 ms', () => {
  const i = main.indexOf("emission: 'SSTV', txKind: 'sstv'");
  const body = main.slice(i, i + 9000);
  assert.ok(/_pttKeyPending = pending;/.test(main), 'a waiting key-down is recorded');
  assert.ok(/const _sstvStartAudio = \(fn\) => pttKeyGate\(\)\.then\(\(keyed\) => \{/.test(body));
  assert.ok(/Math\.max\(delay - \(Date\.now\(\) - _sstvKeyCalledAt\), SSTV_AUDIO_AFTER_KEY_MS\)/.test(body));
  assert.ok(/_sstvStartAudio\(\(\) => \{/.test(body));
  assert.ok(!/\n      \}, delay\);/.test(body), 'no fixed setTimeout(..., delay) left');
});

(async () => {
  for (const [name, fn] of queue) {
    try { await fn(); pass++; console.log('  ok  ' + name); }
    catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
  }
  console.log(`\nPTT data-mode order: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
