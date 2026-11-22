#!/usr/bin/env node
'use strict';
// #868: APRS "Listen on my radio" on a desktop driving a remote shack. The
// switch and band picker go to the shack as aprs-listen (lib/remote-bridge.js
// rows, lib/aprs-remote-shack.js), the window follows the shack's aprs-state
// and the stations its radio heard, and main.js only glues it.
// Run: node test/aprs-remote-shack-test.js
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const S = require('../lib/aprs-remote-shack');
const B = require('../lib/remote-bridge');
const Stations = require('../lib/aprs-stations');
const { MESSAGES } = require('../lib/echocat-protocol');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
const R = (f) => readSrc(path.join(__dirname, '..', f)).replace(/\r\n/g, '\n');

const shackState = (listen) => ({ type: 'aprs-state', feed: { state: 'connected' }, listen, igate: {}, beacon: {}, refusal: '' });

console.log('APRS listening on a remote shack (#868)');

test('the switch sends the wire\'s aprs-listen once the shack has APRS', () => {
  const st = {};
  B.trackState(st, shackState({ on: false, state: 'off', band: '2m', bands: ['2m', '30m'] }));
  assert.strictEqual(st.aprs, true);
  assert.deepStrictEqual(B.OUT['aprs-listen-set']([true], st), { send: [{ type: 'aprs-listen', on: true }] });
  assert.deepStrictEqual(B.OUT['aprs-listen-set']([false], st), { send: [{ type: 'aprs-listen', on: false }] });
});

test('a shack without APRS on the wire is refused in one sentence; nothing is sent', () => {
  const r = B.OUT['aprs-listen-set']([true], { aprs: false });
  assert.ok(r.refuse && !r.send);
  assert.strictEqual(r.refuse, S.SHACK_TOO_OLD);
  assert.ok(B.OUT['aprs-listen-band'](['30m'], {}).refuse);
});

test('a band pick keeps the shack\'s on/off as it is', () => {
  const st = {};
  B.trackState(st, shackState({ on: true, state: 'listening', band: '2m' }));
  assert.deepStrictEqual(B.OUT['aprs-listen-band'](['30m'], st), { send: [{ type: 'aprs-listen', on: true, band: '30m' }] });
  B.trackState(st, shackState({ on: false, state: 'off', band: '30m' }));
  assert.deepStrictEqual(B.OUT['aprs-listen-band'](['2m'], st), { send: [{ type: 'aprs-listen', on: false, band: '2m' }] });
  assert.deepStrictEqual(B.OUT['aprs-listen-band'](['6m'], st), { drop: true }, 'not an APRS band');
});

test('every field sent is declared on aprs-listen (no wire change)', () => {
  const m = S.bandMessage('30m', true);
  for (const k of Object.keys(m)) if (k !== 'type') assert.ok(k in MESSAGES['aprs-listen'].fields, k);
  assert.strictEqual(MESSAGES['aprs-listen'].dir, 'c2s');
});

test('the window shows the shack\'s state and its refusal sentence', () => {
  const out = B.IN['aprs-state'](shackState({ on: false, state: 'refused', band: '2m', bands: ['2m'], modeLabel: 'FM', sentence: 'FT8 is decoding. Stop it to listen to APRS.' }));
  assert.strictEqual(out.length, 1);
  const [ch, p] = out[0];
  assert.strictEqual(ch, 'aprs-listen');
  assert.strictEqual(p.state, 'refused');
  assert.strictEqual(p.sentence, 'FT8 is decoding. Stop it to listen to APRS.');
  assert.deepStrictEqual(p.bands, ['2m']);
  assert.strictEqual(p.on, false);
  assert.strictEqual(p.moved, null);
  const on = S.listenFromState(shackState({ on: true, state: 'listening', band: '30m', bands: ['2m', '30m'], modeLabel: 'USB', mhz: '10.148', heard: 4, lastAt: 5 }));
  assert.strictEqual(on.mhz, '10.148');
  assert.strictEqual(on.heard, 4);
  assert.strictEqual(on.modeLabel, 'USB');
});

test('a refusal made here keeps the card and says the sentence', () => {
  const last = S.listenFromState(shackState({ on: true, state: 'listening', band: '2m', bands: ['2m'], heard: 3 }));
  const r = S.refusedHere('The remote shack is not connected right now.', last);
  assert.strictEqual(r.on, false);
  assert.strictEqual(r.state, 'refused');
  assert.strictEqual(r.heard, 3);
  assert.ok(S.refusedHere('x', null).state === 'refused');
});

test('only stations the shack\'s radio heard become packets, once per hearing', () => {
  const seen = new Map();
  const rowRf = { key: 'K1ABC-9', call: 'K1ABC-9', label: 'K1ABC-9', type: 'position', lat: 40, lon: -75, symbol: '/>', comment: 'mobile', rf: { kind: 'digi', digi: 'WIDE1', lastHeard: 1000, packets: 2 } };
  const rowIs = { key: 'W2XYZ', call: 'W2XYZ', type: 'position', lat: 41, lon: -74, symbol: '/-', rf: null };
  const rowObj = { key: 'obj:NET', call: 'N0CALL', label: 'NET', type: 'object', lat: 39, lon: -76, symbol: '\\n', rf: { kind: 'direct', lastHeard: 900, packets: 1 } };
  const snap = { type: 'aprs-stations', op: 'snapshot', stations: [rowRf, rowIs, rowObj] };
  const out = B.IN['aprs-stations'](snap, { aprsRfSeen: seen });
  assert.strictEqual(out.length, 1);
  const [ch, pk] = out[0];
  assert.strictEqual(ch, 'aprs-packets');
  assert.strictEqual(pk.length, 2, 'the APRS-IS-only row is left to this desktop\'s own feed');
  assert.deepStrictEqual(pk[0].rf, { kind: 'digi', digi: 'WIDE1' });
  assert.strictEqual(pk[0].symbolTable, '/');
  assert.strictEqual(pk[0].symbol, '>');
  assert.strictEqual(pk[1].name, 'NET');
  // An APRS-IS update of the same station is not another radio packet.
  assert.deepStrictEqual(B.IN['aprs-stations']({ type: 'aprs-stations', op: 'delta', add: [], update: [Object.assign({}, rowRf, { comment: 'new' })], gone: [] }, { aprsRfSeen: seen }), []);
  // A new radio hearing is.
  const again = B.IN['aprs-stations']({ type: 'aprs-stations', op: 'delta', add: [], update: [Object.assign({}, rowRf, { rf: { kind: 'direct', lastHeard: 2000, packets: 3 } })], gone: [] }, { aprsRfSeen: seen });
  assert.strictEqual(again[0][1].length, 1);
  // Gone forgets it.
  B.IN['aprs-stations']({ type: 'aprs-stations', op: 'delta', add: [], update: [], gone: ['K1ABC-9'] }, { aprsRfSeen: seen });
  assert.ok(!seen.has('K1ABC-9'));
});

test('the packets land in the window\'s store as heard by my radio', () => {
  const store = Stations.createStore({ home: { lat: 40, lon: -75 } });
  const pk = S.packetsFromStations({ stations: [
    { key: 'K1ABC-9', call: 'K1ABC-9', type: 'position', lat: 40.1, lon: -75.1, symbol: '/>', rf: { kind: 'direct', lastHeard: 1, packets: 1 } },
    { key: 'obj:NET', call: 'N0CALL', label: 'NET', type: 'object', lat: 39, lon: -76, symbol: '/n', rf: { kind: 'direct', lastHeard: 1, packets: 1 } },
  ] }, new Map());
  for (const p of pk) store.add(p);
  const heard = store.list({ heardByMe: true });
  assert.strictEqual(heard.length, 2);
  assert.ok(store.get('obj:NET'), 'an object keeps its own row');
  assert.strictEqual(store.get('K1ABC-9').rf.kind, 'direct');
});

test('the remote desktop lists the aprs capability in its hello', () => {
  const rc = R('lib/remote-client.js');
  assert.ok(/capabilities: \[[^\]]*'aprs'[^\]]*\]/.test(rc));
});

test('main glue: the window watches the shack while open, shows its state, says refusals', () => {
  const main = R('main.js');
  assert.ok(/if \(isRemoteMode\(\)\) remoteAprsWatch\(true\);/.test(main), 'aprs-ready watches the shack');
  assert.ok(/if \(_remoteAprsWanted\) remoteAprsWatch\(false\);/.test(main), 'closing the window stops watching (the shack stops listening this desktop started)');
  assert.ok(/if \(aprsWin && !aprsWin\.isDestroyed\(\)\) remoteAprsWatch\(true\);/.test(main), 'watched again after a reconnect');
  assert.ok(/remoteClient\.sendRaw\(\{ type: 'aprs-subscribe', on: !!on \}\)/.test(main));
  assert.ok(/if \(isRemoteMode\(\) && _remoteAprsListen\)/.test(main), 'the card shows the shack\'s listening, not this PC\'s');
  assert.ok(/const out = rule\(msg, _remoteBridgeState\) \|\| \[\];/.test(main), 'IN rows get the bridge state');
  assert.ok(/if \(ch\.startsWith\('aprs-'\)\)/.test(main), 'APRS frames go to the APRS window only');
  assert.ok(/if \(fromAprs\) remoteAprsRefusedHere\(r\.refuse\);/.test(main) && /if \(fromAprs\) remoteAprsRefusedHere\(REMOTE_NOT_LINKED_MSG\);/.test(main), 'refusals land on the card');
  // No isRemoteMode() branch in the switch's own handler: the bridge row intercepts it.
  const h = main.slice(main.indexOf("ipcMain.on('aprs-listen-set'"), main.indexOf("ipcMain.on('aprs-listen-set'") + 200);
  assert.ok(!/isRemoteMode/.test(h));
});

test('the shack keeps its rules: Guest Pass may listen, never beacon or iGate (unchanged)', () => {
  const E = require('../lib/aprs-echocat');
  assert.ok(!E.GUEST_REFUSED.has('aprs-listen'));
  assert.ok(E.GUEST_REFUSED.has('aprs-beacon-is') && E.GUEST_REFUSED.has('aprs-igate'));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
