#!/usr/bin/env node
'use strict';
// Add a gateway (#585, plan docs/winlink-custom-gateways-plan.md phase 3): a
// gateway the operator types in is a My gateways entry marked as their own
// ("Mine"). This pins the form's checks, the dial POTACAT sets from the
// frequency typed, the stored entry (mine, note, via, bw), Edit and Remove,
// and the gateway list's own group with the Mine tag.
// Run: node test/winlink-my-gateways-test.js
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const M = require('../lib/winlink-my-gateways');
const F = require('../lib/winlink-favourites');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); }
}

const MODES = [
  { id: 'ardop', available: true }, { id: 'packet', available: true },
  { id: 'varafm', available: true }, { id: 'vara', available: true }, { id: 'telnet', available: true },
  { id: 'mercury', available: false },
];

console.log('call and SSID');
test('a gateway call, with or without an SSID up to 15', () => {
  for (const c of ['W2XYZ', 'W2XYZ-10', 'k4spb', 'K4PAR-2', 'VE3ABC-15', '2E0ABC', 'KH6ABC']) assert.ok(M.isCall(c), c);
  for (const c of ['', 'W2XYZ-16', 'W2XYZ-', 'HELLO', 'W2XYZ 10', 'W2X!Z', 'ABCDEFGHIJK1', 'W2XYZ-100', 'EOC-1']) assert.ok(!M.isCall(c), c);
});
test('the call error is the plan\'s words', () => {
  const r = M.validate({ call: 'club', mode: 'ardop', freq: '7101.4' }, { modes: MODES });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.errors.call, "That is not a callsign. Use the gateway's call, with -10 or similar if it has one.");
});
test('the call is upper-cased as typed', () => {
  const r = M.validate({ call: ' w2xyz-10 ', mode: 'packet', freq: '145.05' }, { modes: MODES });
  assert.ok(r.ok, JSON.stringify(r.errors));
  assert.strictEqual(r.entry.call, 'W2XYZ-10');
});

console.log('frequency');
test('kHz or MHz: below 1000 is MHz', () => {
  assert.strictEqual(M.parseFreqKhz('145.05'), 145050);
  assert.strictEqual(M.parseFreqKhz('145050'), 145050);
  assert.strictEqual(M.parseFreqKhz('7101.4'), 7101.4);
  assert.strictEqual(M.parseFreqKhz('7.1014'), 7101.4);
  assert.strictEqual(M.parseFreqKhz('3.5925'), 3592.5);
  assert.strictEqual(M.parseFreqKhz(' 14.1085 MHz'), 14108.5);
  assert.strictEqual(M.parseFreqKhz('7101.4 kHz'), 7101.4);
  assert.strictEqual(M.parseFreqKhz('145.050.00'), 145050, 'the way the VFO writes it');
  assert.strictEqual(M.parseFreqKhz('7,101.4'), 7101.4);
});
test('nothing, zero, text and above 1.5 GHz are refused', () => {
  for (const v of ['', '0', '-7', 'abc', '7101.4.5.6', '1600000', null, undefined]) assert.strictEqual(M.parseFreqKhz(v), null, String(v));
  const r = M.validate({ call: 'W2XYZ', mode: 'ardop', freq: 'soon' }, { modes: MODES });
  assert.strictEqual(r.errors.freq, 'Enter the frequency, for example 145.05 or 7101.4.');
});

console.log('the dial (Pat\'s Dial: app/freq.go)');
test('ARDOP, VARA HF and Mercury: the dial is the center less 1.5 kHz', () => {
  assert.strictEqual(M.dialKhz('ardop', 7101.4), 7099.9);
  assert.strictEqual(M.dialKhz('vara', 14108.5), 14107);
  assert.strictEqual(M.dialKhz('mercury', 3592.5), 3591);
});
test('packet and VARA FM: the dial is the channel', () => {
  assert.strictEqual(M.dialKhz('packet', 145050), 145050);
  assert.strictEqual(M.dialKhz('varafm', 145070), 145070);
});
test('the center comes back from a stored dial (Edit fills the form)', () => {
  assert.strictEqual(M.centerKhz('ardop', 7099.9), 7101.4);
  assert.strictEqual(M.centerKhz('packet', 145050), 145050);
});
test('the line under Frequency says the dial before Save', () => {
  assert.strictEqual(M.dialLine('ardop', '7101.4'), 'The radio dial will be 7.099.90 MHz, 1.5 kHz below the center frequency.');
  assert.strictEqual(M.dialLine('packet', '145.05'), 'The radio dial will be 145.050.00 MHz.');
  assert.strictEqual(M.dialLine('ardop', ''), '');
});
test('the entry stores the dial, as every favourite does', () => {
  const r = M.validate({ call: 'K4SPB', mode: 'ardop', freq: '7101.4' }, { modes: MODES });
  assert.ok(r.ok);
  assert.strictEqual(r.entry.dialKhz, 7099.9);
  assert.strictEqual(r.entry.mine, true);
});

console.log('mode, ARDOP bandwidth, via, note');
test('the mode must be a radio mode this station has available', () => {
  assert.ok(M.validate({ call: 'W2XYZ', mode: 'mercury', freq: '7101.4' }, { modes: MODES }).errors.mode);
  assert.ok(M.validate({ call: 'W2XYZ', mode: 'telnet', freq: '7101.4' }, { modes: MODES }).errors.mode);
  assert.ok(M.validate({ call: 'W2XYZ', mode: 'ardop', freq: '7101.4' }, { modes: MODES }).ok);
});
test('ARDOP bandwidth: one of 200, 500, 1000, 2000, or the operator\'s own setting (0)', () => {
  assert.strictEqual(M.validate({ call: 'W2XYZ', mode: 'ardop', freq: '7101.4', bw: '500' }, { modes: MODES }).entry.bw, 500);
  assert.strictEqual(M.validate({ call: 'W2XYZ', mode: 'ardop', freq: '7101.4', bw: '' }, { modes: MODES }).entry.bw, 0);
  assert.ok(!M.validate({ call: 'W2XYZ', mode: 'ardop', freq: '7101.4', bw: '750' }, { modes: MODES }).ok);
  assert.strictEqual(M.validate({ call: 'W2XYZ', mode: 'packet', freq: '145.05', bw: '500' }, { modes: MODES }).entry.bw, 0, 'ARDOP only');
});
test('via: packet only, up to two digipeater calls, spaces or commas', () => {
  assert.deepStrictEqual(M.parseVia('w2abc-1'), { ok: true, via: ['W2ABC-1'] });
  assert.deepStrictEqual(M.parseVia('W2ABC-1, K2DEF-3'), { ok: true, via: ['W2ABC-1', 'K2DEF-3'] });
  assert.deepStrictEqual(M.parseVia(''), { ok: true, via: [] });
  assert.strictEqual(M.parseVia('W2ABC-1 K2DEF-3 N2GHI').ok, false);
  assert.strictEqual(M.parseVia('W2ABC-1 RELAY*').ok, false);
  assert.strictEqual(M.parseVia('W2ABC-1 K2DEF-3 N2GHI').error, 'Via takes up to two digipeater calls, for example W2ABC-1.');
  const pk = M.validate({ call: 'W2XYZ-10', mode: 'packet', freq: '145.05', via: 'W2ABC-1' }, { modes: MODES });
  assert.deepStrictEqual(pk.entry.via, ['W2ABC-1']);
  const hf = M.validate({ call: 'W2XYZ', mode: 'ardop', freq: '7101.4', via: 'W2ABC-1' }, { modes: MODES });
  assert.deepStrictEqual(hf.entry.via, [], 'not for ARDOP (Pat refuses digipeaters there)');
});
test('note: up to 60 printable characters, trimmed', () => {
  assert.strictEqual(M.validate({ call: 'W2XYZ', mode: 'ardop', freq: '7101.4', note: '  club net Tuesdays ' }, { modes: MODES }).entry.note, 'club net Tuesdays');
  const long = M.validate({ call: 'W2XYZ', mode: 'ardop', freq: '7101.4', note: 'x'.repeat(61) }, { modes: MODES });
  assert.strictEqual(long.errors.note, 'Keep the note to 60 characters or fewer.');
  assert.strictEqual(M.cleanNote('a\u0000b\nc'), 'ab c');
});

console.log('the stored entry (lib/winlink-favourites.js)');
const now = 1763800000000;
const mineArdop = { call: 'K4SPB', mode: 'ardop', khz: 7099.9, mine: true, note: 'club net', bw: 500 };
const minePacket = { call: 'W2XYZ-10', mode: 'packet', khz: 145050, mine: true, via: ['W2ABC-1'] };
test('clean keeps mine, note, via and bw when valid', () => {
  const a = F.clean(mineArdop);
  assert.strictEqual(a.mine, true); assert.strictEqual(a.note, 'club net'); assert.strictEqual(a.bw, 500);
  const p = F.clean(minePacket);
  assert.deepStrictEqual(p.via, ['W2ABC-1']);
});
test('clean drops each one that is not valid and keeps the entry', () => {
  const c = F.clean({ call: 'K4SPB', mode: 'ardop', khz: 7099.9, mine: 'yes', note: 'x'.repeat(80), via: ['W2ABC-1'], bw: 750 });
  assert.ok(c);
  assert.ok(!('mine' in c) && !('note' in c) && !('via' in c) && !('bw' in c), JSON.stringify(c));
  const p = F.clean({ call: 'W2XYZ-10', mode: 'packet', khz: 145050, via: ['W2ABC-1', 'K2DEF-3', 'N2GHI'] });
  assert.ok(!('via' in p), 'three is too many');
  const q = F.clean({ call: 'W2XYZ-10', mode: 'packet', khz: 145050, via: ['NOT A CALL'] });
  assert.ok(!('via' in q));
});
test('entries saved before this change are unchanged', () => {
  const old = F.clean({ call: 'KY4RY', mode: 'ardop', khz: 7100.5, url: 'ardop:///KY4RY?bw=2000MAX&freq=7100.5', savedAt: 5 });
  assert.deepStrictEqual(Object.keys(old).sort(), ['band', 'call', 'dialKhz', 'khz', 'lastGoodAt', 'mode', 'savedAt', 'url']);
});
test('Mine entries are never pushed out by starred ones (41 starred plus 3 Mine keeps 3 Mine)', () => {
  const list = [];
  for (let i = 0; i < 41; i++) list.push({ call: 'K4A' + String.fromCharCode(65 + (i % 26)) + (i < 26 ? '' : 'B'), mode: 'ardop', khz: 7000 + i });
  list.push({ ...mineArdop }, { ...minePacket }, { call: 'N2MIN', mode: 'varafm', khz: 145070, mine: true });
  const n = F.normalize(list);
  assert.strictEqual(n.filter((x) => x.mine).length, 3);
  assert.strictEqual(n.filter((x) => !x.mine).length, F.MAX);
});
test('add with mine saves a Mine entry at the top', () => {
  const r = F.add([{ call: 'KY4RY', mode: 'ardop', khz: 7100.5 }], minePacket, now);
  assert.ok(r.ok);
  assert.strictEqual(r.list[0].call, 'W2XYZ-10');
  assert.strictEqual(r.list[0].mine, true);
});
test('the star on a listed row never sets mine; starring a Mine entry changes nothing', () => {
  const start = F.add([], mineArdop, now).list;
  const r = F.add(start, { call: 'K4SPB', mode: 'ardop', khz: 7099.9, url: 'ardop:///K4SPB?bw=2000MAX&freq=7099.9' }, now + 5);
  assert.ok(r.ok);
  assert.deepStrictEqual(r.list, start);
});
test('edit replaces the entry named by was, in one save', () => {
  const start = F.add(F.add([], mineArdop, now).list, { call: 'KY4RY', mode: 'ardop', khz: 7100.5 }, now).list;
  const r = F.edit(start, { call: 'K4SPB', mode: 'ardop', dialKhz: 7099.9 }, { call: 'K4SPB', mode: 'ardop', khz: 3591, mine: true, note: '80 m at night' }, now + 9);
  assert.ok(r.ok, r.error);
  assert.ok(!r.list.some((x) => x.call === 'K4SPB' && x.khz === 7099.9), 'the old one is gone');
  const e = r.list.find((x) => x.call === 'K4SPB');
  assert.strictEqual(e.khz, 3591); assert.strictEqual(e.note, '80 m at night'); assert.strictEqual(e.mine, true);
  assert.strictEqual(e.savedAt, now, 'keeps when it was first saved');
  assert.ok(r.list.some((x) => x.call === 'KY4RY'), 'others stay');
});
test('edit with a bad entry changes nothing and says why', () => {
  const start = F.add([], mineArdop, now).list;
  const r = F.edit(start, { call: 'K4SPB', mode: 'ardop', dialKhz: 7099.9 }, { call: 'K4SPB', mode: 'ardop', khz: 0, mine: true });
  assert.strictEqual(r.ok, false);
  assert.ok(r.error);
  assert.deepStrictEqual(r.list, start);
});
test('remove takes a Mine entry out', () => {
  const start = F.add(F.add([], mineArdop, now).list, minePacket, now).list;
  const out = F.remove(start, { call: 'K4SPB', mode: 'ardop', khz: 7099.9 });
  assert.ok(!out.some((x) => x.call === 'K4SPB'));
  assert.ok(out.some((x) => x.call === 'W2XYZ-10'));
});
test('findMine finds a typed entry by call, mode and dial, and nothing else', () => {
  const list = F.add(F.add([], mineArdop, now).list, { call: 'KY4RY', mode: 'ardop', khz: 7100.5 }, now).list;
  assert.strictEqual(F.findMine(list, { call: 'k4spb', mode: 'ardop', dialKhz: 7099.9 }).call, 'K4SPB');
  assert.strictEqual(F.findMine(list, { call: 'KY4RY', mode: 'ardop', dialKhz: 7100.5 }), null, 'starred, not typed');
  assert.strictEqual(F.findMine(list, { call: 'K4SPB', mode: 'vara', dialKhz: 7099.9 }), null);
  assert.strictEqual(F.findMine(list, { call: 'K4SPB', mode: 'ardop', dialKhz: 7100.5 }), null);
});

console.log('the gateway list: its own group, the Mine tag');
const favs = F.normalize([
  { ...mineArdop }, { call: 'N3MIN', mode: 'ardop', khz: 14105, mine: true },
  { call: 'KY4RY', mode: 'ardop', khz: 7100.5 }, { call: 'KG4OCM', mode: 'ardop', khz: 10145 }, { ...minePacket },
]);
const pat = [{ call: 'KY4RY', dialKhz: 7100.5, band: '40m' }, { call: 'K4SPB', dialKhz: 7099.9, band: '40m' }, { call: 'W1AW', dialKhz: 7102, band: '40m' }];
test('Mine entries for this mode are their own group, above the ranked list', () => {
  const g = M.pickerGroups({ favourites: favs, gateways: pat, mode: 'ardop', band: '' });
  assert.deepStrictEqual(g.mine.map((x) => x.call), ['K4SPB', 'N3MIN']);
  assert.strictEqual(M.MINE_GROUP, 'My own gateways');
});
test('a Mine entry Pat also lists shows once, in the Mine group', () => {
  const g = M.pickerGroups({ favourites: favs, gateways: pat, mode: 'ardop', band: '' });
  assert.deepStrictEqual(g.ranked.map((x) => x.call), ['KY4RY', 'W1AW']);
});
test('starred entries Pat did not list stay in their own group; the band filter applies', () => {
  const g = M.pickerGroups({ favourites: favs, gateways: pat, mode: 'ardop', band: '' });
  assert.deepStrictEqual(g.missing.map((x) => x.call), ['KG4OCM']);
  const b = M.pickerGroups({ favourites: favs, gateways: pat, mode: 'ardop', band: '40m' });
  assert.deepStrictEqual(b.mine.map((x) => x.call), ['K4SPB']);
  assert.deepStrictEqual(b.missing, []);
});
test('the Mine row reads: star, call, Mine, dial, note', () => {
  assert.strictEqual(M.mineLabel(favs[0]), '★ K4SPB  Mine  7.099.90 MHz  club net');
  assert.strictEqual(M.mineLabel(F.clean(minePacket)), '★ W2XYZ-10  Mine  145.050.00 MHz  via W2ABC-1');
});

console.log('one module for every surface');
test('the module is dual-mode (window.WinlinkMine) and needs no Node module in the page', () => {
  const src = readSrc(path.join(__dirname, '..', 'lib', 'winlink-my-gateways.js'));
  assert.ok(/root\.WinlinkMine = /.test(src));
  assert.ok(!/require\('(?!\.\/freq-dots)/.test(src), 'only freq-dots, which the page already loads');
});
test('this test is in the list CI runs', () => {
  assert.ok(readSrc(path.join(__dirname, '..', 'scripts', 'run-tests.js')).includes("'test/winlink-my-gateways-test.js'"));
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
