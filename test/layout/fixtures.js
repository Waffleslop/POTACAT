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
  { id: 'tx', tx: true, text: 'W2XYZ K1ABC -12', txHz: 1523 },
];

// JTCAT Stations view rows (#557): entries as lib/jtcat-stations.js makes
// them, rendered at NOW. Long calls and countries must cut off with an
// ellipsis, never push the later columns along or wrap.
const NOW = 1800000000000;
const STATIONS = [
  { id: 'cq-plain', e: { call: 'K1ABC', calling: 'CQ', grid: 'FN42', entity: 'United States', state: '', db: -12, df: 1500, lastHeard: NOW - 12000 },
    marks: { entity: 'confirmed', state: '', grid: false, call: false } },
  // A spotted POTA activator: the Park column, a worked state.
  { id: 'cq-pota-state', e: { call: 'KN5YVJ', calling: 'CQ POTA', grid: 'EM20', entity: 'United States', state: 'TX', db: -14, df: 892, lastHeard: NOW - 27000, park: { sig: 'POTA', ref: 'US-12345', from: 'spot' } },
    marks: { entity: 'confirmed', state: 'worked', grid: false, call: true, needed: true } },
  // The native FT4 decoder's float dB and a fractional Hz, as they arrive.
  { id: 'float-db-df', e: { call: 'KF8FTQ', calling: 'KF6JXM', grid: 'EN74', entity: 'United States', state: '', db: 10.9874995727539, df: 232.73, lastHeard: NOW - 3000 } },
  // Every mark at once (the widest Need cell) and a SOTA summit, the longest reference.
  { id: 'all-marks', e: { call: 'KL7ABC', calling: 'CQ SOTA', grid: 'BP51', entity: 'Alaska', state: 'AK', db: -3, df: 2210, lastHeard: NOW - 45000, park: { sig: 'SOTA', ref: 'KL7/AN-001', from: 'cq' } },
    marks: { entity: 'new', state: 'new', grid: true, call: true, needed: true } },
  { id: 'long-everything', e: { call: 'KH6/W1ABCD/P', calling: 'VE3/K1ABCDE/QRP', grid: 'BL11', entity: 'South Sandwich Islands and a very long name', state: '', db: -24.4, df: 3001, lastHeard: NOW - 599000 },
    marks: { entity: 'new', state: '', grid: true, call: true, needed: true } },
  { id: 'no-grid-no-db', e: { call: 'JA1XYZ', calling: 'W2XYZ', grid: '', entity: '', state: '', db: null, df: null, lastHeard: NOW - 125000 } },
  { id: 'cq-dx', e: { call: '9K2YM', calling: 'CQ DX', grid: 'LL39', entity: 'Kuwait', state: '', db: 0, df: 1384, lastHeard: NOW, park: { sig: 'WWFF', ref: '9KFF-0001', from: 'cq' } },
    marks: { entity: 'worked', state: '', grid: false, call: false } },
];
const STATION_SCOPE_TEXT = 'on 20m digital';

module.exports = { SPOTS, COLUMN_SETS, DECODES, STATIONS, STATION_SCOPE_TEXT, NOW };
