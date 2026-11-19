#!/usr/bin/env node
'use strict';
// APRS phase 5: the beacon over APRS-IS (lib/aprs-beacon.js). Sources:
//   APRS Protocol Reference 1.0.1, chapter 6 (Time and Position Formats):
//     position ambiguity, "4903.  N represents latitude to nearest minute",
//     and "The level of ambiguity specified in the latitude will
//     automatically apply to the longitude as well".
//   Chapter 8 (Position and DF Report Data Formats): '!' = position without
//     timestamp, no APRS messaging; the comment after a position is at most
//     43 characters.
//   Appendix 2 (symbol tables): /- house, /; campground (portable ops),
//     /> car, /[ human (hiker), /s ship (power boat).
//   aprs.org/aprs11/SSIDs.txt: "-10 internet, Igates, echolink, winlink, ...".
//   APRS tocalls: APZxxx is the experimental block.
// Run: node test/aprs-beacon-test.js

const assert = require('assert');
const B = require('../lib/aprs-beacon');
const AprsSymbols = require('../lib/aprs-symbols');
const AprsParser = require('../lib/aprs-parser');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

const ok = (o) => B.buildBeacon(Object.assign({ settingsCall: 'K3ABC', lat: 41.7123, lon: -72.6543, symbol: 'house', comment: 'POTACAT', approx: false }, o));

test('the packet: CALL-10>APZPCT,TCPIP*:!lat/lon symbol comment', () => {
  const r = ok();
  assert.ok(r.ok, r.sentence);
  assert.strictEqual(r.packet, 'K3ABC-10>APZPCT,TCPIP*:!4142.74N/07239.26W-POTACAT');
  assert.strictEqual(r.call, 'K3ABC-10');
  assert.strictEqual(B.TOCALL, 'APZPCT');
  assert.strictEqual(B.PATH, 'TCPIP*');
});

test('the SSID is -10 (internet stations), whatever SSID Settings has', () => {
  assert.strictEqual(ok({ settingsCall: 'k3abc-7' }).call, 'K3ABC-10');
});

test('south and east, and minutes that round up to 60 carry into the degree', () => {
  assert.strictEqual(ok({ lat: -33.8688, lon: 151.2093 }).packet, 'K3ABC-10>APZPCT,TCPIP*:!3352.13S/15112.56E-POTACAT');
  assert.strictEqual(ok({ lat: 40.99999, lon: -73.999999 }).packet, 'K3ABC-10>APZPCT,TCPIP*:!4100.00N/07400.00W-POTACAT');
  assert.strictEqual(ok({ lat: 0, lon: 0.5 }).packet, 'K3ABC-10>APZPCT,TCPIP*:!0000.00N/00030.00E-POTACAT');
});

test('approximate position: two spaces in latitude and longitude, to the nearest minute (about 1 nmi), never rounded towards the true point', () => {
  const r = ok({ approx: true });
  assert.strictEqual(r.packet, 'K3ABC-10>APZPCT,TCPIP*:!4142.  N/07239.  W-POTACAT');
  // the phase 1 parser reads it back as ambiguity 2
  const p = AprsParser.parse(r.packet);
  assert.strictEqual(p.ambiguity, 2);
  assert.ok(Math.abs(p.lat - 41.7123) < 1 / 60 && Math.abs(p.lon - -72.6543) < 1 / 60, 'within the minute box');
  assert.strictEqual(B.AMBIGUITY_SPACES, 2);
});

test('the symbol list: house, portable, car, hiker, boat; drawn with the phase 1 icons', () => {
  assert.deepStrictEqual(B.SYMBOLS.map((s) => s.id), ['house', 'portable', 'car', 'hiker', 'boat']);
  const codes = Object.fromEntries(B.SYMBOLS.map((s) => [s.id, s.table + s.code]));
  assert.deepStrictEqual(codes, { house: '/-', portable: '/;', car: '/>', hiker: '/[', boat: '/s' });
  assert.strictEqual(AprsSymbols.iconFor('/', '-'), 'house');
  assert.strictEqual(AprsSymbols.iconFor('/', '>'), 'car');
  assert.strictEqual(AprsSymbols.iconFor('/', '['), 'hiker');
  assert.strictEqual(AprsSymbols.iconFor('/', 's'), 'boat');
  for (const s of B.SYMBOLS) assert.strictEqual(s.icon, AprsSymbols.iconFor(s.table, s.code), s.id);
  assert.strictEqual(ok({ symbol: 'car' }).packet, 'K3ABC-10>APZPCT,TCPIP*:!4142.74N/07239.26W>POTACAT');
  assert.strictEqual(ok({ symbol: 'nonsense' }).packet, ok({ symbol: 'house' }).packet, 'an unknown symbol is the house');
});

test('the comment: POTACAT by default, at most 43 characters, printable only, no | or ~', () => {
  assert.strictEqual(B.DEFAULT_COMMENT, 'POTACAT');
  assert.strictEqual(B.MAX_COMMENT, 43);
  assert.strictEqual(B.cleanComment(undefined), 'POTACAT');
  assert.strictEqual(B.cleanComment(''), '');
  assert.strictEqual(B.cleanComment('x'.repeat(60)).length, 43);
  assert.strictEqual(B.cleanComment('Park K-0001\r\n|~ oké'), 'Park K-0001 ok');
  assert.ok(!/[\r\n]/.test(ok({ comment: 'a\nb' }).packet));
});

test('the timer: Off, 10, 20 or 30 minutes; never under 10 minutes, whatever is asked', () => {
  assert.deepStrictEqual(B.INTERVALS, [0, 10, 20, 30]);
  assert.strictEqual(B.MIN_INTERVAL_MIN, 10);
  assert.strictEqual(B.intervalMinutes(0), 0);
  assert.strictEqual(B.intervalMinutes(undefined), 0);
  assert.strictEqual(B.intervalMinutes('off'), 0);
  assert.strictEqual(B.intervalMinutes(20), 20);
  assert.strictEqual(B.intervalMinutes(1), 10);
  assert.strictEqual(B.intervalMinutes(0.5), 10);
  assert.strictEqual(B.intervalMinutes(-5), 0);
  assert.strictEqual(B.intervalMinutes(9999), 30, 'the longest choice');
  // the next timed beacon never comes sooner than the interval after the last one, manual or timed
  // Casey 2026-11-19: picking an interval, or opening the window with one saved, never sends at once.
  // The first timed beacon is one interval after the later of the last beacon and the pick/open.
  assert.strictEqual(B.nextDueMs({ intervalMin: 10, lastAt: 0, now: 1000 }), 600000, 'never beaconed: one interval from now');
  assert.strictEqual(B.nextDueMs({ intervalMin: 10, lastAt: 0, armedAt: 1000, now: 1000 }), 600000, 'picked now: one interval');
  assert.strictEqual(B.nextDueMs({ intervalMin: 10, lastAt: 1000, armedAt: 3600000, now: 3600000 }), 600000, 'last beacon an hour ago: still one interval after the open');
  assert.strictEqual(B.nextDueMs({ intervalMin: 10, lastAt: 300000, armedAt: 200000, now: 400000 }), 500000, 'the last beacon is later: from it');
  assert.strictEqual(B.nextDueMs({ intervalMin: 10, lastAt: 0, armedAt: 1000, now: 601000 }), 0, 'due once the interval has passed');
  assert.strictEqual(B.nextDueMs({ intervalMin: 10, lastAt: 1000, now: 61000 }), 540000);
  assert.strictEqual(B.nextDueMs({ intervalMin: 1, lastAt: 1000, now: 61000 }), 540000, 'the minimum holds');
  assert.strictEqual(B.nextDueMs({ intervalMin: 0, lastAt: 0, now: 1 }), -1, 'off');
});

test('the last beacon time read back from settings: a number in the past, else 0', () => {
  assert.strictEqual(B.lastBeaconAt({ aprsBeaconLastAt: 5000 }, 10000), 5000);
  assert.strictEqual(B.lastBeaconAt({ aprsBeaconLastAt: 50000 }, 10000), 10000, 'a clock set back counts as now, never as long ago');
  assert.strictEqual(B.lastBeaconAt({}, 10000), 0);
  assert.strictEqual(B.lastBeaconAt({ aprsBeaconLastAt: 'x' }, 10000), 0);
  assert.strictEqual(B.lastBeaconAt(null, 10000), 0);
});

test('refused in a plain sentence: no callsign, a placeholder, an invalid position', () => {
  const none = ok({ settingsCall: '' });
  assert.strictEqual(none.ok, false);
  assert.strictEqual(none.sentence, 'Set your callsign in Settings first.');
  for (const c of ['N0CALL', 'NOCALL', 'PCAT0420']) {
    const r = ok({ settingsCall: c });
    assert.strictEqual(r.reason, 'placeholder', c);
    assert.ok(/is a placeholder/.test(r.sentence));
  }
  for (const pos of [{ lat: null, lon: null }, { lat: 91, lon: 0 }, { lat: 10, lon: -181 }, { lat: NaN, lon: 1 }, { lat: '41', lon: undefined }]) {
    const r = ok(pos);
    assert.strictEqual(r.reason, 'position', JSON.stringify(pos));
    assert.strictEqual(r.sentence, 'Your position is not set. Set a grid square in Settings, or pick a point on the map.');
  }
});

test('the position: the point picked on the map when saved, else the centre of the Settings grid', () => {
  const g = (grid) => ({ FN31PR: { lat: 41.7292, lon: -72.7083 } })[String(grid).toUpperCase()] || null;
  assert.deepStrictEqual(B.beaconPosition({ lat: 41.5, lon: -72.1, grid: 'FN31pr', gridToLatLon: g }), { lat: 41.5, lon: -72.1, source: 'map' });
  assert.deepStrictEqual(B.beaconPosition({ lat: null, lon: null, grid: 'FN31pr', gridToLatLon: g }), { lat: 41.7292, lon: -72.7083, source: 'grid' });
  assert.deepStrictEqual(B.beaconPosition({ lat: 95, lon: 0, grid: 'FN31pr', gridToLatLon: g }), { lat: 41.7292, lon: -72.7083, source: 'grid' }, 'a bad saved point falls back');
  assert.strictEqual(B.beaconPosition({ lat: null, lon: null, grid: '', gridToLatLon: g }), null);
});

test('settings: aprsBeaconSymbol, aprsBeaconComment, aprsBeaconApprox (on by default), aprsBeaconIntervalMin (off by default), aprsBeaconLat, aprsBeaconLon', () => {
  const d = B.beaconSettings({});
  assert.deepStrictEqual(d, { symbol: 'house', comment: 'POTACAT', approx: true, intervalMin: 0, lat: null, lon: null });
  const s = B.beaconSettings({ aprsBeaconSymbol: 'boat', aprsBeaconComment: 'Hi', aprsBeaconApprox: false, aprsBeaconIntervalMin: 5, aprsBeaconLat: 41.5, aprsBeaconLon: -72.1 });
  assert.deepStrictEqual(s, { symbol: 'boat', comment: 'Hi', approx: false, intervalMin: 10, lat: 41.5, lon: -72.1 });
  // a patch from the window: only these keys, each cleaned
  assert.deepStrictEqual(B.settingsPatch({ symbol: 'car', comment: 'x'.repeat(50), approx: 'yes', intervalMin: 3, lat: 41.123456789, lon: -72.5, other: 1 }),
    { aprsBeaconSymbol: 'car', aprsBeaconComment: 'x'.repeat(43), aprsBeaconApprox: false, aprsBeaconIntervalMin: 10, aprsBeaconLat: 41.123457, aprsBeaconLon: -72.5 });
  assert.deepStrictEqual(B.settingsPatch({ lat: null, lon: null }), { aprsBeaconLat: null, aprsBeaconLon: null }, 'back to the grid');
  assert.deepStrictEqual(B.settingsPatch({ lat: 200, lon: 0 }), {}, 'an invalid point is not saved');
  assert.deepStrictEqual(B.settingsPatch({ symbol: 'nonsense' }), {});
});

test('our beacon coming back over the feed is recognised', () => {
  assert.strictEqual(B.isOwnBeacon({ from: 'K3ABC-10', to: 'APZPCT' }, 'K3ABC-10'), true);
  assert.strictEqual(B.isOwnBeacon({ from: 'K3ABC-10', to: 'APRS' }, 'K3ABC-10'), false);
  assert.strictEqual(B.isOwnBeacon({ from: 'K3ABC-9', to: 'APZPCT' }, 'K3ABC-10'), false);
});

console.log(`\nAPRS beacon: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
