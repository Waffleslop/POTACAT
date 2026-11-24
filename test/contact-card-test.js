#!/usr/bin/env node
'use strict';
// Contact details (Discord "Jump", 2026-11-23): one window that shows the
// station behind a callsign, opened from the Logbook and from the Log QSO
// window. lib/contact-card.js turns a QRZ record, the log's history with the
// call, the clicked QSO and the operator's own grid into what the window
// shows: the worked / confirmed line, bearing short and long path, distance in
// the operator's units, local time, the mailing address and the QSL routes.
// A field nobody knows is left out, never shown empty.
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
  { date: '20260720', time: '1432', band: '20m', mode: 'SSB', ref: 'POTA US-1234', qsl: 'L' },
  { date: '20250301', time: '0910', band: '40M', mode: 'CW', ref: '', qsl: '' },
];
const prefixUS = { entity: 'United States', dxcc: 291, cqZone: 5, ituZone: 8, lat: 37.53, lon: -91.67, source: 'cty' };
// 2026-11-23 15:00 UTC
const NOW = Date.UTC(2026, 10, 23, 15, 0, 0);
const base = { call: 'W1XYZ', qrz: qrzFull, qrzState: 'subscriber', history, ownGrid: 'FM18lv', distUnit: 'mi', prefix: prefixUS, now: NOW };
const fact = (vm, key) => { const f = vm.facts.find((x) => x.key === key); return f ? f.value : undefined; };

console.log('Contact details: the view model');

test('header: worked twice, the last contact, confirmed by LoTW', () => {
  const vm = CC.build(base);
  assert.strictEqual(vm.call, 'W1XYZ');
  assert.strictEqual(vm.header.text, 'Worked 2 times, last on 2026-07-20, 20m SSB. Confirmed by LoTW.');
  assert.strictEqual(vm.header.confirmed, true);
  assert.strictEqual(vm.header.count, 2);
});

test('header: once, not confirmed; never; confirmed by card and LoTW', () => {
  assert.strictEqual(CC.build({ ...base, history: [history[1]] }).header.text, 'Worked once, last on 2025-03-01, 40m CW. Not confirmed yet.');
  const none = CC.build({ ...base, history: [] });
  assert.strictEqual(none.header.text, 'Not worked before.');
  assert.strictEqual(none.header.confirmed, false);
  const both = CC.build({ ...base, history: [{ ...history[0], qsl: 'P' }, { ...history[1], qsl: 'LE' }] });
  assert.strictEqual(both.header.text, 'Worked 2 times, last on 2026-07-20, 20m SSB. Confirmed by LoTW, QSL card and eQSL.');
});

test('bearing short and long path, and distance in miles', () => {
  const vm = CC.build(base);
  // FM18lv (Washington DC area) to 42.1014, -72.5898 (Springfield MA)
  assert.ok(vm.path, 'a path');
  assert.strictEqual(vm.path.shortPath, '045°');
  assert.strictEqual(vm.path.longPath, '225°');
  assert.strictEqual(vm.path.distance, '322 mi');
  assert.strictEqual(vm.path.longDistance, '24,552 mi');
  assert.strictEqual(vm.path.approx, false);
});

test('distance in kilometres when the operator chose km', () => {
  const vm = CC.build({ ...base, distUnit: 'km' });
  assert.strictEqual(vm.path.distance, '518 km');
  assert.strictEqual(vm.path.longDistance, '39,512 km');
});

test('no own grid: no path (nothing made up)', () => {
  assert.strictEqual(CC.build({ ...base, ownGrid: '' }).path, null);
  assert.strictEqual(CC.build({ ...base, ownGrid: 'nonsense' }).path, null);
});

test('no QRZ position: the log grid, else the prefix (marked approximate)', () => {
  const fromLog = CC.build({ ...base, qrz: null, qrzState: 'off', record: { CALL: 'W1XYZ', GRIDSQUARE: 'FN32' } });
  assert.strictEqual(fromLog.path.approx, false);
  assert.strictEqual(fromLog.path.from, 'grid FN32');
  const fromPrefix = CC.build({ ...base, qrz: null, qrzState: 'off' });
  assert.strictEqual(fromPrefix.path.approx, true);
  assert.strictEqual(fromPrefix.path.from, 'United States (from the callsign)');
});

test('name, nickname and licence class', () => {
  const vm = CC.build(base);
  assert.strictEqual(vm.name, 'Jane Sample');
  assert.strictEqual(vm.nickname, 'Jan');
  assert.strictEqual(vm.licence, 'Amateur Extra');
  // Outside the US the class is shown as QRZ gives it.
  assert.strictEqual(CC.build({ ...base, qrz: { ...qrzFull, land: 'England', class: 'Full' } }).licence, 'Full');
});

test('mailing address for QSL cards, with the text the Copy button copies', () => {
  const vm = CC.build(base);
  assert.deepStrictEqual(vm.address.lines, ['Jane Sample', 'c/o Club Station', '12 Example Road', 'Springfield, MA 01101', 'United States']);
  assert.strictEqual(vm.address.copy, 'Jane Sample\nc/o Club Station\n12 Example Road\nSpringfield, MA 01101\nUnited States');
  assert.strictEqual(fact(vm, 'county'), 'Hampden');
});

test('location facts: grid, DXCC number and name, zones, IOTA, and the park from the log', () => {
  const vm = CC.build(base);
  assert.strictEqual(fact(vm, 'grid'), 'FN32rc');
  assert.strictEqual(fact(vm, 'dxcc'), '291 United States');
  assert.strictEqual(fact(vm, 'zones'), 'CQ 5, ITU 8');
  assert.strictEqual(fact(vm, 'iota'), 'NA-046');
  assert.strictEqual(fact(vm, 'refs'), 'POTA US-1234 (last contact)');
});

test('QSL routes, e-mail, the QRZ page and aliases', () => {
  const vm = CC.build(base);
  assert.strictEqual(fact(vm, 'qslvia'), 'LoTW, Mail');
  assert.strictEqual(fact(vm, 'qslmgr'), 'Direct or bureau');
  assert.strictEqual(vm.email, 'jane@example.invalid');
  assert.deepStrictEqual(vm.links, [{ label: 'QRZ page', url: 'https://www.qrz.com/db/W1XYZ' }]);
  assert.strictEqual(fact(vm, 'aliases'), 'W1XYZ/P, KA1XYZ');
});

test('photo: only an https address is used', () => {
  assert.strictEqual(CC.build(base).photo, 'https://cdn-xml.qrz.com/z/w1xyz/photo.jpg');
  assert.strictEqual(CC.build({ ...base, qrz: { ...qrzFull, image: 'http://x/y.jpg' } }).photo, '');
  assert.strictEqual(CC.build({ ...base, qrz: { ...qrzFull, image: 'javascript:alert(1)' } }).photo, '');
});

test('local time: QRZ offset with summer time is approximate; outside summer it is the offset', () => {
  const nov = CC.build(base); // November: Eastern standard time, -5
  assert.strictEqual(nov.time.offsetMinutes, -300);
  assert.strictEqual(nov.time.text, '10:00');
  assert.strictEqual(nov.time.utc, 'UTC-5');
  const jul = CC.build({ ...base, now: Date.UTC(2026, 6, 1, 15, 0, 0) });
  assert.strictEqual(jul.time.offsetMinutes, -240, 'summer time adds an hour');
  assert.strictEqual(jul.time.approx, true);
});

test('local time: from the weather service when it answered (exact), else from longitude (approximate)', () => {
  const w = CC.build({ ...base, weather: { tempC: 12.4, text: 'Light rain', utcOffsetSeconds: -18000 } });
  assert.strictEqual(w.time.offsetMinutes, -300);
  assert.strictEqual(w.time.approx, false);
  const lon = CC.build({ ...base, qrz: null, qrzState: 'off', record: { CALL: 'W1XYZ', GRIDSQUARE: 'FN32' } });
  assert.strictEqual(lon.time.approx, true);
  assert.strictEqual(lon.time.offsetMinutes, -300, 'longitude -71 is UTC-5');
});

test('weather: in the operator units, and hidden when there is none', () => {
  const w = { tempC: 12.4, text: 'Light rain', utcOffsetSeconds: -18000 };
  assert.strictEqual(CC.build({ ...base, weather: w }).weather.text, '54 °F, light rain');
  assert.strictEqual(CC.build({ ...base, distUnit: 'km', weather: w }).weather.text, '12 °C, light rain');
  assert.strictEqual(CC.build(base).weather, null);
});

test('the clicked Logbook contact: its own line, its notes, its park first', () => {
  const record = { CALL: 'W1XYZ', QSO_DATE: '20260720', TIME_ON: '143200', BAND: '20M', MODE: 'SSB', SIG: 'POTA', SIG_INFO: 'US-0001', COMMENT: 'Mobile, great signal' };
  const vm = CC.build({ ...base, record });
  assert.strictEqual(vm.thisContact, '2026-07-20 14:32 UTC, 20m SSB, POTA US-0001');
  assert.strictEqual(vm.notes, 'Mobile, great signal');
  assert.strictEqual(fact(vm, 'refs'), 'POTA US-0001 (this contact)');
});

test('without QRZ: name and town from the log, DXCC and zones from the prefix, a quiet note', () => {
  const record = { CALL: 'W1XYZ', NAME: 'Jane', QTH: 'Springfield', STATE: 'MA', GRIDSQUARE: 'FN32' };
  const vm = CC.build({ ...base, qrz: null, qrzState: 'off', record });
  assert.strictEqual(vm.name, 'Jane');
  assert.strictEqual(vm.photo, '');
  assert.strictEqual(vm.address, null, 'no mailing address without QRZ');
  assert.strictEqual(fact(vm, 'qth'), 'Springfield, MA');
  assert.strictEqual(fact(vm, 'dxcc'), '291 United States');
  assert.strictEqual(fact(vm, 'zones'), 'CQ 5, ITU 8');
  assert.strictEqual(vm.qrzNote, 'Turn on QRZ.com lookups (Settings > Station) for the name and town. A QRZ XML Data subscription adds the photo and the mailing address.');
});

test('a QRZ login with no XML subscription: what QRZ gave, and one quiet line', () => {
  const vm = CC.build({ ...base, call: 'G4ABC', qrz: qrzThin, qrzState: 'no-subscription', history: [], prefix: { entity: 'England', dxcc: 223, cqZone: 14, ituZone: 27, lat: 52.8, lon: -1.5, source: 'cty' } });
  assert.strictEqual(vm.name, "Peter O'Brien");
  assert.strictEqual(fact(vm, 'qth'), 'Bristol, England');
  assert.strictEqual(vm.address, null);
  assert.strictEqual(vm.qrzNote, 'A QRZ XML Data subscription adds the photo and the mailing address.');
});

test('a subscriber with a full record: no note at all; a call QRZ does not know says so', () => {
  assert.strictEqual(CC.build(base).qrzNote, '');
  assert.strictEqual(CC.build({ ...base, qrz: null }).qrzNote, 'QRZ.com has no record for W1XYZ.');
  assert.strictEqual(CC.build({ ...base, qrz: null, qrzState: 'login-failed' }).qrzNote, 'QRZ.com did not accept the login, so this shows only what the log knows. Check it in Settings > Station.');
});

test('missing fields are left out, never shown empty', () => {
  const vm = CC.build({ call: 'XX9XX', qrz: null, qrzState: 'off', history: [], ownGrid: '', distUnit: 'mi', prefix: null, now: NOW });
  assert.deepStrictEqual(vm.facts, []);
  assert.strictEqual(vm.name, '');
  assert.strictEqual(vm.path, null);
  assert.strictEqual(vm.time, null);
  assert.strictEqual(vm.email, '');
  for (const f of CC.build(base).facts) assert.ok(String(f.value).trim(), f.key + ' has a value');
});

test('where(): the position the weather is asked for, to a grid square only', () => {
  const p = CC.where(base);
  assert.strictEqual(p.grid4, 'FN32');
  assert.ok(Math.abs(p.lat - 42.5) < 0.01 && Math.abs(p.lon - -73) < 0.01, 'the 4-character square centre, not the street');
  assert.strictEqual(CC.where({ ...base, qrz: null, prefix: null }), null);
});

test('this test is in the list CI runs', () => {
  assert.ok(readSrc(path.join(__dirname, '..', 'scripts', 'run-tests.js')).includes("'test/contact-card-test.js'"));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
