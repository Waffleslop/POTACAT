#!/usr/bin/env node
'use strict';
// The Spots band filter follows the rig you switch to (#291). An HF radio's
// ticks emptied the table on a VHF-only one; now the operator's unticked
// bands are what is kept, and each rig shows its own bands minus those.
// Run: node test/spot-band-filter-test.js
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const SBF = require('../lib/spot-band-filter');
const RB = require('../lib/rig-bands');

const R = (f) => readSrc(path.join(__dirname, '..', f)).replace(/\r\n/g, '\n');
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

const HF = RB.HF.slice();                       // no 6 m
const HF6 = RB.MODEL_BANDS['IC-7300'];          // HF + 6 m
const VHF = RB.MODEL_BANDS['IC-9700'];          // 2 m, 70 cm, 23 cm
const spotsOn = (bands) => bands.map((band) => ({ band }));
// What the table shows: main drops bands the rig is not used on, then the filter.
function shown(spots, off, rigBands) {
  return spots.filter((s) => SBF.shows(s.band, off, rigBands)).map((s) => s.band);
}
const MIX = spotsOn(['40m', '20m', '6m', '2m', '70cm']);

// Switching from a rig without 6 m to one with 6 m shows 6 m spots.
test('rig without 6 m -> rig with 6 m: 6 m spots are shown', () => {
  let off = [];
  assert.deepStrictEqual(shown(MIX, off, HF), ['40m', '20m']);
  // On the HF rig the operator ticks 20 m and 40 m only.
  off = SBF.offFromTicks(['20m', '40m'], HF, off);
  assert.ok(!off.includes('6m'), '6 m was never offered, so it is not off');
  assert.deepStrictEqual(shown(MIX, off, HF6), ['40m', '20m', '6m']);
  assert.deepStrictEqual(SBF.ticksForRig(off, HF6), ['40m', '20m', '6m']);
});

test('rig without 6 m -> rig with 6 m, filter on All: every band of the new rig', () => {
  assert.deepStrictEqual(shown(MIX, [], HF6), ['40m', '20m', '6m']);
  assert.strictEqual(SBF.ticksForRig([], HF6), null);
});

// The reverse hides them.
test('rig with 6 m -> rig without 6 m: 6 m spots are hidden', () => {
  assert.deepStrictEqual(shown(MIX, [], HF), ['40m', '20m']);
  const off = SBF.offFromTicks(['6m', '20m'], HF6, []);
  assert.deepStrictEqual(shown(MIX, off, HF), ['20m']);
  const t = SBF.ticksForRig(off, HF);
  assert.ok(!t || !t.includes('6m'), 'a band the rig lacks is never ticked');
});

// The bug as reported: HF ticks on a VHF-only radio.
test('HF ticks never empty the table on a VHF-only radio', () => {
  const off = SBF.offFromTicks(['20m', '40m'], HF6, []);
  assert.deepStrictEqual(shown(MIX, off, VHF), ['2m', '70cm']);
  assert.strictEqual(SBF.ticksForRig(off, VHF), null, 'falls back to All');
});

// The operator's own unticked bands survive a switch.
test('unticked bands survive a switch and a switch back', () => {
  // On the IC-7300 the operator unticks 60 m and 6 m.
  const ticks = HF6.filter((b) => b !== '60m' && b !== '6m');
  let off = SBF.offFromTicks(ticks, HF6, []);
  assert.deepStrictEqual(off, ['60m', '6m']);
  // To the IC-9700: nothing of its own is off, so All.
  assert.strictEqual(SBF.ticksForRig(off, VHF), null);
  // There the operator unticks 23 cm; the HF unticks are kept.
  off = SBF.offFromTicks(['2m', '70cm'], VHF, off);
  assert.deepStrictEqual(off, ['60m', '6m', '23cm']);
  // Back to the IC-7300: 60 m and 6 m are still off.
  assert.deepStrictEqual(SBF.ticksForRig(off, HF6), ticks);
  assert.deepStrictEqual(shown(spotsOn(['60m', '6m', '20m']), off, HF6), ['20m']);
  // To a 6 m-less HF rig: 60 m stays off there too.
  assert.deepStrictEqual(SBF.ticksForRig(off, HF), HF.filter((b) => b !== '60m'));
});

test('choosing All on one rig clears only that rig\'s bands', () => {
  let off = ['60m', '23cm'];
  off = SBF.offFromTicks(null, HF6, off);
  assert.deepStrictEqual(off, ['23cm']);
});

// An "unrestricted" rig (no bands ticked) shows all.
test('an unrestricted rig shows every band', () => {
  const all = spotsOn(RB.ALL_BANDS);
  assert.deepStrictEqual(shown(all, [], null), RB.ALL_BANDS);
  assert.strictEqual(SBF.ticksForRig([], null), null);
  // VHF-only ticks made on the IC-9700 still let HF through on it.
  const off = SBF.offFromTicks(['2m'], VHF, []);
  assert.deepStrictEqual(SBF.universe(null), RB.ALL_BANDS);
  assert.deepStrictEqual(shown(MIX, off, null), ['40m', '20m', '6m', '2m']);
});

test('a rig whose bands were never ticked in the editor uses its model (rig-bands)', () => {
  const rigBands = RB.bandsForRig({ model: 'Mystery' }, 'Mystery', null);
  assert.strictEqual(rigBands, null, 'unknown model = not restricted');
  assert.strictEqual(SBF.ticksForRig(['20m'], rigBands).includes('6m'), true);
});

test('a saved filter from before #291 (ticks only) is read against the rig', () => {
  assert.deepStrictEqual(SBF.offFromSaved({ bands: ['20m'] }, HF), HF.filter((b) => b !== '20m'));
  assert.deepStrictEqual(SBF.offFromSaved({ bands: null }, HF), []);
  assert.deepStrictEqual(SBF.offFromSaved({ bands: ['20m'], bandsOff: ['6m'] }, HF), ['6m']);
  assert.deepStrictEqual(SBF.offFromSaved(null, HF), []);
});

// ECHOCAT (phone and ECHOCAT Web): settings.echoFilters.
test('ECHOCAT: a client\'s ticks become bandsOff, other fields kept', () => {
  const f = SBF.fromClient({ bands: ['20m', '40m'], modes: ['CW'], sort: 'age' }, null, HF6);
  assert.deepStrictEqual(f.modes, ['CW']);
  assert.strictEqual(f.sort, 'age');
  assert.deepStrictEqual(f.bands, ['20m', '40m']);
  assert.deepStrictEqual(f.bandsOff, HF6.filter((b) => b !== '20m' && b !== '40m'));
});

test('ECHOCAT: a rig switch re-ticks the saved filter and the reverse', () => {
  let f = SBF.fromClient({ bands: ['20m', '40m'], modes: null }, null, HF);
  const toVhf = SBF.followRig(f, HF, VHF);
  assert.strictEqual(toVhf.bands, null, 'VHF rig: All, not an empty list');
  const to6 = SBF.followRig(toVhf, VHF, HF6);
  assert.deepStrictEqual(to6.bands, ['40m', '20m', '6m'], 'the 6 m the HF rig lacked is shown');
  const back = SBF.followRig(to6, HF6, HF);
  assert.deepStrictEqual(back.bands, ['40m', '20m']);
  assert.strictEqual(SBF.followRig(back, HF, HF), null, 'no change, no push');
});

test('ECHOCAT: an older blob with ticks only is read against the rig it was made on', () => {
  const next = SBF.followRig({ bands: ['20m'], sort: 'freq' }, HF, HF6);
  assert.deepStrictEqual(next.bands, ['20m', '6m']);
  assert.strictEqual(next.sort, 'freq');
  assert.strictEqual(SBF.followRig(null, HF, HF6), null);
});

// Wiring (glue stays thin; the rule lives in lib/spot-band-filter.js).
test('main.js: rig switch re-ticks echoFilters and pushes them; client ticks go through fromClient', () => {
  const m = R('main.js');
  assert.ok(/require\('\.\/lib\/spot-band-filter'\)/.test(m));
  const b = m.slice(m.indexOf('function rigBandsBroadcast('));
  assert.ok(/echoFiltersFollowRig\(prevBands, bands\)/.test(b.slice(0, 2000)), 'rigBandsBroadcast calls echoFiltersFollowRig');
  assert.ok(/SpotBandFilter\.followRig\(/.test(m) && /sendFiltersToClient\(\{ \.\.\.next/.test(m));
  assert.ok(/settings\.echoFilters = SpotBandFilter\.fromClient\(filters, settings\.echoFilters, activeRigBands\(\)\)/.test(m));
});

test('app.js: the rig-bands receiver re-ticks the band filter; index.html loads the lib', () => {
  const a = R('renderer/app.js');
  assert.ok(/const onRigBandsMain = /.test(a));
  const recv = a.slice(a.indexOf('const onRigBandsMain = '));
  assert.ok(/syncBandFilterToRig\(\)/.test(recv.slice(0, 600)));
  assert.ok(/window\.api\.onRigBands\(onRigBandsMain\)/.test(a));
  assert.ok(/initMultiDropdown\(bandFilterEl, 'Band', \(\) => \{ noteBandFilterTicks\(\);/.test(a));
  assert.ok(/bandsOff: bandFilterOff/.test(a), 'saveFilters keeps the off list');
  assert.ok(R('renderer/index.html').includes('<script src="../lib/spot-band-filter.js"></script>'));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
