#!/usr/bin/env node
'use strict';
// IC-9700 (2026-10-20): 1.2 GHz was in no band picker — and, worse,
// lib/bands.js did not know 23cm, so a 1296 MHz QSO logged with NO BAND
// (LoTW/QRZ uploads without one, worked-before never matching, per-band RX
// gain and the SWR latch keyed on ''). lib/bands.js is the source; every
// hand-written band list in the renderer must carry the same set, and the
// digital dial tables the same keys above 2m.
// Run: node test/bands-everywhere-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { BANDS, freqToBand } = require('../lib/bands');

const R = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n');
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
console.log('Bands everywhere');
const ALL = Object.keys(BANDS);
const NEW = ['1.25m', '33cm', '23cm'];
// 2026-10-24: LF/MF and the microwave bands (Casey: "add the rest of the bands").
const NEWER = ['2200m', '630m', '13cm', '9cm', '6cm', '3cm', '1.25cm'];

test('lib/bands.js: the three bands above 70cm, and the classifier places their calling frequencies', () => {
  for (const b of NEW) assert.ok(BANDS[b], b);
  assert.strictEqual(freqToBand(1296.174), '23cm');
  assert.strictEqual(freqToBand(222.1), '1.25m');
  assert.strictEqual(freqToBand(903.1), '33cm');
  assert.strictEqual(freqToBand(1200), null, 'between bands is still nothing');
  const { buildAdifFields } = require('../lib/adif-writer');
  assert.strictEqual(buildAdifFields({ callsign: 'W1AW', frequency: '1296174', mode: 'FT8', qsoDate: '20261020', timeOn: '120000' }).BAND, '23cm', 'a 1.2 GHz QSO logs with its band');
});

test('every hand-written band list in the renderer and main carries the full set', () => {
  const app = R('renderer/app.js'), main = R('main.js'), vfo = R('renderer/vfo-popout.html');
  const lists = {
    'app.js WATCH_BANDS': app.match(/const WATCH_BANDS = new Set\(\[(.*?)\]\)/)[1],
    'main.js WATCH_BANDS': main.match(/const WATCH_BANDS = new Set\(\[(.*?)\]\)/)[1],
    'app.js BAND_QSY_ORDER': app.match(/const BAND_QSY_ORDER = \[(.*?)\]/)[1],
    'app.js DXCC_BANDS': app.match(/const DXCC_BANDS = \[(.*?)\]/)[1],
    'app.js HEATMAP_BANDS': app.match(/const HEATMAP_BANDS = \[(.*?)\]/)[1],
    'app.js sortedBands': app.match(/const sortedBands = \[(.*?)\]/)[1],
    'app.js BAND_RANGES': app.slice(app.indexOf('const BAND_RANGES = ['), app.indexOf('function freqKhzToBand')),
    'app.js bandFromKhz': app.slice(app.indexOf('function freqToBandActivator(khz)'), app.indexOf('// --- Multi-Park Dialog ---')),
    'vfo-popout BANDS': vfo.slice(vfo.indexOf('// --- Bands ---'), vfo.indexOf('function freqToBand(hz)')),
    'vfo-popout classifier': vfo.slice(vfo.indexOf('function freqToBand(hz)'), vfo.indexOf('function buildBandGrid(container)')),
  };
  for (const [name, text] of Object.entries(lists)) {
    for (const b of ALL) assert.ok(text.includes(`'${b}'`), `${name} lacks ${b}`);
  }
  for (const key of ['ssb', 'cw', 'digi']) {
    const row = app.match(new RegExp(`^\\s*${key}: \\{(.*)\\}`, 'm'))[1];
    for (const b of ALL) assert.ok(row.includes(`'${b}':`), `QSY ${key} table lacks ${b}`);
  }
  const labels = app.match(/const BAND_QSY_LABELS = \{(.*?)\}/)[1];
  for (const b of ALL) assert.ok(labels.includes(`'${b}':`), `BAND_QSY_LABELS lacks ${b}`);
  for (const map of app.match(/'70cm': '#ffaa44',\n\s*'1\.25m': '#[0-9a-f]{6}', '33cm': '#[0-9a-f]{6}', '23cm': '#[0-9a-f]{6}',/g) || []) assert.ok(map);
  assert.strictEqual((app.match(/'23cm': '#[0-9a-f]{6}'/g) || []).length, 2, 'both band colour maps');
});

test('every band picker in the HTML offers the new bands', () => {
  const html = R('renderer/index.html'), web = R('renderer/remote.html');
  for (const b of NEW.concat(NEWER)) {
    assert.strictEqual((html.match(new RegExp(`value="${b.replace('.', '\\.')}"`, 'g')) || []).length, 3, `index.html pickers (2 spot filters + log form) for ${b}`);
    assert.ok(html.includes(`<th class="dxcc-band-col">${b}</th>`), `DXCC column ${b}`);
    assert.ok(web.includes(`value="${b}"`) && web.includes(`<option>${b}</option>`), `remote.html pickers for ${b}`);
  }
  const dx = R('renderer/app.js').match(/const DXCC_BANDS = \[(.*?)\]/)[1].split(',').length;
  assert.strictEqual((html.match(/class="dxcc-band-col"/g) || []).length, dx, 'DXCC header columns = DXCC_BANDS length');
});

test('digital dial tables agree on the bands above 2m (WSJT-X: 222.065, 1296.174)', () => {
  const dials = {
    'ft8-engine': R('lib/ft8-engine.js'),
    'jtcat-popout.js': R('renderer/jtcat-popout.js'),
    'remote.js': R('renderer/remote.js'),
    'index.html buttons': R('renderer/index.html'),
    'jtcat-popout.html': R('renderer/jtcat-popout.html'),
  };
  for (const [name, text] of Object.entries(dials)) {
    assert.ok(/222065/.test(text) && /1296174/.test(text), `${name} lacks the 1.25m/23cm dials`);
  }
  assert.strictEqual((dials['jtcat-popout.js'].match(/'23cm': 1296174/g) || []).length, 2, 'both pop-out tables');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
