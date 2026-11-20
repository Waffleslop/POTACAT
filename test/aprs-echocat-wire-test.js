#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// APRS phase 6 on the wire (lib/remote-server.js, lib/echocat-protocol.js,
// lib/guest-pass-authority.js) and its glue in main.js:
//   - the shack's hello lists `aprs`
//   - a client that did not list `aprs` gets nothing new (no aprs-state, no
//     aprs-stations) and its APRS requests are ignored
//   - aprs-state goes to every `aprs` client (on hello and on change);
//     aprs-stations only to the ones subscribed
//   - a Guest Pass may subscribe and listen; aprs-beacon-is and aprs-igate are
//     refused at the wall with the owner's-callsign sentence and never emitted
//   - a subscribed device leaving is told to main
//   - every new message is registered
//   - main.js sends each request to the APRS window's own functions, and the
//     radio beacon is not reachable from a client
// Run: node test/aprs-echocat-wire-test.js
'use strict';
const assert = require('assert');
const path = require('path');
const WebSocket = require('ws');
const { readSrc } = require('./_src');
const { RemoteServer } = require('../lib/remote-server');
const protocol = require('../lib/echocat-protocol');
const A = require('../lib/guest-pass-authority');
const PassWording = require('../lib/pass-wording');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); }
}

function fakeWs({ guest, caps, id } = {}) {
  const ws = { readyState: WebSocket.OPEN, _authenticated: true, sent: [], _socket: { remoteAddress: '127.0.0.1' } };
  ws.send = (wire) => ws.sent.push(JSON.parse(wire));
  ws.close = () => { ws.readyState = WebSocket.CLOSED; };
  if (guest) ws._passSession = { code: 'otter-newt-mosaic-rooster', sessionId: 'x'.repeat(64) };
  ws._clientCapabilities = caps || [];
  if (id) ws._clientId = id;
  return ws;
}
function serverWith(...list) {
  const rs = new RemoteServer();
  rs._client = list[0];
  for (const ws of list) rs._clients.add(ws);
  rs.emitted = [];
  const emit = rs.emit.bind(rs);
  rs.emit = (ev, ...args) => { if (ev !== 'log') rs.emitted.push({ ev, args }); return emit(ev, ...args); };
  return rs;
}
const types = (ws) => ws.sent.map((m) => m.type);
const STATE = { feed: { state: 'connected' }, listen: { on: false }, igate: { on: false }, beacon: { call: 'K3SBP-10' }, refusal: '' };

console.log('capability');
test('the shack\'s hello lists aprs', () => {
  const ws = fakeWs();
  const rs = new RemoteServer();
  rs._sendTo = (w, m) => w.sent.push(m);
  const src = readSrc(path.join(__dirname, '..', 'lib', 'remote-server.js'));
  const hello = src.slice(src.indexOf('protocol.buildServerHello({'), src.indexOf('protocol.buildServerHello({') + 3000);
  assert.ok(/'aprs'/.test(hello), 'aprs in the server hello capabilities');
  assert.ok(ws);
});
test('an old client gets nothing new; an aprs client gets aprs-state; only a subscribed one gets stations', () => {
  const old = fakeWs({ id: 'old' });
  const cap = fakeWs({ id: 'cap', caps: ['aprs'] });
  const sub = fakeWs({ id: 'sub', caps: ['aprs'] });
  const rs = serverWith(old, cap, sub);
  rs._handleMessage(sub, { type: 'aprs-subscribe', on: true }, null);
  rs.broadcastAprsState(STATE);
  rs.sendAprsStations(null, { type: 'aprs-stations', op: 'delta', add: [], update: [], gone: ['X'], total: 0 });
  rs.sendAprsStations('sub', { type: 'aprs-stations', op: 'snapshot', stations: [], chunk: 0, totalChunks: 1, total: 0 });
  rs.sendAprsStations('cap', { type: 'aprs-stations', op: 'snapshot', stations: [], chunk: 0, totalChunks: 1, total: 0 });
  assert.deepStrictEqual(types(old), [], 'old client untouched');
  assert.deepStrictEqual(types(cap), ['aprs-state'], 'capable, not subscribed');
  assert.deepStrictEqual(types(sub), ['aprs-state', 'aprs-stations', 'aprs-stations']);
});
test('an old client\'s APRS requests are ignored (never emitted)', () => {
  const old = fakeWs({ id: 'old' });
  const rs = serverWith(old);
  for (const m of [{ type: 'aprs-subscribe', on: true }, { type: 'aprs-listen', on: true }, { type: 'aprs-igate', on: true }, { type: 'aprs-beacon-is' }]) rs._handleMessage(old, m, null);
  assert.deepStrictEqual(rs.emitted, []);
  assert.strictEqual(old._aprsSubscribed, undefined);
});
test('aprs-state carries what this device may do (mayBeacon, mayIgate)', () => {
  const own = fakeWs({ id: 'o', caps: ['aprs'] });
  const gst = fakeWs({ id: 'g', caps: ['aprs'], guest: true });
  const rs = serverWith(own, gst);
  rs.broadcastAprsState(STATE);
  assert.strictEqual(own.sent[0].mayBeacon, true);
  assert.strictEqual(own.sent[0].mayIgate, true);
  assert.strictEqual(gst.sent[0].mayBeacon, false);
  assert.strictEqual(gst.sent[0].mayIgate, false);
  assert.ok(protocol.validate(own.sent[0], protocol.Dir.S2C).ok, 'aprs-state registered');
});
test('a device whose hello lists aprs after it is in gets the last aprs-state; one without does not', () => {
  const a = fakeWs({ id: 'a' });
  const b = fakeWs({ id: 'b' });
  const rs = serverWith(a, b);
  rs.broadcastAprsState(STATE);
  assert.deepStrictEqual(types(a), []);
  rs._handleMessage(a, { type: 'hello', protocolVersion: 1, clientVersion: 'x', clientPlatform: 'ios', capabilities: ['aprs'] }, null);
  rs._handleMessage(b, { type: 'hello', protocolVersion: 1, clientVersion: 'x', clientPlatform: 'ios', capabilities: [] }, null);
  assert.ok(types(a).includes('aprs-state'));
  assert.ok(!types(b).includes('aprs-state'));
});
test('hydration on connect sends aprs-state to an aprs client only', () => {
  const a = fakeWs({ id: 'a', caps: ['aprs'] });
  const b = fakeWs({ id: 'b' });
  const rs = serverWith(a, b);
  rs._aprsState = Object.assign({ type: 'aprs-state' }, STATE);
  rs._hydrateClient(a); rs._hydrateClient(b);
  assert.ok(types(a).includes('aprs-state'));
  assert.ok(!types(b).includes('aprs-state'));
});

console.log('\nrequests');
test('an aprs client\'s requests reach main as one event with its device id', () => {
  const ws = fakeWs({ id: 'dev7', caps: ['aprs'] });
  const rs = serverWith(ws);
  rs._handleMessage(ws, { type: 'aprs-subscribe', on: true, rangeKm: 120 }, null);
  rs._handleMessage(ws, { type: 'aprs-listen', on: true, band: '30m' }, null);
  rs._handleMessage(ws, { type: 'aprs-igate', on: true }, null);
  rs._handleMessage(ws, { type: 'aprs-beacon-is' }, null);
  assert.deepStrictEqual(rs.emitted.map((e) => e.ev), ['aprs-request', 'aprs-request', 'aprs-request', 'aprs-request']);
  assert.deepStrictEqual(rs.emitted[0].args[0], { clientId: 'dev7', guest: false, req: { type: 'aprs-subscribe', on: true, rangeKm: 120 } });
  assert.deepStrictEqual(rs.emitted[1].args[0].req, { type: 'aprs-listen', on: true, band: '30m' });
  assert.strictEqual(ws._aprsSubscribed, true);
  for (const m of [{ type: 'aprs-subscribe', on: true, rangeKm: 120 }, { type: 'aprs-listen', on: true, band: '30m' }, { type: 'aprs-igate', on: false }, { type: 'aprs-beacon-is' }]) {
    assert.ok(protocol.validate(m, protocol.Dir.C2S).ok, m.type + ' registered');
  }
});
test('a subscribed device leaving is told to main', () => {
  const ws = fakeWs({ id: 'dev8', caps: ['aprs'] });
  const other = fakeWs({ id: 'dev9', caps: ['aprs'] });
  const rs = serverWith(ws, other);
  rs._handleMessage(ws, { type: 'aprs-subscribe', on: true }, null);
  rs.emitted.length = 0;
  rs._onClientGone(ws);
  assert.deepStrictEqual(rs.emitted.filter((e) => e.ev === 'aprs-client-gone').map((e) => e.args[0]), [{ clientId: 'dev8' }]);
});

console.log('\nGuest Pass');
test('the sets: a guest may subscribe and listen; beacon and iGate are denied at the wall', () => {
  assert.ok(A.GUEST_TYPES.has('aprs-subscribe') && A.GUEST_TYPES.has('aprs-listen'));
  assert.ok(A.GUEST_DENIED_TYPES.has('aprs-beacon-is') && A.GUEST_DENIED_TYPES.has('aprs-igate'));
  assert.strictEqual(A.isGuestAllowed('aprs-beacon-is'), false);
  assert.strictEqual(A.isGuestAllowed('aprs-igate'), false);
});
test('a guest\'s beacon or iGate request is refused out loud with the owner\'s-callsign sentence and never emitted', () => {
  const g = fakeWs({ id: 'g', caps: ['aprs'], guest: true });
  const rs = serverWith(g);
  rs._handleMessage(g, { type: 'aprs-beacon-is' }, null);
  rs._handleMessage(g, { type: 'aprs-igate', on: true }, null);
  rs._handleMessage(g, { type: 'aprs-igate', on: false }, null);
  assert.deepStrictEqual(rs.emitted, []);
  assert.deepStrictEqual(types(g), ['refused', 'refused', 'refused']);
  assert.strictEqual(g.sent[0].of, 'aprs-beacon-is');
  assert.strictEqual(g.sent[0].text, PassWording.refusalText('aprs-beacon-is'));
  assert.ok(/owner's callsign/.test(g.sent[0].text));
  assert.strictEqual(g.sent[1].text, g.sent[0].text);
});
test('a guest may subscribe and listen (emitted with guest: true)', () => {
  const g = fakeWs({ id: 'g', caps: ['aprs'], guest: true });
  const rs = serverWith(g);
  rs._handleMessage(g, { type: 'aprs-subscribe', on: true }, null);
  rs._handleMessage(g, { type: 'aprs-listen', on: true }, null);
  assert.deepStrictEqual(rs.emitted.map((e) => [e.ev, e.args[0].guest, e.args[0].req.type]), [['aprs-request', true, 'aprs-subscribe'], ['aprs-request', true, 'aprs-listen']]);
});

console.log('\nmain.js glue');
const mainSrc = readSrc(path.join(__dirname, '..', 'main.js'));
test('the controller is built once and fed by the window\'s own channels', () => {
  assert.ok(/AprsEchocat\.createController\(/.test(mainSrc));
  const winSend = mainSrc.slice(mainSrc.indexOf('function aprsWinSend('), mainSrc.indexOf('function aprsWinSend(') + 300);
  assert.ok(/aprsEcho\.tap\(ch, data\)/.test(winSend), 'aprsWinSend taps the controller');
  const send = mainSrc.slice(mainSrc.indexOf('function aprsSend(ch, data)'), mainSrc.indexOf('function aprsSend(ch, data)') + 300);
  assert.ok(/aprsEcho\.tap\(ch, data\)/.test(send), 'aprsSend (the feed batches and status) taps the controller');
});
test('each request goes to the function the APRS window or Settings calls', () => {
  const at = mainSrc.indexOf('AprsEchocat.createController(');
  const block = mainSrc.slice(at, at + 2500);
  assert.ok(/listenSet:\s*\(on\)\s*=>\s*aprsListenSet\(/.test(block), 'listen -> aprsListenSet');
  assert.ok(/listenSetBand:\s*\(b\)\s*=>\s*aprsListenSetBand\(/.test(block), 'band -> aprsListenSetBand');
  assert.ok(/beaconNow:\s*\(\)\s*=>\s*aprsBeaconSend\('now'\)/.test(block), 'beacon -> aprsBeaconSend(\'now\')');
  assert.ok(/igateSet:\s*\(on\)\s*=>\s*aprsIgateSetFromDevice\(/.test(block), 'iGate -> the Settings path');
  assert.ok(/remoteServer\.on\('aprs-request'/.test(mainSrc) || /rs\.on\('aprs-request'/.test(mainSrc), 'requests wired');
  assert.ok(/on\('aprs-client-gone'/.test(mainSrc), 'device leaving wired');
});
test('the radio beacon is not reachable from a client (phase 7 is not on the wire)', () => {
  const at = mainSrc.indexOf('AprsEchocat.createController(');
  const block = mainSrc.slice(at, at + 2500);
  assert.ok(!/beacon-rf|beaconRf|aprsRfBeacon|radio beacon/i.test(block));
  const lib = readSrc(path.join(__dirname, '..', 'lib', 'aprs-echocat.js'));
  assert.ok(!/case 'aprs-beacon-(rf|radio)'/.test(lib));
  for (const t of Object.keys(protocol.MESSAGES || {})) assert.ok(!/^aprs-beacon-(rf|radio)/.test(t), t);
});
test('listening a guest started never gates under the owner\'s callsign', () => {
  const fn = mainSrc.slice(mainSrc.indexOf('function aprsIgateWanted()'), mainSrc.indexOf('function aprsIgateWanted()') + 400);
  assert.ok(/aprsEcho\.guestListening\(\)/.test(fn));
});
test('closing the APRS window keeps the feed and a device\'s listening for a watching device', () => {
  const at = mainSrc.indexOf("aprsWin.on('closed'");
  const block = mainSrc.slice(at, at + 600);
  assert.ok(/aprsEcho\.keepsListen\(\)/.test(block));
  assert.ok(/aprsEcho\.keepsFeed\(\)/.test(block));
});

console.log('\nECHOCAT Web');
const webSrc = readSrc(path.join(__dirname, '..', 'renderer', 'remote.js'));
test('the page lists aprs in its hello and handles aprs-state and aprs-stations', () => {
  assert.ok(/capabilities: \[[^\]]*'aprs'[^\]]*\]/.test(webSrc));
  assert.ok(/case 'aprs-state':\s*aprsApplyState\(msg\)/.test(webSrc));
  assert.ok(/case 'aprs-stations':\s*aprsApplyStations\(msg\)/.test(webSrc));
});
test('the page draws with the APRS window\'s own icon and station modules, inlined once', () => {
  const rs = new RemoteServer();
  rs._basePath = path.join(__dirname, '..', 'renderer');
  const html = rs._buildInlinedHtml(false);
  assert.ok(html.includes('window.AprsIcons = {'), 'renderer/aprs-icons.js inlined');
  assert.ok(html.includes('root.AprsStations = api'), 'lib/aprs-stations.js inlined');
  assert.ok(html.includes('root.AprsSymbols = api'), 'lib/aprs-symbols.js inlined');
  assert.ok(!/<!-- aprs-(icons|stations|symbols)-js -->/.test(html), 'every marker replaced');
  assert.ok(/window\.AprsIcons\.svg\(/.test(webSrc) && /window\.AprsStations\.formatAge\(/.test(webSrc));
});
test('the page sends only the four requests; no radio beacon', () => {
  const sent = [...webSrc.matchAll(/type: '(aprs-[a-z-]+)'/g)].map((m) => m[1]);
  assert.deepStrictEqual([...new Set(sent)].sort(), ['aprs-beacon-is', 'aprs-igate', 'aprs-listen', 'aprs-subscribe']);
});
test('a guest sees no beacon button and no iGate switch (mayBeacon / mayIgate)', () => {
  assert.ok(/aprs-beacon-row[\s\S]{0,120}mayBeacon === false/.test(webSrc));
  assert.ok(/aprs-igate-row[\s\S]{0,120}mayIgate === false/.test(webSrc));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
