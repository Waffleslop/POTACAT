#!/usr/bin/env node
'use strict';
/**
 * Decoded FreeDV speech plays at the codec's own rate, 8 kHz for the classic
 * modes and 16 kHz (wideband) for RADE, one chunk after another. Played as
 * 8 kHz, RADE speech came out at half speed, an octave low.
 *
 * The worker -> engine leg runs for real; the renderer leg is a source guard.
 *
 * Run: node test/freedv-playback-test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { FreedvEngine } = require('../lib/freedv-engine');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

test('the worker labels decoded speech with the codec\'s speech rate', () => {
  assert.ok(/\{ type: 'rx-speech', samples: speech, rate: info\.speechRate \}/.test(read('lib/freedv-worker.js')));
});

test('the engine passes the rate on with the speech', () => {
  const engine = new FreedvEngine();
  engine._lastSync = true;
  engine._lastSnr = 10;
  const got = [];
  engine.on('rx-speech', (d) => got.push(d));
  engine._onWorkerMessage({ type: 'rx-speech', samples: new Int16Array(160), rate: 16000 });
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0].rate, 16000);
  assert.strictEqual(got[0].samples.length, 160);
});

test('the renderer plays each chunk at its rate, in a context running at that rate', () => {
  const app = read('renderer/app.js');
  const at = app.indexOf('window.api.onFreedvRxSpeech(');
  assert.ok(at > 0, 'onFreedvRxSpeech handler');
  const body = app.slice(at, app.indexOf('\n});', at));
  assert.ok(/const rate = data\.rate \|\| 8000;/.test(body), 'rate from the chunk, 8 kHz when absent');
  assert.ok(/new AudioContext\(\{ sampleRate: rate \}\)/.test(body), 'context at the speech rate');
  assert.ok(/freedvRxPlaybackCtx\.sampleRate !== rate/.test(body), 'a new context when the rate changes');
  assert.ok(/createBuffer\(1, floats\.length, rate\)/.test(body), 'buffer at the speech rate');
  assert.ok(!/8000\)/.test(body.replace('data.rate || 8000', '')), 'no other hard-coded 8 kHz');
});

test('the renderer plays decoded chunks back to back, not each on arrival', () => {
  const app = read('renderer/app.js');
  const at = app.indexOf('window.api.onFreedvRxSpeech(');
  const body = app.slice(at, app.indexOf('\n});', at));
  assert.ok(/source\.start\(freedvRxPlaybackTime\);/.test(body), 'started at the scheduled time');
  assert.ok(/freedvRxPlaybackTime \+= buffer\.duration;/.test(body), 'the next one right after it');
  assert.ok(/if \(freedvRxPlaybackTime < now\) freedvRxPlaybackTime = now \+ 0\.05;/.test(body), 'a gap restarts 50 ms out');
  assert.ok(/new AudioContext\(\{ sampleRate: rate \}\);\n\s+freedvRxPlaybackTime = 0;/.test(body), 'a new context starts a new schedule');
  assert.ok(!/source\.start\(\)/.test(body), 'no chunk started on arrival');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
