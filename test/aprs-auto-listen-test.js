#!/usr/bin/env node
'use strict';
// APRS listen on open (Casey 2026-11-20: "The main goal is to listen on my
// radio, so that should switch on by default when the user opens APRS"):
// lib/aprs-listen.js autoListenOnOpen decides whether the window, just opened,
// starts receive-only listening and on which band; main.js runs it once per
// open. Every refusal the Listen switch has holds, plus anything that has or
// keys the radio. Nothing transmits. Run: node test/aprs-auto-listen-test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const L = require('../lib/aprs-listen');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

const F2 = { hz: 144390000, mhz: '144.390' };
const F30 = { hz: 10147600, mhz: '10.1476' };
const freq = (band) => (band === '30m' ? F30 : F2);
// A free station: rig on CAT, Dire Wolf found, nothing else using the radio.
const FREE = {
  firstOpen: true, operatorOff: false, listening: false, transmitting: false, rfInFlight: false, jtcatQso: false,
  radioOwner: 'none', guestPass: false, bandWanted: '',
  remote: false, catConnected: true, bands: ['160m', '80m', '40m', '30m', '20m', '6m', '2m', '70cm'], freq,
  modemFound: true, ft8Decoding: false, winlinkHasModem: false,
};
const go = (patch) => L.autoListenOnOpen({ ...FREE, ...(patch || {}) });

console.log('APRS listen on open');
test('a free station with 2 m starts listening on 2 m', () => {
  assert.deepStrictEqual(go(), { start: true, band: '2m', reason: '' });
});
test('an HF-only rig (the FLEX-8600M has no 2 m) starts on 30 m', () => {
  assert.deepStrictEqual(go({ bands: ['160m', '80m', '40m', '30m', '20m', '17m', '15m', '12m', '10m', '6m'] }), { start: true, band: '30m', reason: '' });
});
test('the band picked earlier this session wins while the rig has it (the same choice as the switch)', () => {
  assert.strictEqual(go({ bandWanted: '30m' }).band, '30m');
  assert.strictEqual(go({ bandWanted: '2m', bands: ['40m', '30m', '20m'] }).band, '30m', 'a band the rig lacks falls back');
  assert.strictEqual(go().band, L.chooseBand(FREE.bands, ''), 'the same as chooseBand');
});
test('the frequency is looked up for the band chosen here', () => {
  const asked = [];
  const d = go({ bands: ['30m'], freq: (b) => { asked.push(b); return F30; } });
  assert.strictEqual(d.start, true);
  assert.deepStrictEqual(asked, ['30m']);
});
test('silent no while anything is transmitting, a radio beacon is out, or a JTCAT QSO is in progress', () => {
  assert.deepStrictEqual(go({ transmitting: true }), { start: false, band: '', reason: 'transmitting' });
  assert.strictEqual(go({ rfInFlight: true }).reason, 'rf-beacon');
  assert.strictEqual(go({ jtcatQso: true }).reason, 'jtcat-qso');
});
test('silent no while another mode owns the radio (JTCAT, Mercury, Winlink) or a Guest Pass is on', () => {
  for (const o of ['jtcat', 'mercury', 'winlink']) assert.strictEqual(go({ radioOwner: o }).start, false, o);
  assert.strictEqual(go({ radioOwner: 'winlink' }).reason, 'owner-winlink');
  assert.strictEqual(go({ guestPass: true }).reason, 'guest-pass');
});
test('every refusal the Listen switch has (whyNot) holds: no rig, remote, no band, no frequency, no modem, FT8, Winlink', () => {
  assert.strictEqual(go({ catConnected: false }).reason, 'no-cat');
  assert.strictEqual(go({ remote: true }).reason, 'remote');
  assert.strictEqual(go({ bands: ['40m', '20m'] }).reason, 'no-band');
  assert.strictEqual(go({ freq: () => null }).reason, 'no-freq');
  assert.strictEqual(go({ modemFound: false }).reason, 'no-modem');
  assert.strictEqual(go({ ft8Decoding: true }).reason, 'ft8');
  assert.strictEqual(go({ winlinkHasModem: true }).reason, 'winlink');
  for (const p of [{ catConnected: false }, { remote: true }, { modemFound: false }, { ft8Decoding: true }, { winlinkHasModem: true }]) {
    const d = go(p);
    assert.strictEqual(d.start, false);
    assert.strictEqual(d.reason, L.whyNot({ ...FREE, ...p, band: '2m', freq: F2 }).reason, 'the switch\'s own reason');
  }
});
test('once per open: already listening, a reload, or the operator switched it off: nothing', () => {
  assert.strictEqual(go({ listening: true }).reason, 'listening');
  assert.strictEqual(go({ firstOpen: false }).reason, 'not-first-open');
  assert.strictEqual(go({ operatorOff: true }).reason, 'operator-off');
});

// ── main.js wiring ──────────────────────────────────────────────────────────
const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
function fnBody(name) {
  const at = main.indexOf('function ' + name + '(');
  assert.ok(at >= 0, name + ' exists');
  let i = main.indexOf('{', at), depth = 0;
  for (let j = i; j < main.length; j++) {
    if (main[j] === '{') depth++;
    else if (main[j] === '}' && --depth === 0) return main.slice(i, j + 1);
  }
  return '';
}
test('main: the window open arms it once; the first aprs-ready runs it; a reload does not', () => {
  const open = main.slice(main.indexOf("ipcMain.on('aprs-popout-open'"), main.indexOf("ipcMain.on('aprs-ready'"));
  assert.ok(/_aprsAutoListenPending = true;/.test(open) && /_aprsListenOffByOperator = false;/.test(open));
  assert.ok(open.indexOf('_aprsAutoListenPending = true') > open.indexOf('aprsWin = new BrowserWindow'), 'armed only when a new window is made');
  const ready = main.slice(main.indexOf("ipcMain.on('aprs-ready'"), main.indexOf("ipcMain.on('aprs-messages-get'"));
  assert.ok(/aprsAutoListenOnOpen\(\);/.test(ready));
  const b = fnBody('aprsAutoListenOnOpen');
  assert.ok(/const firstOpen = _aprsAutoListenPending;\s*_aprsAutoListenPending = false;\s*if \(!firstOpen\) return;/.test(b), 'used up at once');
});
test('main: the operator switching off keeps it off until the window opens again', () => {
  assert.ok(/ipcMain\.on\('aprs-listen-set', \(_e, on\) => \{ markUserActive\(\); aprsListenSet\(!!on, \{ operator: true \}\); if \(!on\) _aprsListenOffByOperator = true; \}\);/.test(main));
  assert.ok(/operatorOff: _aprsListenOffByOperator/.test(fnBody('aprsAutoListenOnOpen')));
});
test('main: the guards are the live ones (PTT, JTCAT, Winlink, the phone, Flex, tune, owner, Guest Pass, the switch\'s own)', () => {
  const b = fnBody('aprsAutoListenOnOpen');
  for (const re of [/transmitting: aprsAutoListenTransmitting\(\)/, /rfInFlight: aprsRfInFlight\(\)/, /jtcatQso: jtcatQsoLive\(\)/, /radioOwner,/,
    /guestPass: aprsGuestPassOn\(\)/, /catConnected: dev \|\| radioTuneRoute\(\) !== ''/, /ft8Decoding: autoSstvBlockedByJtcat\(\)/,
    /winlinkHasModem: aprsWinlinkHoldsRadio\(\)/, /remote: isRemoteMode\(\)/, /bandWanted: aprsListen\.bandWanted/, /bands: aprsRigBands\(\)/]) {
    assert.ok(re.test(b), String(re));
  }
  const tx = fnBody('aprsAutoListenTransmitting');
  assert.ok(/rigPresetTransmitting\(\)/.test(tx) && /aprsRfOtherTx\(\)/.test(tx) && /_flexTxRf/.test(tx) && /jtcatTuneState\.active/.test(tx));
});
test('main: receive only: it starts listening the way the switch does and sends nothing', () => {
  const b = fnBody('aprsAutoListenOnOpen');
  assert.ok(/if \(!d\.start\) \{ aprsLog\(`not listening on open \(\$\{d\.reason\}\); the switch is off`\); return; \}/.test(b),'a no is silent in the window (the log has the reason)');
  assert.ok(/aprsListenSet\(true\);/.test(b));
  assert.ok(!/aprsRfSend|aprsBeaconSend|beaconNow|rfSend|aprsBeaconSchedule|intervalMin/.test(b), 'no beacon, no timer');
});
test('this test is in the list CI runs', () => {
  assert.ok(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'run-tests.js'), 'utf8').includes("'test/aprs-auto-listen-test.js'"));
});

console.log(`\nAPRS listen on open: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
