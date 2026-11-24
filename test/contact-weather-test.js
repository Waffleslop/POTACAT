#!/usr/bin/env node
'use strict';
// Contact details: the station's weather (Discord "Jump", 2026-11-23).
// lib/contact-weather.js asks Open-Meteo (free, no key) for the current
// temperature and a short condition at the centre of the station's 4-character
// grid square, never a street position, and keeps each answer 30 minutes per
// square. It is asked only when the window shows a station, and only when the
// operator has turned weather on. fetch is stubbed: no network here.
// Run: node test/contact-weather-test.js
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const W = require('../lib/contact-weather');

let passed = 0, failed = 0;
const pending = [];
function test(name, fn) {
  pending.push(async () => {
    try { await fn(); passed++; console.log('  ok  ' + name); }
    catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
  });
}

const answer = {
  latitude: 42.5, longitude: -73, utc_offset_seconds: -18000, timezone: 'America/New_York',
  current: { time: '2026-11-23T10:00', temperature_2m: 6.3, weather_code: 61, is_day: 1 },
};
function stubFetch(body, opts) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init });
    if (opts && opts.fail) throw new Error('offline');
    return { ok: !(opts && opts.status), status: (opts && opts.status) || 200, json: async () => body };
  };
  f.calls = calls;
  return f;
}

console.log('Contact details: weather');

test('asks Open-Meteo for the square centre only, current temperature and condition, local time zone', async () => {
  const fetch = stubFetch(answer);
  const c = W.createWeatherClient({ fetch, now: () => 0 });
  const r = await c.current({ lat: 42.1014, lon: -72.5898 });
  assert.strictEqual(fetch.calls.length, 1);
  const u = new URL(fetch.calls[0].url);
  assert.strictEqual(u.origin + u.pathname, 'https://api.open-meteo.com/v1/forecast');
  assert.strictEqual(u.searchParams.get('latitude'), '42.5', 'the centre of FN32, not the address');
  assert.strictEqual(u.searchParams.get('longitude'), '-73');
  assert.strictEqual(u.searchParams.get('current'), 'temperature_2m,weather_code,is_day');
  assert.strictEqual(u.searchParams.get('timezone'), 'auto');
  assert.ok(!/call|name|key/i.test(fetch.calls[0].url), 'nothing but the position');
  assert.deepStrictEqual(r, { tempC: 6.3, code: 61, text: 'Light rain', isDay: true, utcOffsetSeconds: -18000, timezone: 'America/New_York', grid4: 'FN32' });
});

test('one answer per grid square for 30 minutes, then asked again', async () => {
  let t = 0;
  const fetch = stubFetch(answer);
  const c = W.createWeatherClient({ fetch, now: () => t });
  await c.current({ lat: 42.1, lon: -72.6 });
  await c.current({ lat: 42.9, lon: -72.1 }); // same square FN32
  assert.strictEqual(fetch.calls.length, 1);
  t = 29 * 60 * 1000;
  await c.current({ lat: 42.1, lon: -72.6 });
  assert.strictEqual(fetch.calls.length, 1);
  t = 31 * 60 * 1000;
  await c.current({ lat: 42.1, lon: -72.6 });
  assert.strictEqual(fetch.calls.length, 2);
  await c.current({ lat: 51.5, lon: -0.1 }); // another square
  assert.strictEqual(fetch.calls.length, 3);
});

test('two windows asking at once share one request', async () => {
  const fetch = stubFetch(answer);
  const c = W.createWeatherClient({ fetch, now: () => 0 });
  const [a, b] = await Promise.all([c.current({ lat: 42.1, lon: -72.6 }), c.current({ lat: 42.2, lon: -72.7 })]);
  assert.strictEqual(fetch.calls.length, 1);
  assert.deepStrictEqual(a, b);
});

test('offline, an HTTP error or a strange answer: null, and not asked again for 5 minutes', async () => {
  let t = 0;
  for (const fetch of [stubFetch(null, { fail: true }), stubFetch({}, { status: 500 }), stubFetch({ current: {} })]) {
    const c = W.createWeatherClient({ fetch, now: () => t });
    assert.strictEqual(await c.current({ lat: 42.1, lon: -72.6 }), null);
    assert.strictEqual(await c.current({ lat: 42.1, lon: -72.6 }), null);
    assert.strictEqual(fetch.calls.length, 1);
    t += 6 * 60 * 1000;
    await c.current({ lat: 42.1, lon: -72.6 });
    assert.strictEqual(fetch.calls.length, 2);
  }
});

test('no position: nothing is asked', async () => {
  const fetch = stubFetch(answer);
  const c = W.createWeatherClient({ fetch, now: () => 0 });
  assert.strictEqual(await c.current(null), null);
  assert.strictEqual(await c.current({ lat: NaN, lon: 3 }), null);
  assert.strictEqual(await c.current({ lat: 95, lon: 3 }), null);
  assert.strictEqual(fetch.calls.length, 0);
});

test('a request that hangs gives up (an AbortSignal is passed)', async () => {
  const fetch = stubFetch(answer);
  const c = W.createWeatherClient({ fetch, now: () => 0 });
  await c.current({ lat: 42.1, lon: -72.6 });
  assert.ok(fetch.calls[0].init && fetch.calls[0].init.signal, 'a signal');
});

test('WMO weather codes in plain words', () => {
  assert.strictEqual(W.weatherText(0), 'Clear');
  assert.strictEqual(W.weatherText(2), 'Partly cloudy');
  assert.strictEqual(W.weatherText(3), 'Overcast');
  assert.strictEqual(W.weatherText(45), 'Fog');
  assert.strictEqual(W.weatherText(65), 'Heavy rain');
  assert.strictEqual(W.weatherText(73), 'Snow');
  assert.strictEqual(W.weatherText(95), 'Thunderstorm');
  assert.strictEqual(W.weatherText(1234), '');
});

test('this test is in the list CI runs', () => {
  assert.ok(readSrc(path.join(__dirname, '..', 'scripts', 'run-tests.js')).includes("'test/contact-weather-test.js'"));
});

(async () => {
  for (const run of pending) await run();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
