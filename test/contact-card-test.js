#!/usr/bin/env node
'use strict';
// Contact details (Discord "Jump", 2026-11-23; layout approved by Casey the
// same day): one window that shows the station behind a callsign, opened from
// the Logbook and from Log QSO. lib/contact-card.js turns a QRZ record, the
// log's history with the call, the clicked QSO and the operator's own grid
// into what the window shows: the status pill and the worked / confirmed
// line, the Operator card, Path from you (short and long path, distance in
// the operator's units), At their end (local time, weather), Station, QSL and
// Your contacts. A field nobody knows is left out, never shown empty.
// Run: node test/contact-card-test.js
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const CC = require('../lib/contact-card');
const { parseQrzCallsign } = require('../lib/qrz');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

const qrzFull = parseQrzCallsign(readSrc(path.join(__dirname, 'fixtures', 'qrz-callsign-subscriber.xml')));
const qrzThin = parseQrzCallsign(readSrc(path.join(__dirname, 'fixtures', 'qrz-callsign-nonsubscriber.xml')));
const history = [
  { date: '20261123', time: '2347', band: '20m', mode: 'FT8', ref: '', qsl: '', rstSent: '-08', rstRcvd: '-12' },
  { date: '20260720', time: '1402', band: '20M', mode: 'SSB', ref: 'POTA US-1234', qsl: 'L', rstSent: '59', rstRcvd: '57' },
  { date: '20260302', time: '0115', band: '40m', mode: 'CW', ref: '', qsl: '', rstSent: '599', rstRcvd: '579' },
];
const prefixUS = { entity: 'United States', dxcc: 291, cqZone: 5, ituZone: 8, lat: 37.53, lon: -91.67, source: 'cty' };
const NOW = Date.UTC(2026, 10, 23, 15, 0, 0); // 2026-11-23 15:00 UTC
const base = { call: 'W1XYZ', qrz: qrzFull, qrzState: 'subscriber', history, ownGrid: 'FM18lv', distUnit: 'mi', prefix: prefixUS, now: NOW };
const cell = (vm, label) => { const r = vm.station.find((x) => x.label === label); return r ? r.value : undefined; };

console.log('Contact details: the view model');

test('header: Confirmed pill, and the line names the confirmed contact', () => {
  const vm = CC.build(base);
  assert.strictEqual(vm.call, 'W1XYZ');
  assert.strictEqual(vm.status, 'confirmed');
  assert.strictEqual(vm.statusLabel, 'Confirmed');
  assert.strictEqual(vm.headline, 'Worked 3 times. Confirmed 2026-07-20 on 20m SSB by LoTW.');
});

test('header: Worked pill when nothing is confirmed; nothing when never worked', () => {
  const once = CC.build({ ...base, history: [history[0]] });
  assert.strictEqual(once.status, 'worked');
  assert.strictEqual(once.statusLabel, 'Worked');
  assert.strictEqual(once.headline, 'Worked once, 2026-11-23 on 20m FT8. Not confirmed yet.');
  assert.strictEqual(CC.build({ ...base, history: [history[0], history[2]] }).headline, 'Worked 2 times, last 2026-11-23 on 20m FT8. Not confirmed yet.');
  const none = CC.build({ ...base, history: [] });
  assert.strictEqual(none.status, 'new');
  assert.strictEqual(none.statusLabel, '');
  assert.strictEqual(none.headline, 'Not worked before.');
  const both = CC.build({ ...base, history: [{ ...history[1], qsl: 'LP' }] });
  assert.strictEqual(both.headline, 'Worked once. Confirmed 2026-07-20 on 20m SSB by LoTW and QSL card.');
});

test('Path from you: short path, long path, distance in miles', () => {
  const p = CC.build(base).path;
  // FM18lv (Washington DC) to 42.1014, -72.5898 (Springfield MA)
  assert.strictEqual(p.shortDeg, 45);
  assert.strictEqual(p.shortPath, '45°');
  assert.strictEqual(p.longPath, '225°');
  assert.strictEqual(p.distance, '322 mi');
  assert.strictEqual(p.longDistance, '24,552 mi');
  assert.strictEqual(p.approx, false);
});

test('distance in kilometres when the operator chose km', () => {
  const p = CC.build({ ...base, distUnit: 'km' }).path;
  assert.strictEqual(p.distance, '518 km');
  assert.strictEqual(p.longDistance, '39,512 km');
});

test('no own grid: no path (nothing made up)', () => {
  assert.strictEqual(CC.build({ ...base, ownGrid: '' }).path, null);
  assert.strictEqual(CC.build({ ...base, ownGrid: 'nonsense' }).path, null);
});

test('no QRZ position: the log grid, else the prefix, said as "about"', () => {
  const fromLog = CC.build({ ...base, qrz: null, qrzState: 'off', history: [], record: { CALL: 'W1XYZ', GRIDSQUARE: 'FN32' } });
  assert.strictEqual(fromLog.path.approx, false);
  const fromPrefix = CC.build({ ...base, qrz: null, qrzState: 'off', history: [] });
  assert.strictEqual(fromPrefix.path.approx, true);
  assert.ok(/^about [\d,]+ mi$/.test(fromPrefix.path.distance), fromPrefix.path.distance);
});

test('At their end: QRZ offset with summer time is a guess; standard time in November', () => {
  const nov = CC.build(base).time;
  assert.strictEqual(nov.offsetMinutes, -300);
  assert.strictEqual(nov.text, '10:00');
  assert.strictEqual(nov.utc, 'UTC−5');
  const jul = CC.build({ ...base, now: Date.UTC(2026, 6, 1, 15, 0, 0) }).time;
  assert.strictEqual(jul.offsetMinutes, -240, 'summer time adds an hour');
  assert.strictEqual(jul.approx, true);
  assert.strictEqual(jul.sub, 'local time, about UTC−4');
});

test('At their end: the weather service time zone is exact; longitude says so', () => {
  const w = CC.build({ ...base, weather: { tempC: 3.3, text: 'Clear', utcOffsetSeconds: -18000, fetchedAt: NOW - 4 * 60000 } });
  assert.strictEqual(w.time.approx, false);
  assert.strictEqual(w.time.sub, 'local time, UTC−5');
  const lon = CC.build({ ...base, qrz: null, qrzState: 'off', history: [], record: { CALL: 'W1XYZ', GRIDSQUARE: 'FN32' } }).time;
  assert.strictEqual(lon.approx, true);
  assert.strictEqual(lon.offsetMinutes, -300, 'longitude -73 is UTC-5');
  assert.strictEqual(lon.sub, 'local time, from longitude');
});

test('weather: in the operator units, with its source and age; none when there is none', () => {
  const w = { tempC: 3.3, text: 'Clear', utcOffsetSeconds: -18000, fetchedAt: NOW - 4 * 60000 };
  const vm = CC.build({ ...base, weather: w });
  assert.strictEqual(vm.weather.text, '38°F, clear');
  assert.strictEqual(vm.weather.source, 'Open-Meteo, 4 min ago');
  assert.strictEqual(CC.build({ ...base, distUnit: 'km', weather: w }).weather.text, '3°C, clear');
  assert.strictEqual(CC.build(base).weather, null);
});

test('Operator card: photo, name, town, licence and grid pills, notes and aliases', () => {
  const record = { CALL: 'W1XYZ', QSO_DATE: '20260720', TIME_ON: '140200', BAND: '20M', MODE: 'SSB', COMMENT: 'club call' };
  const o = CC.build({ ...base, record }).operator;
  assert.strictEqual(o.photo, 'https://cdn-xml.qrz.com/z/w1xyz/photo.jpg');
  assert.strictEqual(o.name, 'Jane Sample');
  assert.strictEqual(o.town, 'Springfield, MA, United States');
  assert.deepStrictEqual(o.pills, [{ text: 'Amateur Extra', kind: '' }, { text: 'Goes by Jan', kind: '' }, { text: 'FN32rc', kind: 'grid' }]);
  assert.deepStrictEqual(o.notes, ['Notes: club call', 'Also uses: W1XYZ/P, KA1XYZ']);
  assert.strictEqual(o.note, '', 'a subscriber sees no subscription line');
  assert.strictEqual(CC.build({ ...base, qrz: { ...qrzFull, land: 'England', class: 'Full' } }).operator.pills[0].text, 'Full');
});

test('photo: only an https address is used', () => {
  assert.strictEqual(CC.build({ ...base, qrz: { ...qrzFull, image: 'http://x/y.jpg' } }).operator.photo, '');
  assert.strictEqual(CC.build({ ...base, qrz: { ...qrzFull, image: 'javascript:alert(1)' } }).operator.photo, '');
});

test('Station card: county, state, DXCC, zones and the four programs', () => {
  const vm = CC.build(base);
  assert.deepStrictEqual(vm.station.map((r) => r.label), ['County', 'State', 'DXCC', 'CQ / ITU zone', 'POTA', 'SOTA', 'WWFF', 'IOTA']);
  assert.strictEqual(cell(vm, 'County'), 'Hampden');
  assert.strictEqual(cell(vm, 'State'), 'MA');
  assert.strictEqual(cell(vm, 'DXCC'), '291 United States');
  assert.strictEqual(cell(vm, 'CQ / ITU zone'), '5 / 8');
  assert.strictEqual(cell(vm, 'POTA'), 'US-1234', 'from the log');
  assert.strictEqual(cell(vm, 'SOTA'), '—');
  assert.strictEqual(cell(vm, 'IOTA'), 'NA-046');
  assert.strictEqual(vm.stationNote, '');
});

test('the clicked Logbook contact: its own park first, and its row marked in Your contacts', () => {
  const record = { CALL: 'W1XYZ', QSO_DATE: '20260720', TIME_ON: '140200', BAND: '20M', MODE: 'SSB', SIG: 'POTA', SIG_INFO: 'US-0001' };
  const vm = CC.build({ ...base, record });
  assert.strictEqual(cell(vm, 'POTA'), 'US-0001');
  assert.deepStrictEqual(vm.contacts.map((c) => !!c.current), [false, true, false]);
});

test('QSL card: via, mailing address with what Copy copies, e-mail', () => {
  const q = CC.build(base).qsl;
  assert.strictEqual(q.available, true);
  assert.strictEqual(q.via, 'LoTW, Mail');
  assert.deepStrictEqual(q.address.lines, ['Jane Sample', 'c/o Club Station', '12 Example Road', 'Springfield, MA 01101, United States']);
  assert.strictEqual(q.address.copy, 'Jane Sample\nc/o Club Station\n12 Example Road\nSpringfield, MA 01101, United States');
  assert.strictEqual(q.email, 'jane@example.invalid');
  assert.strictEqual(q.note, '');
});

test('Your contacts: date, band, mode, sent / received, park, status', () => {
  assert.deepStrictEqual(CC.build(base).contacts, [
    { when: '2026-11-23 23:47', band: '20m', mode: 'FT8', rst: '-08 / -12', park: '—', status: 'Worked' },
    { when: '2026-07-20 14:02', band: '20m', mode: 'SSB', rst: '59 / 57', park: 'US-1234', status: 'Confirmed' },
    { when: '2026-03-02 01:15', band: '40m', mode: 'CW', rst: '599 / 579', park: '—', status: 'Worked' },
  ]);
});

test('header buttons and the source line', () => {
  const vm = CC.build({ ...base, call: 'W1XYZ/P' });
  assert.strictEqual(vm.qrzUrl, 'https://www.qrz.com/db/W1XYZ', 'the base call');
  assert.strictEqual(vm.full, true);
  assert.strictEqual(vm.source, 'Looked up on QRZ.com (XML subscription).');
  assert.strictEqual(CC.build({ ...base, qrz: null, qrzState: 'off' }).qrzUrl, '', 'no QRZ, no QRZ button');
});

test('without QRZ: log and prefix data, the quiet subscription line, the QSL box says where it comes from', () => {
  const record = { CALL: 'W1XYZ', NAME: 'Jane', QTH: 'Springfield', STATE: 'MA', GRIDSQUARE: 'FN32' };
  const vm = CC.build({ ...base, qrz: null, qrzState: 'off', history: [history[0]], record });
  assert.strictEqual(vm.full, false);
  assert.strictEqual(vm.operator.photo, '');
  assert.strictEqual(vm.operator.name, 'Jane');
  assert.strictEqual(vm.operator.town, 'Springfield, MA, United States');
  assert.deepStrictEqual(vm.operator.pills, [{ text: 'FN32', kind: 'grid' }]);
  assert.strictEqual(vm.operator.note, 'A QRZ XML subscription adds the photo, full name and mailing address. Turn on QRZ.com lookups in Settings > Station.');
  assert.deepStrictEqual(vm.station.map((r) => r.label), ['State', 'DXCC', 'CQ / ITU zone', 'POTA']);
  assert.strictEqual(vm.stationNote, 'From your log and the callsign prefix. Fields nobody knows are left out.');
  assert.deepStrictEqual(vm.qsl, { available: false, via: '', address: null, email: '', note: 'Mailing address and QSL route come from QRZ XML.' });
  assert.strictEqual(vm.source, 'No QRZ.com lookup: from your log and the callsign prefix.');
});

test('a QRZ login with no XML subscription: what QRZ gave, and one quiet line', () => {
  const vm = CC.build({ ...base, call: 'G4ABC', qrz: qrzThin, qrzState: 'no-subscription', history: [], prefix: { entity: 'England', dxcc: 223, cqZone: 14, ituZone: 27, lat: 52.8, lon: -1.5 } });
  assert.strictEqual(vm.operator.name, "Peter O'Brien");
  assert.strictEqual(vm.operator.town, 'Bristol, England');
  assert.strictEqual(vm.qsl.address, null);
  assert.strictEqual(vm.operator.note, 'A QRZ XML subscription adds the photo, full name and mailing address.');
  assert.strictEqual(vm.source, 'Looked up on QRZ.com, without an XML subscription.');
});

test('a subscriber QRZ does not know, and a refused login, say so', () => {
  assert.strictEqual(CC.build({ ...base, qrz: null }).operator.note, 'QRZ.com has no record for W1XYZ.');
  assert.strictEqual(CC.build({ ...base, qrz: null, qrzState: 'login-failed' }).operator.note, CC.NOTE_LOGIN);
});

test('missing fields are left out, never shown empty', () => {
  const vm = CC.build({ call: 'XX9XX', qrz: null, qrzState: 'off', history: [], ownGrid: '', distUnit: 'mi', prefix: null, now: NOW });
  assert.deepStrictEqual(vm.station, [{ label: 'POTA', value: '—' }]);
  assert.strictEqual(vm.operator.name, '');
  assert.strictEqual(vm.operator.town, '');
  assert.deepStrictEqual(vm.operator.pills, []);
  assert.strictEqual(vm.path, null);
  assert.strictEqual(vm.time, null);
  assert.deepStrictEqual(vm.contacts, []);
  for (const r of CC.build(base).station) assert.ok(r.value.trim(), r.label + ' has a value');
});

test('summaryLine: the one line under the Log QSO call field', () => {
  assert.strictEqual(CC.summaryLine(base), 'Jane Sample, Springfield, MA, United States. 45° 322 mi. Worked 3 times, confirmed.');
  assert.strictEqual(CC.summaryLine({ ...base, history: [] }), 'Jane Sample, Springfield, MA, United States. 45° 322 mi. Not worked before.');
  assert.strictEqual(CC.summaryLine({ ...base, qrz: null, qrzState: 'off', history: [history[0]], ownGrid: '', prefix: null }), 'Worked once, not confirmed yet.');
});

test('where(): the weather is asked for a grid square centre only', () => {
  const p = CC.where(base);
  assert.strictEqual(p.grid4, 'FN32');
  assert.ok(Math.abs(p.lat - 42.5) < 0.01 && Math.abs(p.lon - -73) < 0.01, 'the 4-character square centre, not the street');
  assert.strictEqual(CC.where({ ...base, qrz: null, history: [], prefix: null }), null);
});

test('this test is in the list CI runs', () => {
  assert.ok(readSrc(path.join(__dirname, '..', 'scripts', 'run-tests.js')).includes("'test/contact-card-test.js'"));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
