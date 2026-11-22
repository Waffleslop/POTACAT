#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// ECHOCAT handoff 2026-11-22 (Casey: "build map view"): aprs-view {n, s, e, w}
// makes the read-only APRS-IS feed ask for the phone's map area (a/ terms,
// lib/aprs-view.js) instead of, or beside, the range term. Checked strictly so
// nothing but four numbers reaches the filter; two terms across the
// antimeridian; capped to 4000 km a side with the centre kept; one area per
// device (at most MAX_VIEWS); the range term stays while the APRS window is
// open or a device has no view; budlist terms stay; cleared on {}, on
// unsubscribe and on disconnect; feed.area per device; Guest Pass allowed.
// Fake sockets, fake timers, no network; nothing transmits.
// Run: node test/aprs-view-test.js
'use strict';
const assert = require('assert');
const path = require('path');
const { EventEmitter } = require('events');
const WebSocket = require('ws');
const { readSrc } = require('./_src');
const V = require('../lib/aprs-view');
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

const TEXAS = { n: 33.5, s: 31.5, e: -96.0, w: -98.5 };
const PACIFIC = { n: 10, s: 0, e: -170, w: 170 }; // crosses the antimeridian
const WORLD = { n: 85, s: -85, e: 180, w: -180 };

console.log('the box');
test('parseView: {} stops, four good numbers make a box, anything else is bad', () => {
  assert.deepStrictEqual(V.parseView({}), { stop: true });
  assert.deepStrictEqual(V.parseView({ type: 'aprs-view' }), { stop: true });
  assert.deepStrictEqual(V.parseView({ n: 31.123, s: 29.987, e: -96.5, w: -98.25 }), { box: { n: 31.12, s: 29.99, e: -96.5, w: -98.25 } });
  for (const bad of [
    { n: 1, s: 0, e: 1 },                       // a field missing
    { n: '31', s: 30, e: 1, w: 0 },             // a string, even a numeric one
    { n: 31, s: 30, e: 1, w: '0 r/0/0/20000' }, // filter syntax smuggled in
    { n: NaN, s: 0, e: 1, w: 0 }, { n: Infinity, s: 0, e: 1, w: 0 },
    { n: 91, s: 0, e: 1, w: 0 }, { n: 1, s: -90.5, e: 1, w: 0 },
    { n: 1, s: 0, e: 181, w: 0 }, { n: 1, s: 0, e: 1, w: -180.01 },
    { n: 0, s: 1, e: 1, w: 0 }, { n: 1, s: 1, e: 1, w: 0 },   // north not above south
    { n: 1, s: 0, e: 5, w: 5 },                 // no width
    { n: 1, s: 0, e: [1], w: 0 }, { n: 1, s: 0, e: { v: 1 }, w: 0 }, { n: true, s: 0, e: 1, w: 0 },
  ]) assert.deepStrictEqual(V.parseView(bad), { bad: true }, JSON.stringify(bad));
});
test('the edges: lat +-90 and lon +-180 are allowed; east -180 reads as 180', () => {
  assert.ok(V.validBox({ n: 90, s: -90, e: 180, w: -180 }));
  assert.deepStrictEqual(V.validBox({ n: 1, s: 0, e: -180, w: 170 }), { n: 1, s: 0, e: 180, w: 170 });
});
test('areaTerms: one a/latN/lonW/latS/lonE term; two across the antimeridian', () => {
  assert.deepStrictEqual(V.areaTerms(TEXAS), ['a/33.50/-98.50/31.50/-96.00']);
  assert.deepStrictEqual(V.areaTerms(PACIFIC), ['a/10.00/170.00/0.00/180.00', 'a/10.00/-180.00/0.00/-170.00']);
  assert.deepStrictEqual(V.areaTerms({ n: 1, s: 0, e: -180, w: 170 }), ['a/1.00/170.00/0.00/180.00'], 'east -180 is the antimeridian: one term');
  assert.deepStrictEqual(V.areaTerms({ n: 1, s: 0, e: 'x', w: 0 }), [], 'a bad box gives nothing');
  assert.deepStrictEqual(V.areaTerms({ n: -0.001, s: -1, e: 1, w: 0 }), ['a/0.00/0.00/-1.00/1.00'], 'never -0.00');
});
test('capBox: a small box is untouched, capped: false', () => {
  assert.deepStrictEqual(V.capBox(TEXAS), Object.assign({}, TEXAS, { capped: false }));
});
test('capBox: a world view is cut to 4000 km a side around its centre', () => {
  const c = V.capBox(WORLD);
  assert.strictEqual(c.capped, true);
  assert.ok(Math.abs((c.n + c.s) / 2) < 0.02, 'centre latitude kept');
  assert.ok((c.n - c.s) * V.KM_PER_DEG <= V.MAX_SIDE_KM + 2, 'height ' + (c.n - c.s) * V.KM_PER_DEG);
  assert.ok(V.lonSpan(c) * V.KM_PER_DEG <= V.MAX_SIDE_KM + 2, 'width at the equator');
  assert.ok(Math.abs((c.e + c.w) / 2) < 0.02, 'centre longitude kept');
});
test('capBox: width is measured on the widest parallel, so a box far north may span more degrees', () => {
  const c = V.capBox({ n: 70, s: 60, e: 60, w: -60 });
  assert.strictEqual(c.capped, true);
  const km = V.lonSpan(c) * V.KM_PER_DEG * Math.cos(60 * Math.PI / 180);
  assert.ok(km <= V.MAX_SIDE_KM + 2 && km > V.MAX_SIDE_KM - 20, 'about 4000 km at 60N: ' + km);
  assert.ok(V.lonSpan(c) > 60, 'more than 36 degrees of longitude up there');
});
test('capBox: a capped box across the antimeridian keeps its centre there', () => {
  const c = V.capBox({ n: 20, s: -20, e: -120, w: 120 }); // 120 degrees wide, centred on 180
  assert.strictEqual(c.capped, true);
  assert.ok(c.w > c.e, 'still crosses');
  assert.ok(Math.abs(c.w - (180 - V.lonSpan(c) / 2)) < 0.02);
  assert.strictEqual(V.areaTerms(c).length, 2);
});
test('feedArea: one box per device, capped, duplicates dropped, at most MAX_VIEWS (the newest kept)', () => {
  assert.strictEqual(V.feedArea([], true), null);
  const a = V.feedArea([TEXAS, TEXAS, WORLD], false);
  assert.strictEqual(a.boxes.length, 2);
  assert.strictEqual(a.keepRange, false);
  assert.ok(!('capped' in a.boxes[1]), 'the feed gets the box only');
  const many = Array.from({ length: 6 }, (_, i) => ({ n: i + 1, s: i, e: 1, w: 0 }));
  const m = V.feedArea(many, true);
  assert.strictEqual(m.boxes.length, V.MAX_VIEWS);
  assert.strictEqual(m.boxes[V.MAX_VIEWS - 1].n, 6);
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
test('no area: the range filter as before (the window\'s range keeps working)', () => {
  const r = feedRig();
  assert.strictEqual(r.feed.filter(), 'r/41.50/-72.50/150 g/K3SBP/K3SBP-*');
  assert.strictEqual(r.feed.status().area, null);
});
test('an area in place of the range, the message filter and budlist terms kept', () => {
  const r = feedRig({ follow: ['K5ABC'], watch: ['K3SBP-1'], area: { boxes: [TEXAS], keepRange: false } });
  r.feed.start(); r.sockets[0].emit('connect');
  assert.deepStrictEqual(r.sockets[0].written, ['user K3SBP pass -1 vers POTACAT 1.14.7 filter a/33.50/-98.50/31.50/-96.00 g/K3SBP/K3SBP-* b/K5ABC/K5ABC-*/K3SBP-1\r\n']);
});
test('keepRange: the range term stays beside the area', () => {
  const r = feedRig({ area: { boxes: [TEXAS], keepRange: true } });
  assert.strictEqual(r.feed.filter(), 'r/41.50/-72.50/150 a/33.50/-98.50/31.50/-96.00 g/K3SBP/K3SBP-*');
});
test('setArea sends #filter on a live connection; the same area again sends nothing; null goes back to the range', () => {
  const r = feedRig();
  r.feed.start(); r.sockets[0].emit('connect');
  assert.strictEqual(r.feed.setArea({ boxes: [PACIFIC], keepRange: false }), true);
  assert.strictEqual(r.sockets[0].written[1], '#filter a/10.00/170.00/0.00/180.00 a/10.00/-180.00/0.00/-170.00 g/K3SBP/K3SBP-*\r\n');
  assert.strictEqual(r.feed.setArea({ boxes: [Object.assign({}, PACIFIC)], keepRange: false }), false);
  assert.strictEqual(r.sockets[0].written.length, 2);
  r.feed.setArea(null);
  assert.strictEqual(r.sockets[0].written[2], '#filter r/41.50/-72.50/150 g/K3SBP/K3SBP-*\r\n');
});
test('the feed checks and caps boxes itself: nothing else reaches the filter', () => {
  const r = feedRig({ area: { boxes: [{ n: '1 p/K', s: 0, e: 1, w: 0 }, WORLD, { n: 99, s: 0, e: 1, w: 0 }], keepRange: false } });
  const f = r.feed.filter();
  assert.ok(!/p\/K|99/.test(f), f);
  const m = /^a\/([\d.-]+)\/([\d.-]+)\/([\d.-]+)\/([\d.-]+) g\//.exec(f);
  assert.ok(m, f);
  assert.ok((Number(m[1]) - Number(m[3])) * V.KM_PER_DEG <= V.MAX_SIDE_KM + 2, 'capped');
  assert.ok(/^[a-z0-9/.\- *]+$/i.test(f), 'only filter characters');
});
test('only bad boxes: back to the range term, never an empty filter', () => {
  const r = feedRig({ area: { boxes: [{ n: 'x' }], keepRange: false } });
  assert.strictEqual(r.feed.filter(), 'r/41.50/-72.50/150 g/K3SBP/K3SBP-*');
});

function rig(opts) {
  const o = opts || {};
  let feedOn = false;
  let win = !!o.windowOpen;
  const calls = [];
  const out = { stations: [], to: [], states: [] };
  const timers = { setTimeout: () => 0, clearTimeout() {}, setInterval: () => 1, clearInterval() {} };
  const c = E.createController({
    timers, now: () => 1_000_000,
    startFeed: () => { feedOn = true; }, stopFeed: () => { feedOn = false; }, feedRunning: () => feedOn,
    windowOpen: () => win, getState: () => ({}), sendState: (s) => out.states.push(s),
    setArea: (a) => calls.push(a),
    setFollow() {}, setWatch() {},
    sendStations: (id, m) => out.stations.push([id, m]),
    sendTo: (id, m) => out.to.push([id, m]),
  });
  return { c, calls, out, last: () => calls[calls.length - 1], setWindow: (v) => { win = v; } };
}
const view = (box) => E.parseRequest(Object.assign({ type: 'aprs-view' }, box || {}));

console.log('\nthe controller');
test('parseRequest: box, stop or bad', () => {
  assert.deepStrictEqual(view(TEXAS), { type: 'aprs-view', box: TEXAS });
  assert.deepStrictEqual(view(), { type: 'aprs-view', stop: true });
  assert.deepStrictEqual(view({ n: 1, s: 0 }), { type: 'aprs-view', bad: true });
});
test('one phone on Map view, window closed: the area takes the range term\'s place', () => {
  const r = rig();
  r.c.subscribe('ph', { on: true, rangeKm: 1000 });
  assert.strictEqual(r.calls.length, 0, 'no view yet: nothing pushed (range only)');
  assert.strictEqual(r.c.handle('ph', view(TEXAS), {}), true);
  assert.deepStrictEqual(r.last(), { boxes: [TEXAS], keepRange: false });
});
test('the window open: the range term stays; closing it hands over to the area', () => {
  const r = rig({ windowOpen: true });
  r.c.subscribe('ph', { on: true });
  r.c.handle('ph', view(TEXAS), {});
  assert.strictEqual(r.last().keepRange, true);
  r.setWindow(false); r.c.windowChanged();
  assert.strictEqual(r.last().keepRange, false);
  r.setWindow(true); r.c.windowChanged();
  assert.strictEqual(r.last().keepRange, true);
});
test('a restarted feed takes the area, and the next change is still pushed', () => {
  const r = rig({ windowOpen: true });
  r.c.subscribe('ph', { on: true });
  r.c.handle('ph', view(TEXAS), {});
  r.setWindow(false); r.c.windowChanged();
  r.setWindow(true);
  assert.deepStrictEqual(r.c.feedArea(), { boxes: [TEXAS], keepRange: true }, 'the window opened and restarted the feed');
  const n = r.calls.length;
  r.setWindow(false); r.c.windowChanged();
  assert.strictEqual(r.calls.length, n + 1);
  assert.strictEqual(r.last().keepRange, false);
});
test('two devices: one area each; a device on miles keeps the range term', () => {
  const r = rig();
  r.c.subscribe('a', { on: true });
  r.c.subscribe('b', { on: true });
  r.c.handle('a', view(TEXAS), {});
  assert.deepStrictEqual(r.last(), { boxes: [TEXAS], keepRange: true }, 'b has no view: its range stays');
  r.c.handle('b', view(PACIFIC), {});
  assert.deepStrictEqual(r.last(), { boxes: [TEXAS, PACIFIC], keepRange: false });
  r.c.handle('a', view({}), {});
  assert.deepStrictEqual(r.last(), { boxes: [PACIFIC], keepRange: true }, 'a is back on miles');
});
test('the same box again is ignored; a moved box replaces that device\'s own', () => {
  const r = rig();
  r.c.subscribe('ph', { on: true });
  r.c.handle('ph', view(TEXAS), {});
  const n = r.calls.length;
  assert.deepStrictEqual(r.c.view('ph', view(Object.assign({}, TEXAS))), { ok: true, same: true });
  assert.strictEqual(r.calls.length, n);
  r.c.handle('ph', view(PACIFIC), {});
  assert.deepStrictEqual(r.last().boxes, [PACIFIC]);
});
test('a world view is capped and the device is told so (areaBy -> feed.area)', () => {
  const r = rig();
  r.c.subscribe('ph', { on: true });
  assert.strictEqual(r.c.view('ph', view(WORLD)).capped, true);
  const st = r.c.currentState();
  assert.strictEqual(st.areaBy.ph.capped, true);
  assert.ok(st.areaBy.ph.n < 85);
  assert.strictEqual(r.c.viewOf('ph').capped, true);
  r.c.view('ph', view(TEXAS));
  assert.deepStrictEqual(r.c.currentState().areaBy.ph, Object.assign({}, TEXAS, { capped: false }));
});
test('refusals go to that device only: bad-view, not-subscribed, full', () => {
  const r = rig();
  r.c.handle('x', view({ n: 'x', s: 0, e: 1, w: 0 }), {});
  r.c.handle('y', view(TEXAS), {});
  assert.deepStrictEqual(r.out.to.map(([id, m]) => [id, m.type, m.of, m.reason]), [['x', 'refused', 'aprs-view', 'bad-view'], ['y', 'refused', 'aprs-view', 'not-subscribed']]);
  assert.ok(r.out.to.every(([, m]) => typeof m.text === 'string' && m.text.length > 10));
  r.out.to.length = 0;
  for (let i = 0; i < V.MAX_VIEWS; i++) { r.c.subscribe('d' + i, { on: true }); r.c.handle('d' + i, view({ n: i + 1, s: i, e: 1, w: 0 }), {}); }
  r.c.subscribe('late', { on: true });
  assert.strictEqual(r.c.view('late', view(TEXAS)).reason, 'full');
  assert.deepStrictEqual(r.out.to.map(([id, m]) => [id, m.reason]), [['late', 'full']]);
  assert.strictEqual(r.c.view('d0', view(TEXAS)).ok, true, 'a device already on Map view may move');
  assert.strictEqual(r.last().boxes.length, V.MAX_VIEWS);
});
test('aprs-subscribe {on: false} drops the view', () => {
  const r = rig();
  r.c.subscribe('ph', { on: true });
  r.c.subscribe('ot', { on: true });
  r.c.handle('ph', view(TEXAS), {});
  r.c.handle('ph', E.parseRequest({ type: 'aprs-subscribe', on: false }), {});
  assert.strictEqual(r.last(), null, 'range only');
  assert.strictEqual(r.c.viewOf('ph'), null);
  assert.deepStrictEqual(r.c.currentState().areaBy, {});
});
test('a disconnect drops the view', () => {
  const r = rig();
  r.c.subscribe('a', { on: true });
  r.c.subscribe('b', { on: true });
  r.c.handle('a', view(TEXAS), {});
  r.c.handle('b', view(PACIFIC), {});
  r.c.clientGone('a');
  assert.deepStrictEqual(r.last(), { boxes: [PACIFIC], keepRange: false });
  r.c.clientGone('b');
  assert.strictEqual(r.last(), null);
});
test('rows in the box go to the device whatever its rangeKm (every held row is sent)', () => {
  const r = rig();
  r.c.subscribe('ph', { on: true, rangeKm: 10 });
  r.c.handle('ph', view(TEXAS), {});
  r.c.packets([Parser.parse('K5ABC-9>APRS:!3245.00N/09700.00W>Texas')]);
  const d = r.c.flush();
  assert.deepStrictEqual(d.add.map((x) => x.key), ['K5ABC-9']);
});
test('a Guest Pass may follow its map (read only, as aprs-subscribe)', () => {
  const r = rig();
  r.c.subscribe('g', { on: true, guest: true });
  assert.strictEqual(r.c.handle('g', view(TEXAS), { guest: true }), true);
  assert.deepStrictEqual(r.last().boxes, [TEXAS]);
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
test('registered: aprs-view C2S, feature aprs, {n, s, e, w: optNumber}', () => {
  const m = protocol.MESSAGES['aprs-view'];
  assert.ok(m, 'in the registry');
  assert.strictEqual(m.dir, protocol.Dir.C2S);
  assert.strictEqual(m.feature, 'aprs');
  assert.deepStrictEqual(Object.keys(m.fields).sort(), ['e', 'n', 's', 'w']);
});
test('the server hands it on, cleaned, for owner and guest; an old client is ignored', () => {
  const own = fakeWs({ id: 'own', caps: ['aprs'] });
  const g = fakeWs({ id: 'g', caps: ['aprs'], guest: true });
  const old = fakeWs({ id: 'old' });
  const rs = serverWith(own, g, old);
  rs._handleMessage(own, Object.assign({ type: 'aprs-view' }, TEXAS), null);
  rs._handleMessage(g, { type: 'aprs-view' }, null);
  rs._handleMessage(old, Object.assign({ type: 'aprs-view' }, TEXAS), null);
  assert.deepStrictEqual(rs.emitted.map((e) => [e.ev, e.args[0].clientId, e.args[0].guest, e.args[0].req]), [
    ['aprs-request', 'own', false, { type: 'aprs-view', box: TEXAS }],
    ['aprs-request', 'g', true, { type: 'aprs-view', stop: true }],
  ]);
  assert.deepStrictEqual(g.sent.filter((m) => m.type === 'refused'), [], 'a guest is not refused at the wall');
});
test('aprs-state feed.area is each device\'s own; areaBy never goes out', () => {
  const a = fakeWs({ id: 'a', caps: ['aprs'] });
  const b = fakeWs({ id: 'b', caps: ['aprs'] });
  const rs = serverWith(a, b);
  rs.broadcastAprsState({ feed: { state: 'connected', km: 150 }, areaBy: { a: Object.assign({}, TEXAS, { capped: false }) } });
  const sa = a.sent.find((m) => m.type === 'aprs-state');
  const sb = b.sent.find((m) => m.type === 'aprs-state');
  assert.deepStrictEqual(sa.feed.area, Object.assign({}, TEXAS, { capped: false }));
  assert.strictEqual(sa.feed.state, 'connected');
  assert.strictEqual(sb.feed.area, null);
  assert.ok(!('areaBy' in sa) && !('areaBy' in sb));
});
test('Guest Pass lists it with aprs-subscribe (allowed), never denied', () => {
  assert.ok(A.GUEST_TYPES.has('aprs-view'));
  assert.ok(!A.GUEST_DENIED_TYPES.has('aprs-view'));
  assert.strictEqual(A.isGuestAllowed('aprs-view'), A.isGuestAllowed('aprs-subscribe'));
});
test('main.js wires the area to the feed, a restarted feed keeps it, the window close re-decides', () => {
  const main = readSrc(path.join(__dirname, '..', 'main.js'));
  assert.ok(/setArea: \(area\) => \{ if \(aprsFeedHooks\) aprsFeedHooks\.setArea\(area\); \}/.test(main));
  assert.ok(/setArea: \(area\) => \{ if \(aprsFeed\) aprsFeed\.setArea\(area\); \}/.test(main));
  assert.ok(/area: aprsEcho\.feedArea\(\)/.test(main));
  assert.ok(/aprsWin = null;\s*\n\s*aprsEcho\.windowChanged\(\);/.test(main));
});
test('documented in docs/echocat-protocol.md', () => {
  const doc = readSrc(path.join(__dirname, '..', 'docs', 'echocat-protocol.md'));
  assert.ok(/\| `aprs-view` \| C→S \|/.test(doc));
  assert.ok(/feed\.area/.test(doc));
});
test('this test is in the list CI runs', () => {
  assert.ok(readSrc(path.join(__dirname, '..', 'scripts', 'run-tests.js')).includes("'test/aprs-view-test.js'"));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
