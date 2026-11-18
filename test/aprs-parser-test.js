#!/usr/bin/env node
'use strict';
// APRS packet parser (lib/aprs-parser.js): APRS-IS TNC2 lines into plain
// objects for the APRS window. Fixtures are the APRS 1.0.1 spec's worked
// examples typed in by hand, plus lines built here and decoded by hand
// (the Mic-E one is worked out byte by byte below).
// Run: node test/aprs-parser-test.js

const assert = require('assert');
const P = require('../lib/aprs-parser');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= (eps || 1e-4), (msg || '') + ` ${a} != ${b}`);

console.log('APRS parser');

test('header: source, destination and path', () => {
  const p = P.parse('N0CALL-9>APRS,WIDE1-1,WIDE2-1,qAR,K3SBP-10:>On the air');
  assert.strictEqual(p.from, 'N0CALL-9');
  assert.strictEqual(p.to, 'APRS');
  assert.deepStrictEqual(p.path, ['WIDE1-1', 'WIDE2-1', 'qAR', 'K3SBP-10']);
  assert.strictEqual(p.igate, 'K3SBP-10', 'the station after the q construct gated it');
  assert.strictEqual(p.raw, 'N0CALL-9>APRS,WIDE1-1,WIDE2-1,qAR,K3SBP-10:>On the air');
});

test('uncompressed position, no timestamp, no messaging (!)', () => {
  const p = P.parse('W1AW>APRS,TCPIP*,qAC,T2TEST:!4903.50N/07201.75W-Test 001234');
  assert.strictEqual(p.type, 'position');
  assert.strictEqual(p.format, 'uncompressed');
  near(p.lat, 49 + 3.5 / 60);
  near(p.lon, -(72 + 1.75 / 60));
  assert.strictEqual(p.symbolTable, '/');
  assert.strictEqual(p.symbol, '-');
  assert.strictEqual(p.comment, 'Test 001234');
  assert.strictEqual(p.messaging, false);
  assert.strictEqual(p.timestamp, null);
});

test('uncompressed position with messaging (=), southern and eastern hemispheres', () => {
  const p = P.parse('VK2ABC>APRS:=3351.50S/15112.25E#Sydney digi');
  near(p.lat, -(33 + 51.5 / 60));
  near(p.lon, 151 + 12.25 / 60);
  assert.strictEqual(p.messaging, true);
  assert.strictEqual(p.symbol, '#');
  assert.strictEqual(p.comment, 'Sydney digi');
});

test('position with timestamp (@ zulu DHM) and course/speed', () => {
  const p = P.parse('W1AW>APRS:@092345z4903.50N/07201.75W>088/036');
  assert.strictEqual(p.type, 'position');
  assert.strictEqual(p.messaging, true);
  assert.deepStrictEqual(p.timestamp, { raw: '092345z', day: 9, hour: 23, minute: 45, second: null, zulu: true });
  near(p.lat, 49.058333);
  assert.strictEqual(p.symbol, '>');
  assert.strictEqual(p.course, 88);
  assert.strictEqual(p.speed, 36, 'knots, as sent');
  assert.strictEqual(p.comment, '');
});

test('position with timestamp (/ local DHM and HMS)', () => {
  const a = P.parse('W1AW>APRS:/092345/4903.50N/07201.75W>Test1234');
  assert.deepStrictEqual(a.timestamp, { raw: '092345/', day: 9, hour: 23, minute: 45, second: null, zulu: false });
  assert.strictEqual(a.messaging, false);
  assert.strictEqual(a.comment, 'Test1234');
  const b = P.parse('W1AW>APRS:/234517h4903.50N/07201.75W>');
  assert.deepStrictEqual(b.timestamp, { raw: '234517h', day: null, hour: 23, minute: 45, second: 17, zulu: true });
});

test('altitude in the comment (/A=feet)', () => {
  const p = P.parse('W1AW>APRS:!4903.50N/07201.75W-Test /A=001234');
  assert.strictEqual(p.altitude, 1234);
  assert.strictEqual(p.comment, 'Test');
  const n = P.parse('W1AW>APRS:!4903.50N/07201.75W-/A=-00012 below the sea');
  assert.strictEqual(n.altitude, -12);
});

test('position ambiguity: spaces in the minutes become the middle of the area', () => {
  const p = P.parse('W1AW>APRS:!4903.  N/07201.  W-');
  near(p.lat, 49 + 3.5 / 60, 1e-6);
  near(p.lon, -(72 + 1.5 / 60), 1e-6);
  assert.strictEqual(p.ambiguity, 2);
});

test('an overlay character as the symbol table', () => {
  const p = P.parse('W1AW>APRS:!4903.50N307201.75W#');
  assert.strictEqual(p.symbolTable, '3');
  assert.strictEqual(p.symbol, '#');
});

test('compressed position with course and speed (spec example)', () => {
  const p = P.parse('W1AW>APRS:=/5L!!<*e7>7P[');
  assert.strictEqual(p.type, 'position');
  assert.strictEqual(p.format, 'compressed');
  near(p.lat, 49.5);
  near(p.lon, -72.75);
  assert.strictEqual(p.symbolTable, '/');
  assert.strictEqual(p.symbol, '>');
  assert.strictEqual(p.course, 88);
  near(p.speed, 36.2, 0.1);
});

test('compressed position with altitude (spec example)', () => {
  const p = P.parse('W1AW>APRS:!/5L!!<*e7OS]S');
  near(p.lat, 49.5);
  assert.strictEqual(p.symbol, 'O');
  assert.ok(Math.abs(p.altitude - 10004) <= 1, 'altitude ' + p.altitude);
  assert.strictEqual(p.course, null);
});

test('compressed position with no course/speed and a comment', () => {
  const p = P.parse('W1AW>APRS:!/5L!!<*e7-  _Home');
  near(p.lon, -72.75);
  assert.strictEqual(p.symbol, '-');
  assert.strictEqual(p.course, null);
  assert.strictEqual(p.speed, null);
  assert.strictEqual(p.comment, 'Home');
});

// Mic-E, worked by hand. Target: 33 25.64 N, 112 07.74 W, 20 knots, course
// 251, altitude 331 m, message bits 1,0,0 (standard "Returning").
//  dest S32UVT: S=3 (bit 1), 3, 2, U=5 (north), V=6 (+100 longitude), T=4 (west)
//  info: ` then d+28 = 12+28 '(' , m+28 = 7+28 '#', h+28 = 74+28 'f',
//  SP = 82+28 'n' (820 knots mod 800 = 20), DC = 6+28 '"' (course 600 mod 400
//  = 200 hundreds), SE = 51+28 'O', symbol '>' table '/', then the altitude
//  "7Q} = (1*8281 + 22*91 + 48) - 10000 = 331 m.
test('Mic-E: latitude from the destination, longitude, speed and course from the info field', () => {
  const p = P.parse('N0CALL-9>S32UVT,WIDE1-1,qAR,K3SBP:`(#fn"O>/"7Q}Phoenix test');
  assert.strictEqual(p.type, 'position');
  assert.strictEqual(p.format, 'mic-e');
  near(p.lat, 33 + 25.64 / 60);
  near(p.lon, -(112 + 7.74 / 60));
  assert.strictEqual(p.speed, 20);
  assert.strictEqual(p.course, 251);
  assert.strictEqual(p.symbolTable, '/');
  assert.strictEqual(p.symbol, '>');
  assert.strictEqual(p.altitude, Math.round(331 * 3.28084), 'feet, like every other altitude');
  assert.strictEqual(p.micEMessage, 'Returning');
  assert.strictEqual(p.comment, 'Phoenix test');
  assert.strictEqual(p.to, 'S32UVT');
});

test('Mic-E: the old apostrophe type, east and longitude 180-189', () => {
  // dest 30PR50: 3, 0 (bits 0), P=0 (bit 1), R=2 (north), 5 (+0), 0 (east)
  // -> 30 02.50 N. Lon byte 'v' = 118-28 = 90 degrees, '!' = 5 minutes,
  // '!' = 5 hundredths -> 90 05.05 E.
  const p = P.parse("JA1ABC>30PR50:'v!!l!'k/");
  near(p.lat, 30 + 2.5 / 60);
  near(p.lon, 90 + 5 / 60 + 5 / 6000);
  assert.strictEqual(p.symbol, 'k');
  // Longitudes 100-109 are sent as 108-117 with the +100 offset (V in
  // position 5): byte 'l' (108-28 = 80) +100 = 180, and 180-189 maps to 100-109.
  const q = P.parse("JA1ABC>30PRV0:'l!!l!'k/");
  near(q.lon, 100 + 5.05 / 60);
});

test('Mic-E: emergency message bits, speed 0, course 0', () => {
  const p = P.parse('W1AW>4132P0:`l!!l!\x1c>/');
  // dest 4132P0: '4' '1' '3' are message bits 0,0,0 (Emergency); the 4th
  // character '2' is a digit, so the latitude is south.
  assert.strictEqual(p.micEMessage, 'Emergency');
  assert.strictEqual(p.speed, 0);
  assert.ok(p.lat < 0, 'char 4 a digit means south');
});

test('a Mic-E packet with a bad destination is rejected cleanly', () => {
  assert.strictEqual(P.parse('W1AW>APRS:`(#fn"O>/'), null);
  assert.strictEqual(P.parse('W1AW>S32U:`(#fn"O>/'), null, 'destination too short');
});

test('object (;): live, with timestamp and course/speed (spec example)', () => {
  const p = P.parse('N0CALL>APRS:;LEADER   *092345z4903.50N/07201.75W>088/036');
  assert.strictEqual(p.type, 'object');
  assert.strictEqual(p.name, 'LEADER');
  assert.strictEqual(p.live, true);
  assert.strictEqual(p.timestamp.raw, '092345z');
  near(p.lat, 49.058333);
  assert.strictEqual(p.course, 88);
  assert.strictEqual(p.speed, 36);
});

test('object (;): killed, and compressed position', () => {
  const p = P.parse('N0CALL>APRS:;LEADER   _092345z/5L!!<*e7>7P[');
  assert.strictEqual(p.live, false);
  near(p.lat, 49.5);
});

test('item ()): name ends at ! (live) or _ (killed)', () => {
  const p = P.parse('N0CALL>APRS:)AID #2!4903.50N/07201.75WA');
  assert.strictEqual(p.type, 'item');
  assert.strictEqual(p.name, 'AID #2');
  assert.strictEqual(p.live, true);
  assert.strictEqual(p.symbol, 'A');
  const k = P.parse('N0CALL>APRS:)G/WB4APR_4903.50N/07201.75WA');
  assert.strictEqual(k.name, 'G/WB4APR');
  assert.strictEqual(k.live, false);
  assert.strictEqual(P.parse('N0CALL>APRS:)AB!4903.50N/07201.75WA'), null, 'a name is 3 to 9 characters');
});

test('status (>), with and without a timestamp', () => {
  const a = P.parse('N0CALL>APRS:>Net Control Center');
  assert.strictEqual(a.type, 'status');
  assert.strictEqual(a.status, 'Net Control Center');
  assert.strictEqual(a.lat, null);
  const b = P.parse('N0CALL>APRS:>092345zNet Control Center');
  assert.strictEqual(b.status, 'Net Control Center');
  assert.strictEqual(b.timestamp.day, 9);
});

test('message (:ADDRESSEE:text{id}), ack and rej: parsed only', () => {
  const m = P.parse('KB2ICI-14>APRS::WU2Z     :Testing{003');
  assert.strictEqual(m.type, 'message');
  assert.deepStrictEqual(m.message, { addressee: 'WU2Z', text: 'Testing', id: '003', ack: null, rej: null });
  const a = P.parse('WU2Z>APRS::KB2ICI-14:ack003');
  assert.deepStrictEqual(a.message, { addressee: 'KB2ICI-14', text: '', id: null, ack: '003', rej: null });
  const r = P.parse('WU2Z>APRS::KB2ICI-14:rej003');
  assert.strictEqual(r.message.rej, '003');
  const n = P.parse('WU2Z>APRS::BLN1     :Snow on the mountain');
  assert.strictEqual(n.message.text, 'Snow on the mountain');
  assert.strictEqual(n.message.id, null);
  assert.strictEqual(P.parse('WU2Z>APRS::SHORT:hi'), null, 'the addressee field is exactly 9 characters');
});

test('weather in the position comment (wind, gust, temperature, rain, humidity, pressure)', () => {
  const p = P.parse('W1AW>APRS:@092345z4903.50N/07201.75W_220/004g005t077r000p000P000h50b09900wRSW');
  assert.strictEqual(p.type, 'position');
  assert.strictEqual(p.symbol, '_');
  assert.deepStrictEqual(p.weather, {
    windDir: 220, windSpeed: 4, windGust: 5, tempF: 77,
    rain1h: 0, rain24h: 0, rainMidnight: 0, humidity: 50, pressure: 990.0,
  });
  assert.strictEqual(p.course, null, 'a weather station\'s 220/004 is wind, not course');
  assert.strictEqual(p.speed, null);
});

test('weather: below freezing, humidity 00 is 100, missing fields', () => {
  const p = P.parse('W1AW>APRS:!4903.50N/07201.75W_.../...g...t-05h00b10132');
  assert.strictEqual(p.weather.tempF, -5);
  assert.strictEqual(p.weather.humidity, 100);
  assert.strictEqual(p.weather.windDir, null);
  assert.strictEqual(p.weather.windGust, null);
  assert.strictEqual(p.weather.pressure, 1013.2);
});

test('positionless weather (_) has weather and no position', () => {
  const p = P.parse('W1AW>APRS:_10090556c220s004g005t077r000p000P000h50b09900wRSW');
  assert.strictEqual(p.type, 'weather');
  assert.strictEqual(p.lat, null);
  assert.strictEqual(p.weather.windDir, 220);
  assert.strictEqual(p.weather.tempF, 77);
});

test('third party (}): the inner packet is unwrapped, the carrier is kept', () => {
  const p = P.parse('N0GW>APRS,TCPIP*,qAC,T2TEXAS:}W1AW>APRS,TCPIP,N0GW*:=4134.00N/07243.00W-Hartford');
  assert.strictEqual(p.from, 'W1AW');
  assert.strictEqual(p.type, 'position');
  near(p.lat, 41 + 34 / 60);
  assert.strictEqual(p.comment, 'Hartford');
  assert.deepStrictEqual(p.thirdParty, { from: 'N0GW', to: 'APRS', path: ['TCPIP*', 'qAC', 'T2TEXAS'] });
  assert.strictEqual(P.parse('N0GW>APRS:}garbage'), null, 'an inner line that does not parse rejects the whole');
  assert.strictEqual(P.parse('A>B:}C>D:}E>F:}G>H:}I>J:}K>L:>deep'), null, 'nesting is bounded');
});

test('other types are kept with no position, never thrown on', () => {
  const t = P.parse('N0CALL>APRS:T#005,199,000,255,073,123,01101001');
  assert.strictEqual(t.type, 'other');
  assert.strictEqual(t.lat, null);
});

test('server comments, blank and garbage lines are rejected cleanly', () => {
  const bad = [
    '# aprsc 2.1.14-g5e22b37',
    '# logresp N0CALL unverified, server T2TEST',
    '',
    '   ',
    null,
    undefined,
    42,
    'no header at all',
    '>APRS:!4903.50N/07201.75W-',
    'W1AW>:!4903.50N/07201.75W-',
    'W1AW>APRS:',
    'W1 AW>APRS:!4903.50N/07201.75W-',
    'W1AW>APRS:!4903.50X/07201.75W-',
    'W1AW>APRS:!9903.50N/07201.75W-',
    'W1AW>APRS:!4903.50N/19201.75W-',
    'W1AW>APRS:!49',
    'W1AW>APRS:@0923',
    'W1AW>APRS:;SHORT',
    'W1AW>APRS:=/5L!!',
  ];
  for (const line of bad) {
    let r;
    assert.doesNotThrow(() => { r = P.parse(line); }, 'threw on ' + JSON.stringify(line));
    assert.strictEqual(r, null, 'accepted ' + JSON.stringify(line));
  }
});

test('a trailing CR/LF is ignored', () => {
  const p = P.parse('W1AW>APRS:!4903.50N/07201.75W-Test\r\n');
  assert.strictEqual(p.comment, 'Test');
});

test('symbol class: station, vehicle, weather, object', () => {
  assert.strictEqual(P.symbolClass('/', '-'), 'station');
  assert.strictEqual(P.symbolClass('/', '>'), 'vehicle');
  assert.strictEqual(P.symbolClass('/', 'k'), 'vehicle');
  assert.strictEqual(P.symbolClass('/', '_'), 'weather');
  assert.strictEqual(P.symbolClass('\\', '_'), 'weather');
  assert.strictEqual(P.symbolClass('/', '#'), 'station');
  assert.strictEqual(P.symbolClass('/', 'A', 'item'), 'object');
  assert.strictEqual(P.symbolClass('/', '>', 'object'), 'object');
});

test('dual mode: window.AprsParser in a page', () => {
  const fs = require('fs');
  const vm = require('vm');
  const src = fs.readFileSync(require.resolve('../lib/aprs-parser'), 'utf8');
  const sandbox = { window: {} };
  sandbox.self = sandbox.window;
  vm.runInNewContext(src, sandbox);
  assert.strictEqual(typeof sandbox.window.AprsParser.parse, 'function');
});

test('this test is in the list CI runs', () => {
  const fs = require('fs');
  const path = require('path');
  assert.ok(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'run-tests.js'), 'utf8').includes("'test/aprs-parser-test.js'"));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
