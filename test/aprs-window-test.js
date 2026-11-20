#!/usr/bin/env node
'use strict';
// The APRS window's layout (Casey 2026-11-19, the approved mock-up): the three
// status cards with no heading, the internet timer banner (only with an
// interval), the red on-the-air banner (only while a radio beacon is keyed)
// and its Stop transmitting (main's abort, the one closing the window uses),
// the Beacon panel's two one-click buttons, the minus / read-back / plus TX
// power, the two-line Stations list and the "Within" range in round numbers
// of the operator's units.
//
// Pure: lib/aprs-window-state.js. Glue: renderer/aprs-window.js runs here
// against a stand-in DOM that has only the ids renderer/aprs-popout.html
// declares, so a misspelt id fails the test.
// Run: node test/aprs-window-test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n       ') : e)); }
}
const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8').replace(/\r\n/g, '\n');
const W = require('../lib/aprs-window-state');
const fnBody = (src, name) => {
  let i = src.indexOf('\nfunction ' + name + '(');
  if (i < 0) i = src.indexOf('\nasync function ' + name + '(');
  assert.ok(i >= 0, name + ' exists');
  return src.slice(i, src.indexOf('\n}\n', i));
};

console.log('APRS window: cards, banners, beacon panel, stations, range');

// ── the "Within" range ──────────────────────────────────────────────────────
test('range: round numbers in the operator\'s units (25, 50, 100, 250, 500 mi; 25 ... 800 km)', () => {
  assert.deepStrictEqual(W.rangeOptions('mi').map((o) => o.label), ['25 mi', '50 mi', '100 mi', '250 mi', '500 mi']);
  assert.deepStrictEqual(W.rangeOptions('km').map((o) => o.label), ['25 km', '50 km', '100 km', '250 km', '500 km', '800 km']);
});

test('range: each choice maps to whole km for the APRS-IS filter, miles rounded up so it covers the distance picked', () => {
  assert.deepStrictEqual(W.rangeOptions('mi').map((o) => o.km), [41, 81, 161, 403, 805]);
  assert.deepStrictEqual(W.rangeOptions('km').map((o) => o.km), [25, 50, 100, 250, 500, 800]);
  for (const o of W.rangeOptions('mi')) {
    assert.ok(o.km >= o.value * W.KM_PER_MI && o.km - o.value * W.KM_PER_MI < 1, o.label);
    assert.strictEqual(W.nearestRange(o.km, 'mi').label, o.label, 'reads back exactly: ' + o.label);
  }
  const feed = require('../lib/aprs-is-feed');
  for (const o of W.rangeOptions('mi').concat(W.rangeOptions('km'))) assert.strictEqual(feed.clampRangeKm(o.km), o.km, 'inside the feed\'s limits: ' + o.label);
  assert.ok(/r\/40\.00\/-75\.00\/161$/.test(feed.buildRangeFilter(40, -75, W.rangeKmFor(100, 'mi'))));
});

test('range: no more "93 mi" from 150 km: an older saved range becomes the nearest choice, once', () => {
  assert.deepStrictEqual(W.convertSavedRange(150, 'mi'), { km: 161, changed: true }, '150 km = 93 mi -> 100 mi');
  assert.deepStrictEqual(W.convertSavedRange(150, 'km'), { km: 100, changed: true });
  assert.deepStrictEqual(W.convertSavedRange(400, 'mi'), { km: 403, changed: true }, '400 km = 249 mi -> 250 mi');
  assert.deepStrictEqual(W.convertSavedRange(600, 'km'), { km: 500, changed: true });
  assert.deepStrictEqual(W.convertSavedRange(25, 'mi'), { km: 41, changed: true });
  // A choice stays: the conversion runs once.
  assert.deepStrictEqual(W.convertSavedRange(161, 'mi'), { km: 161, changed: false });
  assert.deepStrictEqual(W.convertSavedRange(250, 'km'), { km: 250, changed: false });
  // A tie goes to the larger choice.
  assert.strictEqual(W.nearestRange(175 * W.KM_PER_MI, 'mi').value, 250);
  const main = read('main.js');
  const ready = main.slice(main.indexOf("ipcMain.on('aprs-ready'"), main.indexOf("ipcMain.on('aprs-beacon-get'"));
  assert.ok(/AprsWindowState\.convertSavedRange\(/.test(ready) && /if \(conv\.changed\) \{/.test(ready) && /settings\.aprsRangeKm = conv\.km;/.test(ready), 'main converts before the init and the feed');
  assert.ok(ready.indexOf('convertSavedRange') < ready.indexOf('aprsStartFeed()'));
  const pop = read('renderer/aprs-popout.js');
  assert.ok(/W\.rangeOptions\(unit\)/.test(pop) && !/RANGES_KM|Math\.round\(k \/ KM_PER_MI\)/.test(pop), 'the window lists the choices, no km-to-miles rounding');
});

// ── card 1: My radio ────────────────────────────────────────────────────────
const LISTEN_ON = { on: true, state: 'listening', sentence: '', band: '30m', bands: ['2m', '30m'], modeLabel: 'USB', mhz: '10.1476', heard: 3, lastAt: 1, note: '' };
const LISTEN_OFF = { on: false, state: 'off', sentence: '', band: '2m', bands: ['2m', '30m'], modeLabel: 'FM', mhz: '', heard: 0, lastAt: 0, note: '', dialMhz: '14.074', dialMode: 'USB' };
const RF_READY = {
  allowed: true, reason: '', why: '', band: '30m', bandLabel: '30 m', mode: 'USB', mhz: '10.1476', powerW: 5,
  preview: { button: 'Beacon now on 30 m, 10.1476 MHz at 5 W', detail: 'USB, as K3SBP-6, path WIDE1-1, about 1.6 s on the air. One click transmits one packet.' },
  sending: false, phase: 'idle', keyed: false, meters: { smeter: true, swr: true, alc: false, power: true }, lastPeak: null,
  sentence: '', lastAt: 0, lastPacket: '', lastBand: '', keyedAt: 0, airMs: 2700, lastHeldMs: 0, txNarrow: null,
};

test('My radio, listening: band, frequency and baud, the switch on, the S-meter', () => {
  const c = W.radioCard({ listen: LISTEN_ON, rf: RF_READY, smeter: 60, sText: 'S5', available: { smeter: true } });
  assert.strictEqual(c.kind, 'on');
  assert.strictEqual(c.title, 'Listening on my radio');
  assert.strictEqual(c.lines[0], '30 m · 10.1476 MHz · 300 baud');
  assert.strictEqual(c.switchShown, true); assert.strictEqual(c.switchOn, true);
  assert.strictEqual(c.smeter.text, 'S5');
  assert.ok(c.smeter.pct > 30 && c.smeter.pct < 40, String(c.smeter.pct));
  assert.deepStrictEqual(c.otherBands.map((b) => b.band), ['2m'], 'the other band to switch to');
  assert.strictEqual(W.radioCard({ listen: { ...LISTEN_ON, band: '2m', mhz: '144.390' } }).lines[0], '2 m · 144.390 MHz · 1200 baud');
  assert.strictEqual(W.radioCard({ listen: LISTEN_ON, available: { smeter: false } }).smeter.text, 'No S-meter from this radio');
});

test('My radio, off: one button per band the rig has, and where the radio goes back to', () => {
  const c = W.radioCard({ listen: LISTEN_OFF });
  assert.strictEqual(c.kind, 'off');
  assert.strictEqual(c.title, 'Not listening on my radio');
  assert.deepStrictEqual(c.bands.map((b) => b.label), ['2 m', '30 m']);
  assert.ok(c.lines.includes('Your radio goes back to 14.074 MHz USB when you stop.'), c.lines.join('|'));
  const hf = W.radioCard({ listen: { ...LISTEN_OFF, bands: ['30m'], band: '30m' } });
  assert.deepStrictEqual(hf.bands.map((b) => b.label), ['30 m'], 'an HF-only rig (the 8600M): one button');
  const refused = W.radioCard({ listen: { ...LISTEN_OFF, state: 'refused', sentence: 'Connect your radio to listen to APRS.' } });
  assert.strictEqual(refused.lines[0], 'Connect your radio to listen to APRS.');
  assert.strictEqual(refused.dot, 'bad');
});

test('My radio, transmitting: a red card "Transmitting on 30 m" while the beacon is keyed', () => {
  const c = W.radioCard({ listen: LISTEN_ON, rf: { ...RF_READY, phase: 'keyed', keyed: true, txNarrow: { lo: 1400, hi: 2000 } } });
  assert.strictEqual(c.kind, 'tx');
  assert.strictEqual(c.title, 'Transmitting on 30 m');
  assert.strictEqual(c.lines[0], '10.1476 MHz · filter 1400-2000 Hz for this beacon');
  assert.strictEqual(c.lines[1], 'Listening resumes when it ends');
  const w = W.radioCard({ listen: LISTEN_ON, rf: { ...RF_READY, phase: 'waiting', sending: true } });
  assert.strictEqual(w.kind, 'busy', 'waiting for the channel is not red: nothing is keyed yet');
});

// ── card 2 and 3 ────────────────────────────────────────────────────────────
test('APRS-IS card: connected with server and packets a minute, the iGate line; off: a Connect button', () => {
  const c = W.isCard({ link: { state: 'connected', server: 'T2SPAIN' }, rate: 160, ig: { on: true, active: true, link: 'verified', gated: 3 } });
  assert.strictEqual(c.title, 'Connected to APRS-IS');
  assert.deepStrictEqual(c.lines, ['Server T2SPAIN · 160 packets a minute', 'iGate on: 3 packets from my radio sent up']);
  assert.strictEqual(c.switchOn, true);
  const off = W.isCard({ link: { state: 'stopped' } });
  assert.strictEqual(off.title, 'Not connected to APRS-IS');
  assert.strictEqual(off.connectShown, true);
  assert.ok(/Receive only until you beacon/.test(off.lines[0]));
  assert.strictEqual(W.isCard({ link: { state: 'no-grid' } }).connectShown, false);
  assert.strictEqual(W.igateLine({ on: true, paused: 'iGate paused: a guest has the radio' }), 'iGate paused: a guest has the radio', 'a Guest Pass pause shows');
  assert.strictEqual(W.igateLine({ on: true, active: true, link: 'unverified' }), 'iGate on: login not verified, nothing sent');
});

test('Heard by my radio: the count this session and the last station; none: the plain explanation', () => {
  const now = 10 * 60000;
  const c = W.heardCard({ heard: { count: 3, last: { label: 'W4TTU-10', at: now - 4 * 60000, distanceKm: 412 * W.KM_PER_MI } }, unit: 'mi', now });
  assert.strictEqual(c.kind, 'some'); assert.strictEqual(c.count, 3);
  assert.strictEqual(c.countText, 'stations this session');
  assert.strictEqual(c.lines[0], 'Last: W4TTU-10, 4 min ago, 412 mi');
  const none = W.heardCard({ heard: { count: 0 }, listening: false });
  assert.strictEqual(none.title, 'Nothing yet');
  assert.ok(/Turn on listening to decode packets yourself\. They get a green ring on the map\./.test(none.lines[0]));
});

// ── banners ─────────────────────────────────────────────────────────────────
test('the timer banner appears only with an interval, says the next time and that the radio sends only on a press', () => {
  const at = new Date(2026, 10, 19, 16, 10).getTime();
  const b = { settings: { intervalMin: 30 }, call: 'K3SBP-10', timerOn: true, nextAt: at };
  const t = W.timerBanner({ beacon: b, band: '30m' });
  assert.strictEqual(t.title, 'Beaconing over the internet every 30 min as K3SBP-10.');
  assert.strictEqual(t.detail, 'Next at 16:10. The radio only sends when you press Beacon on 30 m.');
  assert.strictEqual(t.button, 'Stop the timer');
  assert.strictEqual(W.timerBanner({ beacon: { ...b, settings: { intervalMin: 0 } } }), null);
  assert.strictEqual(W.timerBanner({ beacon: null }), null);
});

test('the on-air banner appears only while keyed: elapsed of expected seconds, and Stop transmitting', () => {
  assert.strictEqual(W.onAirBanner({ rf: RF_READY }), null);
  assert.strictEqual(W.onAirBanner({ rf: { ...RF_READY, phase: 'waiting', sending: true } }), null, 'not while waiting for the channel');
  const a = W.onAirBanner({ rf: { ...RF_READY, phase: 'keyed', keyed: true, keyedAt: 1000 }, rfCall: 'K3SBP-6', now: 2400 });
  assert.strictEqual(a.title, 'On the air: APRS beacon on 30 m as K3SBP-6');
  assert.strictEqual(a.time, '1.4 s of about 2.7 s');
  assert.strictEqual(a.button, 'Stop transmitting');
});

// ── the Beacon panel ────────────────────────────────────────────────────────
const BEACON = { settings: { intervalMin: 0, comment: 'POTACAT', symbol: 'house', approx: true, activation: false, rfSsid: 6 }, call: 'K3SBP-10', rfCall: 'K3SBP-6',
  grid: 'FN20', position: { lat: 40.5, lon: -75, source: 'grid' }, lastAt: 0, sending: false, timerOn: false, nextAt: 0, sentence: '' };

test('Beacon panel: the radio button says what it will do; disabled, the gate\'s sentence is its reason', () => {
  const p = W.beaconPanel({ rf: RF_READY, beacon: BEACON, ssidChoices: require('../lib/aprs-beacon').SSID_CHOICES });
  assert.strictEqual(p.rf.label, 'Beacon on 30 m');
  assert.strictEqual(p.rf.sub, '10.1476 MHz at 5 W, one click');
  assert.strictEqual(p.rf.disabled, false);
  assert.ok(/path WIDE1-1/.test(p.detail) && /about 1\.6 s on the air/.test(p.detail), 'mode, call, path and air time under it, before the click');
  assert.strictEqual(p.as, 'Beacons as K3SBP-6 (internet K3SBP-10)');
  assert.ok(/\(special activity\)/.test(p.asTitle), p.asTitle);
  const why = 'Turn on Listen on my radio first. The beacon goes out on the frequency it listens on.';
  const no = W.beaconPanel({ rf: { ...RF_READY, allowed: false, reason: 'listen', why, band: '', bandLabel: '' }, beacon: BEACON });
  assert.strictEqual(no.rf.disabled, true);
  assert.strictEqual(no.rf.label, 'Beacon on the radio');
  assert.strictEqual(no.rf.reason, why); assert.strictEqual(no.rf.sub, why); assert.strictEqual(no.rf.title, why);
  const busy = W.beaconPanel({ rf: { ...RF_READY, phase: 'keyed', keyed: true }, beacon: BEACON });
  assert.strictEqual(busy.rf.disabled, true); assert.strictEqual(busy.rf.label, 'Sending on 30 m...');
  assert.strictEqual(W.beaconPanel({ rf: RF_READY, beacon: BEACON, clickHeld: true }).rf.disabled, true, 'a click on its way');
});

test('Beacon panel: the internet button and the last radio beacon\'s power and SWR', () => {
  const p = W.beaconPanel({ rf: { ...RF_READY, lastAt: 1000, lastBand: '30m', lastHeldMs: 2100, lastPeak: { swr: 1.5, fwdW: 4.1 } }, beacon: { ...BEACON, settings: { ...BEACON.settings, intervalMin: 30 } }, now: 1000 + 8 * 60000 });
  assert.strictEqual(p.net.label, 'Beacon on the internet');
  assert.strictEqual(p.net.sub, 'Timer: every 30 min');
  assert.strictEqual(W.beaconPanel({ rf: RF_READY, beacon: { ...BEACON, lastAt: 1000 }, now: 1000 + 3 * 60000 }).net.sub, 'Last 3 min ago. Once, now. Nothing goes on the air.');
  assert.strictEqual(p.last, 'Last radio beacon 8 min ago · 2.1 s · 4.1 W out · SWR 1.5');
  assert.strictEqual(W.beaconPanel({ rf: { ...RF_READY, band: '2m', lastAt: 1000, lastBand: '30m' }, beacon: BEACON, now: 61000 }).last, 'Last radio beacon 1 min ago on 30 m', 'the band when it differs');
  const nocall = W.beaconPanel({ rf: RF_READY, beacon: { ...BEACON, call: '' } });
  assert.strictEqual(nocall.net.disabled, true);
  assert.strictEqual(nocall.net.reason, 'Set your callsign in Settings first.');
  const refused = W.beaconPanel({ rf: { ...RF_READY, sentence: 'The radio refused to transmit: out of band.' }, beacon: BEACON });
  assert.deepStrictEqual(refused.result, { text: 'The radio refused to transmit: out of band.', tone: 'bad' });
});

test('live meters while keyed: power out against the set power, SWR; no reading says so', () => {
  const v = W.liveMeters({ fwdW: 4.1, swr: 1.5, setW: 5, available: { swr: true, power: true } });
  assert.strictEqual(v.power.text, '4.1 W'); assert.strictEqual(v.power.pct, 82);
  assert.strictEqual(v.swr.text, '1.5'); assert.strictEqual(v.swr.cls, 'ok'); assert.strictEqual(v.swr.pct, 25);
  assert.strictEqual(v.note, 'Set to 5 W, read back from the radio before keying.');
  const none = W.liveMeters({ fwdW: 0, swr: 0, setW: 5, available: { swr: false, power: false } });
  assert.strictEqual(none.swr.text, 'No SWR from this radio');
  assert.strictEqual(none.power.text, 'No RF out reading from this radio');
});

test('TX power minus / plus: the rig\'s choices where it has them, else round steps inside its range', () => {
  const P = require('../lib/rig-power-view');
  const v = P.powerView({ watts: 5, powerUnit: 'W', settable: true, capable: true, known: true, minPower: 5, maxPower: 100, powerStep: 1, powerDecimals: 0, powerChoices: null });
  assert.strictEqual(W.powerStep(v, +1), 10);
  assert.strictEqual(W.powerStep(v, -1), null, 'at the minimum');
  assert.strictEqual(W.powerStep({ ...v, watts: 100 }, +1), null, 'at the maximum');
  assert.strictEqual(W.powerStep({ ...v, watts: 100 }, -1), 75);
  const sel = P.powerView({ watts: 2.5, powerUnit: 'W', settable: true, capable: true, known: true, minPower: 0.5, maxPower: 5, powerChoices: [0.5, 1, 2.5, 5], powerDecimals: 1 });
  assert.strictEqual(W.powerStep(sel, +1), 5); assert.strictEqual(W.powerStep(sel, -1), 1);
  assert.strictEqual(W.powerStep({ ...v, enabled: false }, +1), null, 'read only: no steps');
});

// ── the Stations list ───────────────────────────────────────────────────────
test('a station row is two lines: call and how heard, distance and age; the comment under', () => {
  const now = 100 * 60000;
  const mine = W.stationRow({ label: 'VE2SIL-1', rf: { kind: 'digi', digi: 'W3EKT-1' }, distanceKm: 398 * W.KM_PER_MI, lastHeard: now - 19 * 60000, comment: 'HF gateway' }, { unit: 'mi', now });
  assert.deepStrictEqual(mine, { call: 'VE2SIL-1', via: 'my radio, via W3EKT-1', mine: true, dist: '398 mi', ago: '19 min', comment: 'HF gateway' });
  const net = W.stationRow({ label: 'NK1N', rf: null, distanceKm: 17 * W.KM_PER_MI, lastHeard: now, comment: 'PHG5130' }, { unit: 'mi', now });
  assert.strictEqual(net.via, 'internet'); assert.strictEqual(net.ago, 'now'); assert.strictEqual(net.mine, false);
  assert.strictEqual(W.stationRow({ label: 'X', distanceKm: 1210 * W.KM_PER_MI, lastHeard: now }, { unit: 'mi', now }).dist, '1,210 mi');
  assert.strictEqual(W.stationCounts([{ rf: {} }, { rf: null }, { rf: null }]).text, '1 by my radio, 2 on the internet');
  const pop = read('renderer/aprs-popout.js');
  assert.ok(/W\.stationRow\(r, \{ unit: unit, now: t \}\)/.test(pop), 'the list draws stationRow');
  assert.ok(/filter\(function \(r\) \{ return !!r\.rf; \}\)\.concat\(/.test(pop), 'my radio\'s stations first');
  assert.ok(/mapRows = heardOnly \?/.test(pop), 'the map switch filters the map');
  const css = read('renderer/aprs-popout.css');
  assert.ok(/\.aprs-st-cmt \{[^}]*text-overflow: ellipsis/.test(css), 'the comment line is ellipsised');
});

// ── the page ────────────────────────────────────────────────────────────────
const html = read('renderer/aprs-popout.html');
test('the page: three cards with no "APRS" heading, the banners, the map switch, the Beacon panel, the Stations list', () => {
  const cards = html.slice(html.indexOf('<header class="aprs-cards">'), html.indexOf('</header>'));
  assert.ok(/aria-label="My radio"/.test(cards) && /aria-label="APRS-IS"/.test(cards) && /aria-label="Heard by my radio"/.test(cards));
  assert.ok(!/<h[1-6][^>]*>\s*APRS\s*<\/h/.test(cards) && !/class="aprs-cards-title"/.test(cards), 'no APRS heading at the left of the cards (Casey)');
  assert.ok(/id="aprs-timer-banner"/.test(html) && />Stop the timer</.test(html));
  assert.ok(/id="aprs-air-banner"/.test(html) && /id="aprs-rf-stop">Stop transmitting</.test(html));
  assert.ok(/id="aprs-map-heard"[^>]*>Heard by my radio</.test(html) && /id="aprs-map-all"[^>]*>Everyone</.test(html));
  assert.ok(/<h2>Beacon<\/h2>/.test(html) && /<h2>Stations<\/h2>/.test(html) && /Within\s*<select id="aprs-range">/.test(html));
  assert.ok(/id="aprs-rf-power-down" aria-label="Less power"/.test(html) && /id="aprs-rf-power-up" aria-label="More power"/.test(html));
  assert.ok(/id="aprs-rf-now" disabled/.test(html), 'the radio button starts disabled');
  assert.ok(!/aprs-listen-bar|aprs-beacon-bar|aprs-rf-beacon-bar/.test(html), 'the old bars are gone');
  for (const f of ['renderer/aprs-listen-bar.js', 'renderer/aprs-beacon-bar.js', 'renderer/aprs-rf-beacon-bar.js', 'renderer/aprs-listen-bar.css', 'renderer/aprs-beacon-bar.css']) assert.ok(!fs.existsSync(path.join(root, f)), f + ' removed');
  assert.ok(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(html + read('renderer/aprs-window.js') + read('lib/aprs-window-state.js')) === false, 'no emoji');
  // Order: the libs before the two scripts that use them.
  const at = (s) => html.indexOf(s);
  assert.ok(at('../lib/aprs-window-state.js') < at('aprs-popout.js"') && at('aprs-popout.js"') < at('aprs-window.js"'));
  assert.ok(at('popout-theme-boot.js') < at('<link'), 'the theme boot first');
});

test('window rules: themed background, remembered place, theme query (test/window-rules-test.js)', () => {
  const main = read('main.js');
  const open = main.slice(main.indexOf("ipcMain.on('aprs-popout-open'"), main.indexOf("ipcMain.on('aprs-ready'"));
  assert.ok(/backgroundColor: getThemeWindowBg\(\)/.test(open));
  assert.ok(/rememberWindowPlace\(aprsWin, 'aprsPopoutBounds'/.test(open));
  assert.ok(/loadFile\(path\.join\(__dirname, 'renderer', 'aprs-popout\.html'\), \{ query: themeQuery\(\) \}\)/.test(open));
});

test('theme: colours are theme variables only, never a hard-coded hex', () => {
  const css = read('renderer/aprs-popout.css');
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(css), 'no hex in the stylesheet');
  assert.ok(/\.aprs-banner-air \{ background: var\(--tx-active\); color: var\(--on-tx-active\); \}/.test(css), 'on the air: the theme\'s on-air colour');
  assert.ok(/\.aprs-banner-timer \{ background: var\(--tint-orange\)/.test(css));
});

// ── main: Stop transmitting is the window-close abort ───────────────────────
test('Stop transmitting is main\'s aprsRfAbort, the abort closing the window uses', () => {
  const main = read('main.js');
  assert.ok(/ipcMain\.on\('aprs-rf-stop', \(\) => \{ aprsRfAbort\('you pressed Stop transmitting'\); aprsRfPush\(\); \}\);/.test(main));
  assert.ok(/aprsRfAbort\('the APRS window closed'\)/.test(main), 'the same function on close');
  assert.ok(/if \(aprsRf && aprsRf\.inFlight\(\)\) aprsRf\.abort\(why\);/.test(fnBody(main, 'aprsRfAbort')));
  assert.ok(/rfStop: \(\) => ipcRenderer\.send\('aprs-rf-stop'\)/.test(read('preload-aprs-popout.js')));
  const abort = read('lib/aprs-rf-beacon.js');
  assert.ok(/function abort\(why\) \{[\s\S]*?fail\(r, 'aborted'/.test(abort), 'abort ends the run (finish unkeys at once)');
});

test('main: the payload carries the key-down time, the air time and the last hold; the feed switch spares an ECHOCAT device', () => {
  const main = read('main.js');
  const pay = fnBody(main, 'aprsRfPayload');
  assert.ok(/keyedAt: _aprsRfKeyed \? _aprsRfKeyedAt : 0, airMs: _aprsRfAirMs, lastHeldMs: aprsRfUi\.lastHeldMs/.test(pay));
  assert.ok(/_aprsRfAirMs = cap\.airMs;/.test(fnBody(main, 'aprsRfTransmit')));
  assert.ok(/_aprsRfPeak\.start\(\);\n  _aprsRfKeyedAt = Date\.now\(\);/.test(fnBody(main, 'aprsRfKey')));
  const fs2 = main.slice(main.indexOf("ipcMain.on('aprs-feed-set'"), main.indexOf("ipcMain.on('aprs-set-range'"));
  assert.ok(/if \(aprsEcho\.keepsFeed\(\)\)/.test(fs2) && fs2.indexOf('keepsFeed') < fs2.indexOf('aprsStopFeed()'));
  assert.ok(/dialMhz: !aprsListen\.on/.test(fnBody(main, 'aprsListenPayload')));
});

// ── the glue against a stand-in DOM ─────────────────────────────────────────
const IDS = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
// Each element starts with the classes the page gives it (hidden ones stay hidden).
const CLASSES = {};
for (const m of html.matchAll(/<[a-z0-9]+\b[^>]*>/g)) {
  const id = /\bid="([^"]+)"/.exec(m[0]), cl = /\bclass="([^"]*)"/.exec(m[0]);
  if (id) CLASSES[id[1]] = cl ? cl[1] : '';
}
function makeDom() {
  const els = {};
  function el(id, tag) {
    const cls = new Set();
    let text = '';
    const e = {
      id, tagName: String(tag || 'div').toUpperCase(), title: '', disabled: false, hidden: false, checked: false, value: '', type: '',
      dataset: {}, style: {}, children: [], options: [], attrs: {}, listeners: {},
      get textContent() { return text || e.children.map((c) => c.textContent).join(' '); },
      set textContent(v) { text = String(v); e.children = []; e.options = []; },
      set innerHTML(v) { text = ''; e.children = []; e.options = []; },
      get innerHTML() { return ''; },
      get className() { return Array.from(cls).join(' '); },
      set className(v) { cls.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => cls.add(c)); },
      classList: {
        add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c),
        toggle: (c, on) => { if (on === undefined ? !cls.has(c) : on) cls.add(c); else cls.delete(c); },
      },
      setAttribute(k, v) { e.attrs[k] = String(v); }, getAttribute(k) { return e.attrs[k]; },
      appendChild(c) { e.children.push(c); if (c.tagName === 'OPTION') e.options.push(c); return c; },
      addEventListener(t, fn) { (e.listeners[t] = e.listeners[t] || []).push(fn); },
      fire(t, ev) { for (const fn of e.listeners[t] || []) fn(ev || { target: e }); },
      blur() {}, focus() {},
    };
    return e;
  }
  const document = {
    hidden: false, activeElement: null,
    documentElement: { getAttribute: () => '' },
    getElementById: (id) => {
      if (!IDS.has(id)) return null;
      if (!els[id]) { els[id] = el(id, /select|ssid|interval|range$/.test(id) ? 'select' : 'div'); els[id].className = CLASSES[id] || ''; }
      return els[id];
    },
    createElement: (tag) => el('', tag),
    addEventListener() {},
  };
  return { els, document };
}
function loadWindow() {
  const { els, document } = makeDom();
  const calls = [];
  const on = {};
  const clock = { t: 1_000_000 };
  class FakeDate extends Date { static now() { return clock.t; } }
  const api = {};
  for (const k of ['minimize', 'maximize', 'close', 'setRange', 'openExternal', 'ready', 'listenSet', 'listenBand', 'listenGet', 'beaconNow', 'beaconGet', 'beaconSet', 'rfGet', 'rfSend', 'rfStop', 'feedSet', 'igateSet', 'rigPowerGet']) {
    api[k] = (...a) => calls.push([k, ...a]);
  }
  api.rigControl = (d) => { calls.push(['rigControl', d]); return Promise.resolve({ ok: true }); };
  for (const k of ['onInit', 'onStatus', 'onPackets', 'onListen', 'onIgate', 'onBeacon', 'onRf', 'onRigPower', 'onCatSmeter', 'onCatSwr', 'onCatSwrRatio', 'onCatFwdPower']) {
    api[k] = (cb) => { calls.push([k]); on[k] = cb; };
  }
  const timers = [];
  const ctx = {
    document, console, Date: FakeDate, Math, Number, String, Object, Array, JSON, Set, Map, Infinity, isFinite, parseFloat, parseInt, Promise,
    setTimeout: (fn, ms) => { timers.push({ fn, at: clock.t + (ms || 0) }); return timers.length; }, clearTimeout: () => {},
    setInterval: () => 0, getComputedStyle: () => ({ getPropertyValue: () => '' }),
    MutationObserver: class { observe() {} },
    AprsIcons: { svg: () => '' },
  };
  ctx.window = ctx; ctx.self = ctx; ctx.api = api;
  vm.createContext(ctx);
  for (const f of ['lib/aprs-beacon.js', 'lib/rig-power-view.js', 'lib/aprs-rf-meters.js', 'lib/aprs-window-state.js', 'renderer/aprs-window.js']) vm.runInContext(read(f), ctx, { filename: f });
  const runTimers = () => { const due = timers.splice(0).filter((t) => t.at <= clock.t + 1e9); for (const t of due) t.fn(); };
  return { els, calls, on, clock, runTimers, el: (id) => document.getElementById(id), names: () => calls.map((c) => c[0]) };
}

test('glue: asks main for the listen state after its listen and iGate listeners are attached (the 8600M\'s empty row)', () => {
  const w = loadWindow();
  const n = w.names();
  assert.ok(n.indexOf('onListen') >= 0 && n.indexOf('onIgate') >= 0);
  assert.ok(n.indexOf('listenGet') > n.indexOf('onListen') && n.indexOf('listenGet') > n.indexOf('onIgate'), n.join(','));
  assert.ok(n.indexOf('beaconGet') > n.indexOf('onBeacon') && n.indexOf('rfGet') > n.indexOf('onRf') && n.indexOf('rigPowerGet') > n.indexOf('onRigPower'));
  const main = read('main.js');
  const at = main.indexOf("ipcMain.on('aprs-listen-get'");
  const h = main.slice(at, main.indexOf('\n', at));
  assert.ok(/aprsListenPush\(\)/.test(h) && /aprsIgatePush\(\)/.test(h), 'main answers with the listen state and the iGate mark');
});

test('glue: off, the 30 m button from the first answer; a click picks the band and turns listening on', () => {
  const w = loadWindow();
  assert.strictEqual(w.els['aprs-listen-bands'].children.length, 0, 'no buttons before main answers');
  w.on.onListen({ ...LISTEN_OFF, bands: ['30m'], band: '30m' });
  const btns = w.els['aprs-listen-bands'].children;
  assert.strictEqual(btns.length, 1);
  assert.strictEqual(btns[0].textContent, 'Listen on 30 m');
  btns[0].fire('click');
  const tail = w.calls.slice(-2);
  assert.deepStrictEqual(tail, [['listenBand', '30m'], ['listenSet', true]]);
  w.on.onListen({ ...LISTEN_OFF, state: 'refused', sentence: 'Connect your radio to listen to APRS.' });
  assert.ok(/Connect your radio to listen to APRS\./.test(w.els['radio-lines'].textContent));
  w.on.onListen(LISTEN_ON);
  assert.strictEqual(w.els['radio-title'].textContent, 'Listening on my radio');
  assert.strictEqual(w.els['aprs-listen-on'].checked, true);
  w.els['aprs-listen-on'].checked = false;
  w.els['aprs-listen-on'].fire('change', { target: w.els['aprs-listen-on'] });
  assert.deepStrictEqual(w.calls[w.calls.length - 1], ['listenSet', false]);
});

test('glue: one click sends one radio beacon; a second click while it goes out does nothing; a refusal disables with its reason', () => {
  const w = loadWindow();
  w.on.onBeacon(BEACON);
  w.on.onRf(RF_READY);
  const btn = w.els['aprs-rf-now'];
  assert.strictEqual(btn.disabled, false);
  assert.strictEqual(w.els['aprs-rf-now-label'].textContent, 'Beacon on 30 m');
  assert.strictEqual(w.els['aprs-rf-now-sub'].textContent, '10.1476 MHz at 5 W, one click');
  btn.fire('click');
  assert.strictEqual(btn.disabled, true, 'disabled at once');
  btn.fire('click');
  w.on.onRf(RF_READY); // a push from before the click arrives: still held
  btn.fire('click');
  w.clock.t += 5000;
  w.on.onRf({ ...RF_READY, sending: true, phase: 'waiting' });
  btn.fire('click');
  w.on.onRf({ ...RF_READY, phase: 'keyed', keyed: true, keyedAt: w.clock.t });
  btn.fire('click');
  assert.strictEqual(w.calls.filter((c) => c[0] === 'rfSend').length, 1, 'never a second send');
  w.on.onRf(RF_READY);
  assert.strictEqual(btn.disabled, false, 'ready again after the beacon');
  const why = 'Turn on Listen on my radio first. The beacon goes out on the frequency it listens on.';
  w.on.onRf({ ...RF_READY, allowed: false, reason: 'listen', why });
  assert.strictEqual(btn.disabled, true);
  assert.strictEqual(btn.title, why);
  assert.strictEqual(w.els['aprs-rf-now-sub'].textContent, why);
  btn.fire('click');
  assert.strictEqual(w.calls.filter((c) => c[0] === 'rfSend').length, 1);
});

test('glue: the timer banner shows only with an interval; Stop the timer sets it to Off', () => {
  const w = loadWindow();
  w.on.onListen(LISTEN_ON);
  w.on.onBeacon(BEACON);
  assert.strictEqual(w.els['aprs-timer-banner'].classList.contains('hidden'), true);
  w.on.onBeacon({ ...BEACON, settings: { ...BEACON.settings, intervalMin: 20 }, timerOn: true, nextAt: w.clock.t + 600000 });
  assert.strictEqual(w.els['aprs-timer-banner'].classList.contains('hidden'), false);
  assert.strictEqual(w.els['aprs-timer-title'].textContent, 'Beaconing over the internet every 20 min as K3SBP-10.');
  assert.ok(/The radio only sends when you press Beacon on 30 m\./.test(w.els['aprs-timer-detail'].textContent));
  w.els['aprs-timer-stop'].fire('click');
  assert.strictEqual(JSON.stringify(w.calls[w.calls.length - 1]), JSON.stringify(['beaconSet', { intervalMin: 0 }]));
  assert.ok(!w.calls.some((c) => c[0] === 'beaconNow' || c[0] === 'rfSend'), 'nothing is sent by showing or stopping the timer');
});

test('glue: the on-air banner shows only while keyed, and Stop transmitting asks main to abort', () => {
  const w = loadWindow();
  w.on.onBeacon(BEACON);
  w.on.onRf(RF_READY);
  const banner = w.els['aprs-air-banner'];
  assert.strictEqual(banner.classList.contains('hidden'), true);
  w.on.onRf({ ...RF_READY, phase: 'waiting', sending: true });
  assert.strictEqual(banner.classList.contains('hidden'), true, 'not while waiting');
  w.on.onRf({ ...RF_READY, phase: 'keyed', keyed: true, keyedAt: w.clock.t - 1400 });
  assert.strictEqual(banner.classList.contains('hidden'), false);
  assert.strictEqual(w.els['aprs-air-title'].textContent, 'On the air: APRS beacon on 30 m as K3SBP-6');
  assert.strictEqual(w.els['aprs-air-time'].textContent, '1.4 s of about 2.7 s');
  assert.strictEqual(w.els['card-radio'].className, 'aprs-card tx', 'the red card');
  w.els['aprs-rf-stop'].fire('click');
  assert.deepStrictEqual(w.calls[w.calls.length - 1], ['rfStop']);
  w.on.onRf(RF_READY);
  assert.strictEqual(banner.classList.contains('hidden'), true, 'gone once unkeyed');
});

test('glue: TX power plus sends set-tx-power through rig-control; the value shown is the radio\'s read-back', () => {
  const w = loadWindow();
  const payload = { watts: 5, powerUnit: 'W', settable: true, capable: true, known: true, minPower: 5, maxPower: 100, powerStep: 1, powerDecimals: 0, powerChoices: null };
  w.on.onRigPower(payload);
  assert.strictEqual(w.els['aprs-rf-power-label'].textContent, 'Power (radio reads 5 W)');
  assert.strictEqual(w.els['aprs-rf-power-val'].textContent, '5 W');
  assert.strictEqual(w.els['aprs-rf-power-down'].disabled, true, 'at the minimum');
  w.els['aprs-rf-power-up'].fire('click');
  assert.strictEqual(w.els['aprs-rf-power-val'].textContent, 'setting 10W');
  w.runTimers();
  assert.strictEqual(JSON.stringify(w.calls.filter((c) => c[0] === 'rigControl').map((c) => c[1])), JSON.stringify([{ action: 'set-tx-power', value: 10 }]));
  w.on.onRigPower({ ...payload, watts: 10 });
  assert.strictEqual(w.els['aprs-rf-power-val'].textContent, '10 W', 'the read-back');
  w.on.onRigPower({ ...payload, capable: false });
  assert.strictEqual(w.els['aprs-rf-power-up'].disabled, true, 'no txpower capability: no control');
  assert.ok(!/set-tx-power/.test(read('lib/aprs-rf-beacon.js')), 'the beacon itself never changes power');
});

test('glue: My APRS SSID picks the radio beacon\'s ending; the header shows both calls', () => {
  const w = loadWindow();
  w.on.onBeacon(BEACON);
  const sel = w.els['aprs-rf-ssid'];
  assert.strictEqual(sel.options.length, 17, 'As my Settings callsign, then 0 to 15');
  assert.strictEqual(sel.options[7].textContent, '-6 special activity, satellite, camping');
  sel.value = '9';
  sel.fire('change', { target: sel });
  assert.strictEqual(JSON.stringify(w.calls[w.calls.length - 1]), JSON.stringify(['beaconSet', { rfSsid: 9 }]));
  assert.strictEqual(w.els['aprs-beacon-as'].textContent, 'Beacons as K3SBP-6 (internet K3SBP-10)');
});

// ── APRS settings (Casey 2026-11-20: "iGate should be a setting on the APRS window ... not hidden in idle mode") ──
test('APRS settings: a plain-text, labelled button top right opens a panel inside the window, no browser dialog', () => {
  const tb = html.slice(html.indexOf('<div class="titlebar-controls">'), html.indexOf('id="tb-min"'));
  assert.ok(/id="aprs-settings-btn" aria-haspopup="dialog" aria-controls="aprs-settings" aria-label="APRS settings[^"]*">APRS settings<\/button>/.test(tb), 'in the title bar, before the window buttons');
  assert.ok(/<section class="aprs-settings hidden" id="aprs-settings" role="dialog"/.test(html));
  const panel = html.slice(html.indexOf('id="aprs-settings" role="dialog"'));
  for (const id of ['aprs-igate-on', 'aprs-rf-ssid', 'aprs-precision', 'aprs-beacon-pick', 'aprs-beacon-syms', 'aprs-beacon-comment', 'aprs-beacon-activation']) assert.ok(panel.indexOf('id="' + id + '"') > 0, id + ' is in the panel');
  assert.ok(/Report what I hear to APRS-IS \(iGate\)/.test(panel));
  const main = html.slice(0, html.indexOf('id="aprs-settings" role="dialog"'));
  for (const id of ['aprs-rf-ssid', 'aprs-beacon-comment', 'aprs-beacon-syms', 'aprs-beacon-approx']) assert.ok(main.indexOf('id="' + id + '"') < 0, id + ' is no longer on the main screen');
  assert.ok(/id="aprs-beacon-settings"/.test(main) && /id="aprs-igate-settings"[^>]*>iGate settings</.test(main), 'the links that open it');
  const glue = read('renderer/aprs-window.js');
  assert.ok(!/alert\(|confirm\(|prompt\(|showMessageBox/.test(glue), 'no browser dialog');
});

test('APRS settings: the iGate switch is settings.aprsIgate, the one setting Idle Mode shows', () => {
  const main = read('main.js');
  assert.ok(/ipcMain\.on\('aprs-igate-set', \(_e, on\) => aprsIgateSetFromWindow\(on === true\)\);/.test(main));
  const fn = fnBody(main, 'aprsIgateSetFromWindow');
  assert.ok(/settings\.aprsIgate = on === true;/.test(fn) && /saveSettings\(settings\)/.test(fn) && /aprsIgateSync\(\); aprsIgatePush\(\);/.test(fn), fn);
  assert.ok(/win\.webContents\.send\('aprs-igate-status', s\)/.test(fnBody(main, 'aprsIgatePush')), 'the main window hears every change');
  assert.ok(/igateSet: \(on\) => ipcRenderer\.send\('aprs-igate-set', !!on\)/.test(read('preload-aprs-popout.js')));
  const ix = read('renderer/index.html'), app = read('renderer/app.js');
  assert.ok(!/id="set-aprs-igate"/.test(ix), 'no second switch in Idle Mode');
  assert.ok(/id="idle-aprs-igate-line"/.test(ix) && /'iGate: ' \+ \(s && s\.on \? 'on' : 'off'\) \+ ', set in the APRS window/.test(app));
  assert.ok(!/aprsIgate: document\.getElementById/.test(app), 'Settings\' save never writes the iGate (it cannot undo a change made in the APRS window)');
});

test('APRS settings, glue: opens and closes, the iGate checkbox sends igateSet, precision sends beaconSet', () => {
  const w = loadWindow();
  w.on.onBeacon(BEACON);
  w.on.onIgate({ on: false });
  const panel = w.el('aprs-settings');
  assert.strictEqual(panel.classList.contains('hidden'), true);
  w.els['aprs-igate-settings'].fire('click');
  assert.strictEqual(panel.classList.contains('hidden'), false, 'the APRS-IS card link opens it');
  const ig = w.els['aprs-igate-on'];
  ig.checked = true; ig.fire('change', { target: ig });
  assert.strictEqual(JSON.stringify(w.calls[w.calls.length - 1]), JSON.stringify(['igateSet', true]));
  w.on.onIgate({ on: true, active: false, link: 'stopped', gated: 0 });
  assert.strictEqual(w.els['aprs-igate-state'].textContent, 'iGate on: waits for my radio to listen');
  assert.ok(/iGate on/.test(w.els['is-lines'].textContent), 'the APRS-IS card shows it');
  w.on.onIgate({ on: true, paused: 'iGate paused: a guest has the radio' });
  assert.ok(/iGate paused: a guest has the radio/.test(w.els['is-lines'].textContent), 'paused for a Guest Pass');
  const radios = w.els['aprs-precision'].children;
  assert.deepStrictEqual(radios.map((r) => r.children[0].value), ['grid4', 'grid6', 'exact']);
  radios[0].children[0].checked = true; radios[0].children[0].fire('change');
  assert.strictEqual(JSON.stringify(w.calls[w.calls.length - 1]), JSON.stringify(['beaconSet', { precision: 'grid4' }]));
  w.els['aprs-settings-done'].fire('click');
  assert.strictEqual(panel.classList.contains('hidden'), true);
  assert.ok(!w.calls.some((c) => c[0] === 'beaconNow' || c[0] === 'rfSend'), 'no setting sends anything');
});

test('position precision: grid 4, grid 6, exact; each says what it reveals; the default is today\'s behaviour', () => {
  const c = W.precisionChoices({ grid: 'FN20JB', settings: { approx: true, precision: null } });
  assert.deepStrictEqual(c.map((x) => x.label), ['Grid square, 4 characters (FN20)', 'Grid square, 6 characters (FN20jb)', 'Exact position']);
  assert.deepStrictEqual(c.map((x) => x.checked), [false, true, false], 'not set + approximate (today\'s default) = the 6-character square');
  assert.ok(c.every((x) => x.note && x.note.split('. ').length <= 2), 'one line each');
  assert.strictEqual(W.precisionChoices({ grid: 'FN20', settings: { approx: true } })[1].disabled, true, 'a 4-character grid cannot give 6');
  const B = require('../lib/aprs-beacon');
  assert.strictEqual(B.beaconSettings({}).precision, null, 'not set: today\'s behaviour');
  assert.deepStrictEqual(B.settingsPatch({ precision: 'grid4' }), { aprsBeaconPrecision: 'grid4', aprsBeaconApprox: true });
  assert.deepStrictEqual(B.settingsPatch({ precision: 'exact' }), { aprsBeaconPrecision: 'exact', aprsBeaconApprox: false });
  assert.deepStrictEqual(B.settingsPatch({ precision: 'street' }), {});
  assert.deepStrictEqual(B.positionInputs({ precision: 'grid4', lat: 40.1, lon: -75.1, grid: 'FN20jb' }), { lat: null, lon: null, grid: 'FN20' }, 'a grid never uses the picked point');
  assert.deepStrictEqual(B.positionInputs({ precision: 'grid6', lat: 40.1, lon: -75.1, grid: 'FN20jb' }), { lat: null, lon: null, grid: 'FN20jb' });
  assert.deepStrictEqual(B.positionInputs({ precision: null, lat: 40.1, lon: -75.1, grid: 'FN20jb' }), { lat: 40.1, lon: -75.1, grid: 'FN20jb' }, 'today\'s path unchanged');
  assert.deepStrictEqual(B.positionInputs({ precision: 'exact', lat: 40.1, lon: -75.1, grid: 'FN20jb' }), { lat: 40.1, lon: -75.1, grid: 'FN20jb' });
  const main = read('main.js');
  // The radio's GPS PR: the precision goes through the one position provider (lib/aprs-position.js), for every source.
  assert.ok(/AprsPosition\.beaconPositionFrom\(\{[^}]*precision: st\.precision/.test(fnBody(main, 'aprsBeaconPosition')), 'both beacons use it (one position function)');
  assert.ok(/AprsBeacon\.positionInputs\(\{ precision, lat, lon, grid \}\)/.test(read('lib/aprs-position.js')), 'the provider applies the precision rule');
  assert.ok(/precision: 'exact'/.test(read('renderer/aprs-window.js')), 'picking a point on the map is the exact position');
});

test('the test is in scripts/run-tests.js', () => {
  assert.ok(read('scripts/run-tests.js').indexOf("'test/aprs-window-test.js'") >= 0);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
