'use strict';
// #742: one FreeDV station, one row. PSKReporter reports a FreeDV station as
// "FREEDV" (source 'pskr'); FreeDV Reporter reports the same station with its
// codec, "FREEDV-RADEV1" (source 'freedv'). Each feed deduped only itself, the
// cross-source dedupe skips both, so the station showed twice. Stations that
// left FreeDV Reporter were never removed. And the table told rows apart by
// callsign + frequency only, so clicking one row could mark the other tuned.
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const { mergeFreedvSpots, dropFreedvStation, FREEDV_MERGE_WINDOW_KHZ } = require('../lib/freedv-spot-merge');
const SpotRow = require('../lib/spot-row');

let passed = 0;
function t(name, fn) { fn(); passed++; console.log('  ok', name); }
const read = (p) => readSrc(path.join(__dirname, '..', p));

const fdv = (call, khz, codec = 'RADEV1') => ({ source: 'freedv', callsign: call, frequency: String(khz), mode: 'FREEDV-' + codec, band: '20m' });
const pskr = (call, khz, mode = 'FREEDV') => ({ source: 'pskr', callsign: call, frequency: String(khz), mode, band: '20m' });

t('the window is 2 kHz', () => {
  assert.strictEqual(FREEDV_MERGE_WINDOW_KHZ, 2);
});
t('same call on both feeds, same frequency: one row, the FreeDV Reporter one', () => {
  const out = mergeFreedvSpots([pskr('N0KAH', 14236), fdv('N0KAH', 14236)]);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].source, 'freedv');
  assert.strictEqual(out[0].mode, 'FREEDV-RADEV1');
  assert.deepStrictEqual(out[0].sources, ['freedv', 'pskr']);
});
t('within the window (receiver tuned 1.5 kHz off), case-insensitive call: merged', () => {
  const out = mergeFreedvSpots([fdv('n0kah', 14236), pskr('N0KAH', 14237.5)]);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].source, 'freedv');
});
t('outside the window or on another band: both rows stay', () => {
  assert.strictEqual(mergeFreedvSpots([fdv('N0KAH', 14236), pskr('N0KAH', 14240)]).length, 2);
  assert.strictEqual(mergeFreedvSpots([fdv('N0KAH', 14236), pskr('N0KAH', 7177)]).length, 2);
});
t('a different call on the same frequency is not merged', () => {
  assert.strictEqual(mergeFreedvSpots([fdv('N0KAH', 14236), pskr('K3SBP', 14236)]).length, 2);
});
t('a non-FreeDV PSKReporter spot (FT8) is never merged', () => {
  assert.strictEqual(mergeFreedvSpots([fdv('N0KAH', 14236), pskr('N0KAH', 14236, 'FT8')]).length, 2);
});
t('a PSKReporter FreeDV spot with no FreeDV Reporter twin stays', () => {
  const out = mergeFreedvSpots([pskr('N0KAH', 14236)]);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].source, 'pskr');
});
t('inputs are not mutated, other sources pass through in order', () => {
  const a = { source: 'pota', callsign: 'W1AW', frequency: '14236', mode: 'SSB' };
  const f = fdv('N0KAH', 14236);
  const p = pskr('N0KAH', 14236);
  const out = mergeFreedvSpots([a, p, f]);
  assert.deepStrictEqual(out.map((s) => s.source), ['pota', 'freedv']);
  assert.strictEqual(f.sources, undefined);
  assert.strictEqual(out[0], a);
});
t('dropFreedvStation removes that call only, case-insensitive', () => {
  const list = [fdv('N0KAH', 14236), fdv('K3SBP', 7177)];
  const out = dropFreedvStation(list, 'n0kah');
  assert.deepStrictEqual(out.map((s) => s.callsign), ['K3SBP']);
  assert.strictEqual(list.length, 2);
  assert.strictEqual(dropFreedvStation(list, '').length, 2);
});
t('row identity includes the mode: FREEDV and FREEDV-RADEV1 rows are different rows', () => {
  const a = pskr('N0KAH', 14236);
  const b = fdv('N0KAH', 14236);
  assert.notStrictEqual(SpotRow.spotRowKey(a), SpotRow.spotRowKey(b));
  assert.strictEqual(SpotRow.sameSpotRow(a, b), false);
  assert.strictEqual(SpotRow.sameSpotRow(b, { ...b }), true);
  assert.strictEqual(SpotRow.sameSpotRow(b, null), false);
  assert.strictEqual(SpotRow.sameSpotRow({ callsign: 'W1AW', frequency: '7074' }, { callsign: 'W1AW', frequency: '7074', mode: '' }), true);
});
t('main.js merges the feeds before the cross-source dedupe', () => {
  const main = read('main.js');
  assert.ok(/const raw = FreedvSpotMerge\.mergeFreedvSpots\(\[[^\]]*\.\.\.pskrSpots, \.\.\.freedvReporterSpots\]\);/.test(main));
  assert.ok(/cwSpeeds\.fillSpots\(dedupeCrossSource\(raw\)\)/.test(main));
});
t("main.js handles the FreeDV Reporter 'remove' event", () => {
  const main = read('main.js');
  assert.ok(/freedvReporter\.on\('remove',/.test(main));
  assert.ok(/FreedvSpotMerge\.dropFreedvStation\(freedvReporterSpots,/.test(main));
});
t('the main window keys rows and matches the pin with the shared rule', () => {
  const app = read('renderer/app.js');
  assert.ok(/tr\.dataset\.spotKey = SpotRow\.spotRowKey\(s\)/.test(app));
  assert.ok(!/s\.callsign === lastTunedSpot\.callsign &&\s*s\.frequency === lastTunedSpot\.frequency/.test(app),
    'no pin match on callsign + frequency alone');
  assert.ok((app.match(/SpotRow\.sameSpotRow\(s, lastTunedSpot\)/g) || []).length >= 3);
});

console.log(`freedv-spot-merge: ${passed} passed`);
