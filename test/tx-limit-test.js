#!/usr/bin/env node
'use strict';
// The stuck-TX limit covers every key-down POTACAT starts (jcoreyc FT-710:
// keyed at 0 W in DATA-U with no ECHOCAT open until POTACAT was closed).
// lib/tx-limit.js holds the limits and the timer; main.js arms it in
// handleRemotePtt for every PTT source and unkeys by every route on a trip.
// Run: node test/tx-limit-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const T = require('../lib/tx-limit');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
}

function fakeClock() {
  let now = 0; const timers = [];
  return {
    now: () => now,
    setTimer: (fn, ms) => { const t = { fn, at: now + ms, live: true }; timers.push(t); return t; },
    clearTimer: (t) => { if (t) t.live = false; },
    advance(ms) {
      now += ms;
      for (const t of timers) if (t.live && t.at <= now) { t.live = false; t.fn(); }
    },
  };
}

test('every mode has a limit sized above what it legitimately needs', () => {
  assert.ok(T.limitMsFor('ft8') >= 20000 && T.limitMsFor('ft8') <= 60000, 'FT8 over is 12.6 s');
  assert.ok(T.limitMsFor('js8') > 30000, 'JS8 Slow is ~28 s');
  assert.ok(T.limitMsFor('sstv') > 300000, 'PD290 is 289 s');
  assert.ok(T.limitMsFor('voice') >= 300000, 'a voice over can run minutes');
  assert.ok(T.limitMsFor('tune') > 90000, 'JTCAT tune stops itself at 90 s');
  assert.strictEqual(T.limitMsFor('wspr'), null, 'WSPR times its own over');
  assert.strictEqual(T.limitMsFor('something-new'), T.limitMsFor('voice'));
});

test('JTCAT modes map to their kinds', () => {
  assert.strictEqual(T.kindForJtcatMode('FT8'), 'ft8');
  assert.strictEqual(T.kindForJtcatMode('FT4'), 'ft4');
  assert.strictEqual(T.kindForJtcatMode('WSPR'), 'wspr');
  assert.strictEqual(T.kindForJtcatMode('JS8'), 'js8');
  assert.strictEqual(T.kindForJtcatMode('PSK31'), 'psk');
  assert.strictEqual(T.kindForJtcatMode('JTTY'), 'jtty');
});

test('a key-down held past its limit trips once, with the reason', () => {
  const c = fakeClock(); const trips = [];
  const l = new T.TxLimit({ onTrip: (t) => trips.push(t), setTimer: c.setTimer, clearTimer: c.clearTimer, now: c.now });
  l.arm('ft8');
  c.advance(29000);
  assert.strictEqual(trips.length, 0);
  c.advance(2000);
  assert.strictEqual(trips.length, 1);
  assert.strictEqual(trips[0].kind, 'ft8');
  assert.ok(/FT8 had kept the radio keyed for 30 s/.test(trips[0].message), trips[0].message);
  c.advance(60000);
  assert.strictEqual(trips.length, 1);
});

test('a release disarms; a re-assert of the same PTT keeps the original start', () => {
  const c = fakeClock(); const trips = [];
  const l = new T.TxLimit({ onTrip: (t) => trips.push(t), setTimer: c.setTimer, clearTimer: c.clearTimer, now: c.now });
  l.arm('ft8'); c.advance(20000); l.disarm(); c.advance(60000);
  assert.strictEqual(trips.length, 0, 'released');
  l.arm('voice'); c.advance(400000); l.arm('voice'); c.advance(250000);
  assert.strictEqual(trips.length, 1, 'the re-assert did not restart the clock');
});

test('WSPR is exempt', () => {
  const c = fakeClock(); const trips = [];
  const l = new T.TxLimit({ onTrip: (t) => trips.push(t), setTimer: c.setTimer, clearTimer: c.clearTimer, now: c.now });
  l.arm('wspr'); c.advance(3600000);
  assert.strictEqual(trips.length, 0);
});

test('an unsolicited TX report names the PTT lines', () => {
  const s = T.unsolicitedTxReport({ lines: { dtr: false, rts: true }, handshake: false, pttRoute: 'CAT', mode: 'DIGU', freqHz: 14074000 });
  assert.ok(/did not key it/.test(s) && /DTR low, RTS HIGH/.test(s) && /14\.0740 MHz/.test(s), s);
});

const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
test('main arms the limit for every PTT POTACAT asserts and disarms it on release', () => {
  const i = main.indexOf('function handleRemotePtt(state, opts = {}) {');
  const body = main.slice(i, main.indexOf('\nfunction _isEffectivelyTransmitting', i));
  assert.ok((body.match(/txLimitNote\(state, opts\)/g) || []).length >= 2, 'both the no-CAT and the CAT exits arm it');
});

test('each key-down names its kind', () => {
  assert.ok(/handleRemotePtt\(true, \{ audio: true, emission: 'DATA', txKind: jtcatTxKind\(\) \}\)/.test(main), 'JTCAT');
  assert.ok(/emission: 'SSTV', txKind: 'sstv'/.test(main), 'SSTV');
  assert.ok(/noDataSwap: !!opts\.noDataSwap, txKind: 'tune'/.test(main), 'tune / Test transmit');
  assert.ok((main.match(/txKind: 'winlink'/g) || []).length >= 2, 'Winlink + Mercury');
});

test('a trip unkeys by every route: CAT TX0, the RTS/DTR line, the audio, and says why', () => {
  const i = main.indexOf('function txLimitTrip(');
  assert.ok(i > 0);
  const body = main.slice(i, main.indexOf('\n}\n', i));
  for (const re of [/cat\.setTransmit\(false\)/, /setPin\(/, /jtcatHaltTxNow\(/, /sstvHaltTxNow\(\)/, /stop-voice-macro/,
    /gatedSmartSdrTransmit\(false\)/, /forceReleaseIcomNetworkTx\(/, /nocatSerialPtt\(false/, /app-notice/, /\[TX LIMIT\]/]) {
    assert.ok(re.test(body), 'missing ' + re);
  }
});

test('a radio that transmits when POTACAT did not key it is logged with the line state', () => {
  assert.ok(/controller\.on\('ptt', \(on\) => txNoteRadioPtt\(controller, on\)\)/.test(main));
  assert.ok(/function txNoteRadioPtt\(/.test(main) && /unsolicitedTxReport\(/.test(main));
});

console.log(`\ntx limit: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
