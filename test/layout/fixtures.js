// Deliberately awkward rows for the layout test. Each one is a shape that has
// broken, or could break, a row: add a fixture whenever a new kind of row or
// value appears (a new source, a new badge, a new decoder).
'use strict';

const base = { spotTime: '', bearing: 0 };

const SPOTS = [
  { id: 'pota-ssb', spot: { ...base, callsign: 'K1ABC', frequency: '14285.0', mode: 'SSB', band: '20m', distance: 812, source: 'pota', reference: 'US-1234', parkName: 'Acadia National Park', locationDesc: 'US-ME', spotter: 'W1AW', cqZone: 5, ituZone: 8 }, v: { age: '3m', distUnit: 'mi' } },
  // 1.11.7–1.13.0 bug: the speed was a second grid cell.
  { id: 'cw-wpm', spot: { ...base, callsign: 'W2XYZ', frequency: '14062.5', mode: 'CW', band: '20m', distance: 230, source: 'pota', reference: 'US-0042', wpm: 22, wpmFrom: 'skimmer' }, v: { age: '1m', distUnit: 'mi' } },
  { id: 'ft8-with-stray-wpm', spot: { ...base, callsign: 'N3QQ', frequency: '14074.0', mode: 'FT8', band: '20m', distance: 1543.7, source: 'pota', reference: 'US-5555', wpm: 18 }, v: { age: '12m', distUnit: 'mi' } },
  { id: 'net-no-buttons', spot: { ...base, callsign: 'NET', frequency: '7268.0', mode: 'LSB', band: '40m', source: 'net', comments: 'Hootowl Net' }, v: { distUnit: 'mi' } },
  { id: 'no-band', spot: { ...base, callsign: 'VE3ZZZ', frequency: '', mode: '', distance: null, source: 'dxc', locationDesc: 'Canada' }, v: { age: '40m', distUnit: 'km' } },
  { id: 'long-everything', spot: { ...base, callsign: 'KH6/W1ABCD/P', frequency: '1296174.0', mode: 'FT8', band: '23cm', distance: 12345.678, source: 'sota', isDx: true, reference: 'W7A/PE-097', parkName: 'A very long summit name that keeps going and going', locationDesc: 'Turks & Caicos Islands', spotter: 'VERYLONGSPOTTER-#', cqZone: 31.0, ituZone: '61' }, v: { age: '2h 59m', distUnit: 'mi', newPark: true, dxe: 'contest', dxeTitle: 'CQ WW', donor: true, creator: false, workedEver: true } },
  { id: 'worked-skipped-creator', spot: { ...base, callsign: 'K3SBP', frequency: '7074.0', mode: 'FT8', band: '40m', distance: 0.4, source: 'llota', reference: 'LLCL-0001', cqZone: null, ituZone: '' }, v: { age: '<1m', distUnit: 'km', workedToday: true, isSkipped: true, creator: true, tuned: true } },
];

const ALL = { freq: true, mode: true, band: true, dist: true, ref: true, name: true, region: true, cqz: true, ituz: true, src: true, age: true, spotter: true, skip: true, hide: true, log: true };
const COLUMN_SETS = {
  default: { freq: true, dist: true, ref: true, age: true, skip: true, hide: true, log: true },
  mode: { freq: true, mode: true, dist: true, ref: true, age: true, skip: true, hide: true, log: true },
  all: ALL,
};

const DECODES = [
  // The 2026-10-22 report: the native FT4 decoder's float dB, as it arrived.
  { id: 'ft4-float-db', d: { db: 10.9874995727539, dt: -0.2, df: 232.73, text: 'KF6JXM KF8FTQ EN74' } },
  { id: 'ft8-weak', d: { db: -24.4, dt: 1.86, df: 2210, text: 'CQ POTA N3QQ FM19' } },
  { id: 'ft2-zero', d: { db: -0.4, dt: 0, df: 1500, text: 'CQ K1ABC FN42' } },
  { id: 'no-dt', d: { db: 3, dt: null, df: 980.5, text: 'W2XYZ K1ABC RR73' } },
  { id: 'big-dt', d: { db: -7, dt: 12.44, df: 640, text: 'CQ DX JA1XYZ PM95' } },
  { id: 'badges-entity', d: { db: -12, dt: 0.1, df: 1520, text: 'CQ KH6/W1ABCD/P BL11' }, badges: '<span class="ft8-badge ft8-badge-dxcc">D</span><span class="ft8-badge ft8-badge-call">C</span>', entity: 'Hawaii' },
  { id: 'long-free-text', d: { db: 9, dt: -0.3, df: 3001, text: 'K1ABC W2XYZ R-08 THIS IS A LONG FREE TEXT LINE' } },
  // Wanted-state badge (WAS): a straddling grid shows every candidate with a ?
  { id: 'state-badge', d: { db: -3, dt: 0.4, df: 1210, text: 'CQ K2ABC FN20' }, badges: '<span class="ft8-badge ft8-badge-state">NJ/NY/PA?</span><span class="ft8-badge ft8-badge-call">C</span>', entity: 'United States' },
  { id: 'tx', tx: true, text: 'W2XYZ K1ABC -12' },
];

module.exports = { SPOTS, COLUMN_SETS, DECODES };
