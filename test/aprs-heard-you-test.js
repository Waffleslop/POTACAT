#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// "Heard you" (ECHOCAT handoff 2026-11-22, Casey: "Build heard you"):
// who heard my radio beacon, learned from the beacon coming back on APRS-IS.
//   - lib/aprs-heard-you.js: the q construct (qAR/qAO/qAr/qAo only), used
//     digipeaters, the 15-minute watch, the 60-minute marks, the budlist cap
//   - lib/aprs-is-feed.js setWatch: exact calls, beside aprs-find's calls
//   - lib/aprs-echocat.js: the feed stays up 15 minutes with nobody watching,
//     heardMe rows (lat/lon null until a position), beacon.rf.heard
//   - main.js glue and the APRS window's mark
// Fake sockets and timers, no network; nothing transmits.
// Run: node test/aprs-heard-you-test.js
'use strict';
const assert = require('assert');
const path = require('path');
const { EventEmitter } = require('events');
const { readSrc } = require('./_src');
const H = require('../lib/aprs-heard-you');
const F = require('../lib/aprs-is-feed');
const E = require('../lib/aprs-echocat');
const W = require('../lib/aprs-window-state');
const Parser = require('../lib/aprs-parser');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); }
}
const pkt = (line, extra) => { const p = Parser.parse(line); assert.ok(p, 'parsed: ' + line); return Object.assign(p, extra || {}); };
const MIN = 60000;

const BACK_IGATE = 'K3SBP-1>APZPCT,WIDE1-1,qAR,W5XYZ-10:!4003.00N/07512.00W-beacon';
const BACK_DIGI = 'K3SBP-1>APZPCT,N3DIG-1*,WIDE1*,qAR,KB3ABC:!4003.00N/07512.00W-beacon';
const BACK_QAC = 'K3SBP-1>APZPCT,TCPIP*,qAC,T2TEXAS:!4003.00N/07512.00W-beacon';
const W5POS = 'W5XYZ-10>APRS,TCPIP*,qAC,T2:!3245.00N/09700.00W#iGate';

console.log('the path');
test('qAR / qAO / qAr / qAo name an iGate; starred calls before q are digipeaters', () => {
  assert.deepStrictEqual(H.reporters(['WIDE1-1', 'qAR', 'W5XYZ-10']), { igate: 'W5XYZ-10', digis: [] });
  assert.deepStrictEqual(H.reporters(['N3DIG-1*', 'WIDE1*', 'qAR', 'KB3ABC']), { igate: 'KB3ABC', digis: ['N3DIG-1'] });
  for (const q of ['qAO', 'qAr', 'qAo']) assert.strictEqual(H.reporters([q, 'W1IG']).igate, 'W1IG', q);
  for (const q of ['qAC', 'qAS', 'qAX', 'qAI', 'qAZ']) assert.strictEqual(H.reporters(['TCPIP*', q, 'T2X1']).igate, '', q);
  assert.deepStrictEqual(H.reporters(['W3XYZ-1*', 'WIDE2*', 'qAo', 'N0IGT']).digis, ['W3XYZ-1']);
  assert.deepStrictEqual(H.reporters(['TRACE*', 'RELAY*', 'NODIGIT*', 'qAR', 'W1IG']).digis, [], 'aliases and calls with no digit');
  assert.deepStrictEqual(H.reporters(['qAR', 'W1IG', 'N3DIG-1*']).digis, [], 'only hops before the q construct');
});

console.log('\nthe watch');
function clock() { let t = 1_000_000_000; return { now: () => t, advance: (ms) => { t += ms; } }; }
test('nothing is learned before a beacon, after 15 minutes, or from another call', () => {
  const c = clock();
  const w = H.createWatch({ now: c.now });
  assert.deepStrictEqual(w.offer(pkt(BACK_IGATE)), []);
  w.beaconSent('K3SBP-1');
  assert.deepStrictEqual(w.offer(pkt(W5POS)), [], 'another call');
  c.advance(15 * MIN);
  assert.strictEqual(w.active(), false);
  assert.deepStrictEqual(w.offer(pkt(BACK_IGATE)), []);
});
test('an iGate and a digipeater; this shack\'s own login is never counted', () => {
  const c = clock();
  const w = H.createWatch({ now: c.now });
  w.beaconSent('K3SBP-1');
  const t0 = c.now();
  assert.deepStrictEqual(w.offer(pkt(BACK_DIGI)), [
    { call: 'KB3ABC', heardMe: { at: t0, by: 'igate', beacons: 1, lastBeaconAt: t0 } },
    { call: 'N3DIG-1', heardMe: { at: t0, by: 'digi', beacons: 1, lastBeaconAt: t0 } },
  ]);
  assert.deepStrictEqual(w.offer(pkt(BACK_DIGI), { ownLogin: 'KB3ABC' }).map((x) => x.call), ['N3DIG-1']);
  assert.deepStrictEqual(w.offer(pkt(BACK_QAC)), [], 'qAC is not an RF report');
});
test('our own radio hearing the beacon via a digipeater names it', () => {
  const c = clock();
  const w = H.createWatch({ now: c.now });
  w.beaconSent('K3SBP-1');
  assert.deepStrictEqual(w.offer(pkt('K3SBP-1>APZPCT,N3DIG-1*,WIDE1*:!4003.00N/07512.00W-b', { rf: { kind: 'digi', digi: 'N3DIG-1' } })).map((x) => [x.call, x.heardMe.by]), [['N3DIG-1', 'digi']]);
  assert.deepStrictEqual(w.offer(pkt('K3SBP-1>APZPCT:!4003.00N/07512.00W-b', { rf: { kind: 'direct', digi: '' } })), [], 'direct: nobody repeated it');
});
test('beacons counts my beacons it heard; count is for the last beacon; until and lastAt', () => {
  const c = clock();
  const w = H.createWatch({ now: c.now });
  assert.deepStrictEqual(w.state(), { until: 0, count: 0, lastAt: 0 });
  w.beaconSent('K3SBP-1');
  const b1 = c.now();
  assert.deepStrictEqual(w.state(), { until: b1 + 15 * MIN, count: 0, lastAt: 0 }, 'not heard yet');
  c.advance(MIN);
  w.offer(pkt(BACK_IGATE));
  w.offer(pkt(BACK_IGATE)); // the same beacon again: still one
  assert.strictEqual(w.heardMe('W5XYZ-10').beacons, 1);
  assert.deepStrictEqual(w.state(), { until: b1 + 15 * MIN, count: 1, lastAt: b1 + MIN });
  c.advance(9 * MIN);
  w.beaconSent('K3SBP-1');
  const b2 = c.now();
  assert.strictEqual(w.state().count, 0, 'a new beacon: nobody has heard it yet');
  assert.strictEqual(w.state().until, b2 + 15 * MIN, 'each beacon restarts the 15 minutes');
  c.advance(MIN);
  w.offer(pkt(BACK_IGATE));
  assert.deepStrictEqual(w.heardMe('W5XYZ-10'), { at: b2 + MIN, by: 'igate', beacons: 2, lastBeaconAt: b2 });
});
test('a mark lasts 60 minutes after it last heard me; calls(): beacon call first, capped', () => {
  const c = clock();
  const w = H.createWatch({ now: c.now });
  w.beaconSent('K3SBP-1');
  w.offer(pkt(BACK_DIGI));
  assert.deepStrictEqual(w.calls(), ['K3SBP-1', 'KB3ABC', 'N3DIG-1']);
  c.advance(20 * MIN);
  assert.deepStrictEqual(w.calls(), ['KB3ABC', 'N3DIG-1'], 'the beacon call only while watching');
  c.advance(40 * MIN);
  assert.strictEqual(w.heardMe('KB3ABC'), null);
  assert.deepStrictEqual(w.prune().sort(), ['KB3ABC', 'N3DIG-1']);
  const w2 = H.createWatch({ now: c.now });
  w2.beaconSent('K3SBP-1');
  for (let i = 0; i < 15; i++) { c.advance(1000); w2.offer(pkt('K3SBP-1>APZPCT,qAR,W' + i + 'IGT:!4003.00N/07512.00W-b')); }
  assert.strictEqual(w2.calls().length, H.MAX_CALLS);
  assert.strictEqual(w2.calls()[0], 'K3SBP-1');
  assert.strictEqual(w2.calls()[1], 'W14IGT', 'newest first');
});

class FakeSocket extends EventEmitter {
  constructor() { super(); this.written = []; }
  setEncoding() {}
  write(s) { this.written.push(s); return true; }
  destroy() {}
}
console.log('\nthe feed');
test('setWatch adds exact calls (no wildcard) after aprs-find\'s, live with #filter, capped beside them', () => {
  const sockets = [];
  const noTimer = { setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {} };
  const feed = new F.AprsIsFeed({ call: 'K3SBP', version: '1.14.7', lat: 41.5, lon: -72.5, km: 150, timers: noTimer, follow: ['K5ABC'], watch: ['K3SBP'], createSocket: () => { const s = new FakeSocket(); sockets.push(s); return s; } });
  feed.start(); sockets[0].emit('connect');
  assert.strictEqual(sockets[0].written[0], 'user K3SBP pass -1 vers POTACAT 1.14.7 filter r/41.50/-72.50/150 g/K3SBP/K3SBP-* b/K5ABC/K5ABC-*/K3SBP\r\n', 'K3SBP exactly, not K3SBP-*');
  assert.strictEqual(feed.setWatch(['K3SBP-1', 'W5XYZ-10', 'bad call']), true);
  assert.strictEqual(sockets[0].written[1], '#filter r/41.50/-72.50/150 g/K3SBP/K3SBP-* b/K5ABC/K5ABC-*/K3SBP-1/W5XYZ-10\r\n');
  assert.strictEqual(feed.setWatch(['K3SBP-1', 'W5XYZ-10']), false, 'the same list sends nothing');
  const many = Array.from({ length: 15 }, (_, i) => 'W' + i + 'IGT');
  const finds = Array.from({ length: 10 }, (_, i) => 'K' + i + 'FND');
  const b = F.budlistFilter(finds, many);
  assert.strictEqual(b.split('/').length - 1, 20 + F.MAX_WATCH, '10 finds (each with its -*) plus 10 exact');
});

console.log('\nthe controller');
function fakeTimers() {
  let id = 0, t = 1_000_000_000;
  const jobs = new Map();
  return {
    now: () => t,
    setTimeout(fn, ms) { jobs.set(++id, { at: t + ms, fn }); return id; },
    clearTimeout(i) { jobs.delete(i); },
    setInterval(fn, ms) { jobs.set(++id, { at: t + ms, fn, every: ms }); return id; },
    clearInterval(i) { jobs.delete(i); },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        let next = null;
        for (const [k, j] of jobs) if (j.at <= end && (!next || j.at < next[1].at)) next = [k, j];
        if (!next) break;
        t = next[1].at;
        if (next[1].every) next[1].at += next[1].every; else jobs.delete(next[0]);
        next[1].fn();
      }
      t = end;
    },
  };
}
function rig({ windowOpen = false } = {}) {
  const t = fakeTimers();
  let feedOn = false;
  const calls = [];
  const out = { stations: [], states: [], heard: [] };
  const c = E.createController({
    timers: t, now: t.now,
    startFeed: () => { feedOn = true; calls.push(['startFeed']); },
    stopFeed: () => { feedOn = false; calls.push(['stopFeed']); },
    feedRunning: () => feedOn,
    windowOpen: () => windowOpen,
    getState: () => ({ beacon: { rf: { ready: true } } }),
    sendState: (s) => out.states.push(s),
    sendStations: (id, m) => out.stations.push([id, m]),
    setWatch: (list) => calls.push(['setWatch', list]),
    ownLogin: () => 'K3SBP-10',
    heardChanged: (m) => out.heard.push(m),
  });
  return { c, t, calls, out, feed: () => feedOn, watches: () => calls.filter((x) => x[0] === 'setWatch').map((x) => x[1]) };
}
test('a confirmed beacon keeps the feed up 15 minutes with the window closed and nobody watching', () => {
  const r = rig();
  assert.strictEqual(r.c.beaconSent('K3SBP-1'), true);
  assert.strictEqual(r.feed(), true, 'started for the watch');
  assert.strictEqual(r.c.keepsFeed(), true, 'closing the window keeps it');
  assert.deepStrictEqual(r.watches(), [['K3SBP-1']]);
  // A device that subscribes and leaves inside the window does not stop it (the 2026-11-22 report).
  r.c.subscribe('ph', { on: true });
  r.c.subscribe('ph', { on: false });
  assert.strictEqual(r.feed(), true);
  r.t.advance(14 * MIN);
  assert.strictEqual(r.feed(), true);
  r.t.advance(2 * MIN);
  assert.strictEqual(r.feed(), false, 'stopped after the 15 minutes');
  assert.deepStrictEqual(r.watches()[r.watches().length - 1], [], 'the beacon call leaves the budlist');
});
test('with the window open the feed is the window\'s: nothing is stopped at the end', () => {
  const r = rig({ windowOpen: true });
  r.c.beaconSent('K3SBP-1');
  r.t.advance(16 * MIN);
  assert.ok(!r.calls.some((x) => x[0] === 'stopFeed'));
});
test('who heard it: rows with heardMe (lat/lon null until a position) to a device, whatever the distance', () => {
  const r = rig();
  r.c.subscribe('ph', { on: true, rangeKm: 50 });
  r.c.beaconSent('K3SBP-1');
  const b = r.t.now();
  r.t.advance(MIN);
  r.c.packets([pkt(BACK_DIGI)]);
  const d = r.c.flush();
  const kb = d.add.find((x) => x.key === 'KB3ABC');
  assert.ok(kb, 'the iGate is listed before its position arrives');
  assert.strictEqual(kb.lat, null); assert.strictEqual(kb.lon, null);
  assert.deepStrictEqual(kb.heardMe, { at: b + MIN, by: 'igate', beacons: 1, lastBeaconAt: b });
  assert.deepStrictEqual(d.add.find((x) => x.key === 'N3DIG-1').heardMe.by, 'digi');
  assert.strictEqual(d.add.find((x) => x.key === 'K3SBP-1').heardMe, null, 'my own row heard nobody');
  assert.deepStrictEqual(r.watches()[r.watches().length - 1], ['K3SBP-1', 'KB3ABC', 'N3DIG-1'], 'each reporter budlisted for its position');
  assert.deepStrictEqual(Object.keys(r.out.heard[r.out.heard.length - 1]).sort(), ['KB3ABC', 'N3DIG-1'], 'the APRS window gets the marks');
  // Its position beacon arrives (2,000 km away): the same row, now with a place and still heardMe.
  r.c.packets([pkt('KB3ABC>APRS,TCPIP*,qAC,T2:!3245.00N/09700.00W#iGate')]);
  const u = r.c.flush().update.find((x) => x.key === 'KB3ABC');
  assert.ok(u.lat > 32 && u.heardMe && u.heardMe.by === 'igate');
});
test('aprs-state.beacon.rf.heard says how the watch is going', () => {
  const r = rig();
  r.c.beaconSent('K3SBP-1');
  const b = r.t.now();
  assert.deepStrictEqual(r.c.currentState().beacon.rf.heard, { until: b + 15 * MIN, count: 0, lastAt: 0 });
  r.t.advance(2 * MIN);
  r.c.packets([pkt(BACK_IGATE)]);
  assert.deepStrictEqual(r.c.currentState().beacon.rf.heard, { until: b + 15 * MIN, count: 1, lastAt: b + 2 * MIN });
  r.t.advance(20 * MIN);
  assert.strictEqual(r.c.currentState().beacon.rf.heard.until, 0, 'closed');
});
test('a snapshot carries heardMe; 60 minutes after heardMe.at it goes back to null', () => {
  const r = rig();
  r.c.beaconSent('K3SBP-1');
  r.c.packets([pkt(BACK_IGATE), pkt(W5POS)]);
  r.c.subscribe('ph', { on: true });
  const snap = r.out.stations.find(([, m]) => m.op === 'snapshot')[1];
  assert.strictEqual(snap.stations.find((x) => x.key === 'W5XYZ-10').heardMe.by, 'igate');
  r.c.packets([pkt(W5POS)]); // it keeps beaconing, so its row stays
  r.t.advance(30 * MIN); r.c.packets([pkt(W5POS)]);
  r.t.advance(31 * MIN); r.c.packets([pkt(W5POS)]);
  r.t.advance(2000);
  const ups = r.out.stations.filter(([, m]) => m.op === 'delta').flatMap(([, m]) => m.update.concat(m.add)).filter((x) => x.key === 'W5XYZ-10');
  assert.ok(ups.some((x) => x.heardMe), 'marked within the hour');
  assert.strictEqual(ups[ups.length - 1].heardMe, null, 'cleared after it');
});
test('a heard-you row with no position stays the hour, then ages out', () => {
  const r = rig();
  r.c.subscribe('ph', { on: true });
  r.c.beaconSent('K3SBP-1');
  r.c.packets([pkt(BACK_IGATE)]);
  r.c.flush();
  r.t.advance(59 * MIN);
  const mid = r.out.stations.filter(([, m]) => m.op === 'delta').flatMap(([, m]) => m.gone);
  assert.ok(mid.indexOf('W5XYZ-10') < 0);
  r.t.advance(2 * MIN);
  const gone = r.out.stations.filter(([, m]) => m.op === 'delta').flatMap(([, m]) => m.gone);
  assert.ok(gone.indexOf('W5XYZ-10') >= 0);
});
test('switching APRS-IS off ends the watch', () => {
  const r = rig();
  r.c.beaconSent('K3SBP-1');
  r.c.heardStop();
  assert.strictEqual(r.c.keepsFeed(), false);
  assert.strictEqual(r.c.watching, false);
});

console.log('\nthe APRS window');
test('the mark: "heard you" with a tip, for an hour', () => {
  const now = 10 * 60 * MIN;
  assert.deepStrictEqual(W.heardYouMark({ at: now - 3 * MIN, by: 'igate' }, now), { text: 'heard you', tip: 'Heard your radio beacon as an iGate, 3 min ago' });
  assert.strictEqual(W.heardYouMark({ at: now, by: 'digi' }, now).tip, 'Heard your radio beacon as a digipeater, just now');
  assert.strictEqual(W.heardYouMark({ at: now - 60 * MIN, by: 'igate' }, now), null);
  assert.strictEqual(W.heardYouMark(null, now), null);
});
test('the window draws it with theme tokens only', () => {
  const pop = readSrc(path.join(__dirname, '..', 'renderer', 'aprs-popout.js'));
  assert.ok(/W\.heardYouMark\(heardYou\[r\.call\], t\)/.test(pop));
  assert.ok(/window\.api\.onHeardYou\(/.test(pop));
  const css = readSrc(path.join(__dirname, '..', 'renderer', 'aprs-popout.css'));
  const rule = css.slice(css.indexOf('.aprs-st-heard'), css.indexOf('}', css.indexOf('.aprs-st-heard')));
  assert.ok(/var\(--accent-blue\)/.test(rule) && !/#[0-9a-f]{3,6}/i.test(rule));
  assert.ok(/onHeardYou: \(cb\) => ipcRenderer\.on\('aprs-heard-you'/.test(readSrc(path.join(__dirname, '..', 'preload-aprs-popout.js'))));
});

console.log('\nmain.js glue');
const main = readSrc(path.join(__dirname, '..', 'main.js'));
test('a confirmed radio beacon starts the watch with the source call that went out', () => {
  const at = main.indexOf('async function aprsRfTransmit()');
  const fn = main.slice(at, main.indexOf('\n}\n', at));
  const ok = fn.indexOf('if (res.ok && res.confirmed) {');
  const hook = fn.indexOf('aprsEcho.beaconSent(b.source)');
  assert.ok(ok > 0 && hook > ok && hook < fn.indexOf('} else if (res.ok)'), 'only in the confirmed branch');
});
test('the feed gets the exact calls; refusals of nothing; the operator\'s off switch ends the watch', () => {
  const at = main.indexOf('AprsEchocat.createController(');
  const block = main.slice(at, at + 3000);
  assert.ok(/setWatch: \(calls\) => \{ if \(aprsFeedHooks\) aprsFeedHooks\.setWatch\(calls\); \}/.test(block));
  assert.ok(/ownLogin: \(\) =>/.test(block));
  assert.ok(/watch: aprsEcho\.watchCalls\(\)/.test(main));
  assert.ok(/setWatch: \(calls\) => \{ if \(aprsFeed\) aprsFeed\.setWatch\(calls\); \}/.test(main));
  const set = main.slice(main.indexOf("ipcMain.on('aprs-feed-set'"), main.indexOf("ipcMain.on('aprs-feed-set'") + 400);
  assert.ok(/aprsEcho\.heardStop\(\)/.test(set));
});
test('documented in docs/echocat-protocol.md', () => {
  const doc = readSrc(path.join(__dirname, '..', 'docs', 'echocat-protocol.md'));
  assert.ok(/heardMe: \{ at, by: 'igate'\|'digi', beacons, lastBeaconAt \} \| null/.test(doc));
  assert.ok(/`rf\.heard: \{until, count, lastAt\}`/.test(doc));
});
test('this test is in the list CI runs', () => {
  assert.ok(readSrc(path.join(__dirname, '..', 'scripts', 'run-tests.js')).includes("'test/aprs-heard-you-test.js'"));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
