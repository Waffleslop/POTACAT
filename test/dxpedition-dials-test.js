#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
// DXpedition FT8/FT4 dials in JTCAT (level_death 2026-10-31): the feed
// Worker parses the dials an announcement gives, the desktop offers the
// ones on the air today in the JTCAT window's band menu.
// Run: node test/dxpedition-dials-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { jtcatDxpeditionDials } = require('../lib/dxpedition-dials');
const read = (p) => readSrc(path.join(__dirname, '..', p));

let passed = 0, failed = 0;
let chain = Promise.resolve();
function test(name, fn) {
  chain = chain.then(fn).then(
    () => { passed++; console.log('  ok  ' + name); },
    (e) => { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.message || e)); });
}

const details = () => import(pathToFileURL(path.join(__dirname, '..', 'worker', 'dxpeditions', 'details.js')).href);

test('Worker: dials from announcement wording', async () => {
  const { parseFreqs } = await details();
  assert.deepStrictEqual(parseFreqs('QRV on 160-10m CW, SSB and FT8 (F/H) on 14.090, 18.095 & 21.091. QSL via M0OXO.'),
    [{ mode: 'FT8', khz: 14090, hound: true }, { mode: 'FT8', khz: 18095, hound: true }, { mode: 'FT8', khz: 21091, hound: true }]);
  assert.deepStrictEqual(parseFreqs('FT4 14080 kHz and FT8 14074 kHz'), [{ mode: 'FT8', khz: 14074 }, { mode: 'FT4', khz: 14080 }]);
  assert.deepStrictEqual(parseFreqs('14.090 MHz FT8, CW on 14.023'), [{ mode: 'FT8', khz: 14090 }]);
  assert.deepStrictEqual(parseFreqs('SuperFox on 14.090'), [{ mode: 'FT8', khz: 14090, hound: true, superFox: true }]);
});
test('Worker: no dial without an FT mention or outside a band', async () => {
  const { parseFreqs } = await details();
  assert.deepStrictEqual(parseFreqs('QSL via 14.090 LoTW; arriving 14 March'), []);
  assert.deepStrictEqual(parseFreqs('FT8 on 13.500'), []);
  assert.deepStrictEqual(parseFreqs(''), []);
});
test('Worker: the record carries freqs, NG3K first, deduped; an override wins', async () => {
  const { combineDetails, FREQ_OVERRIDES } = await details();
  const d = { 'dx-world': { freqs: [{ mode: 'FT8', khz: 14090, hound: true }] }, dxnews: { freqs: [{ mode: 'FT8', khz: 14090, hound: true }, { mode: 'FT4', khz: 14080 }] } };
  assert.deepStrictEqual(combineDetails('VP2V/GU4YOX', d).freqs, [{ mode: 'FT8', khz: 14090, hound: true }, { mode: 'FT4', khz: 14080 }]);
  assert.deepStrictEqual(combineDetails('X1X', { ng3k: { freqs: [{ mode: 'FT8', khz: 7056 }] }, dxnews: { freqs: [{ mode: 'FT8', khz: 14090 }] } }).freqs, [{ mode: 'FT8', khz: 7056 }]);
  FREQ_OVERRIDES.Y1Y = [{ mode: 'FT4', khz: 21140 }];
  assert.deepStrictEqual(combineDetails('Y1Y', d).freqs, [{ mode: 'FT4', khz: 21140 }]);
  delete FREQ_OVERRIDES.Y1Y;
  assert.ok(/d\.parsedFrom === 'article' && Array\.isArray\(d\.freqs\)/.test(read('worker/dxpeditions/index.js')), 'older article parses are read once more');
});

const NOW = Date.parse('2026-11-02T12:00:00Z');
test('Desktop: only DXpeditions on the air, never contests or aliases', () => {
  const recs = [
    { call: 'VP2V/GU4YOX', entity: 'British Virgin Islands', kind: 'dxpedition', start: '2026-10-30', end: '2026-11-10', freqs: [{ mode: 'FT8', khz: 14090, hound: true }, { mode: 'FT4', khz: 14080 }] },
    { call: 'GU4YOX', aliasOf: 'VP2V/GU4YOX', kind: 'dxpedition', start: '2026-10-30', end: '2026-11-10', freqs: [{ mode: 'FT8', khz: 14090 }] },
    { call: 'CQ3W', kind: 'contest', start: '2026-11-01', end: '2026-11-03', freqs: [{ mode: 'FT8', khz: 7074 }] },
    { call: 'FT4WC', kind: 'dxpedition', start: '2026-12-01', end: '2027-01-10', freqs: [{ mode: 'FT8', khz: 18095 }] },
    { call: 'Z1Z', kind: 'dxpedition', firstSeen: NOW - 3 * 86400000, freqs: [{ mode: 'FT8', khz: 21091 }, { mode: 'CW', khz: 21023 }] },
    { call: 'Q1Q', kind: 'dxpedition', firstSeen: NOW - 40 * 86400000, freqs: [{ mode: 'FT8', khz: 28091 }] },
  ];
  const list = jtcatDxpeditionDials(recs, { now: NOW });
  assert.deepStrictEqual(list.map((d) => `${d.call} ${d.mode} ${d.khz} ${d.band}${d.hound ? ' FH' : ''}`),
    ['VP2V/GU4YOX FT4 14080 20m', 'VP2V/GU4YOX FT8 14090 20m FH', 'Z1Z FT8 21091 15m']);
});
test('Desktop: main sends the list to the JTCAT window; the window offers it in the band menu', () => {
  const main = read('main.js');
  assert.ok(/_jtcatDxpDials = jtcatDxpeditionDials\(potacatResult\.value\);\s*sendJtcatDxpeditions\(\);/.test(main));
  assert.ok(/ipcMain\.handle\('jtcat-dxpeditions-get', \(\) => _jtcatDxpDials\)/.test(main));
  assert.ok(read('lib/remote-bridge.js').includes("'jtcat-dxpeditions-get':"));
  const pop = read('renderer/jtcat-popout.js');
  assert.ok(/function renderDxpeditionDials\(list\)/.test(pop) && /o\.className = 'jp-dxp-opt'/.test(pop));
  assert.ok(/if \(!opt \|\| !opt\.classList\.contains\('jp-dxp-opt'\)\) return;\s*e\.stopImmediatePropagation\(\);/.test(pop));
  assert.ok(/window\.api\.tune\(khz, mode \|\| modeSelect\.value\);/.test(pop));
  assert.ok(/\}, true\);\s*if \(window\.api\.onJtcatDxpeditions\)/.test(pop), 'capture listener, before the band handler');
});

chain.then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
});
