#!/usr/bin/env node
'use strict';
// A Winlink radio session goes only where this radio can transmit (Casey
// 2026-11-11: "a user should never be able to attempt to send winlink via a
// freq they can't reach"). K3SBP's FLEX-8600 was offered packet gateway
// W9OU-10 on 149.09 MHz: in no amateur band, so the old band filter kept it;
// the pick sent listening to an HF-only WebSDR, Dire Wolf keyed three times,
// every key-down was refused, and the attempt went on until Stop. A Dire Wolf
// built before socket audio played the tones into his speakers.
// Run: node test/winlink-reach-test.js
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const R = require('../lib/winlink-reach');
const main = readSrc(path.join(__dirname, '..', 'main.js'));

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
const fnBody = (sig) => { const i = main.indexOf(sig); assert.ok(i >= 0, 'missing ' + sig); return main.slice(i, main.indexOf('\n}\n', i)); };

// A FLEX-8600 set up for 40 to 6 m, its range HF + 6 m.
const FLEX = { bands: ['40m', '30m', '20m', '17m', '15m', '12m', '10m', '6m'], reach: [[30000, 54000000]], rigName: 'FLEX-8600' };

console.log('Winlink: only gateways this radio can call');

test('149.09 MHz (W9OU-10) is refused: not an amateur band', () => {
  const r = R.gatewayReach(149090, FLEX);
  assert.strictEqual(r.ok, false);
  assert.match(r.why, /149\.09 MHz is not in an amateur band/);
  assert.strictEqual(R.gatewayReach(149090, {}).ok, false, 'even with nothing known about the radio');
  assert.strictEqual(R.gatewayReach(27185, {}).ok, false, 'CB is not amateur either');
  assert.strictEqual(R.gatewayReach(5000, {}).ok, false);
});

test('a band the radio is not set up for is refused, and says where to change it', () => {
  const r = R.gatewayReach(145090, FLEX);
  assert.strictEqual(r.ok, false);
  assert.match(r.why, /145\.09 MHz is on 2m, a band FLEX-8600 is not set up for \(Settings > My Rigs > Bands\)/);
  assert.strictEqual(R.gatewayReach(3588, FLEX).ok, false, '#336: 80 m on a radio set for 40 to 6 m');
});

test('outside the radio\'s range is refused even when the band is ticked', () => {
  const r = R.gatewayReach(145090, { bands: ['2m'], reach: [[30000, 54000000]], rigName: 'FLEX-8600' });
  assert.strictEqual(r.ok, false);
  assert.match(r.why, /FLEX-8600 cannot transmit on 145\.09 MHz/);
});

test('a gateway the radio can call is allowed', () => {
  assert.deepStrictEqual(R.gatewayReach(14107.5, FLEX), { ok: true, band: '20m' });
  assert.strictEqual(R.gatewayReach(145090, { bands: ['2m'], reach: [[144e6, 148e6]] }).ok, true);
  assert.strictEqual(R.gatewayReach(7100, { bands: null, reach: null }).ok, true, 'nothing known about the radio: any amateur band');
});

test('no frequency, no attempt', () => {
  assert.strictEqual(R.gatewayReach(undefined, FLEX).ok, false);
  assert.strictEqual(R.gatewayReach(0, FLEX).ok, false);
});

test('the list keeps only what the radio can call (#336 and 149.09 MHz)', () => {
  const rows = [
    { call: 'A', freqKhz: 3589.5, dialKhz: 3588 },
    { call: 'B', freqKhz: 7101.5, dialKhz: 7100 },
    { call: 'C', freqKhz: 14109, dialKhz: 14107.5 },
    { call: 'D', freqKhz: 28120, dialKhz: 28118.5 },
    { call: 'W9OU-10', dialKhz: 149090 },
    { call: 'E', freqKhz: 5000 },
    { call: 'F' },
  ];
  const r = R.gatewaysInReach(rows, FLEX);
  assert.deepStrictEqual(r.list.map((g) => g.call), ['B', 'C', 'D']);
  assert.strictEqual(r.dropped, 4);
  assert.strictEqual(R.gatewaysInReach([{ call: 'G', dialKhz: 3588 }], { bands: ['40m'] }).dropped, 1, 'the dial is used when the centre is missing');
});

test('a refused key-down gives the radio\'s own reason', () => {
  assert.strictEqual(R.pttRefusalText('[CAT 17:47:40.305] [PTT] refused — 149.09 MHz is on the SDR; FLEX-8400/8600 cannot transmit there.'), '149.09 MHz is on the SDR; FLEX-8400/8600 cannot transmit there.');
  assert.strictEqual(R.pttRefusalText('[CAT 1] [SWR GUARD] PTT blocked — SWR guard tripped. Run the ATU.'), 'SWR guard tripped. Run the ATU.');
  assert.match(R.pttRefusalText(''), /\[PTT\] line in the log/);
});

console.log('wiring in main.js');

test('the gateway list is filtered before it is stored and sent', () => {
  const fn = main.slice(main.indexOf('async function winlinkGateways('), main.indexOf('let _winlinkGatewaysLogged'));
  const at = fn.indexOf('WinlinkReach.gatewaysInReach(list, winlinkReachOpts())');
  assert.ok(at > 0 && at < fn.indexOf('winlinkState.setGateways(mode, band, list)'));
  assert.ok(/this radio cannot call left out/.test(fn), 'the window says how many were left out');
  assert.ok(!/gatewaysOnBands/.test(main), 'the old filter (kept non-amateur frequencies) is gone');
});

test('a pick the radio cannot call is refused before anything tunes', () => {
  const f = fnBody('function winlinkPreviewQsy(');
  const g = f.indexOf('WinlinkReach.gatewayReach(khz, winlinkReachOpts())');
  assert.ok(g > 0 && g < f.indexOf('tuneRadio('));
});

test('a session the radio cannot call is refused before it takes the radio', () => {
  const f = fnBody('async function winlinkStartSession(');
  const g = f.indexOf('WinlinkReach.gatewayReach(dialKhz, winlinkReachOpts())');
  assert.ok(g > 0 && g < f.indexOf("acquireRadio('winlink')") && g < f.indexOf('spawnDirewolf()') && g < f.indexOf('tuneRadio('));
  assert.ok(/reason: 'out-of-reach'/.test(f));
});

test('the reach uses the radio\'s bands, its range and its name', () => {
  assert.ok(/function winlinkReachOpts\(\) \{\s*return \{ bands: activeRigBands\(\), reach: rigReachNow\(\), rigName: getActiveRigModelName\(\) \|\| 'the radio' \};/.test(main));
});

test('a refused key-down ends the attempt instead of keying into nothing', () => {
  const i = main.indexOf('setPtt: (on) => {');
  const f = main.slice(i, main.indexOf('}, { host: \'127.0.0.1\', log: winlinkLog });', i));
  assert.ok(/keyed = handleRemotePtt\(true, \{[^}]*\}\) !== false;/.test(f), 'the refusal is read, not ignored');
  const b = f.slice(f.indexOf('if (!keyed) {'));
  assert.ok(/winlinkTxActive = false;/.test(b) && /winlinkAbortSession\(`the radio refused to transmit: \$\{why\}`\);/.test(b) && /return false;/.test(b));
  assert.ok(f.indexOf('if (!keyed) {') < f.indexOf('winlinkSendPreKeyAudio();'), 'no audio is sent after a refusal');
});

test('the modem must be on POTACAT\'s audio before anything tunes or keys', () => {
  const f = fnBody('async function winlinkStartSession(');
  const w = f.indexOf("await winlinkModemAudioConnected(mode === 'packet' ? 'Dire Wolf' : 'ardopcf')");
  assert.ok(w > f.indexOf('await spawnDirewolf()') && w < f.indexOf("tuneRadio(Number(dialKhz)") && w < f.indexOf('patClient.connect(url)'));
  const h = fnBody('function winlinkModemAudioConnected(');
  assert.ok(/srv\.once\('modem-connected', on\)/.test(h) && /play into this computer's sound card instead of the radio/.test(h));
});

test('this test is in the list CI runs', () => {
  assert.ok(readSrc(path.join(__dirname, '..', 'scripts', 'run-tests.js')).includes("'test/winlink-reach-test.js'"));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
