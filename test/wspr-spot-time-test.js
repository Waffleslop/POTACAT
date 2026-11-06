#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
// WSPR spot time = the START of the 2-minute window (W5JSS 2026-10-21: a :06
// transmission was reported to wsprnet at :08 or :09, the moment the decode
// finished). Run: node test/wspr-spot-time-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const N = require('../lib/wspr/wsprnet');
const { Ft8Engine } = require('../lib/ft8-engine');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
console.log('WSPR spot time');

const T = (iso) => Date.parse(iso);

test('a known window start is reported as itself', () => {
  assert.strictEqual(N.wsprWindowStartMs(T('2026-10-21T14:06:00Z'), T('2026-10-21T14:08:41Z')), T('2026-10-21T14:06:00Z'));
});
test('a window start that is not on the even minute is floored to it', () => {
  assert.strictEqual(N.wsprWindowStartMs(T('2026-10-21T14:07:58.500Z'), null), T('2026-10-21T14:06:00Z'));
});
test('with no window known, a decode that finished at :08 or :09 belongs to :06', () => {
  assert.strictEqual(N.wsprWindowStartMs(null, T('2026-10-21T14:08:05Z')), T('2026-10-21T14:06:00Z'));
  assert.strictEqual(N.wsprWindowStartMs(undefined, T('2026-10-21T14:09:59Z')), T('2026-10-21T14:06:00Z'));
});
test('the wsprnet fields are the window start, across midnight too', () => {
  assert.deepStrictEqual(N.utcStamp(new Date(N.wsprWindowStartMs(T('2026-10-21T14:06:00Z'), 0))), { dateYYMMDD: '261021', timeHHMM: '1406' });
  // The 23:58 window decodes after midnight: still the previous day.
  assert.deepStrictEqual(N.utcStamp(new Date(N.wsprWindowStartMs(null, T('2026-10-22T00:00:40Z')))), { dateYYMMDD: '261021', timeHHMM: '2358' });
});

// The real engine handler: the job for the 14:06 window was posted at its
// snapshot, and its result arrives late (14:08:52, well into the next window).
test('the engine carries the window the job was posted for, not the arrival time', () => {
  const eng = Object.create(Ft8Engine.prototype);
  require('events').EventEmitter.call(eng);
  eng._decodeJobPeriods = new Map([[7, T('2026-10-21T14:06:00Z')]]);
  eng._cycleNumber = 0;
  let got = null;
  eng.on('wspr-spots', (d) => { got = d; });
  eng.on('log', () => {});
  eng._onWorkerMessage({ type: 'wspr-result', id: 7, spots: [{ call: 'W5JSS', grid: 'EM12', dBm: 23, snr: -20, dt: 0.3, drift: 0, freqMHz: 14.097102 }] });
  assert.ok(got, 'wspr-spots emitted');
  assert.strictEqual(got.periodStartMs, T('2026-10-21T14:06:00Z'));
  assert.ok(!eng._decodeJobPeriods.has(7), 'the job record is released');
  const params = N.buildSpotParams(got.spots[0], { call: 'K3SBP', grid: 'FN20' },
    Object.assign({ dialMHz: 14.0956 }, N.utcStamp(new Date(N.wsprWindowStartMs(got.periodStartMs, T('2026-10-21T14:08:52Z'))))));
  assert.strictEqual(params.time, '1406');
  assert.strictEqual(params.date, '261021');
});

const main = readSrc(path.join(__dirname, '..', 'main.js'));
const h = main.slice(main.indexOf("ft8Engine.on('wspr-spots'"), main.indexOf("ft8Engine.on('silent'"));
test('main stamps the spots and the upload from the window start', () => {
  assert.ok(/wsprnet\.wsprWindowStartMs\(data\.periodStartMs, Date\.now\(\)\)/.test(h));
  assert.ok(/wsprnet\.utcStamp\(windowStart\)/.test(h));
  assert.ok(/s\.timeUtc = windowHHMM/.test(h));
  assert.ok(!/utcStamp\(now\)/.test(h) && !/new Date\(\);/.test(h), 'no arrival clock left in the handler');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
