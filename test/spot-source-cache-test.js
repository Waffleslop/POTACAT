#!/usr/bin/env node
'use strict';
// A failed POTA fetch no longer empties the POTA rows (wayne 2026-10-31: the
// table blanked, then showed WWFF, then POTA came back).
// Run: node test/spot-source-cache-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { createSpotSourceCache } = require('../lib/spot-source-cache');

let passed = 0, failed = 0;
let chain = Promise.resolve();
function test(name, fn) {
  chain = chain.then(fn).then(
    () => { passed++; console.log('  ok  ' + name); },
    (e) => { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); });
}

test('a failed fetch shows the last good list, and says so once', async () => {
  let t = 1000; const log = [];
  const c = createSpotSourceCache({ now: () => t, log: (l) => log.push(l) });
  assert.deepStrictEqual(await c.wrap('POTA', Promise.resolve([{ callsign: 'K1A' }])), [{ callsign: 'K1A' }]);
  t += 60000;
  assert.deepStrictEqual(await c.wrap('POTA', Promise.reject(new Error('POTA HTTP 503'))), [{ callsign: 'K1A' }]);
  assert.deepStrictEqual(await c.wrap('POTA', Promise.reject(new Error('POTA HTTP 503'))), [{ callsign: 'K1A' }]);
  assert.strictEqual(log.length, 1, 'one line per outage');
  assert.ok(/POTA fetch failed \(POTA HTTP 503\) — showing the last 1 POTA spots/.test(log[0]), log[0]);
  assert.deepStrictEqual(await c.wrap('POTA', Promise.resolve([])), []);
  assert.ok(/POTA spots are back \(0\)/.test(log[1]), 'recovery logged');
});

test('a list older than 10 minutes is not shown as live', async () => {
  let t = 0;
  const c = createSpotSourceCache({ now: () => t });
  await c.wrap('POTA', Promise.resolve([{ callsign: 'K1A' }]));
  t = 11 * 60000;
  assert.deepStrictEqual(await c.wrap('POTA', Promise.reject(new Error('x'))), []);
});

test('sources are kept apart', async () => {
  const c = createSpotSourceCache();
  await c.wrap('WWFF', Promise.resolve([{ callsign: 'W1' }]));
  assert.deepStrictEqual(await c.wrap('POTA', Promise.reject(new Error('x'))), []);
});

test('the POTA client rejects an error status and a non-list body', async () => {
  const pota = require('../lib/pota');
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'pota.js'), 'utf8');
  assert.ok(/reject\(new Error\('POTA HTTP ' \+ res\.statusCode\)\)/.test(src));
  assert.ok(/if \(!Array\.isArray\(json\)\) \{ reject\(/.test(src));
  assert.ok(/req\.setTimeout\(15000/.test(src));
  assert.strictEqual(typeof pota.fetchSpots, 'function');
});

test('refreshSpots wraps every program source', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  for (const s of ['POTA', 'SOTA', 'WWFF', 'LLOTA', 'WWBOTA', 'GMA', 'PARC']) {
    assert.ok(new RegExp(`keep\\('${s}', fetch\\w+Spots\\(\\)\\.then\\(process\\w+Spots\\)\\)`).test(main), s);
  }
});

chain.then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
});
