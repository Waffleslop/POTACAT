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
test('Desktop: main sends the list to the JTCAT window', () => {
  const main = read('main.js');
  assert.ok(/_jtcatDxpDials = jtcatDxpeditionDials\(potacatResult\.value\);\s*sendJtcatDxpeditions\(\);/.test(main));
  assert.ok(/ipcMain\.handle\('jtcat-dxpeditions-get', \(\) => _jtcatDxpDials\)/.test(main));
  assert.ok(read('lib/remote-bridge.js').includes("'jtcat-dxpeditions-get':"));
});

// #1033: the "Band and mode" picker (315e818f) replaced the band menu a day
// after the DXpeditions group went in, and the group became unreachable. The
// group now lives in the picker.
const { pickerDxpeditionDials, dxpeditionNote, dxpeditionTag } = require('../lib/dxpedition-dials');
const LIST = [
  { call: 'VP2V/GU4YOX', entity: 'British Virgin Islands', mode: 'FT4', khz: 14080, band: '20m', hound: false, superFox: false, end: '2026-11-10' },
  { call: 'VP2V/GU4YOX', entity: 'British Virgin Islands', mode: 'FT8', khz: 14090, band: '20m', hound: true, superFox: false, end: '2026-11-10' },
  { call: 'Z1Z', entity: '', mode: 'FT8', khz: 50313, band: '6m', hound: false, superFox: true, end: '' },
];
test('#1033 picker rows: only bands this radio uses and modes the window has, each with a key', () => {
  const rows = pickerDxpeditionDials(LIST, { bands: ['40m', '20m', '15m'], modes: ['FT8', 'FT4', 'WSPR'] });
  assert.deepStrictEqual(rows.map((d) => d.key), ['VP2V/GU4YOX|FT4|14080', 'VP2V/GU4YOX|FT8|14090']);
  assert.deepStrictEqual(pickerDxpeditionDials(LIST, { bands: ['20m', '6m'], modes: ['FT8'] }).map((d) => d.key),
    ['VP2V/GU4YOX|FT8|14090', 'Z1Z|FT8|50313']);
  assert.deepStrictEqual(pickerDxpeditionDials(LIST, { modes: ['FT8', 'FT4'] }).length, 3, 'no band list = every band');
  assert.deepStrictEqual(pickerDxpeditionDials(null, {}), []);
  assert.deepStrictEqual(pickerDxpeditionDials([{ call: 'X', mode: 'FT8', khz: 0, band: '20m' }], {}), []);
  assert.strictEqual(LIST[0].key, undefined, 'the input list is not changed');
});
test('#1033 picker words: Fox/Hound and SuperFox, in real words', () => {
  assert.strictEqual(dxpeditionTag(LIST[0]), '');
  assert.strictEqual(dxpeditionTag(LIST[1]), 'Fox/Hound');
  assert.strictEqual(dxpeditionTag(LIST[2]), 'SuperFox');
  assert.strictEqual(dxpeditionNote(LIST[0], false), '');
  assert.strictEqual(dxpeditionNote(LIST[1], false), 'They run Fox/Hound: turn on Hound before you call.');
  assert.strictEqual(dxpeditionNote(LIST[1], true), 'Fox/Hound: Hound is on.');
  assert.ok(/SuperFox/.test(dxpeditionNote(LIST[2], true)) && /WSJT-X/.test(dxpeditionNote(LIST[2], true)));
});
test('#1033 the picker has a DXpeditions group, hidden until one is on the air', () => {
  const html = read('renderer/jtcat-popout.html');
  assert.ok(/<script src="\.\.\/lib\/dxpedition-dials\.js"><\/script>[\s\S]*<script src="jtcat-popout\.js">/.test(html), 'the page loads the module before the window script');
  const picker = html.slice(html.indexOf('id="jp-picker"'), html.indexOf('id="jp-pk-apply"'));
  assert.ok(/id="jp-pk-dxp-sec"[^>]*hidden/.test(picker), 'section heading, hidden by default');
  assert.ok(/DXPEDITIONS ON THE AIR/.test(picker));
  assert.ok(/id="jp-pk-dxps"[^>]*role="radiogroup"[^>]*hidden/.test(picker), 'the buttons, hidden by default');
  assert.ok(/\.jp-pk-band\.jp-pk-dxp \{/.test(html), 'the buttons have their own style');
});
test('#1033 the window: list feeds the picker, Switch tunes through one tune path', () => {
  const pop = read('renderer/jtcat-popout.js');
  assert.ok(!/jp-dxp-opt|jp-dxp-group/.test(pop), 'the old hidden-menu group is gone, one path only');
  assert.ok(/function renderDxpeditionDials\(list\)\s*\{\s*pkDxpList = Array\.isArray\(list\) \? list : \[\];\s*if \(pkIsOpen\(\)\) pkRender\(\);/.test(pop));
  assert.ok(/DxpeditionDials\.pickerDxpeditionDials\(pkDxpList,/.test(pop), 'pkRender filters with the shared module');
  assert.ok(/dxpSec\.hidden = dxpEl\.hidden = !rows\.length;/.test(pop), 'the group shows only when there is one to offer');
  assert.ok(/function pkApply\(\) \{\s*if \(pk\.dxp\) \{ pkApplyDxpedition\(\); return; \}/.test(pop), 'Switch on a DXpedition tunes it');
  assert.ok(/function pkApplyDxpedition\(\) \{[\s\S]{0,300}if \(d\) tuneDxpedition\(d\);/.test(pop));
  const render = pop.slice(pop.indexOf('function pkRender('), pop.indexOf('function pkOpen('));
  assert.ok(!/tuneDxpedition|window\.api\.tune/.test(render), 'a tap on a DXpedition only picks it');
  const fn = pop.slice(pop.indexOf('function tuneDxpedition(d)'));
  assert.ok(/window\.api\.tune\(d\.khz, d\.mode\);/.test(fn.slice(0, 2500)), 'the JTCAT tune: it moves the TX dial anchor');
  assert.ok(/pkDxpOn = d;/.test(fn.slice(0, 2500)));
  assert.ok(/var expectKhz = pkDxpOn \? pkDxpOn\.khz : parseFloat\(dial \? dial\.dataset\.freq : 0\);/.test(pop), 'the off-dial colour reads the DXpedition dial');
  assert.ok(/function selectBand\(btn, save\) \{\s*pkDxpOn = null;/.test(pop), 'any band pick leaves the DXpedition dial');
});

chain.then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
});
