#!/usr/bin/env node
'use strict';
/**
 * rade_native -- RADE V1 through the calls lib/freedv-worker.js makes.
 *
 * Speech goes into tx() in 10 ms frames and the modem audio comes back
 * through rx() in getNin() chunks, the way the worker feeds them, on one
 * handle (the RADE API is single-context). What has to hold: one 120 ms
 * modem frame per 120 ms of speech, a receiver that locks and turns every
 * frame back into speech, and an end-of-over frame that is received without
 * writing past a buffer (that took the whole app down on air, 2026-11-03).
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

// RMS per 20 ms, the envelope the syllable rhythm shows up in.
function envelope(samples, rate) {
  const win = Math.round(rate * 0.02);
  const env = [];
  for (let i = 0; i + win <= samples.length; i += win) {
    let sum = 0;
    for (let j = i; j < i + win; j++) sum += samples[j] * samples[j];
    env.push(Math.sqrt(sum / win));
  }
  return env;
}

// Best normalised correlation of b against a, over lags up to maxLag windows.
function bestCorrelation(a, b, maxLag) {
  let best = -1;
  for (let lag = 0; lag <= maxLag; lag++) {
    const n = Math.min(a.length, b.length - lag);
    if (n < 25) break;
    let ma = 0, mb = 0;
    for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i + lag]; }
    ma /= n; mb /= n;
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < n; i++) {
      const x = a[i] - ma, y = b[i + lag] - mb;
      num += x * y; da += x * x; db += y * y;
    }
    if (da > 0 && db > 0) best = Math.max(best, num / Math.sqrt(da * db));
  }
  return best;
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
for (let i = 0; i < eooFrame.length; i++) modem.push(eooFrame[i]);
for (let i = 0; i < info.modemRate; i++) modem.push(0);

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

let pos = 0, firstSync = -1, sawEoo = false;
const decoded = [];
while (pos + rade.getNin(handle) <= modem.length) {
  const nin = rade.getNin(handle);
  const r = rade.rx(handle, Int16Array.from(modem.slice(pos, pos + nin)));
  pos += nin;
  if (r.sync && firstSync < 0) firstSync = pos / info.modemRate;
  if (r.eoo) sawEoo = true;
  for (let i = 0; i < r.speech.length; i++) decoded.push(r.speech[i]);
}
const decodedSeconds = decoded.length / info.speechRate;

test('the receiver locks within a second', () => {
  assert.ok(firstSync >= 0 && firstSync < 1, `first sync at ${firstSync} s`);
});

test('every received modem frame is turned back into speech', () => {
  // Lost to acquisition; everything after is speech.
  const expected = SECONDS - firstSync;
  assert.ok(decodedSeconds > 0.85 * expected && decodedSeconds < 1.05 * SECONDS,
    `${decodedSeconds.toFixed(2)} s decoded, ${expected.toFixed(2)} s expected`);
});

test('the decoded speech keeps the input\'s syllable rhythm', () => {
  const corr = bestCorrelation(envelope(speech, info.speechRate), envelope(decoded, info.speechRate), 100);
  assert.ok(corr > 0.6, `envelope correlation ${corr.toFixed(2)}`);
});

test('the end-of-over frame is received and reported', () => {
  assert.ok(sawEoo, 'rx() never reported eoo');
});

rade.close(handle);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
