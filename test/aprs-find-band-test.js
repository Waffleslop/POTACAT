#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// ECHOCAT ask 2026-11-21 (Casey: "Build band tag and find call"):
//   1. rf.band / rf.bands on aprs-stations rows: the band the radio was
//      listening on when it heard the station (lib/aprs-rf-frames.js packet,
//      lib/aprs-stations.js markSource, lib/aprs-echocat.js slimStation).
//   2. aprs-find {call}: follow one call per device on APRS-IS beyond the
//      range with a budlist term (lib/aprs-is-feed.js), validated so nothing
//      but a callsign reaches the filter string; cleared with {call: ''}, on
//      unsubscribe and on disconnect; a Guest Pass may find, as it may watch.
// Fake sockets, fake timers, no network; nothing transmits.
// Run: node test/aprs-find-band-test.js
'use strict';
const assert = require('assert');
const path = require('path');
const { EventEmitter } = require('events');
const WebSocket = require('ws');
const { readSrc } = require('./_src');
const RF = require('../lib/aprs-rf-frames');
const Stations = require('../lib/aprs-stations');
const E = require('../lib/aprs-echocat');
const F = require('../lib/aprs-is-feed');
const Parser = require('../lib/aprs-parser');
const protocol = require('../lib/echocat-protocol');
const A = require('../lib/guest-pass-authority');
const { RemoteServer } = require('../lib/remote-server');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); }
}

const pkt = (line, rf) => { const p = Parser.parse(line); assert.ok(p, 'parsed: ' + line); if (rf) p.rf = rf; return p; };
const W1 = 'W1AW-9>APRS,WIDE1-1:!4140.00N/07240.00W>090/045Mobile';
const TX = 'K5ABC-9>APRS:!3245.00N/09700.00W>Texas';
const TXHOME = 'K5ABC>APRS:=3245.00N/09700.00W-Home';
const OTHER = 'K5ABCD>APRS:=3245.00N/09700.00W-Not him';

function monitorFrame(text) { return { datakind: 'U', data: Buffer.from(text, 'latin1') }; }
const FRAME = ' 1:Fm W1AW-9 To APRS Via WIDE1-1 <UI pid=F0 Len=40 PF=0 >[00:03:30]\r!4140.00N/07240.00W>090/045Mobile\r\0';

console.log('band tag');
test('packet() marks the band listened on; nothing else gets in', () => {
  assert.deepStrictEqual(RF.packet(monitorFrame(FRAME), Parser.parse, '30m').rf, { kind: 'direct', digi: '', band: '30m' });
  assert.deepStrictEqual(RF.packet(monitorFrame(FRAME), Parser.parse, '2m').rf.band, '2m');
  assert.deepStrictEqual(RF.packet(monitorFrame(FRAME), Parser.parse).rf, { kind: 'direct', digi: '' }, 'no band: none claimed');
  assert.strictEqual(RF.packet(monitorFrame(FRAME), Parser.parse, '2m; drop').rf.band, undefined);
  assert.strictEqual(RF.bandTag('70CM'), '70cm');
});
test('a row keeps the last band heard and every band heard, shortest first', () => {
  let t = 1000;
  const s = Stations.createStore({ now: () => t });
  s.add(pkt(W1, { kind: 'direct', digi: '', band: '30m' }));
  assert.strictEqual(s.get('W1AW-9').rf.band, '30m');
  t += 1000;
  s.add(pkt(W1, { kind: 'digi', digi: 'W3XYZ-1', band: '2m' }));
  assert.strictEqual(s.get('W1AW-9').rf.band, '2m');
  assert.deepStrictEqual(s.get('W1AW-9').rf.bands, ['2m', '30m']);
  assert.strictEqual(s.get('W1AW-9').rf.packets, 2);
  t += 1000;
  s.add(pkt(W1)); // APRS-IS: the radio marks stay
  assert.strictEqual(s.get('W1AW-9').rf.band, '2m');
  s.add(pkt(W1, { kind: 'direct', digi: '' })); // a packet that did not say: '' (not known), bands kept
  assert.strictEqual(s.get('W1AW-9').rf.band, '');
  assert.deepStrictEqual(s.get('W1AW-9').rf.bands, ['2m', '30m']);
});
test('the phone row carries rf.band and rf.bands', () => {
  const s = Stations.createStore({ now: () => 1 });
  s.add(pkt(W1, { kind: 'direct', digi: '', band: '30m' }));
  const row = E.slimStation(s.get('W1AW-9'));
  assert.deepStrictEqual(row.rf, { kind: 'direct', digi: '', lastHeard: 1, packets: 1, band: '30m', bands: ['30m'] });
  s.add(pkt(TX));
  assert.strictEqual(E.slimStation(s.get('K5ABC-9')).rf, null, 'internet only: no rf');
  // A row from an older store (no band fields) still slims cleanly.
  assert.deepStrictEqual(E.slimStation({ key: 'X', call: 'X', rf: { kind: 'digi', digi: 'D', lastHeard: 2, packets: 1 } }).rf, { kind: 'digi', digi: 'D', lastHeard: 2, packets: 1, band: '', bands: [] });
});
test('main.js tags each radio packet with the band being listened on', () => {
  const main = readSrc(path.join(__dirname, '..', 'main.js'));
  assert.ok(/AprsRfFrames\.packet\(f, AprsParser\.parse, aprsListen\.band\)/.test(main));
});
test('a desktop driving a remote shack keeps the shack\'s band on the packet', () => {
  const src = readSrc(path.join(__dirname, '..', 'lib', 'aprs-remote-shack.js'));
  assert.ok(/band: r\.rf\.band/.test(src));
});

console.log('\nthe callsign check and the budlist');
test('findCall takes a plain callsign with one SSID and nothing else', () => {
  assert.strictEqual(F.findCall('k5abc'), 'K5ABC');
  assert.strictEqual(F.findCall(' K5ABC-9 '), 'K5ABC-9');
  assert.strictEqual(F.findCall('K3SBP-10'), 'K3SBP-10');
  for (const bad of ['', 'K5', 'K5ABC/M', 'K5ABC-*', '*', 'K5ABC -9', 'K5ABC-123', 'ABCDEF', '123456', 'K5ABC r/0/0/20000', 'K5ABC\r\n#filter', 'K5ABC-9-1', 'K5ABCDEFG', null, 5, {}]) {
    assert.strictEqual(F.findCall(bad), null, JSON.stringify(bad));
  }
});
test('budlistFilter: no SSID follows every SSID; duplicates dropped; capped', () => {
  assert.strictEqual(F.budlistFilter(['K5ABC']), 'b/K5ABC/K5ABC-*');
  assert.strictEqual(F.budlistFilter(['W1AW-9', 'k5abc', 'K5ABC', 'bad/x']), 'b/W1AW-9/K5ABC/K5ABC-*');
  assert.strictEqual(F.budlistFilter([]), null);
  const many = Array.from({ length: 15 }, (_, i) => 'W' + i + 'AAA-1');
  assert.strictEqual(F.budlistFilter(many).split('/').length - 1, F.MAX_FOLLOW);
});

class FakeSocket extends EventEmitter {
  constructor() { super(); this.written = []; }
  setEncoding() {}
  write(s) { this.written.push(s); return true; }
  destroy() {}
}
function feedRig(opts) {
  const sockets = [];
  const noTimer = { setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {} };
  const feed = new F.AprsIsFeed(Object.assign({ call: 'K3SBP', version: '1.14.7', lat: 41.5, lon: -72.5, km: 150, timers: noTimer, createSocket: () => { const s = new FakeSocket(); sockets.push(s); return s; } }, opts || {}));
  return { feed, sockets };
}

console.log('\nthe feed');
test('the login carries the budlist after the range and the message filter', () => {
  const r = feedRig({ follow: ['K5ABC'] });
  r.feed.start(); r.sockets[0].emit('connect');
  assert.deepStrictEqual(r.sockets[0].written, ['user K3SBP pass -1 vers POTACAT 1.14.7 filter r/41.50/-72.50/150 g/K3SBP/K3SBP-* b/K5ABC/K5ABC-*\r\n']);
});
test('setFollow sends #filter on a live connection; the same list again sends nothing', () => {
  const r = feedRig();
  r.feed.start(); r.sockets[0].emit('connect');
  assert.strictEqual(r.feed.setFollow(['K5ABC-9']), true);
  assert.strictEqual(r.sockets[0].written[1], '#filter r/41.50/-72.50/150 g/K3SBP/K3SBP-* b/K5ABC-9\r\n');
  assert.strictEqual(r.feed.setFollow(['k5abc-9']), false);
  assert.strictEqual(r.sockets[0].written.length, 2);
  r.feed.setFollow([]);
  assert.strictEqual(r.sockets[0].written[2], '#filter r/41.50/-72.50/150 g/K3SBP/K3SBP-*\r\n');
  assert.deepStrictEqual(r.feed.status().follow, []);
});
test('the feed drops anything that is not a callsign, even if handed one directly', () => {
  const r = feedRig({ follow: ['K5ABC r/0/0/20000', 'p/K', 'W1AW'] });
  assert.ok(/ b\/W1AW\/W1AW-\*$/.test(r.feed.filter()), r.feed.filter());
  assert.ok(!/p\/K|20000/.test(r.feed.filter()));
});
test('the anonymous login follows too (no message filter)', () => {
  const r = feedRig({ call: '', follow: ['K5ABC-9'], random: () => 0.1234 });
  assert.strictEqual(r.feed.filter(), 'r/41.50/-72.50/150 b/K5ABC-9');
});

function rig() {
  let feedOn = false;
  const calls = [];
  const out = { stations: [], to: [] };
  let clock = 1_000_000;
  const timers = { setTimeout: () => 0, clearTimeout() {}, setInterval: () => 1, clearInterval() {} };
  const c = E.createController({
    timers, now: () => clock,
    startFeed: () => { feedOn = true; }, stopFeed: () => { feedOn = false; }, feedRunning: () => feedOn,
    windowOpen: () => false, getState: () => ({}), sendState() {},
    setFollow: (list) => calls.push(['setFollow', list]),
    sendStations: (id, m) => out.stations.push([id, m]),
    sendTo: (id, m) => out.to.push([id, m]),
  });
  return { c, calls, out, advance: (ms) => { clock += ms; }, follows: () => calls.filter((x) => x[0] === 'setFollow').map((x) => x[1]) };
}

console.log('\naprs-find in the controller');
test('parseRequest: a callsign, an empty stop, or bad', () => {
  assert.deepStrictEqual(E.parseRequest({ type: 'aprs-find', call: 'k5abc-9' }), { type: 'aprs-find', call: 'K5ABC-9' });
  assert.deepStrictEqual(E.parseRequest({ type: 'aprs-find', call: '' }), { type: 'aprs-find', call: '' });
  assert.deepStrictEqual(E.parseRequest({ type: 'aprs-find' }), { type: 'aprs-find', call: '' });
  assert.deepStrictEqual(E.parseRequest({ type: 'aprs-find', call: 'K5ABC/P' }), { type: 'aprs-find', call: '', bad: true });
});
test('one call per device: a new find replaces the old; {call: \'\'} stops', () => {
  const r = rig();
  r.c.subscribe('ph', { on: true });
  r.c.handle('ph', E.parseRequest({ type: 'aprs-find', call: 'K5ABC' }), {});
  r.c.handle('ph', E.parseRequest({ type: 'aprs-find', call: 'W1AW-9' }), {});
  assert.deepStrictEqual(r.c.followCalls(), ['W1AW-9']);
  r.c.handle('ph', E.parseRequest({ type: 'aprs-find', call: '' }), {});
  assert.deepStrictEqual(r.follows(), [['K5ABC'], ['W1AW-9'], []]);
});
test('two devices following the same call: it stays until both stop', () => {
  const r = rig();
  r.c.subscribe('a', { on: true }); r.c.subscribe('b', { on: true });
  r.c.find('a', { call: 'K5ABC' }); r.c.find('b', { call: 'K5ABC' });
  r.c.find('a', { call: '' });
  assert.deepStrictEqual(r.c.followCalls(), ['K5ABC']);
  r.c.find('b', { call: '' });
  assert.deepStrictEqual(r.c.followCalls(), []);
  assert.deepStrictEqual(r.follows(), [['K5ABC'], []], 'setFollow only when the list changes');
});
test('the find ends when the device unsubscribes or leaves', () => {
  const r = rig();
  r.c.subscribe('a', { on: true }); r.c.subscribe('b', { on: true });
  r.c.find('a', { call: 'K5ABC' }); r.c.find('b', { call: 'W1AW' });
  r.c.subscribe('a', { on: false });
  assert.deepStrictEqual(r.c.followCalls(), ['W1AW']);
  r.c.clientGone('b');
  assert.deepStrictEqual(r.c.followCalls(), []);
});
test('refusals go to that device only: bad call, not watching, too many', () => {
  const r = rig();
  r.c.handle('x', E.parseRequest({ type: 'aprs-find', call: 'K5ABC*' }), {});
  r.c.find('y', { call: 'K5ABC' });
  assert.deepStrictEqual(r.out.to.map(([id, m]) => [id, m.type, m.of, m.reason]), [['x', 'refused', 'aprs-find', 'bad-call'], ['y', 'refused', 'aprs-find', 'not-subscribed']]);
  assert.ok(r.out.to.every(([, m]) => typeof m.text === 'string' && m.text.length > 10));
  for (let i = 0; i < F.MAX_FOLLOW; i++) { r.c.subscribe('d' + i, { on: true }); r.c.find('d' + i, { call: 'W' + i + 'AAA' }); }
  r.c.subscribe('late', { on: true });
  assert.strictEqual(r.c.find('late', { call: 'K5ABC' }).reason, 'full');
  assert.strictEqual(r.c.find('late', { call: 'W3AAA' }).ok, true, 'a call already followed is no extra load');
  assert.strictEqual(r.c.followCalls().length, F.MAX_FOLLOW);
});
test('the followed call\'s rows reach the phone, whatever the distance, and stay while the find is on', () => {
  const r = rig();
  r.c.subscribe('ph', { on: true });
  r.c.find('ph', { call: 'K5ABC' });
  r.c.packets([pkt(TX), pkt(TXHOME), pkt(OTHER)]);
  const d = r.c.flush();
  assert.deepStrictEqual(d.add.map((x) => x.key).sort(), ['K5ABC', 'K5ABC-9', 'K5ABCD']);
  r.advance(2 * 60 * 60 * 1000); // two hours, nothing heard
  const g = r.c.flush();
  assert.deepStrictEqual(g.gone, ['K5ABCD'], 'only the station not followed ages out');
  r.c.find('ph', { call: '' });
  assert.deepStrictEqual(r.c.flush().gone.sort(), ['K5ABC', 'K5ABC-9'], 'they age out once the find stops');
});
test('a held row for the call goes out again at once, so the phone can centre on it', () => {
  const r = rig();
  r.c.subscribe('ph', { on: true });
  r.c.packets([pkt(TX)]);
  r.c.flush();
  r.c.find('ph', { call: 'K5ABC-9' });
  assert.deepStrictEqual(r.c.flush().update.map((x) => x.key), ['K5ABC-9']);
});
test('followMatch: no SSID matches every SSID; an SSID matches that station only', () => {
  assert.ok(E.followMatch('K5ABC', { call: 'K5ABC' }) && E.followMatch('K5ABC', { call: 'K5ABC-15' }));
  assert.ok(!E.followMatch('K5ABC', { call: 'K5ABCD' }));
  assert.ok(E.followMatch('K5ABC-9', { call: 'K5ABC-9' }) && !E.followMatch('K5ABC-9', { call: 'K5ABC' }));
});
test('a Guest Pass may find (it may watch); nothing transmits', () => {
  const r = rig();
  r.c.subscribe('g', { on: true, guest: true });
  assert.strictEqual(r.c.handle('g', E.parseRequest({ type: 'aprs-find', call: 'K5ABC' }), { guest: true }), true);
  assert.deepStrictEqual(r.c.followCalls(), ['K5ABC']);
});

console.log('\non the wire');
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
test('registered: aprs-find C2S, feature aprs, {call: optString}', () => {
  const m = protocol.MESSAGES['aprs-find'];
  assert.ok(m, 'in the registry');
  assert.strictEqual(m.dir, protocol.Dir.C2S);
  assert.strictEqual(m.feature, 'aprs');
  assert.deepStrictEqual(Object.keys(m.fields), ['call']);
});
test('the server hands it on, cleaned, for owner and guest; an old client is ignored', () => {
  const own = fakeWs({ id: 'own', caps: ['aprs'] });
  const g = fakeWs({ id: 'g', caps: ['aprs'], guest: true });
  const old = fakeWs({ id: 'old' });
  const rs = serverWith(own, g, old);
  rs._handleMessage(own, { type: 'aprs-find', call: 'k5abc' }, null);
  rs._handleMessage(g, { type: 'aprs-find', call: 'W1AW-9' }, null);
  rs._handleMessage(old, { type: 'aprs-find', call: 'W1AW-9' }, null);
  assert.deepStrictEqual(rs.emitted.map((e) => [e.ev, e.args[0].clientId, e.args[0].guest, e.args[0].req]), [
    ['aprs-request', 'own', false, { type: 'aprs-find', call: 'K5ABC' }],
    ['aprs-request', 'g', true, { type: 'aprs-find', call: 'W1AW-9' }],
  ]);
  assert.deepStrictEqual(g.sent.filter((m) => m.type === 'refused'), [], 'a guest is not refused at the wall');
});
test('Guest Pass lists it with aprs-subscribe (allowed), never denied', () => {
  assert.ok(A.GUEST_TYPES.has('aprs-find'));
  assert.ok(!A.GUEST_DENIED_TYPES.has('aprs-find'));
  assert.strictEqual(A.isGuestAllowed('aprs-find'), A.isGuestAllowed('aprs-subscribe'));
});
test('main.js wires the follow list to the feed and refusals to the one device', () => {
  const main = readSrc(path.join(__dirname, '..', 'main.js'));
  const at = main.indexOf('AprsEchocat.createController(');
  const block = main.slice(at, at + 2500);
  assert.ok(/setFollow: \(calls\) => \{ if \(aprsFeedHooks\) aprsFeedHooks\.setFollow\(calls\); \}/.test(block));
  assert.ok(/sendTo: \(id, m\) => \{ if \(remoteServer && remoteServer\.sendAprsTo\) remoteServer\.sendAprsTo\(id, m\); \}/.test(block));
  assert.ok(/follow: aprsEcho\.followCalls\(\)/.test(main), 'a restarted feed keeps the calls followed');
  assert.ok(/setFollow: \(calls\) => \{ if \(aprsFeed\) aprsFeed\.setFollow\(calls\); \}/.test(main));
});
test('documented in docs/echocat-protocol.md', () => {
  const doc = readSrc(path.join(__dirname, '..', 'docs', 'echocat-protocol.md'));
  assert.ok(/\| `aprs-find` \| C→S \|/.test(doc));
  assert.ok(/rf\.band/.test(doc));
});
test('this test is in the list CI runs', () => {
  assert.ok(readSrc(path.join(__dirname, '..', 'scripts', 'run-tests.js')).includes("'test/aprs-find-band-test.js'"));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
