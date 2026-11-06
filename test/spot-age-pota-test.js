#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
// POTA spots follow pota.app's own expiry (N4FFF 2026-09-27: ECHOCAT showed
// 6 activators, pota.app 12). The POTA feed drops a spot when it expires, so
// a 5-minute Max Spot Age hid about half the active activators — on the
// desktop table AND on ECHOCAT. WWFF/LLOTA/WWBOTA feeds keep spots for hours
// and keep the limit. Run: node test/spot-age-pota-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ FAIL: ' + name + '\n      ' + (e.stack || e.message)); }
}
const R = (f) => readSrc(path.join(__dirname, '..', f)).replace(/\r\n/g, '\n');
const main = R('main.js');
const app = R('renderer/app.js');

function body(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name + ' not found');
  let d = 0, i = src.indexOf('{', start);
  for (; i < src.length; i++) { if (src[i] === '{') d++; else if (src[i] === '}' && --d === 0) break; }
  return src.slice(start, i + 1);
}

console.log('POTA spot age');

test('only POTA is exempt, and only until the operator opts in', () => {
  // eslint-disable-next-line no-new-func
  const make = (settings) => new Function('settings', body(main, 'spotAgeExempt') + '\nreturn spotAgeExempt;')(settings);
  const off = make({});
  assert.strictEqual(off({ source: 'pota' }), true, 'POTA follows the feed by default');
  for (const src of ['wwff', 'llota', 'wwbota', 'sota', 'dxc']) assert.strictEqual(off({ source: src }), false, src);
  assert.strictEqual(make({ potaAgeLimit: true })({ source: 'pota' }), false, 'opt-in applies the limit to POTA');
});

test('ECHOCAT, SmartSDR and TCI all use the exemption', () => {
  const merged = body(main, 'sendMergedSpots');
  assert.ok(/else if \(spotAgeExempt\(s\)\) limit = Infinity;/.test(merged), 'ECHOCAT forward');
  const sdr = body(main, 'pushSpotsToSmartSdr'), tci = body(main, 'pushSpotsToTci');
  for (const [n, f] of [['SmartSDR', sdr], ['TCI', tci]]) {
    assert.ok(/spotAgeExempt\(spot\) \? potaMaxAgeMs : maxAgeMs/.test(f), n + ': POTA keeps only the panadapter cap');
  }
});

test('the desktop table exempts POTA the same way', () => {
  const f = body(app, 'getFiltered');
  assert.ok(/s\.source === 'pota' && !potaAgeLimit/.test(f));
  assert.ok(/potaAgeLimit = settings\.potaAgeLimit === true;/.test(app), 'loaded at startup');
});

test('the table reads Max Spot Age from settings only (no stale localStorage copy)', () => {
  const lp = body(app, 'loadPrefs');
  assert.ok(/maxAgeMin = parseInt\(settings\.maxAgeMin, 10\) \|\| 5;/.test(lp));
  assert.ok(!/saved\.maxAgeMin/.test(lp), 'localStorage no longer overrides settings.json');
  assert.ok(!/maxAgeMin,\n\s*\};\n\s*localStorage\.setItem\(FILTERS_KEY/.test(body(app, 'saveFilters')), 'filters no longer store it');
  assert.ok(/remoteServer\.on\('set-max-age'[\s\S]{0,400}win\.webContents\.send\('reload-prefs'\)/.test(main), 'an ECHOCAT change reaches the desktop table');
});

test('set-max-age accepts the registry field `minutes` and the legacy `value`', () => {
  const rs = R('lib/remote-server.js');
  assert.ok(/this\.emit\('set-max-age', \{ value: msg\.minutes != null \? msg\.minutes : msg\.value \}\)/.test(rs));
  assert.ok(!/type: 'set-max-age', value:/.test(R('renderer/remote.js')), 'ECHOCAT Web sends `minutes`');
  assert.ok(/potaAgeLimit: settings\.potaAgeLimit === true,/.test(main), 'clients are told whether POTA is age-limited');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
