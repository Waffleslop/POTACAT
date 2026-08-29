#!/usr/bin/env node
'use strict';
// Chunked worked-qsos. The 256 KB cap protects iOS sockets, but for an active
// logger it meant the worked history was SKIPPED ENTIRELY — and a client with
// an empty history cannot mark a single spot, which is why LZ3AW's worked
// checkmark never appeared across three releases while the rendering code for
// it sat there working. Capable clients ('chunked-worked-qsos') now get the
// whole history in byte-bounded pieces, the same transport the logbook uses.
// Run: node test/worked-qsos-chunk-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { RemoteServer } = require('../lib/remote-server');
const { chunkQsosBySize, DEFAULT_CHUNK_BYTES } = require('../lib/qso-chunker');
const protocol = require('../lib/echocat-protocol');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

/** A worked-history entries array big enough to blow the 256 KB cap. */
function bigHistory(calls) {
  const out = [];
  for (let i = 0; i < calls; i++) {
    const call = 'LZ' + String(i).padStart(4, '0') + 'AW';
    const qsos = [];
    for (let q = 0; q < 6; q++) {
      qsos.push({ date: '2026082' + (q % 10), ref: 'LZ-000' + q, band: '20m', mode: 'SSB' });
    }
    out.push([call, qsos]);
  }
  return out;
}

/** Minimal fake ws capturing what the server sends. */
function fakeWs(capabilities) {
  return {
    readyState: 1,
    _clientCapabilities: capabilities,
    _authenticated: true,
    sent: [],
    send(json) { this.sent.push(JSON.parse(json)); },
  };
}

function serverWith(history) {
  const srv = Object.create(RemoteServer.prototype);
  srv._workedQsos = history;
  srv._workedQsosCache = null;
  srv.emit = () => {};
  srv._sendTo = function (ws, obj) { ws.send(JSON.stringify(obj)); };
  return srv;
}

const HISTORY = bigHistory(1200);

test('the fixture really does exceed the legacy 256 KB cap', () => {
  const bytes = JSON.stringify({ type: 'worked-qsos', entries: HISTORY }).length;
  assert.ok(bytes > 256000, 'fixture too small to exercise the bug: ' + bytes);
});

test('legacy client (no capability) still gets the skip notice, not a huge frame', () => {
  const srv = serverWith(HISTORY);
  const ws = fakeWs([]);
  srv._sendWorkedQsosCapped(ws);
  assert.strictEqual(ws.sent.length, 1);
  assert.strictEqual(ws.sent[0].type, 'worked-qsos-skipped');
  assert.strictEqual(ws.sent[0].reason, 'size');
});

test('capable client receives EVERY call, across chunks', () => {
  const srv = serverWith(HISTORY);
  const ws = fakeWs(['chunked-worked-qsos']);
  srv._sendWorkedQsosCapped(ws);
  assert.ok(ws.sent.length > 1, 'expected multiple chunks, got ' + ws.sent.length);
  for (const m of ws.sent) assert.strictEqual(m.type, 'worked-qsos');
  // Reassemble exactly as the client does.
  const rebuilt = [];
  ws.sent.forEach((m, i) => {
    assert.strictEqual(m.chunk, i, 'chunks out of order');
    assert.strictEqual(m.totalChunks, ws.sent.length);
    assert.strictEqual(m.total, HISTORY.length);
    rebuilt.push(...m.entries);
  });
  assert.strictEqual(rebuilt.length, HISTORY.length, 'lost calls in transit');
  assert.deepStrictEqual(new Map(rebuilt).get('LZ0000AW'), HISTORY[0][1]);
  assert.deepStrictEqual(rebuilt[rebuilt.length - 1], HISTORY[HISTORY.length - 1]);
});

test('every chunk stays under the byte budget', () => {
  const srv = serverWith(HISTORY);
  const ws = fakeWs(['chunked-worked-qsos']);
  srv._sendWorkedQsosCapped(ws);
  for (const m of ws.sent) {
    const bytes = JSON.stringify(m).length;
    assert.ok(bytes <= 256000, 'chunk too big: ' + bytes);
  }
});

test('an empty history still completes the set (client clears its loading state)', () => {
  const srv = serverWith([]);
  const ws = fakeWs(['chunked-worked-qsos']);
  srv._sendWorkedQsosCapped(ws);
  assert.strictEqual(ws.sent.length, 1);
  assert.strictEqual(ws.sent[0].totalChunks, 1);
  assert.strictEqual(ws.sent[0].chunk, 0);
  assert.deepStrictEqual(ws.sent[0].entries, []);
});

test('a small history sends as ONE chunk, not a stream of frames', () => {
  const srv = serverWith(bigHistory(3));
  const ws = fakeWs(['chunked-worked-qsos']);
  srv._sendWorkedQsosCapped(ws);
  assert.strictEqual(ws.sent.length, 1);
  assert.strictEqual(ws.sent[0].entries.length, 3);
});

test('re-entry on the same socket does not double-send', () => {
  // Both the auth-ok path and the client-connected handler call this.
  const srv = serverWith(HISTORY);
  const ws = fakeWs(['chunked-worked-qsos']);
  srv._sendWorkedQsosCapped(ws);
  const first = ws.sent.length;
  srv._sendWorkedQsosCapped(ws);
  assert.strictEqual(ws.sent.length, first, 'sent the whole history twice');
});

test('the chunked frame shape is registered in the protocol', () => {
  const entry = protocol.MESSAGES ? protocol.MESSAGES['worked-qsos'] : null;
  assert.ok(entry, 'worked-qsos missing from the registry');
  for (const f of ['entries', 'chunk', 'totalChunks', 'total']) {
    assert.ok(Object.prototype.hasOwnProperty.call(entry.fields, f), 'field not registered: ' + f);
  }
});

test('GUEST PASS still never receives the owner\'s worked history', () => {
  // The capability must not become a back door: guest gating lives upstream
  // (the guest hydration path never calls this), and the guest-pass suite
  // pins it. Assert the source still routes worked-qsos only through the
  // full-trust hydration, so a guest advertising the capability gains nothing.
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'remote-server.js'), 'utf8');
  const guestHydrate = src.indexOf('_hydrateGuest');
  if (guestHydrate !== -1) {
    const slice = src.slice(guestHydrate, guestHydrate + 4000);
    assert.ok(!/_sendWorkedQsosCapped/.test(slice),
      'guest hydration now sends worked history');
  }
});

console.log(`\nWorked-QSOs chunking: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
