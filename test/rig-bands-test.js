#!/usr/bin/env node
'use strict';
// Bands each radio is used on (Casey 2026-10-24): native per model, the
// operator can add or remove bands in the rig editor, and a band the radio
// is not configured for is seen nowhere. Run: node test/rig-bands-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const RB = require('../lib/rig-bands');
const { RIG_MODELS } = require('../lib/rig-models');
const { BANDS, freqToBand } = require('../lib/bands');

const R = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n');
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

test('ALL_BANDS is lib/bands.js, low to high, and the classifier knows every one', () => {
  assert.deepStrictEqual([...RB.ALL_BANDS].sort(), Object.keys(BANDS).sort());
  for (const b of RB.ALL_BANDS) {
    const { lower, upper } = BANDS[b];
    assert.strictEqual(freqToBand((lower + upper) / 2), b, b);
    assert.strictEqual(RB.bandOfMhz((lower + upper) / 2), b, 'renderer classifier ' + b);
  }
  const lows = RB.ALL_BANDS.map((b) => BANDS[b].lower);
  assert.deepStrictEqual(lows, lows.slice().sort((a, b) => a - b), 'low to high');
});

test('every radio model POTACAT knows has a native band list', () => {
  for (const [name, m] of Object.entries(RIG_MODELS)) {
    const n = RB.nativeBands(name, m);
    assert.ok(Array.isArray(n) && n.length, name + ' has no native bands');
    for (const b of n) assert.ok(RB.ALL_BANDS.includes(b), name + ': ' + b);
  }
});

test('native lists: the radios that brought this up', () => {
  assert.ok(!RB.nativeBands('IC-7300').includes('23cm') && !RB.nativeBands('IC-7300').includes('2m'), 'IC-7300 is HF + 6 m');
  assert.deepStrictEqual(RB.nativeBands('IC-9700'), ['2m', '70cm', '23cm']);
  assert.ok(!RB.nativeBands('FLEX-8400/8600').includes('2m'), 'a Flex needs a transverter for 2 m');
  assert.ok(RB.nativeBands('FLEX-6700').includes('2m'));
  assert.ok(RB.nativeBands('IC-705').includes('70cm'));
  assert.deepStrictEqual(RB.nativeBands('Pebble HF', RIG_MODELS['Pebble HF']), ['20m'], 'a model\'s own bands win');
});

test('the operator\'s ticks win; an unknown model is not restricted', () => {
  assert.deepStrictEqual(RB.bandsForRig({ bands: ['2m', '20m', 'junk'] }, 'FLEX-8400/8600'), ['20m', '2m'], 'transverter band added, order kept');
  assert.deepStrictEqual(RB.bandsForRig({}, 'IC-9700'), ['2m', '70cm', '23cm']);
  assert.strictEqual(RB.bandsForRig({}, ''), null);
  assert.strictEqual(RB.bandsForRig({ bands: [] }, ''), null, 'an empty list is no restriction, never "no bands"');
});

test('allowed / filterByBand', () => {
  assert.ok(RB.allowed(null, '23cm'));
  assert.ok(!RB.allowed(['20m'], '23cm'));
  assert.ok(RB.allowed(['20m'], ''), 'a spot with no band is not hidden');
  assert.ok(RB.allowed(['20m'], 'whatever'), 'a band we cannot name is not hidden');
  assert.deepStrictEqual(RB.filterByBand([{ b: '20m' }, { b: '2m' }], ['20m'], (x) => x.b), [{ b: '20m' }]);
});

test('applyToElements hides and disables, by data-band, data-khz, data-freq, value or label', () => {
  const mk = (tag, o) => Object.assign({ tagName: tag, dataset: {}, hidden: false, disabled: false }, o);
  const els = [mk('BUTTON', { dataset: { band: '23cm' } }), mk('BUTTON', { dataset: { khz: '14074' } }),
    mk('OPTION', { value: '2m' }), mk('LABEL', { textContent: ' 6m' }), mk('OPTION', { dataset: { freq: '1296174' } }), mk('LABEL', { textContent: 'All' })];
  const root = { querySelectorAll: () => els };
  const n = RB.applyToElements(root, '*', ['20m', '6m']);
  assert.strictEqual(n, 3);
  assert.deepStrictEqual(els.map((e) => e.hidden), [true, false, true, false, true, false]);
  assert.ok(els[2].disabled && els[4].disabled, 'a hidden option is also disabled');
  RB.applyToElements(root, '*', null);
  assert.ok(els.every((e) => !e.hidden), 'null shows everything again');
});

test('main: one reader, spots filtered at the source, caps + broadcast + IPC + ECHOCAT hydration', () => {
  const main = R('main.js');
  assert.ok(/function activeRigBands\(\)/.test(main) && /RigBands\.bandsForRig\(rig, name, getModel\(name, null\)\)/.test(main));
  assert.ok(/caps\.bands = activeRigBands\(\);/.test(main));
  assert.ok(/const rigBands = activeRigBands\(\);\n\s*if \(rigBands\) \{\n\s*const keep = merged\.filter\(\(sp\) => RigBands\.allowed\(rigBands, sp\.band\)\);/.test(main), 'the merged spot list');
  assert.ok(/const caps = getRigCapabilities\(rigType\);\n\s*rigBandsBroadcast\(\);/.test(main), 'broadcastRigState pushes a change');
  assert.ok(/ipcMain\.handle\('rig-bands-get'/.test(main) && /ipcMain\.handle\('rig-bands-native'/.test(main));
  assert.ok(/type: 'rig-bands', bands: activeRigBands\(\), all: RigBands\.ALL_BANDS/.test(main), 'hydrated at connect');
  const rs = R('lib/remote-server.js');
  assert.ok(rs.includes("'rig-bands'") && rs.includes('broadcastRigBands') && rs.includes("['rig-bands-js', 'rig-bands.js']"));
  const proto = require('../lib/echocat-protocol');
  assert.ok((proto.MESSAGES || proto)['rig-bands']);
});

test('rig editor: the checkbox grid, native pre-ticks, saved only once touched', () => {
  const html = R('renderer/index.html'), app = R('renderer/app.js');
  assert.ok(html.includes('Check all bands you can use with this radio') && html.includes('id="rig-bands-grid"'));
  assert.ok(html.includes('<script src="../lib/rig-bands.js"></script>'));
  assert.ok(/await initRigBandsForEditor\(mode === 'edit'/.test(app));
  assert.ok(/const rb = rigBandsToSave\(\); if \(rb\) rig\.bands = rb; else delete rig\.bands;/.test(app));
  assert.ok(/\.\.\.\(rigBandsToSave\(\) \? \{ bands: rigBandsToSave\(\) \} : \{\}\)/.test(app));
  assert.ok(/if \(!rigBandsState\.touched\) rigBandsState\.selected = new Set\(native \|\|/.test(app));
});

test('every operating surface filters by the rig\'s bands', () => {
  const surfaces = {
    'renderer/app.js': ["'#band-filter .multi-dropdown-item'", "'#band-buttons button'", "'.jtcat-band-btn'", 'HEATMAP_BANDS_RIG'],
    'renderer/jtcat-popout.js': ["'.jp-band-opt'", 'window.RigBands.allowed(jpRigBands, b)'],
    'renderer/sstv-popout.js': ['applySstvRigBands(freqSel)', "'.band'"],
    'renderer/vfo-popout.html': ['window.RigBands.allowed(vfoRigBands, b.label)'],
    'renderer/js8call-popout.js': ['applyJs8RigBands'],
    'renderer/spots-popout.js': ["getElementById('filter-band')"],
    'renderer/winlink-popout.js': ["getElementById('wl-band')"],
    'renderer/remote.js': ["'.vf-band'", "'#rc-band-filter .rc-dropdown-item'", "getElementById('ft8-band-select')", "getElementById('sstv-freq-phone')", "getElementById('mail-band')", "case 'rig-bands':"],
  };
  for (const [file, needles] of Object.entries(surfaces)) {
    const t = R(file);
    for (const n of needles) assert.ok(t.includes(n), file + ' lacks ' + n);
  }
  for (const page of ['renderer/jtcat-popout.html', 'renderer/sstv-popout.html', 'renderer/vfo-popout.html', 'renderer/js8call-popout.html', 'renderer/spots-popout.html', 'renderer/winlink-popout.html']) {
    assert.ok(R(page).includes('../lib/rig-bands.js'), page + ' loads lib/rig-bands.js');
  }
  for (const pre of ['preload.js', 'preload-jtcat-popout.js', 'preload-sstv-popout.js', 'preload-vfo-popout.js', 'preload-js8call-popout.js', 'preload-spots-popout.js', 'preload-winlink-popout.js']) {
    const t = R(pre);
    assert.ok(t.includes("rigBandsGet: () => ipcRenderer.invoke('rig-bands-get')") && t.includes("ipcRenderer.on('rig-bands'"), pre);
  }
});

console.log(`\nRig bands: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
