#!/usr/bin/env node
'use strict';
/**
 * The idle-activity feed — "open the app into what the station is doing."
 *
 * The rules worth protecting: results accumulated while NOBODY was
 * connected must be there at connect (that is the entire feature — the
 * caches fill without a client); all THREE auth paths hydrate through the
 * shared helpers (per-path inline copies are how the Guest Pass JS8 gap
 * happened); and activity-state hydrates before content so the app can
 * route first.
 *
 * Run: node test/idle-activity-test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { RemoteServer } = require('../lib/remote-server');
const protocol = require('../lib/echocat-protocol');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

function fakeWs() {
  const sent = [];
  return {
    _authenticated: true,
    readyState: 1,
    send: (w) => { try { sent.push(JSON.parse(w)); } catch {} },
    _sent: sent,
  };
}

// ── registry + capability ────────────────────────────────────────────────────

test('activity-state and wspr-session are registered S2C', () => {
  for (const t of ['activity-state', 'wspr-session']) {
    assert.ok(protocol.isKnownType(t), t);
    assert.strictEqual(protocol.describe(t).dir, protocol.Dir.S2C, t);
  }
});

test('the hello capability list gains activity', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'remote-server.js'), 'utf8');
  assert.ok(/capabilities: \[[^\]]*'activity'/.test(src),
    "the server hello must advertise 'activity'");
});

// ── the caches fill with NO client connected ────────────────────────────────

test('results accumulated while nobody was connected survive to hydration', () => {
  const rs = new RemoteServer();
  // No client at all — the idle desktop broadcasting into the void.
  rs.broadcastActivityState({ activity: 'wspr', auto: true, since: 1, detail: { sessionCount: 47 }, busy: { tx: false, decoding: false } });
  rs.broadcastWsprSession({ startedAt: 1, count: 47, active: true, spots: [{ call: 'W1AW' }] });
  rs.broadcastSstvTxStatus({ state: 'auto-rx', freqKhz: 14230 });
  rs.broadcastSstvRxImage({ base64: 'data:image/png;base64,AAAA', mode: 'Martin 1', width: 320, height: 256 });
  rs.broadcastSstvProgress({ progress: 0.5, line: 128, totalLines: 256, mode: 'decoding' });

  assert.strictEqual(rs._activityState.activity, 'wspr');
  assert.strictEqual(rs._wsprSession.count, 47);
  assert.strictEqual(rs._sstvTxStatus.state, 'auto-rx');
  assert.ok(rs._sstvLastImage.image.startsWith('data:image/png'));
  assert.strictEqual(rs._sstvProgress.line, 128);
});

test('a finished decode clears the cached progress', () => {
  const rs = new RemoteServer();
  rs.broadcastSstvProgress({ progress: 0.5, line: 128, totalLines: 256, mode: 'decoding' });
  assert.ok(rs._sstvProgress);
  rs.broadcastSstvProgress({ progress: 1, line: 256, totalLines: 256, mode: '' });
  assert.strictEqual(rs._sstvProgress, null,
    'a stale 100% must not hydrate as "decoding" to the next connect');
});

// ── hydration goes through the shared helpers on every auth path ────────────

test('all three auth paths hydrate via the shared helpers', () => {
  // Inline per-path copies are how the Guest Pass JS8 gap happened — the
  // helpers exist so a new feed reaches every path by construction. Count
  // the call sites: legacy token, hello, and pass auth.
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'remote-server.js'), 'utf8');
  // 2026-08-20: the no-token and token paths consolidated onto ONE
  // _hydrateClient(ws) helper (which carries the activity + JS8 calls
  // once), so the counts are: helper internals (1 each) + the Guest Pass
  // path's DELIBERATE subset (activity + JS8 inbox only — guests must not
  // receive the owner's worked history / logbook feeds). Both full-trust
  // paths must call the shared helper.
  const js8Calls = (src.match(/this\._sendJs8Hydration\(ws\)/g) || []).length;
  const actCalls = (src.match(/this\._sendActivityHydration\(ws\)/g) || []).length;
  const fullHydrations = (src.match(/this\._hydrateClient\(ws\)/g) || []).length;
  assert.strictEqual(js8Calls, 2, 'JS8 hydration: shared helper + Guest Pass subset');
  assert.strictEqual(actCalls, 2, 'activity hydration: shared helper + Guest Pass subset');
  assert.strictEqual(fullHydrations, 2, 'both full-trust auth paths use _hydrateClient');
});

test('hydration sends activity-state before the content feeds', () => {
  const rs = new RemoteServer();
  const ws = fakeWs();
  rs.broadcastActivityState({ activity: 'sstv', auto: true, since: 1, busy: { tx: false, decoding: true } });
  rs.broadcastWsprSession({ startedAt: 1, count: 2, active: false, spots: [] });
  rs.broadcastSstvTxStatus({ state: 'auto-rx' });
  rs._sendActivityHydration(ws);
  const types = ws._sent.map((m) => m.type);
  assert.strictEqual(types[0], 'activity-state', 'route first, content after');
  assert.ok(types.indexOf('wspr-session') > 0);
  assert.ok(types.indexOf('sstv-tx-status') > 0);
});

// ── main.js wiring (static, same idiom as the JS8 wiring test) ──────────────

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

test('main pushes activity on every lifecycle edge that changes it', () => {
  // The compute is cheap and debounced; what matters is coverage — a
  // transition the feed misses is a lie the phone renders until the next
  // unrelated push.
  for (const anchor of [
    ['function stopJtcat()', 'pushActivityState'],
    ["sstvEngine.on('rx-vis'", 'pushActivityState'],
    ["sstvEngine.on('rx-image'", 'pushActivityState'],
    ['function handleRemotePtt', 'pushActivityState'],
    ['function cancelAutoSstv', 'pushActivityState'],
  ]) {
    const at = MAIN.indexOf(anchor[0]);
    assert.ok(at > 0, anchor[0] + ' not found');
    assert.ok(MAIN.slice(at, at + 2600).includes(anchor[1]),
      anchor[0] + ' must reach ' + anchor[1]);
  }
});

test('the WSPR session accumulates where the live batch broadcasts', () => {
  const at = MAIN.indexOf('broadcastJtcatWsprSpots(payload)');
  assert.ok(at > 0);
  assert.ok(MAIN.slice(at, at + 300).includes('wsprSessionAppend(spots)'),
    'the session append rides the same handler as the live batch');
});

test('a stale SSTV decode cannot pin the busy flag', () => {
  const at = MAIN.indexOf('function computeActivityState()');
  assert.ok(at > 0);
  const body = MAIN.slice(at, at + 900);
  assert.ok(/updatedAt/.test(body) && /60/.test(body),
    'the decode tracker must expire when line ticks stop');
});

test('WSPR session ends on every path away from WSPR', () => {
  const ends = (MAIN.match(/wsprSessionEnd\(\)/g) || []).length;
  assert.ok(ends >= 4,
    `stopJtcat + both set-mode handlers + startJtcat rebuild — got ${ends}`);
});

console.log(`\nIdle activity: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
