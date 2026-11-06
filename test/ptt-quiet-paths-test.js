#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
// Transmit-safety review, medium items on main's PTT path:
//  5. A radio that cannot report its DATA state waited 800 ms on every over
//     ("keying anyway"), so a Winlink/Mercury frame already playing lost its
//     head. Skipped when the codec latched the read off; after one timeout on
//     a link, later overs key at the bus-gap minimum.
//  6. A hand-mic over logged a WARNING every time. One informational line per
//     session unless a line POTACAT holds is HIGH.
//  7. The voice-TX hint (0 W, set SSB MOD SOURCE) opened for a naked PTT with
//     no audio of ours, telling a hand-mic user to change a menu.
// Run: node test/ptt-quiet-paths-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
const queue = [];
function test(name, fn) { queue.push([name, fn]); }
const main = readSrc(path.join(__dirname, '..', 'main.js')).replace(/\r\n/g, '\n');
const slice = (a, b) => main.slice(main.indexOf(a), main.indexOf(b, main.indexOf(a)));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function loadKey(cat) {
  const keys = [];
  const logs = [];
  const ctx = {
    cat, setTimeout, Promise, Date, keys, logs, _pttKeySeq: 1,
    sendCatLog: (l) => logs.push(l),
    gatedSetTransmit: (on) => keys.push(on),
    pttModeReport: () => null, pttAskMode: () => {},
    PttModeSwap: { confirmMode: ({ timeoutMs }) => new Promise((r) => setTimeout(() => r({ ok: false, waitedMs: timeoutMs }), 30)) },
    PTT_DATA_CONFIRM_MS: 800, PTT_DATA_CONFIRM_STEP_MS: 25, PTT_DATA_CONFIRM_ASK_MS: 100,
  };
  vm.createContext(ctx);
  vm.runInContext(slice('let _pttDataNoConfirmCat = null;', '/** After a release: confirm the voice mode came back')
    + '\nthis.key = pttKeyAfterDataMode; this.confirmable = pttDataConfirmable;', ctx);
  return ctx;
}

test('an Icom whose DATA read is latched off keys at the bus-gap minimum, without the 800 ms confirm', async () => {
  const ctx = loadKey({ connected: true, _codec: { _dataModeUnsupported: true } });
  const t0 = Date.now();
  assert.strictEqual(await ctx.key(t0, 20, 'DATA'), true);
  assert.deepStrictEqual(ctx.keys, [true]);
  assert.ok(!ctx.logs.some((l) => /keying anyway/.test(l)), 'no timeout line');
});

test('after one timeout on a link, later overs there key without waiting', async () => {
  const cat = { connected: true, _codec: {} };
  const ctx = loadKey(cat);
  assert.strictEqual(ctx.confirmable(), true);
  await ctx.key(Date.now(), 20, 'DATA');                       // the first over times out
  assert.ok(ctx.logs.some((l) => /keying anyway\. Later overs on this connection key without waiting/.test(l)));
  assert.strictEqual(ctx.confirmable(), false);
  const before = ctx.logs.length;
  await ctx.key(Date.now(), 20, 'DATA');
  assert.strictEqual(ctx.logs.length, before, 'the second over says nothing and does not wait');
  assert.deepStrictEqual(ctx.keys, [true, true]);
});

function loadNote(lines) {
  const logs = [];
  const controller = { _transport: { _lastPinState: lines } };
  const ctx = {
    cat: controller, logs, Date, Math,
    sendCatLog: (l) => logs.push(l),
    _isEffectivelyTransmitting: () => false, _externalAtuActive: false, _stationSetupTxTest: false, _stationSetupTxBusy: false, _atuTuneEpisode: null,
    pttRouteLabel: () => 'CAT', _currentMode: 'USB', _currentFreqHz: 14200000,
    TxLimitLib: require('../lib/tx-limit'),
  };
  vm.createContext(ctx);
  vm.runInContext(slice('let _txUnsolicitedSince = 0;', '// --- SSB-over-DATA: key only once') + '\nthis.note = txNoteRadioPtt;', ctx);
  return { ctx, controller, logs };
}

test('hand-mic overs with the lines low: one plain line per session, no WARNING', () => {
  const { ctx, controller, logs } = loadNote({ dtr: false, rts: false });
  for (let i = 0; i < 3; i++) { ctx.note(controller, true); ctx.note(controller, false); }
  assert.ok(!logs.some((l) => /WARNING/.test(l)), logs.join('\n'));
  assert.strictEqual(logs.filter((l) => /transmitted without POTACAT keying it/.test(l)).length, 1);
});

test('a line POTACAT holds is HIGH: the WARNING with the line states, every over', () => {
  const { ctx, controller, logs } = loadNote({ dtr: false, rts: true });
  ctx.note(controller, true); ctx.note(controller, false);
  ctx.note(controller, true);
  assert.strictEqual(logs.filter((l) => /\[TX\] WARNING: the radio reports TRANSMIT/.test(l) && /RTS HIGH/.test(l)).length, 2);
});

test('the voice hint is armed only when POTACAT sends the audio', () => {
  const ctx = { remoteAudioWin: null, freedvEngine: null };
  vm.createContext(ctx);
  vm.runInContext(slice('function pttAudioActive(', 'function handleRemotePtt(') + '\nthis.f = pttAudioActive;', ctx);
  assert.strictEqual(ctx.f({}), false, 'a naked PTT');
  assert.strictEqual(ctx.f({ audio: true }), true);
  ctx.remoteAudioWin = { isDestroyed: () => false };
  assert.strictEqual(ctx.f({}), true, 'the ECHOCAT audio bridge is sending');
  assert.strictEqual(ctx.f({ audio: false }), false);
  const hrp = slice('function handleRemotePtt(', '// SSB-over-DATA only makes sense');
  assert.ok(/!opts\.emission && pttAudioActive\(opts\) && /.test(hrp), 'the check is gated on audio');
});

(async () => {
  for (const [name, fn] of queue) {
    try { await fn(); pass++; console.log('  ok  ' + name); }
    catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
  }
  console.log(`\nQuiet PTT paths: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
