#!/usr/bin/env node
'use strict';
/**
 * LZ3AW round 14 (ECHOCAT Web): FT8 tab band follows a tapped spot and the
 * tab comes back to its own dial; Logbook filter bar; Prop view (RBN +
 * PSKReporter); PSK31 pane parity (macro editor, Clear, Tune, ATU); DX
 * Expeditions in the Spots menu with the desktop's DXP / CONTEST badges.
 *
 * Run: node test/lz3aw-round14-test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e).split('\n')[0]); }
}
const root = path.join(__dirname, '..');
const R = (f) => fs.readFileSync(path.join(root, f), 'utf8').replace(/\r\n/g, '\n');
const web = R('renderer/remote.js');
const html = R('renderer/remote.html');
const server = R('lib/remote-server.js');
const proto = R('lib/echocat-protocol.js');
const main = R('main.js');

function body(src, startPat) {
  const i = src.indexOf(startPat);
  assert.ok(i >= 0, 'not found: ' + startPat);
  let d = 0, j = src.indexOf('{', i);
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}' && --d === 0) break; }
  return src.slice(i, j + 1);
}
function fnFrom(names) {
  const src = names.map((n) => body(web, 'function ' + n + '(')).join('\n');
  return new Function(src + '\nreturn {' + names.join(',') + '};')();
}

console.log('LZ3AW round 14 (ECHOCAT Web)');

// --- Item 15: FT8 tab band + return dial ---
const { ft8ReturnDial } = fnFrom(['ft8ReturnDial']);
test('FT8 tab returns to the dial it left on, same band and mode only', () => {
  const left = { freqKhz: 14076.5, band: '20m', mode: 'FT8' };
  assert.strictEqual(ft8ReturnDial(left, '20m', 'FT8'), 14076.5);
  assert.strictEqual(ft8ReturnDial(left, '40m', 'FT8'), null, 'another band = its default dial');
  assert.strictEqual(ft8ReturnDial(left, '20m', 'FT4'), null, 'another mode = its default dial');
  assert.strictEqual(ft8ReturnDial(null, '20m', 'FT8'), null);
  assert.strictEqual(ft8ReturnDial({ freqKhz: 0, band: '20m', mode: 'FT8' }, '20m', 'FT8'), null);
});
test('a tapped spot moves the band dials and a running engine to its mode', () => {
  assert.ok(/if \(modeChanged\) \{\s+updateBandFreqs\(\);\s+if \(ft8Running\) ft8Send\(\{ type: 'jtcat-set-mode', mode: ft8Mode \}\);/.test(web));
  const sw = body(web, 'function switchTab(');
  assert.ok(/freqToBandLocal\(spotFreq\)/.test(sw), 'band picked from the spot frequency, not dial proximity');
  assert.ok(/ft8ReturnDial\(ft8TabDial, /.test(sw), 'return dial used when the tab reopens');
  assert.ok(/ft8TabDial = \{ freqKhz: currentFreqKhz/.test(sw), 'dial recorded on leaving the tab');
});

// --- Item 6: Logbook filter bar ---
const { lbFilterQsos, lbModeFamily } = fnFrom(['lbModeFamily', 'lbFilterQsos']);
const qsos = [
  { CALL: 'K1ABC', BAND: '20m', MODE: 'USB', QSO_DATE: '20261001' },
  { CALL: 'LZ1XX', BAND: '40m', MODE: 'CW', QSO_DATE: '20261010', SIG_INFO: 'US-1234' },
  { CALL: 'W9XYZ', BAND: '20m', MODE: 'MFSK', SUBMODE: 'FT4', QSO_DATE: '20261015' },
  { CALL: 'DL1AA', BAND: '20m', MODE: 'PSK31', QSO_DATE: '20261018' },
];
test('mode family: USB/LSB = SSB, MFSK+SUBMODE = submode, PSK31 = PSK', () => {
  assert.strictEqual(lbModeFamily(qsos[0]), 'SSB');
  assert.strictEqual(lbModeFamily(qsos[2]), 'FT4');
  assert.strictEqual(lbModeFamily(qsos[3]), 'PSK');
});
test('band, mode, date range and search combine', () => {
  const calls = (f) => lbFilterQsos(qsos, f).map((q) => q.CALL);
  assert.deepStrictEqual(calls({ band: '20m' }), ['K1ABC', 'W9XYZ', 'DL1AA']);
  assert.deepStrictEqual(calls({ mode: 'SSB' }), ['K1ABC']);
  assert.deepStrictEqual(calls({ mode: 'FT4' }), ['W9XYZ']);
  assert.deepStrictEqual(calls({ from: '2026-10-10', to: '2026-10-15' }), ['LZ1XX', 'W9XYZ']);
  assert.deepStrictEqual(calls({ query: 'us-1234' }), ['LZ1XX']);
  assert.deepStrictEqual(calls({ band: '20m', from: '2026-10-16' }), ['DL1AA']);
  assert.strictEqual(calls({}).length, 4);
});
test('Logbook filter bar markup is present', () => {
  for (const id of ['lb-filter-band', 'lb-filter-mode', 'lb-filter-from', 'lb-filter-to', 'lb-filter-clear']) {
    assert.ok(html.includes('id="' + id + '"'), id);
  }
});

// --- Prop view ---
const { propFilter } = fnFrom(['propFilter']);
test('Prop: both sources, band and age filter, newest first', () => {
  const now = Date.parse('2026-10-19T12:00:00Z');
  const rbn = [
    { spotter: 'DL8LAS', band: '20m', mode: 'CW', snr: 12, spotTime: '2026-10-19T11:50:00Z' },
    { spotter: 'OLD1', band: '20m', spotTime: '2026-10-19T09:00:00Z' },
  ];
  const pskr = [{ receiver: 'K1RX', band: '40m', mode: 'FT8', snr: -10, spotTime: '2026-10-19T11:55:00Z' }];
  const all = propFilter(rbn, pskr, { ageMin: 60, now });
  assert.deepStrictEqual(all.map((r) => r.station), ['K1RX', 'DL8LAS']);
  assert.strictEqual(all[0].source, 'PSKR');
  assert.deepStrictEqual(propFilter(rbn, pskr, { ageMin: 60, band: '20m', now }).map((r) => r.station), ['DL8LAS']);
  assert.deepStrictEqual(propFilter(rbn, pskr, { ageMin: 60, rbn: false, now }).map((r) => r.station), ['K1RX']);
  assert.strictEqual(propFilter(rbn, pskr, { ageMin: 360, now }).length, 3);
});
test('Prop: tab, view and the pushes it renders', () => {
  assert.ok(html.includes('data-tab="prop"') && html.includes('id="prop-view"') && html.includes('id="prop-map"'));
  assert.ok(/case 'rbn-prop-spots':/.test(web) && /case 'pskr-map-spots':/.test(web));
  assert.ok(/tab === 'prop'/.test(body(web, 'function switchTab(')));
  // propView is read by switchTab, which can run during the initial restore.
  assert.ok(web.indexOf("const propView = document.getElementById('prop-view');") < web.indexOf('function switchTab('));
});

// --- PSK31 pane parity ---
test('PSK31: macro editor, Clear, Tune and ATU', () => {
  for (const id of ['psk-clear', 'psk-tune', 'psk-atu', 'psk-macro-editor', 'psk-me-save', 'psk-me-reset']) {
    assert.ok(html.includes('id="' + id + '"'), id);
  }
  assert.ok(/settings: \{ pskMacros: list \}/.test(web), 'macros saved to the desktop setting');
  assert.ok(/type: 'jtcat-tune-toggle'/.test(web));
  assert.ok(/case 'jtcat-tune-state':/.test(web));
});

// --- DX Expeditions ---
const { dxeKind } = fnFrom(['dxeKind']);
test('DXE: flagged only with the master on and a listing feed on', () => {
  const st = {
    enable: true,
    sources: { clublog: true, 'dx-world': false, dxnews: true, ng3k: true },
    calls: new Set(['3Y0J', 'K1T', 'TX5X']),
    meta: { '3Y0J': { sources: 'dx-world,ng3k' }, 'K1T': { sources: 'ng3k', kind: 'contest' }, 'TX5X': { sources: 'dx-world' } },
  };
  assert.strictEqual(dxeKind('3y0j', st), 'dxpedition');
  assert.strictEqual(dxeKind('K1T', st), 'contest');
  assert.strictEqual(dxeKind('TX5X', st), '', 'its only feed is off');
  assert.strictEqual(dxeKind('W1AW', st), '');
  assert.strictEqual(dxeKind('3Y0J', Object.assign({}, st, { enable: false })), '');
  assert.strictEqual(dxeKind('3Y0J', Object.assign({}, st, { meta: {} })), 'dxpedition', 'no metadata = visible');
});
test('DXE: protocol entry, cached server push, re-applied on rebuild', () => {
  assert.ok(/'expedition-callsigns': \{ dir: Dir\.S2C/.test(proto));
  assert.ok(/setExpeditions\(payload\)/.test(server));
  assert.ok(/if \(this\._expeditions\) this\._sendTo\(ws, \{ type: 'expedition-callsigns'/.test(server), 'hydrated at connect');
  assert.ok(/remoteServer\.setExpeditions\(_lastExpeditionPayload\)/.test(main));
  assert.ok(/onRemoteServer\(\(rs\) => \{ if \(_lastExpeditionPayload && typeof rs\.setExpeditions === 'function'\) rs\.setExpeditions\(_lastExpeditionPayload\); \}\);/.test(main));
});
test('DXE: web Spots menu toggles save the desktop settings and badge spots', () => {
  assert.ok(html.includes('id="rc-dxe"'));
  for (const k of ['clublog', 'dx-world', 'dxnews', 'ng3k']) assert.ok(html.includes('data-dxe-src="' + k + '"'), k);
  assert.ok(/settings: \{ enableDxe: dxeState\.enable, enableDxeSources:/.test(web));
  assert.ok(/case 'expedition-callsigns':/.test(web));
  assert.ok(/dxeState\.enable = msg\.settings\.enableDxe === true;/.test(web));
  // The badge markup moved into lib/spot-row.js (2026-10-22); the page hands it the kind.
  assert.ok(/class="dxe-badge/.test(require('fs').readFileSync(require('path').join(__dirname, '..', 'lib', 'spot-row.js'), 'utf8')));
  assert.ok(/dxe: dxe === 'contest' \? 'contest' : dxe \? 'dxpedition' : ''/.test(web), 'the page passes the expedition kind to SpotRow');
  assert.ok(/dxeKind\(a\.callsign, dxeState\) === 'dxpedition'/.test(body(web, 'function getFilteredSpots(')), 'DXpeditions sort first');
});

console.log(`\nLZ3AW round 14: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
