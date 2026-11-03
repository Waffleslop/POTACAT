#!/usr/bin/env node
'use strict';
/**
 * rade_native -- RADE V1 through the calls lib/freedv-worker.js makes.
 *
 * Speech goes into tx() in 10 ms frames and the modem audio comes back
 * through rx() in getNin() chunks, the way the worker feeds them, on one
 * handle (the RADE API is single-context). What has to hold: one 120 ms
 * modem frame per 120 ms of speech, then an end-of-over frame.
 *
 * Skips (with a loud line) when the addon isn't built: npm run build-rade.
 *
 * Run: node test/rade-native-test.js
 */

const assert = require('assert');

let rade;
try {
  rade = require('../lib/rade_native/build/Release/rade_native.node');
} catch (e) {
  console.log('rade_native not built (npm run build-rade) -- skipping native tests');
  process.exit(0);
}

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

// Voiced, syllable-paced test signal: harmonics of a gliding ~120 Hz pitch,
// amplitude-modulated at 3.5 Hz.
function speechLike(rate, seconds) {
  const out = new Int16Array(Math.round(rate * seconds));
  for (let i = 0; i < out.length; i++) {
    const t = i / rate;
    const f0 = 120 + 30 * Math.sin(2 * Math.PI * 0.7 * t);
    let s = 0;
    for (let h = 1; h <= 12; h++) s += Math.sin(2 * Math.PI * f0 * h * t) / h;
    out[i] = Math.round(4000 * s * (0.55 + 0.45 * Math.sin(2 * Math.PI * 3.5 * t)));
  }
  return out;
}

const SECONDS = 6;
const handle = rade.open();
const info = rade.getInfo(handle);
const speech = speechLike(info.speechRate, SECONDS);
const nFrames = Math.floor(speech.length / info.nSpeech);

const txLengths = [];
const modem = [];
for (let f = 0; f < nFrames; f++) {
  const out = rade.tx(handle, speech.slice(f * info.nSpeech, (f + 1) * info.nSpeech));
  txLengths.push(out.length);
  for (let i = 0; i < out.length; i++) modem.push(out[i]);
}
const speechModemSamples = modem.length;
const eooFrame = rade.txEoo(handle);

const modemFrames = txLengths.filter((n) => n > 0);
const framesPerModemFrame = nFrames / Math.max(1, modemFrames.length);

test('tx() returns one modem frame per 120 ms of speech, nothing in between', () => {
  assert.ok(modemFrames.length > 0, 'tx() never returned modem audio');
  for (const n of modemFrames) assert.strictEqual(n, info.nModem);
  assert.ok(Math.abs(framesPerModemFrame - 12) < 0.1, `${framesPerModemFrame.toFixed(2)} speech frames per modem frame`);
});

test('the modem audio lasts as long as the speech', () => {
  const speechSeconds = nFrames * info.nSpeech / info.speechRate;
  const modemSeconds = speechModemSamples / info.modemRate;
  assert.ok(Math.abs(modemSeconds - speechSeconds) <= 0.12, `${modemSeconds.toFixed(2)} s of modem for ${speechSeconds.toFixed(2)} s of speech`);
});

test('txEoo() returns the end-of-over frame', () => {
  assert.ok(eooFrame instanceof Int16Array && eooFrame.length > 0, `${eooFrame && eooFrame.length} samples`);
});

test('tx() refuses a speech frame that is not nSpeech samples', () => {
  assert.throws(() => rade.tx(handle, new Int16Array(info.nSpeech - 1)));
});

rade.close(handle);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
