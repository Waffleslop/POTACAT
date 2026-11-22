#!/usr/bin/env node
'use strict';
// APRS-IS receive feed (lib/aprs-is-feed.js): login line, range filter, line
// framing, keep-alive, silence watchdog, reconnect backoff and a clean stop.
// Driven with a fake socket and fake timers; no network.
// Run: node test/aprs-is-feed-test.js

const assert = require('assert');
const { EventEmitter } = require('events');
const F = require('../lib/aprs-is-feed');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

class FakeSocket extends EventEmitter {
  constructor() { super(); this.written = []; this.destroyed = false; }
  setEncoding() {}
  write(s) { this.written.push(s); return true; }
  destroy() { this.destroyed = true; }
}

/** Manual clock: timers fire only on advance(). */
function fakeClock() {
  let now = 1000000, id = 0;
  const timers = new Map();
  return {
    now: () => now,
    timers: {
      setTimeout(fn, ms) { timers.set(++id, { fn, at: now + ms, every: 0 }); return id; },
      clearTimeout(h) { timers.delete(h); },
      setInterval(fn, ms) { timers.set(++id, { fn, at: now + ms, every: ms }); return id; },
      clearInterval(h) { timers.delete(h); },
    },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let next = null;
        for (const [h, t] of timers) if (t.at <= end && (!next || t.at < next[1].at)) next = [h, t];
        if (!next) break;
        now = next[1].at;
        if (next[1].every) next[1].at += next[1].every; else timers.delete(next[0]);
        next[1].fn();
      }
      now = end;
    },
    get count() { return timers.size; },
  };
}

function rig(opts) {
  const clock = fakeClock();
  const sockets = [];
  const feed = new F.AprsIsFeed(Object.assign({
    call: 'K3SBP', version: '1.14.6', lat: 41.5, lon: -72.5, km: 150,
    createSocket: (host, port) => { const s = new FakeSocket(); s.host = host; s.port = port; sockets.push(s); return s; },
    timers: clock.timers, now: clock.now,
  }, opts || {}));
  const lines = [], statuses = [];
  feed.on('line', (l) => lines.push(l));
  feed.on('status', (s) => statuses.push(s));
  feed.on('error', () => {});
  return { clock, sockets, feed, lines, statuses };
}

console.log('APRS-IS feed');

test('login: the operator\'s callsign, else an anonymous PCATnnnn (aprsc refuses N0CALL)', () => {
  assert.strictEqual(F.feedCallsign('k3sbp'), 'K3SBP');
  assert.strictEqual(F.feedCallsign('K3SBP-9'), 'K3SBP-9');
  assert.strictEqual(F.feedCallsign(''), null);
  assert.strictEqual(F.feedCallsign(undefined), null);
  assert.strictEqual(F.feedCallsign('pass -1 vers'), null, 'nothing odd reaches the login line');
  assert.strictEqual(F.feedCallsign('ABCDEF'), null, 'a callsign has a digit');
  assert.strictEqual(F.feedCallsign('N0CALL'), null, '"Login by user not allowed"');
  assert.strictEqual(F.feedCallsign('N0CALL-1'), null);
  assert.strictEqual(F.anonymousLogin(() => 0.0421), 'PCAT0421');
  const r = rig({ call: '', random: () => 0.5 });
  assert.strictEqual(r.feed.call, 'PCAT5000');
  assert.strictEqual(r.feed.anonymous, true);
  r.feed.start();
  r.sockets[0].emit('connect');
  assert.ok(r.sockets[0].written[0].startsWith('user PCAT5000 pass -1 vers POTACAT 1.14.6 '));
  assert.ok(!/ g\//.test(r.sockets[0].written[0]), 'A1: no message filter for the anonymous login');
  r.feed.stop();
});

test('a refused login waits 60 s and says so, without counting up the backoff', () => {
  const r = rig();
  r.feed.start();
  r.sockets[0].emit('connect');
  r.sockets[0].emit('data', '# aprsc 3.0.1\r\n# Login by user not allowed\r\n');
  r.sockets[0].emit('close');
  const last = r.statuses[r.statuses.length - 1];
  assert.strictEqual(last.state, 'refused');
  assert.strictEqual(last.retryInMs, 60000);
  assert.deepStrictEqual(r.lines, []);
  r.clock.advance(59000);
  assert.strictEqual(r.sockets.length, 1);
  r.clock.advance(1000);
  assert.strictEqual(r.sockets.length, 2);
  r.feed.stop();
});

test('range filter: two decimals, kilometres clamped 10 to 1000, default 150', () => {
  assert.strictEqual(F.buildRangeFilter(41.5, -72.5, 150), 'r/41.50/-72.50/150');
  assert.strictEqual(F.buildRangeFilter(-33.8667, 151.2, 75.4), 'r/-33.87/151.20/75');
  assert.strictEqual(F.buildRangeFilter(41.5, -72.5, 0), 'r/41.50/-72.50/150');
  assert.strictEqual(F.buildRangeFilter(41.5, -72.5, 5), 'r/41.50/-72.50/10');
  assert.strictEqual(F.buildRangeFilter(41.5, -72.5, 99999), 'r/41.50/-72.50/1000');
  assert.strictEqual(F.buildRangeFilter(null, -72.5, 150), null, 'no grid, no filter');
  assert.strictEqual(F.buildRangeFilter(95, 0, 150), null);
});

test('login line: passcode -1 (read-only), POTACAT and its version, the filter', () => {
  assert.strictEqual(F.buildLoginLine({ call: 'K3SBP', version: '1.14.6', filter: 'r/41.50/-72.50/150' }),
    'user K3SBP pass -1 vers POTACAT 1.14.6 filter r/41.50/-72.50/150');
  assert.ok(/^user PCAT\d{4} pass -1 vers POTACAT 1\.14\.6$/.test(F.buildLoginLine({ call: '', version: '1.14.6' })));
});

test('line framing: split on LF, CR stripped, partial lines kept, blanks dropped', () => {
  let r = F.splitLines('', 'A>B:>one\r\nC>D:>tw');
  assert.deepStrictEqual(r.lines, ['A>B:>one']);
  assert.strictEqual(r.rest, 'C>D:>tw');
  r = F.splitLines(r.rest, 'o\r\n\r\n# comment\n');
  assert.deepStrictEqual(r.lines, ['C>D:>two', '# comment']);
  assert.strictEqual(r.rest, '');
  r = F.splitLines('', 'x'.repeat(9000));
  assert.strictEqual(r.rest, '', 'a runaway line with no newline is dropped');
});

test('reconnect backoff: 2 s doubling, capped at 60 s', () => {
  assert.deepStrictEqual([0, 1, 2, 3, 4, 5, 6, 10].map(F.reconnectDelay), [2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
});

test('connects to the rotate address, logs in, passes packets and keeps comments out', () => {
  const r = rig();
  r.feed.start();
  assert.strictEqual(r.sockets.length, 1);
  assert.strictEqual(r.sockets[0].host, 'rotate.aprs2.net');
  assert.strictEqual(r.sockets[0].port, 14580);
  r.sockets[0].emit('connect');
  assert.deepStrictEqual(r.sockets[0].written, ['user K3SBP pass -1 vers POTACAT 1.14.6 filter r/41.50/-72.50/150 g/K3SBP/K3SBP-*\r\n']);
  assert.strictEqual(r.feed.state, 'connected');
  r.sockets[0].emit('data', '# aprsc 2.1.14\r\n# logresp K3SBP unverified, server T2TEST\r\nW1AW>APRS:>hi\r\nN0C');
  r.sockets[0].emit('data', 'ALL>APRS:>two\r\n');
  assert.deepStrictEqual(r.lines, ['W1AW>APRS:>hi', 'N0CALL>APRS:>two']);
  assert.strictEqual(r.feed.server, 'T2TEST');
  r.feed.stop();
});

test('keep-alive every 2 minutes; 90 s of silence drops and reconnects', () => {
  const r = rig();
  r.feed.start();
  r.sockets[0].emit('connect');
  // The server talks every 20 s; we write a keep-alive after 2 minutes of our own silence.
  for (let i = 0; i < 7; i++) { r.clock.advance(20000); r.sockets[0].emit('data', '# server tick\r\n'); }
  assert.ok(r.sockets[0].written.includes('#keepalive\r\n'), 'keep-alive sent');
  // Now the server goes quiet.
  r.clock.advance(90000);
  assert.strictEqual(r.sockets[0].destroyed, true, 'silent socket dropped');
  assert.strictEqual(r.feed.state, 'waiting');
  r.clock.advance(2000);
  assert.strictEqual(r.sockets.length, 2, 'reconnected after 2 s');
});

test('reconnect backs off while the server refuses, and resets after a good connect', () => {
  const r = rig();
  r.feed.start();
  const waits = [];
  r.feed.on('status', (s) => { if (s.state === 'waiting') waits.push(s.retryInMs); });
  for (let i = 0; i < 4; i++) {
    r.sockets[r.sockets.length - 1].emit('error', new Error('ECONNREFUSED'));
    r.sockets[r.sockets.length - 1].emit('close');
    r.clock.advance(60000);
  }
  assert.deepStrictEqual(waits, [2000, 4000, 8000, 16000]);
  assert.strictEqual(r.sockets.length, 5);
  r.sockets[4].emit('connect');
  r.sockets[4].emit('close');
  assert.strictEqual(waits[waits.length - 1], 2000, 'a good connection resets the backoff');
  r.feed.stop();
});

test('stop: closes the socket, leaves no timer, never reconnects', () => {
  const r = rig();
  r.feed.start();
  r.sockets[0].emit('connect');
  r.feed.stop();
  assert.strictEqual(r.sockets[0].destroyed, true);
  assert.strictEqual(r.feed.state, 'stopped');
  assert.strictEqual(r.clock.count, 0, 'no timers left');
  r.sockets[0].emit('close');
  r.clock.advance(120000);
  assert.strictEqual(r.sockets.length, 1);
  // Stop during the backoff wait, too.
  const s = rig();
  s.feed.start();
  s.sockets[0].emit('close');
  assert.strictEqual(s.feed.state, 'waiting');
  s.feed.stop();
  assert.strictEqual(s.clock.count, 0);
  s.clock.advance(120000);
  assert.strictEqual(s.sockets.length, 1);
});

test('setRange sends #filter on a live connection and is used at the next login', () => {
  const r = rig();
  r.feed.start();
  r.sockets[0].emit('connect');
  r.feed.setRange(null, null, 300);
  assert.strictEqual(r.sockets[0].written[1], '#filter r/41.50/-72.50/300 g/K3SBP/K3SBP-*\r\n');
  r.sockets[0].emit('close');
  r.clock.advance(2000);
  r.sockets[1].emit('connect');
  assert.ok(r.sockets[1].written[0].endsWith('filter r/41.50/-72.50/300 g/K3SBP/K3SBP-*\r\n'));
  r.feed.stop();
});

test('batcher: one hand-over per 500 ms window, nothing after stop', () => {
  const clock = fakeClock();
  const out = [];
  const b = F.createBatcher((items) => out.push(items), 500, clock.timers);
  b.push(1); b.push(2);
  assert.deepStrictEqual(out, []);
  clock.advance(499);
  assert.deepStrictEqual(out, []);
  clock.advance(1);
  assert.deepStrictEqual(out, [[1, 2]]);
  b.push(3);
  clock.advance(500);
  assert.deepStrictEqual(out, [[1, 2], [3]]);
  b.push(4);
  b.stop();
  clock.advance(1000);
  assert.deepStrictEqual(out, [[1, 2], [3]]);
  assert.strictEqual(clock.count, 0);
});

test('never writes a packet: only the login, #keepalive and #filter', () => {
  const src = require('fs').readFileSync(require.resolve('../lib/aprs-is-feed'), 'utf8');
  const writes = [...src.matchAll(/this\._write\(([^)]*\)?)/g)].map((m) => m[1]);
  assert.strictEqual(writes.length, 3, writes.join(' | '));
  assert.ok(/buildLoginLine/.test(writes[0]) && /#keepalive/.test(writes[1]) && /#filter/.test(writes[2]));
  assert.ok(!/aprsPasscode/.test(src), 'phase 1 computes no passcode');
});

test('this test is in the list CI runs', () => {
  const fs = require('fs');
  const path = require('path');
  assert.ok(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'run-tests.js'), 'utf8').includes("'test/aprs-is-feed-test.js'"));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
