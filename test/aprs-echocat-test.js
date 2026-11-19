#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// APRS phase 6 (lib/aprs-echocat.js): what an ECHOCAT client with the `aprs`
// capability gets and may ask for, with fake timers and fake desktop functions.
//   - the requests are cleaned; the radio beacon is not one of them
//   - a station row carries what the phone draws, and nothing else
//   - a snapshot on subscribe, chunked by bytes
//   - deltas batched every 1.5 s: add, update, gone (age-out and killed objects)
//   - no deltas and no timer with nobody subscribed
//   - the feed runs for a phone with the window closed, and stops after the last one
//   - each request goes to the desktop's own function (the APRS window's)
//   - listening a device turned on stops when it leaves (window closed)
//   - a Guest Pass never beacons or touches the iGate; its listening never gates
//   - aprs-state is coalesced and carries the window's sentences
// Run: node test/aprs-echocat-test.js
'use strict';
const assert = require('assert');
const E = require('../lib/aprs-echocat');
const Parser = require('../lib/aprs-parser');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); }
}

function fakeTimers() {
  let id = 0, clock = 1_000_000;
  const jobs = new Map(); // id -> {at, fn, every}
  return {
    now: () => clock,
    setTimeout(fn, ms) { jobs.set(++id, { at: clock + ms, fn }); return id; },
    clearTimeout(i) { jobs.delete(i); },
    setInterval(fn, ms) { jobs.set(++id, { at: clock + ms, fn, every: ms }); return id; },
    clearInterval(i) { jobs.delete(i); },
    pending: () => jobs.size,
    advance(ms) {
      const end = clock + ms;
      for (;;) {
        let next = null;
        for (const [k, j] of jobs) if (j.at <= end && (!next || j.at < next[1].at)) next = [k, j];
        if (!next) break;
        clock = next[1].at;
        if (next[1].every) next[1].at += next[1].every; else jobs.delete(next[0]);
        next[1].fn();
      }
      clock = end;
    },
  };
}

function rig(opts) {
  const t = fakeTimers();
  const calls = [];
  const out = { stations: [], states: [] };
  let feedOn = false, windowOpen = !!(opts && opts.windowOpen);
  const state = { listen: { on: false, state: 'off', band: '2m', bands: ['2m', '30m'], sentence: '' }, igate: { on: false, link: 'stopped' }, beacon: { call: 'K3SBP-10', sentence: '' } };
  const c = E.createController({
    timers: t, now: t.now,
    startFeed: () => { feedOn = true; calls.push(['startFeed']); },
    stopFeed: () => { feedOn = false; calls.push(['stopFeed']); },
    feedRunning: () => feedOn,
    setFeedRange: (km) => calls.push(['setFeedRange', km]),
    windowOpen: () => windowOpen,
    listenSet: (on) => calls.push(['listenSet', on]),
    listenSetBand: (b) => calls.push(['listenSetBand', b]),
    igateSet: (on) => calls.push(['igateSet', on]),
    beaconNow: () => calls.push(['beaconNow']),
    markUserActive: () => calls.push(['markUserActive']),
    getState: () => state,
    sendState: (s) => out.states.push(s),
    sendStations: (id, m) => out.stations.push([id, m]),
  });
  return { c, t, calls, out, state, setWindow: (o) => { windowOpen = o; }, feed: () => feedOn };
}

const pkt = (line) => { const p = Parser.parse(line); assert.ok(p, 'parsed: ' + line); return p; };
const W1 = 'W1AW-9>APRS,WIDE1-1:!4140.00N/07240.00W>090/045Mobile';
const W1b = 'W1AW-9>APRS,WIDE1-1:!4141.00N/07241.00W>095/050Mobile';
const N2 = 'N2XYZ>APRS:=4030.00N/07400.00W-Home';

console.log('requests');
test('the four requests are cleaned; anything else (a radio beacon too) is not ours', () => {
  assert.deepStrictEqual(E.parseRequest({ type: 'aprs-listen', on: true, band: '30m' }), { type: 'aprs-listen', on: true, band: '30m' });
  assert.deepStrictEqual(E.parseRequest({ type: 'aprs-listen', on: 'yes', band: '6m' }), { type: 'aprs-listen', on: false, band: '' });
  assert.deepStrictEqual(E.parseRequest({ type: 'aprs-igate', on: true }), { type: 'aprs-igate', on: true });
  assert.deepStrictEqual(E.parseRequest({ type: 'aprs-beacon-is' }), { type: 'aprs-beacon-is' });
  assert.deepStrictEqual(E.parseRequest({ type: 'aprs-subscribe', on: true, rangeKm: '150' }), { type: 'aprs-subscribe', on: true, rangeKm: 150 });
  assert.deepStrictEqual(E.parseRequest({ type: 'aprs-subscribe', on: true, rangeKm: -3 }), { type: 'aprs-subscribe', on: true, rangeKm: null });
  for (const t of ['aprs-beacon', 'aprs-beacon-rf', 'aprs-beacon-radio', 'tune', undefined]) assert.strictEqual(E.parseRequest({ type: t }), null, String(t));
  assert.strictEqual(E.parseRequest(null), null);
});

test('building the controller calls nothing on the desktop (main.js builds it before settings load)', () => {
  const touched = [];
  const deps = new Proxy({}, { get: (_t, k) => (typeof k === 'string' && k !== 'timers' && k !== 'now' && k !== 'flushMs' && k !== 'stateMs' && k !== 'maxAgeMs' && k !== 'chunkBytes'
    ? (...a) => { touched.push(k); return null; } : undefined) });
  E.createController(deps);
  assert.deepStrictEqual(touched, []);
});

console.log('\nstation rows');
test('a row carries call, place, icon, course, speed, comment, last heard, heard-by-me and direct/digi', () => {
  const { c, out } = rig();
  c.subscribe('a', { on: true });
  const rf = Object.assign(pkt(W1), { rf: { kind: 'digi', digi: 'W2DIG' } });
  c.packets([rf]);
  const row = c.snapshot('x')[0].stations[0];
  for (const k of ['key', 'call', 'label', 'lat', 'lon', 'cls', 'symbol', 'course', 'speed', 'comment', 'status', 'lastHeard', 'heardByMe', 'rf', 'isHeard', 'distanceKm', 'bearing', 'type', 'altitude'])
    assert.ok(k in row, 'row has ' + k);
  assert.strictEqual(row.call, 'W1AW-9');
  assert.strictEqual(row.cls, 'car');
  assert.strictEqual(row.course, 90);
  assert.ok(row.speed > 0);
  assert.strictEqual(row.heardByMe, true);
  assert.deepStrictEqual({ kind: row.rf.kind, digi: row.rf.digi }, { kind: 'digi', digi: 'W2DIG' });
  assert.ok(!('raw' in row) && !('path' in row), 'no raw packet or path on the wire');
  assert.ok(out.stations.length >= 1);
});

console.log('\nsnapshot');
test('subscribing sends a snapshot to that device only, chunked by bytes, every row once', () => {
  const { c, out } = rig();
  for (let i = 0; i < 40; i++) c.packets([pkt(`K${i}AB>APRS:!41${String(10 + i).padStart(2, '0')}.00N/07200.00W-padding padding padding ${i}`)]);
  const msgs = c.snapshot('dev1', 1500);
  assert.ok(msgs.length > 1, 'more than one chunk: ' + msgs.length);
  const all = msgs.flatMap((m) => m.stations);
  assert.strictEqual(all.length, 40);
  assert.strictEqual(new Set(all.map((r) => r.key)).size, 40);
  msgs.forEach((m, i) => { assert.strictEqual(m.op, 'snapshot'); assert.strictEqual(m.chunk, i); assert.strictEqual(m.totalChunks, msgs.length); assert.strictEqual(m.total, 40); });
  for (const m of msgs) assert.ok(Buffer.byteLength(JSON.stringify(m.stations)) <= 1500, 'chunk under budget');
  assert.ok(out.stations.every(([id]) => id === 'dev1'), 'only to that device');
});
test('an empty store still sends one empty snapshot (the phone knows it is complete)', () => {
  const { c, out } = rig();
  c.subscribe('a', { on: true });
  assert.deepStrictEqual(out.stations, [['a', { type: 'aprs-stations', op: 'snapshot', stations: [], chunk: 0, totalChunks: 1, total: 0 }]]);
});

console.log('\nthrottled deltas');
test('packets inside 1.5 s go out as ONE delta; first sight is add, later is update', () => {
  const { c, t, out } = rig();
  c.subscribe('a', { on: true });
  out.stations.length = 0;
  c.packets([pkt(W1)]); c.packets([pkt(N2)]); c.packets([pkt(W1b)]);
  assert.strictEqual(out.stations.length, 0, 'nothing before the batch time');
  t.advance(1499);
  assert.strictEqual(out.stations.length, 0);
  t.advance(1);
  assert.strictEqual(out.stations.length, 1, 'one message for three packets');
  const [id, m] = out.stations[0];
  assert.strictEqual(id, null, 'to every subscribed device');
  assert.strictEqual(m.op, 'delta');
  assert.deepStrictEqual(m.add.map((r) => r.call).sort(), ['N2XYZ', 'W1AW-9']);
  assert.deepStrictEqual(m.update, []);
  assert.strictEqual(m.add.find((r) => r.call === 'W1AW-9').course, 95, 'the latest place');
  c.packets([pkt(W1)]);
  t.advance(1500);
  assert.strictEqual(out.stations.length, 2);
  assert.deepStrictEqual(out.stations[1][1].update.map((r) => r.call), ['W1AW-9']);
  assert.deepStrictEqual(out.stations[1][1].add, []);
  t.advance(15000);
  assert.strictEqual(out.stations.length, 2, 'no empty deltas');
});
test('a station already in the snapshot is an update, not an add', () => {
  const { c, t, out } = rig();
  c.packets([pkt(W1)]);
  c.subscribe('a', { on: true });
  c.packets([pkt(W1b)]);
  t.advance(1500);
  const m = out.stations[out.stations.length - 1][1];
  assert.deepStrictEqual(m.update.map((r) => r.call), ['W1AW-9']);
  assert.deepStrictEqual(m.add, []);
});
test('a station not heard for an hour goes out as gone', () => {
  const { c, t, out } = rig();
  c.subscribe('a', { on: true });
  c.packets([pkt(W1)]);
  t.advance(1500);
  t.advance(30 * 60 * 1000);
  c.packets([pkt(N2)]);
  t.advance(31 * 60 * 1000);
  const gones = out.stations.filter(([, m]) => m.op === 'delta' && m.gone.length).map(([, m]) => m.gone);
  assert.deepStrictEqual(gones, [['W1AW-9']]);
});
test('a killed object goes out as gone', () => {
  const { c, t, out } = rig();
  c.subscribe('a', { on: true });
  c.packets([pkt('W1AW>APRS:;LEADER   *092345z4903.50N/07201.75W>Net')]);
  t.advance(1500);
  c.packets([pkt('W1AW>APRS:;LEADER   _092345z4903.50N/07201.75W>Net')]);
  t.advance(1500);
  const last = out.stations[out.stations.length - 1][1];
  assert.deepStrictEqual(last.gone, ['obj:LEADER']);
});
test('nobody subscribed: no deltas, no timer; the store still fills for the next snapshot', () => {
  const { c, t, out } = rig();
  c.packets([pkt(W1)]);
  assert.strictEqual(t.pending(), 0, 'no timer');
  t.advance(10000);
  assert.strictEqual(out.stations.length, 0);
  assert.strictEqual(c.size, 1);
  c.subscribe('a', { on: true });
  c.subscribe('a', { on: false });
  assert.strictEqual(t.pending(), 0, 'the timer stops after the last device');
});

console.log('\nthe feed');
test('a phone with the window closed starts the feed; it stops after the last phone', () => {
  const r = rig();
  r.c.subscribe('a', { on: true, rangeKm: 80 });
  r.c.subscribe('b', { on: true });
  assert.deepStrictEqual(r.calls.filter((x) => /Feed/.test(x[0])), [['startFeed'], ['setFeedRange', 80]]);
  r.c.subscribe('a', { on: false });
  assert.ok(r.feed(), 'b still watching');
  r.c.clientGone('b');
  assert.strictEqual(r.feed(), false, 'stopped after the last');
  assert.strictEqual(r.c.currentState().feed.state, 'off');
});
test('with the APRS window open the window owns the feed and its range', () => {
  const r = rig({ windowOpen: true });
  r.c.subscribe('a', { on: true, rangeKm: 80 });
  assert.deepStrictEqual(r.calls.filter((x) => x[0] === 'setFeedRange'), []);
  r.c.subscribe('a', { on: false });
  assert.deepStrictEqual(r.calls.filter((x) => x[0] === 'stopFeed'), [], 'never stopped under the window');
  assert.strictEqual(r.c.keepsFeed(), false);
  r.c.subscribe('a', { on: true });
  assert.strictEqual(r.c.keepsFeed(), true, 'closing the window keeps the feed for a watching phone');
});

console.log('\nrequests reach the desktop functions');
test('aprs-listen: the band chip first, then the switch, as the window does (and the operator is active)', () => {
  const r = rig();
  assert.ok(r.c.handle('a', E.parseRequest({ type: 'aprs-listen', on: true, band: '30m' })));
  assert.deepStrictEqual(r.calls, [['markUserActive'], ['listenSetBand', '30m'], ['listenSet', true]]);
  r.calls.length = 0;
  r.c.handle('a', E.parseRequest({ type: 'aprs-listen', on: false }));
  assert.deepStrictEqual(r.calls, [['markUserActive'], ['listenSet', false]]);
});
test('aprs-igate and aprs-beacon-is: the Settings switch and the window\'s Beacon now', () => {
  const r = rig();
  r.c.handle('a', E.parseRequest({ type: 'aprs-igate', on: true }));
  r.c.handle('a', E.parseRequest({ type: 'aprs-beacon-is' }));
  assert.deepStrictEqual(r.calls, [['igateSet', true], ['beaconNow']]);
});
test('listening a phone turned on stops when it leaves; another device leaving does not stop it', () => {
  const r = rig();
  r.c.subscribe('a', { on: true }); r.c.subscribe('b', { on: true });
  r.c.handle('a', E.parseRequest({ type: 'aprs-listen', on: true }));
  r.calls.length = 0;
  r.c.clientGone('b');
  assert.deepStrictEqual(r.calls.filter((x) => x[0] === 'listenSet'), []);
  assert.strictEqual(r.c.keepsListen(), true);
  r.c.clientGone('a');
  assert.deepStrictEqual(r.calls.filter((x) => x[0] === 'listenSet'), [['listenSet', false]]);
});
test('with the window open, the window\'s rule holds: a phone leaving does not stop listening', () => {
  const r = rig({ windowOpen: true });
  r.c.subscribe('a', { on: true });
  r.c.handle('a', E.parseRequest({ type: 'aprs-listen', on: true }));
  r.calls.length = 0;
  r.c.clientGone('a');
  assert.deepStrictEqual(r.calls.filter((x) => x[0] === 'listenSet'), []);
});
test('listening switched off anywhere forgets who turned it on', () => {
  const r = rig();
  r.c.subscribe('a', { on: true });
  r.c.handle('a', E.parseRequest({ type: 'aprs-listen', on: true }));
  r.c.tap('aprs-listen', { on: false, state: 'off' });
  r.calls.length = 0;
  r.c.clientGone('a');
  assert.deepStrictEqual(r.calls.filter((x) => x[0] === 'listenSet'), []);
});

console.log('\nGuest Pass');
test('a guest never beacons or changes the iGate, on or off', () => {
  const r = rig();
  assert.strictEqual(r.c.handle('g', E.parseRequest({ type: 'aprs-beacon-is' }), { guest: true }), false);
  assert.strictEqual(r.c.handle('g', E.parseRequest({ type: 'aprs-igate', on: true }), { guest: true }), false);
  assert.strictEqual(r.c.handle('g', E.parseRequest({ type: 'aprs-igate', on: false }), { guest: true }), false);
  assert.deepStrictEqual(r.calls, []);
  assert.ok(/owner's callsign/.test(E.guestRefusal('aprs-beacon-is')));
  assert.ok(/owner's callsign/.test(E.guestRefusal('aprs-igate')));
  assert.strictEqual(E.guestRefusal('aprs-listen'), '');
});
test('a guest may watch and listen, and listening a guest started never gates', () => {
  const r = rig();
  r.c.subscribe('g', { on: true, guest: true });
  assert.strictEqual(r.c.guestListening(), false);
  r.c.handle('g', E.parseRequest({ type: 'aprs-listen', on: true }), { guest: true });
  assert.ok(r.calls.some((x) => x[0] === 'listenSet' && x[1] === true));
  assert.strictEqual(r.c.guestListening(), true);
  r.c.handle('o', E.parseRequest({ type: 'aprs-listen', on: true }));
  assert.strictEqual(r.c.guestListening(), false, 'the owner took it over');
});

console.log('\naprs-state');
test('state changes inside 500 ms are one aprs-state, with the window\'s own sentences', () => {
  const r = rig();
  r.state.listen = { on: true, state: 'refused', band: '2m', bands: ['2m'], sentence: 'FT8 is decoding. Stop it to listen to APRS.' };
  r.c.tap('aprs-listen', r.state.listen);
  r.c.tap('aprs-igate', {});
  r.c.tap('aprs-beacon', {});
  r.c.tap('aprs-status', { state: 'connected', server: 'T2FAKE', km: 150, filter: 'r/40.50/-75.00/150' });
  assert.strictEqual(r.out.states.length, 0);
  r.t.advance(500);
  assert.strictEqual(r.out.states.length, 1);
  const s = r.out.states[0];
  assert.strictEqual(s.listen.sentence, 'FT8 is decoding. Stop it to listen to APRS.');
  assert.strictEqual(s.refusal, 'FT8 is decoding. Stop it to listen to APRS.');
  assert.deepStrictEqual(s.feed, { state: 'connected', server: 'T2FAKE', km: 150, anonymous: false, subscribers: 0 });
  assert.ok(!('filter' in s.feed), 'the home filter stays on the desktop');
  assert.strictEqual(s.beacon.call, 'K3SBP-10');
  for (const k of ['on', 'active', 'call', 'link', 'gated', 'lastAt', 'lastFrom', 'sentence']) assert.ok(k in s.igate, 'igate.' + k);
  for (const k of ['on', 'state', 'band', 'bands', 'mhz', 'heard', 'lastAt', 'sentence']) assert.ok(k in s.listen, 'listen.' + k);
  for (const k of ['call', 'lastAt', 'sending', 'sentence', 'backAt']) assert.ok(k in s.beacon, 'beacon.' + k);
});
test('a beacon refusal is the refusal when listening is fine', () => {
  const s = E.buildState({ listen: { on: false, state: 'off' }, beacon: { sentence: 'Set your callsign in Settings to beacon.' } });
  assert.strictEqual(s.refusal, 'Set your callsign in Settings to beacon.');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
