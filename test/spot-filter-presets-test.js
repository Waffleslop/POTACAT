#!/usr/bin/env node
'use strict';
// Spot filter presets: named sets of the spot filters. Run: node test/spot-filter-presets-test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const P = require('../lib/spot-filter-presets');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fail++; console.log(`FAIL  ${name}\n      ${e.message}`); }
}

const allSources = (on) => Object.fromEntries(P.SOURCE_KEYS.map((k) => [k, on.includes(k)]));
const allHide = (on) => Object.fromEntries(P.HIDE_KEYS.map((k) => [k, on.includes(k)]));
const window40cw = {
  bands: ['40m'], bandRadio: false, modes: ['CW'], modeRadio: false, continents: null,
  calls: '', sources: allSources(['pota']), hide: allHide(['qrt']),
};

check('normalize: junk dropped, names cleaned, the first of a name kept', () => {
  const list = P.normalizePresets([
    null, 'x', { name: '   ' }, { name: '  POTA   40m ', bands: ['40M'] },
    { name: 'pota 40m', bands: ['20m'] }, { name: 'DX', modes: ['ssb'] },
  ]);
  assert.deepStrictEqual(list.map((p) => p.name), ['POTA 40m', 'DX']);
  assert.deepStrictEqual(list[0].bands, ['40m']);
  assert.deepStrictEqual(list[1].modes, ['SSB']);
  assert.deepStrictEqual(P.normalizePresets('nope'), []);
});

check('normalize: bad tokens and unknown continents dropped; an empty list means All', () => {
  const f = P.normalizeFilters({ bands: ['<b>', ''], modes: ['CW', 'CW'], continents: ['EU', 'XX'] });
  assert.strictEqual(f.bands, null);
  assert.deepStrictEqual(f.modes, ['CW']);
  assert.deepStrictEqual(f.continents, ['EU']);
  assert.strictEqual(P.normalizeFilters({ continents: ['XX'] }).continents, null);
});

check('normalize: "follow the radio" wins over a band or mode list', () => {
  const f = P.normalizeFilters({ bands: ['40m'], bandRadio: true, modes: ['CW'], modeRadio: true });
  assert.strictEqual(f.bands, null);
  assert.strictEqual(f.modes, null);
  assert.ok(f.bandRadio && f.modeRadio);
});

check('normalize: name and list are capped', () => {
  assert.strictEqual(P.cleanName('x'.repeat(100)).length, P.MAX_NAME);
  const many = Array.from({ length: 50 }, (_, i) => ({ name: 'p' + i }));
  assert.strictEqual(P.normalizePresets(many).length, P.MAX_PRESETS);
});

check('match: order and case of lists and calls do not matter', () => {
  const preset = { name: 'A', bands: ['20m', '40m'], modes: ['CW'], calls: 'LZ, sp9abc', sources: allSources(['pota']), hide: allHide([]) };
  const now = { bands: ['40m', '20m'], modes: ['cw'], calls: 'SP9ABC,lz', sources: allSources(['pota']), hide: allHide([]) };
  assert.ok(P.matchesPreset(preset, now));
});

check('match: a changed band, source or switch no longer matches', () => {
  const preset = { name: 'A', ...window40cw };
  assert.ok(P.matchesPreset(preset, window40cw));
  assert.ok(!P.matchesPreset(preset, { ...window40cw, bands: ['20m'] }));
  assert.ok(!P.matchesPreset(preset, { ...window40cw, bands: null }));
  assert.ok(!P.matchesPreset(preset, { ...window40cw, sources: allSources(['pota', 'sota']) }));
  assert.ok(!P.matchesPreset(preset, { ...window40cw, hide: allHide([]) }));
  assert.ok(!P.matchesPreset(preset, { ...window40cw, calls: 'DL' }));
});

check('match: a preset without sources or switches leaves them out of the match', () => {
  const preset = { name: 'Bands only', bands: ['40m'], modes: ['CW'] };
  assert.ok(P.matchesPreset(preset, window40cw));
});

check('findMatchingPreset: the first that matches, else null', () => {
  const list = [{ name: 'All' }, { name: 'CW 40', ...window40cw }, { name: 'CW 40 again', ...window40cw }];
  assert.strictEqual(P.findMatchingPreset(list, window40cw).name, 'CW 40');
  assert.strictEqual(P.findMatchingPreset(list, { ...window40cw, modes: ['FT8'] }), null);
});

check('save: adds at the end, replaces a name in place (any case)', () => {
  let r = P.savePreset([], 'POTA 40m CW', window40cw);
  assert.strictEqual(r.error, null);
  r = P.savePreset(r.list, 'DX', { modes: ['SSB'] });
  r = P.savePreset(r.list, 'pota 40M cw', { ...window40cw, bands: ['30m'] });
  assert.deepStrictEqual(r.list.map((p) => p.name), ['pota 40M cw', 'DX']);
  assert.deepStrictEqual(r.list[0].bands, ['30m']);
});

check('save: no name, or a full list, is refused and changes nothing', () => {
  assert.ok(P.savePreset([], '  ', window40cw).error);
  const full = Array.from({ length: P.MAX_PRESETS }, (_, i) => ({ name: 'p' + i }));
  const r = P.savePreset(full, 'one more', window40cw);
  assert.ok(r.error);
  assert.strictEqual(r.list.length, P.MAX_PRESETS);
  assert.strictEqual(P.savePreset(full, 'P3', window40cw).error, null); // replacing still works
});

check('rename: keeps the filters; a name already taken is refused', () => {
  const list = [{ name: 'A', ...window40cw }, { name: 'B' }];
  const r = P.renamePreset(list, 'a', 'Contest');
  assert.strictEqual(r.error, null);
  assert.deepStrictEqual(r.list[0].bands, ['40m']);
  assert.strictEqual(r.list[0].name, 'Contest');
  assert.ok(P.renamePreset(list, 'A', 'b').error);
  assert.strictEqual(P.renamePreset(list, 'A', 'a').error, null); // its own name in another case
  assert.ok(P.renamePreset(list, 'gone', 'x').error);
});

check('delete and move', () => {
  const list = [{ name: 'A' }, { name: 'B' }, { name: 'C' }];
  assert.deepStrictEqual(P.deletePreset(list, 'b').map((p) => p.name), ['A', 'C']);
  assert.deepStrictEqual(P.movePreset(list, 'C', -1).map((p) => p.name), ['A', 'C', 'B']);
  assert.deepStrictEqual(P.movePreset(list, 'A', -1).map((p) => p.name), ['A', 'B', 'C']);
  assert.deepStrictEqual(P.movePreset(list, 'C', 1).map((p) => p.name), ['A', 'B', 'C']);
});

check('describe: says what the preset sets', () => {
  const d = P.describePreset({ name: 'A', ...window40cw, continents: ['EU'] });
  assert.ok(/Band: 40m/.test(d) && /Mode: CW/.test(d) && /Region: EU/.test(d), d);
  assert.ok(/Sources: POTA/.test(d) && /hide QRT/.test(d), d);
  assert.ok(/Band: radio/.test(P.describePreset({ bandRadio: true })));
});

// Wiring: the window and main use the module, and a preset goes the way of a click.
const app = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

check('wiring: the main window loads the module and has the Presets menu', () => {
  assert.ok(html.includes('<script src="../lib/spot-filter-presets.js"></script>'));
  assert.ok(/id="filter-presets-btn"/.test(html) && /id="filter-presets-menu"/.test(html));
});

check('wiring: applying a preset commits the Spots menu like a click', () => {
  const fn = app.slice(app.indexOf('async function applySpotFilterPreset('), app.indexOf('function saveSpotFilterPresets('));
  assert.ok(fn.length > 0);
  assert.ok(/applyFilterData\(/.test(fn) && /saveFilters\(\)/.test(fn), 'band/mode/region set and saved');
  assert.ok(/await commitSpotsPanel\(\)/.test(fn), 'sources and switches go through commitSpotsPanel');
  assert.ok(fn.indexOf('syncSpotsPanel()') >= 0 && fn.indexOf('syncSpotsPanel()') < fn.indexOf('if (p.sources)'),
    'the menu boxes are synced before the preset sets its own');
  assert.ok(/addEventListener\('change', \(\) => commitSpotsPanel\(\)\)/.test(app), 'the menu click uses the same function');
});

check('wiring: presets load from settings, the button follows every redraw', () => {
  assert.ok(/SpotFilterPresets\.normalizePresets\(settings\.spotFilterPresets\)/.test(app));
  const render = app.slice(app.indexOf('function render() {'), app.indexOf('function render() {') + 300);
  assert.ok(/updateFilterPresetsButton\(\)/.test(render));
  assert.ok(/window\.api\.saveSettings\(\{ spotFilterPresets \}\)/.test(app));
});

check('wiring: main sanitises presets on every save', () => {
  assert.ok(/newSettings\.spotFilterPresets = normalizeSpotFilterPresets\(newSettings\.spotFilterPresets\)/.test(main));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
