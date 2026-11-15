#!/usr/bin/env node
'use strict';
/**
 * The Flex pan centres on the Winlink channel (ECHOCAT's ask 2026-11-15,
 * Casey on the 8600: "It's not centered where I transmit"):
 *   - lib/scope-digital-view.js winlinkView: the modem's channel from
 *     lib/winlink-spectrum.js markerBand, at its RF position (above the dial
 *     on USB/DIGU, below on LSB/DIGL, moved by the slice's DIGU/DIGL offset),
 *     6 kHz wide; pickView: a Winlink session wins, then the JTCAT view, then
 *     a device's ask
 *   - the JTCAT view unchanged
 *   - remote-server: scope-digital-view {on, view: 'winlink'}, capability
 *     scope-winlink-view
 *   - main.js: on while a session runs or a device asks; the operator's zoom
 *     and the dial centre come back when it ends; never `atu clear`
 *
 * Run: node test/winlink-pan-view-test.js
 */
require('./ws-stub-if-missing');
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const V = require('../lib/scope-digital-view');
const S = require('../lib/winlink-spectrum');
const protocol = require('../lib/echocat-protocol');
const { RemoteServer } = require('../lib/remote-server');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
const ROOT = path.join(__dirname, '..');
const main = readSrc(path.join(ROOT, 'main.js'));
const server = readSrc(path.join(ROOT, 'lib', 'remote-server.js'));
const fnSrc = (name) => new RegExp(`function ${name}\\(\\) \\{[\\s\\S]*?\\n\\}`).exec(main)[0];
const vara = S.markerBand('vara', { vara: 2300 });
const ardop = S.markerBand('ardop', { ardop: 500 });

console.log('The Winlink view');
test('USB / DIGU: the channel above the dial, centred on 1500 Hz, 6 kHz wide', () => {
  for (const rigMode of ['USB', 'DIGU', 'PKTUSB']) {
    assert.deepStrictEqual(V.winlinkView({ band: vara, rigMode, minSpanHz: 1230 }),
      { kind: 'winlink', offsetHz: 1500, spanHz: 6000, window: { lo: 350, hi: 2650 } }, rigMode);
  }
  assert.deepStrictEqual(V.winlinkView({ band: ardop, rigMode: 'DIGU' }).window, { lo: 1250, hi: 1750 }, 'ARDOP 500');
  assert.strictEqual(V.winlinkView({ band: ardop, rigMode: 'DIGU' }).offsetHz, 1500);
});
test('LSB / DIGL: the channel below the dial', () => {
  for (const rigMode of ['LSB', 'DIGL', 'PKTLSB']) {
    assert.deepStrictEqual(V.winlinkView({ band: vara, rigMode }),
      { kind: 'winlink', offsetHz: -1500, spanHz: 6000, window: { lo: -2650, hi: -350 } }, rigMode);
  }
});
test('a DIGU or DIGL offset on the slice moves the centre to where the signal really is', () => {
  const kv = { digu_offset: '1500', digl_offset: '2210' };
  assert.strictEqual(V.flexDigOffsetHz('DIGU', kv), 1500);
  assert.strictEqual(V.flexDigOffsetHz('DIGL', kv), 2210);
  assert.strictEqual(V.flexDigOffsetHz('USB', kv), 0, 'USB has no data offset');
  assert.strictEqual(V.flexDigOffsetHz('DIGU', {}), 0, 'the slice has not said');
  assert.strictEqual(V.flexDigOffsetHz('DIGU', { digu_offset: 'x' }), 0);
  const u = V.winlinkView({ band: vara, rigMode: 'DIGU', digOffsetHz: 1500 });
  assert.deepStrictEqual([u.offsetHz, u.window], [0, { lo: -1150, hi: 1150 }], 'DIGU offset 1500: the channel sits on the slice frequency');
  const l = V.winlinkView({ band: vara, rigMode: 'DIGL', digOffsetHz: 2210 });
  assert.deepStrictEqual([l.offsetHz, l.window], [710, { lo: -440, hi: 1860 }], 'DIGL offset 2210: carrier 2210 Hz up, audio below it');
});
test('the whole channel fits with the margin, and the width never drops below the radio\'s minimum', () => {
  for (const rigMode of ['DIGU', 'DIGL']) {
    const v = V.winlinkView({ band: vara, rigMode });
    assert.ok(V.viewFit(v, { offsetHz: v.offsetHz, spanHz: v.spanHz }).fits, rigMode);
  }
  assert.strictEqual(V.winlinkView({ band: vara, rigMode: 'DIGU', minSpanHz: 8000 }).spanHz, 8000);
});
test('no view on FM, and none without a channel', () => {
  assert.strictEqual(V.winlinkView({ band: S.markerBand('packet'), rigMode: 'FM' }), null);
  assert.strictEqual(V.winlinkView({ band: vara, rigMode: 'NFM' }), null);
  assert.strictEqual(V.winlinkView({ band: null, rigMode: 'DIGU' }), null);
});
test('which view: a Winlink session wins, then the JTCAT view, then a device\'s ask', () => {
  assert.strictEqual(V.pickView({}), null);
  assert.strictEqual(V.pickView({ winlinkSession: true, jtcatWanted: true }), 'winlink');
  assert.strictEqual(V.pickView({ jtcatWanted: true, winlinkAsked: true }), 'jtcat');
  assert.strictEqual(V.pickView({ winlinkAsked: true }), 'winlink');
});
test('the view key changes on and off, so the sync acts once each way', () => {
  const v = V.winlinkView({ band: vara, rigMode: 'DIGU' });
  assert.ok(V.viewKey(v));
  assert.strictEqual(V.viewKey(null), '');
  assert.notStrictEqual(V.viewKey(v), V.viewKey(V.winlinkView({ band: vara, rigMode: 'DIGL' })), 'a sideband change re-centres');
  assert.notStrictEqual(V.viewKey(v), V.viewKey(V.digitalView({ mode: 'FT8', rigMode: 'DIGU' })));
});
test('the JTCAT view is unchanged', () => {
  assert.deepStrictEqual(V.digitalView({ mode: 'FT8', rigMode: 'DIGU', minSpanHz: 1230 }), { offsetHz: 1600, spanHz: 3100, window: { lo: 200, hi: 3000 } });
  assert.deepStrictEqual(V.digitalView({ mode: 'WSPR', rigMode: 'USB', minSpanHz: 1230 }), { offsetHz: 1500, spanHz: 1230, window: { lo: 1400, hi: 1600 } });
  assert.deepStrictEqual(V.digitalView({ mode: 'FT8', rigMode: 'LSB', minSpanHz: 1230 }), { offsetHz: -1600, spanHz: 3100, window: { lo: -3000, hi: -200 } });
});

console.log('The wire');
test('scope-digital-view carries an optional view; the shack advertises scope-winlink-view', () => {
  const m = protocol.MESSAGES['scope-digital-view'];
  assert.deepStrictEqual(Object.keys(m.fields), ['on', 'view']);
  assert.ok(protocol.validate({ type: 'scope-digital-view', on: true }, protocol.Dir.C2S).ok, 'the JTCAT ask as before');
  assert.ok(protocol.validate({ type: 'scope-digital-view', on: true, view: 'winlink' }, protocol.Dir.C2S).ok);
  assert.ok(/'scope-winlink-view'\]/.test(server));
});
test('remote-server passes the view, JTCAT when absent or unknown', () => {
  const rs = new RemoteServer();
  const got = [];
  const ws = { _authenticated: true, readyState: 1, _clientId: 'c4', send() {} };
  rs._client = ws;
  rs.on('scope-digital-view', (e) => got.push([e.on, e.view, e.clientId]));
  for (const m of [{ on: true, view: 'winlink' }, { on: false, view: 'winlink' }, { on: true }, { on: true, view: 'other' }]) rs._handleMessage(ws, { type: 'scope-digital-view', ...m }, {});
  assert.deepStrictEqual(got, [[true, 'winlink', 'c4'], [false, 'winlink', 'c4'], [true, 'jtcat', 'c4'], [true, 'jtcat', 'c4']]);
});

console.log('main.js');
test('wanted while a Winlink radio session runs, or while a device asks', () => {
  const fn = fnSrc('flexDigitalViewWanted');
  assert.ok(/const wlSession = winlinkSessionActive\(\) && WinlinkModes\.isRadioMode\(winlinkState\.session\.mode\);/.test(fn));
  assert.ok(/const wlAsked = !!\(yaesuScopeRemoteWinlink && yaesuScopeRemoteWants && remoteServer/.test(fn));
  assert.ok(/ScopeDigitalView\.pickView\(\{ winlinkSession: wlSession, jtcatWanted: strip \|\| device, winlinkAsked: wlAsked \}\)/.test(fn));
  assert.ok(/WinlinkSpectrum\.markerBand\(mode, winlinkModemBw\(\)\)/.test(fn), 'the channel from markerBand');
  assert.ok(/digOffsetHz: ScopeDigitalView\.flexDigOffsetHz\(_currentMode, _flexSliceKv\)/.test(fn), 'the slice offset');
  assert.ok(/yaesuScopeRemoteDigital && yaesuScopeRemoteWants && ft8Engine\._running/.test(fn), 'the JTCAT conditions as before');
});
test('the view sends centerOffsetHz and the channel as decodeWindow; the end restores the operator\'s zoom and the dial centre', () => {
  const sync = fnSrc('flexDigitalViewSync');
  assert.ok(/yaesuScopeState\.centerOffsetHz = v\.offsetHz;/.test(sync));
  assert.ok(/yaesuScopeState\.decodeWindow = v\.window;/.test(sync));
  assert.ok(/FlexScope\.nearestSpan\(settings\.flexScopeSpanHz\)/.test(sync) && /flexScopeAskCenter\(dial\);/.test(sync), 'back to the operator zoom, on the dial');
  assert.ok(/yaesuScopeState\.decodeWindow = null;/.test(sync));
  assert.ok(!/saveSettings/.test(sync), 'the Winlink view is never saved as the operator zoom');
  assert.ok(!/atu clear/.test(sync + fnSrc('flexDigitalViewWanted')), 'never atu clear to a Flex');
});
test('the device ask follows the watchers, per view', () => {
  assert.ok(/scopeWatchers\.setDigital\(clientId, on, view\)/.test(main));
  assert.ok(/function scopeRemoteApply\(sum\) \{[^}]*yaesuScopeRemoteWinlink = !!sum\.winlink;/.test(main));
  assert.ok(/yaesuScopeRemoteDigital === before && yaesuScopeRemoteWinlink === beforeWl\) return;/.test(main), 'either view changing re-syncs the pan');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
