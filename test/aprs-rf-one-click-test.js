#!/usr/bin/env node
'use strict';
// APRS window, 2026-11-19 (Casey: "I should just be able to do a 1-click
// transmit. Also I should be able to see my SWR, S-meter and also change my
// tx signal power"; and "shouldn't I be able to change my callsign addendum
// (K3SBP-10)?"). The radio beacon is one click, its button reads band,
// frequency and power before the click, a refused gate still disables it, a
// second click during a beacon does nothing; the window shows the meters and
// sets TX power through set-tx-power with the radio's read-back; "My APRS
// SSID" picks the radio beacon's SSID, the default unchanged.
// The window's script runs here against a small stand-in DOM.
// Run: node test/aprs-rf-one-click-test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8').replace(/\r\n/g, '\n');
const exists = (f) => fs.existsSync(path.join(root, f));
const fnBody = (src, name) => {
  let i = src.indexOf('\nfunction ' + name + '(');
  if (i < 0) i = src.indexOf('\nasync function ' + name + '(');
  assert.ok(i >= 0, name + ' exists');
  return src.slice(i, src.indexOf('\n}\n', i));
};

console.log('APRS radio beacon: one click, meters, TX power, My APRS SSID');

// The window redesign (2026-11-19): the radio beacon bar this file used to run
// in a stand-in DOM is gone; its button, click, meter and power checks run on
// the new Beacon panel in test/aprs-window-test.js. What stays here is the
// preview, main's wiring, the meters lib and My APRS SSID.

// ── one click ────────────────────────────────────────────────────────────────
test('the preview reads band, frequency and power, and the line under it mode, call, path and air time', () => {
  const R = require('../lib/aprs-rf-beacon');
  const p = R.rfPreview({ bandLabel: '30 m', mhz: '10.1476', mode: 'USB', powerW: 5, path: ['WIDE1-1'], airMs: 1600, source: 'K3SBP' });
  assert.strictEqual(p.button, 'Beacon now on 30 m, 10.1476 MHz at 5 W');
  assert.ok(/USB/.test(p.detail) && /as K3SBP/.test(p.detail) && /path WIDE1-1/.test(p.detail) && /about 1\.6 s on the air/.test(p.detail), p.detail);
  const unknown = R.rfPreview({ bandLabel: '2 m', mhz: '144.390', mode: 'FM', powerW: 0, path: ['WIDE1-1', 'WIDE2-1'], airMs: 900, source: 'K3SBP-9' });
  assert.strictEqual(unknown.button, 'Beacon now on 2 m, 144.390 MHz');
  assert.ok(/power set on the radio/.test(unknown.detail) && /WIDE1-1,WIDE2-1/.test(unknown.detail));
  const narrow = R.rfPreview({ bandLabel: '30 m', mhz: '10.1476', mode: 'USB', powerW: 10, path: ['WIDE1-1'], airMs: 1600, source: 'K3SBP', txNarrow: { lo: 1400, hi: 2000 } });
  assert.ok(/narrowed to 1400-2000 Hz/.test(narrow.detail));
});

test('one click sends: rfSend at once, no confirmation step anywhere', () => {
  const all = read('renderer/aprs-popout.html') + read('renderer/aprs-window.js') + read('preload-aprs-popout.js');
  assert.ok(/api\.rfSend\(\);/.test(read('renderer/aprs-window.js')), 'the click sends');
  assert.ok(!/aprs-rf-confirm|aprs-rf-cancel|rfAsk|rfCancel|aprs-rf-ask/.test(all), 'no confirm line, Cancel or ask step in the window');
  const main = read('main.js');
  assert.ok(!/aprs-rf-ask|aprs-rf-cancel|aprsRfAsk|aprsRfCancel|APRS_RF_CONFIRM_MS|aprsRfUi\.confirm/.test(main), 'no confirm step in main');
  assert.ok(/ipcMain\.on\('aprs-rf-send', \(\) => \{ aprsRfSend\(\)/.test(main));
});

test('a second click while a beacon is going out does nothing (main; the window in test/aprs-window-test.js)', () => {
  const send = fnBody(read('main.js'), 'aprsRfSend');
  assert.ok(/if \(_aprsRfSending \|\| aprsRfInFlight\(\)\) return;/.test(send), send);
  assert.ok(send.indexOf('_aprsRfSending = true') < send.indexOf('aprsRfTransmit()') && /finally \{ _aprsRfSending = false;/.test(send));
});

test('main judges the gate again at the click, before the runner (the window\'s disabled button in test/aprs-window-test.js)', () => {
  const t = fnBody(read('main.js'), 'aprsRfTransmit');
  assert.ok(t.indexOf('AprsRfGate.readiness(aprsRfGateState())') > 0 && t.indexOf('AprsRfGate.readiness(aprsRfGateState())') < t.indexOf('aprsRfRunner()'));
  assert.ok(t.indexOf('if (APRS_DEV_FRAMES)') < t.indexOf('aprsRfRunner()'), 'a dev build never transmits');
});

// ── meters ───────────────────────────────────────────────────────────────────
test('meters: the S-meter while listening, SWR and RF out while the beacon transmits, peaks after (lib)', () => {
  const M = require('../lib/aprs-rf-meters');
  const rx = M.meterView({ txing: false, smeter: 100, available: { smeter: true, swr: true } });
  assert.strictEqual(rx.items.find((i) => i.key === 'smeter').text, 'S8');
  const tx = M.meterView({ txing: true, swr: 1.5, fwdW: 5, available: { swr: true, power: true } });
  assert.strictEqual(tx.items.find((i) => i.key === 'swr').text, '1.5');
  assert.strictEqual(tx.items.find((i) => i.key === 'fwd').text, '5 W');
  assert.strictEqual(M.meterView({ last: { swr: 1.3, fwdW: 5.1 }, available: { swr: true } }).last, 'Peak on the last radio beacon: SWR 1.3, RF out 5.1 W.');
  const glue = read('renderer/aprs-window.js');
  assert.ok(/M\.sLabel\(meter\.smeter\)/.test(glue) && /meter\.swr = M\.swrFromWire\(v\)/.test(glue) && /meter\.swrRatioSeen = true/.test(glue), 'the window reads the same scale');
});

test('meters: a radio with no SWR says so and never shows a made-up value', () => {
  const M = require('../lib/aprs-rf-meters');
  const v = M.meterView({ txing: true, swr: 0, fwdW: 4, available: { smeter: true, swr: false, power: true } });
  assert.strictEqual(v.items.find((i) => i.key === 'swr').text, 'No SWR from this radio');
  const rx = M.meterView({ txing: false, smeter: 120, available: { smeter: true, swr: false } });
  assert.strictEqual(rx.items.find((i) => i.key === 'swr').text, 'No SWR from this radio');
  assert.strictEqual(rx.items.find((i) => i.key === 'smeter').text, 'S9');
  const last = M.meterView({ txing: false, available: { swr: false }, last: { swr: 0, fwdW: 5 } });
  assert.strictEqual(last.last, 'Peak on the last radio beacon: no SWR from this radio, RF out 5 W.');
  // the scale is the VFO and JTCAT windows': S9 at 120, S9+60 at 255; SWR 1 + v/60
  assert.strictEqual(M.sLabel(255), 'S9+60');
  assert.strictEqual(M.swrFromWire(60), 2);
  assert.strictEqual(M.swrClass(1.4), 'ok'); assert.strictEqual(M.swrClass(2.5), 'warn'); assert.strictEqual(M.swrClass(3.5), 'high');
});

test('the peaks: only between the beacon\'s key-down and its end; the true ratio wins over the wire value', () => {
  const M = require('../lib/aprs-rf-meters');
  const p = M.createPeak();
  p.note('swr', 3); p.note('fwd', 50);
  p.start();
  p.note('swr', 1.5); p.note('swr-ratio', 1.2); p.note('fwd', 4.96); p.note('fwd', 2);
  assert.deepStrictEqual(p.end(), { swr: 1.2, fwdW: 5 });
  p.note('fwd', 80);
  assert.strictEqual(p.active(), false);
  const main = read('main.js');
  assert.ok(/_aprsRfKeyed = true;\n  _aprsRfPeak\.start\(\);/.test(fnBody(main, 'aprsRfKey')));
  assert.ok(/aprsRfUi\.lastPeak = _aprsRfPeak\.end\(\)/.test(fnBody(main, 'aprsRfTransmit')));
});

test('main feeds the window the meters every window gets', () => {
  const main = read('main.js');
  assert.ok(/aprsWinMeter\('cat-smeter', val\)/.test(fnBody(main, 'sendCatSmeter')));
  assert.ok(/aprsWinMeter\('cat-swr', val\)/.test(fnBody(main, 'sendCatSwr')));
  assert.ok(/aprsWinMeter\('cat-fwd-power', v\)/.test(fnBody(main, 'sendCatFwdPower')));
  assert.ok((main.match(/aprsWinMeter\('cat-swr-ratio', /g) || []).length >= 3, 'Flex, TCI and remote SWR ratio');
  assert.ok(/meters: vfoMetersAvailable\(\)/.test(fnBody(main, 'aprsRfPayload')), 'the VFO window\'s rule for which meters the radio has');
  const pre = read('preload-aprs-popout.js');
  for (const ch of ['cat-smeter', 'cat-swr', 'cat-swr-ratio', 'cat-fwd-power']) assert.ok(pre.indexOf("'" + ch + "'") > 0, ch);
});

// ── TX power ─────────────────────────────────────────────────────────────────
test('the power control sends set-tx-power through rig-control (the window\'s minus / plus in test/aprs-window-test.js)', () => {
  const glue = read('renderer/aprs-window.js');
  assert.ok(/api\.rigControl\(\{ action: 'set-tx-power', value: w \}\)/.test(glue));
  const main = read('main.js');
  const push = fnBody(main, 'pushAprsRigPower');
  assert.ok(/jtcatPopoutRigPowerPayload\(\)/.test(push) && /'aprs-rig-power'/.test(push), 'the JTCAT / Winlink payload: the rig caps\' min/max');
  assert.ok(/pushAprsRigPower\(\);/.test(main), 'pushed with every rig state');
  assert.ok(/rigControl: \(d\) => ipcRenderer\.invoke\('rig-control', d\)/.test(read('preload-aprs-popout.js')));
});

test('the beacon itself still never changes power', () => {
  const main = read('main.js');
  const a = main.indexOf('// ── APRS phase 7: ONE manual beacon over the radio');
  const block = main.slice(a, main.indexOf('\nfunction killArdop() {', a));
  assert.ok(!/setPower|setRfPower|rfpower|set-power|applyRigControl|rigControl/i.test(block));
  assert.ok(!/set-tx-power/.test(read('lib/aprs-rf-beacon.js')));
});

test('the power note is short and factual', () => {
  const html = read('renderer/aprs-popout.html');
  const m = /id="aprs-rf-power-note">([^<]*)</.exec(html);
  assert.ok(m, 'the note is there');
  assert.ok(/5 W is fine to start/.test(m[1]) && /2 m commonly runs 5 to 50 W/.test(m[1]) && /30 m/.test(m[1]) && /depending on conditions/.test(m[1]));
});

// ── My APRS SSID ─────────────────────────────────────────────────────────────
test('My APRS SSID: 0 to 15 with the APRS SSID recommendations\' meanings', () => {
  const B = require('../lib/aprs-beacon');
  assert.deepStrictEqual(B.SSID_CHOICES.map((c) => c.ssid), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  const label = (n) => B.SSID_CHOICES[n].label;
  assert.ok(/primary|home/.test(label(0)));
  assert.ok(/handheld/.test(label(7)));
  assert.ok(/primary mobile/.test(label(9)));
  assert.ok(/special activity/.test(label(6)));
  assert.ok(/internet|iGate/.test(label(10)));
  assert.ok(/weather station/.test(label(13)));
  assert.ok(/balloon/.test(label(11)));
});

test('My APRS SSID: the default keeps the radio beacon as before; a pick sets it; the Settings call is never touched', () => {
  const B = require('../lib/aprs-beacon');
  const R = require('../lib/aprs-rf-beacon');
  const pkt = (o) => R.buildRfBeacon({ settingsCall: 'K3SBP', band: '2m', lat: 40.5, lon: -75.05, symbol: 'car', comment: 'x', approx: true, ...(o || {}) });
  assert.strictEqual(B.beaconSettings({}).rfSsid, null, 'nothing picked');
  assert.strictEqual(pkt().source, 'K3SBP', 'default: no SSID, as before');
  assert.strictEqual(pkt({ settingsCall: 'K3SBP-7' }).source, 'K3SBP-7', 'default: the Settings call\'s own SSID, as before');
  assert.strictEqual(pkt({ ssid: 9 }).source, 'K3SBP-9');
  assert.ok(/^K3SBP-9>APZPCT,WIDE1-1,WIDE2-1:/.test(pkt({ ssid: 9 }).packet));
  assert.strictEqual(pkt({ settingsCall: 'K3SBP-7', ssid: 0 }).source, 'K3SBP', '0 = no SSID, never -0');
  assert.deepStrictEqual(B.settingsPatch({ rfSsid: 9 }), { aprsRfSsid: 9 });
  assert.deepStrictEqual(B.settingsPatch({ rfSsid: null }), { aprsRfSsid: null });
  assert.deepStrictEqual(B.settingsPatch({ rfSsid: 16 }), {}, 'out of range: dropped');
  assert.deepStrictEqual(B.settingsPatch({ rfSsid: 'x' }), {});
  assert.ok(!('myCallsign' in B.settingsPatch({ rfSsid: 9, myCallsign: 'X' })));
  assert.strictEqual(B.beaconSettings({ aprsRfSsid: 6 }).rfSsid, 6);
});

test('the internet beacon and the iGate stay on the login -10 (APRS-IS documents FROMCALL = login)', () => {
  const B = require('../lib/aprs-beacon');
  const b = B.buildBeacon({ settingsCall: 'K3SBP', lat: 40.5, lon: -75.05, symbol: 'house', comment: 'x', approx: true });
  assert.ok(/^K3SBP-10>APZPCT,TCPIP\*:/.test(b.packet));
  assert.strictEqual(require('../lib/aprs-igate').uplinkLogin('K3SBP-9').call, 'K3SBP-10');
});

test('main uses the pick for the packet and for Dire Wolf\'s MYCALL, and the window shows the calls', () => {
  const main = read('main.js');
  assert.ok(/ssid: st\.rfSsid/.test(fnBody(main, 'aprsRfPlan')));
  assert.ok(/ssid: AprsBeacon\.beaconSettings\(settings\)\.rfSsid/.test(fnBody(main, 'aprsRfStartModem')));
  assert.ok(/rfCall: login\.ok \? AprsRfBeacon\.rfSource\(settings\.myCallsign, login\.base, /.test(fnBody(main, 'aprsBeaconState')));
  // The window redesign (2026-11-19): "Call sign ending" in the Beacon panel, the calls in its header.
  const html = read('renderer/aprs-popout.html');
  assert.ok(/id="aprs-rf-ssid"/.test(html) && /id="aprs-beacon-as"/.test(html));
  // 2026-11-20: the ending moved to the APRS settings panel; the Beacon panel keeps "Beacons as ..." and a link to it.
  assert.ok(html.indexOf('id="aprs-rf-ssid"') > html.indexOf('id="aprs-settings" role="dialog"'), 'the ending is in APRS settings');
  assert.ok(/id="aprs-beacon-as"><\/span>\s*<button type="button" class="aprs-link" id="aprs-beacon-settings"/.test(html), 'the calls and the link head the Beacon panel');
  const lib = read('lib/aprs-window-state.js');
  assert.ok(/'Beacons as ' \+ rc/.test(lib) && /' \(internet ' \+ b\.call/.test(lib));
  assert.ok(/beaconSet\(\{ rfSsid: /.test(read('renderer/aprs-window.js')));
});

test('the new test is in scripts/run-tests.js', () => {
  assert.ok(read('scripts/run-tests.js').indexOf("'test/aprs-rf-one-click-test.js'") >= 0);
  assert.ok(exists('lib/aprs-rf-meters.js'));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
