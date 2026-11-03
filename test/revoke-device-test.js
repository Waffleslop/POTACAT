#!/usr/bin/env node
'use strict';
// Revoking a device ends EVERY live socket of that device (adversarial review
// of 1.13.9, finding 2; potacat-meta work/in-progress/guest-pass-authority-fixes.md
// part D). With "more than one device at a time" on, revokeDevice() used to
// close only the primary (_client): a second socket of the revoked device
// stayed in _clients with full station control.
//   - revokeDevice: both sockets of the device are told, closed 4004 and run
//     through the gone-path; another device's socket is untouched and becomes
//     the primary; one log line with the count
//   - the admission belt: a socket whose pairing no longer exists is closed
//     on its next message, whatever path forgot to; guests and legacy-token
//     clients (no pairing) are untouched
// Fake sockets, no listener. Run: node test/revoke-device-test.js
const assert = require('assert');
const WebSocket = require('ws');
const { RemoteServer } = require('../lib/remote-server');
const protocol = require('../lib/echocat-protocol');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
}

function fakeWs(device, extra = {}) {
  const ws = { readyState: WebSocket.OPEN, _authenticated: true, _pairedDevice: device, sent: [], closed: null, _socket: { remoteAddress: '127.0.0.1' }, ...extra };
  ws.send = (wire) => ws.sent.push(JSON.parse(wire));
  ws.close = (code, reason) => { ws.closed = { code, reason }; ws.readyState = WebSocket.CLOSING; };
  ws._heartbeat = setInterval(() => {}, 60000);
  return ws;
}
function server(devices, sockets, { multi = true } = {}) {
  const rs = new RemoteServer();
  rs.setMultiClient(multi);
  rs.setPairedDevices(devices.map(d => ({ ...d })));
  rs._wss = { clients: new Set(sockets) };
  for (const s of sockets) rs._clients.add(s);
  rs._client = sockets[sockets.length - 1];
  rs.logs = []; rs.emitted = [];
  rs.on('log', (l) => rs.logs.push(l));
  rs.on('paired-devices-changed', (l) => rs.emitted.push(['paired-devices-changed', l.length]));
  rs.on('client-disconnected', () => rs.emitted.push(['client-disconnected']));
  return rs;
}
const devA = { id: 'dev-a', name: 'Casey iPhone', token: 'tok-a', pairedAt: new Date().toISOString() };
const devB = { id: 'dev-b', name: 'Shack laptop', token: 'tok-b', pairedAt: new Date().toISOString() };

console.log('revokeDevice');
test('both sockets of the revoked device are told, closed 4004 and dropped; the other device stays and becomes primary', () => {
  const a1 = fakeWs(devA), a2 = fakeWs(devA), b = fakeWs(devB);
  const rs = server([devA, devB], [a1, a2, b]);
  rs._client = b;
  assert.strictEqual(rs.revokeDevice('dev-a'), true);
  for (const s of [a1, a2]) {
    // (a presence broadcast from the first socket's gone-path may precede it)
    assert.deepStrictEqual(s.sent.filter(m => m.type === 'revoked'), [{ type: 'revoked', reason: 'Access revoked by the desktop operator' }]);
    assert.strictEqual(s.sent[s.sent.length - 1].type, 'revoked', 'revoked is the last thing it hears');
    assert.deepStrictEqual(s.closed, { code: protocol.CLOSE_CODES.AUTH_REVOKED, reason: 'revoked' });
    assert.strictEqual(s._authenticated, false, 'deauthenticated at once');
    assert.strictEqual(s._heartbeat, null, 'heartbeat cleared');
    assert.ok(!rs._clients.has(s), 'out of _clients');
  }
  assert.deepStrictEqual(b.sent.filter(m => m.type === 'revoked'), [], 'the other device is not told it was revoked');
  assert.strictEqual(b.closed, null);
  assert.ok(rs._clients.has(b));
  assert.strictEqual(rs._client, b);
  assert.deepStrictEqual(rs.listPairedDevices().map(d => d.id), ['dev-b']);
  assert.strictEqual(rs.logs.filter(l => /Revoked device dev-a — 2 live sessions disconnected \(4004\)/.test(l)).length, 1, rs.logs.join(' | '));
  clearInterval(b._heartbeat);
});
test('the primary socket of the revoked device is covered too (the old behaviour), and a lone one runs the full disconnect', () => {
  const a1 = fakeWs(devA), a2 = fakeWs(devA);
  const rs = server([devA], [a1, a2]);
  assert.strictEqual(rs._client, a2);
  rs.revokeDevice('dev-a');
  assert.deepStrictEqual([a1.closed.code, a2.closed.code], [4004, 4004]);
  assert.strictEqual(rs._client, null, 'nobody left');
  assert.strictEqual(rs._clients.size, 0);
  assert.ok(rs.emitted.some(e => e[0] === 'client-disconnected'), 'the last one out runs the full disconnect (PTT off, CW stopped)');
  assert.ok(rs.logs.some(l => /dev-a — 2 live sessions/.test(l)));
});
test('revoking a device with no live socket touches nobody and says nothing about sessions', () => {
  const b = fakeWs(devB);
  const rs = server([devA, devB], [b]);
  assert.strictEqual(rs.revokeDevice('dev-a'), true);
  assert.deepStrictEqual(b.sent, []);
  assert.strictEqual(b.closed, null);
  assert.ok(!rs.logs.some(l => /live session/.test(l)));
  assert.strictEqual(rs.revokeDevice('dev-a'), false, 'already gone');
  clearInterval(b._heartbeat);
});
test('a socket that is already closing is skipped (no double close, not counted)', () => {
  const a1 = fakeWs(devA), a2 = fakeWs(devA);
  a2.readyState = WebSocket.CLOSING;
  const rs = server([devA], [a1, a2]);
  rs.revokeDevice('dev-a');
  assert.strictEqual(a2.closed, null);
  assert.ok(rs.logs.some(l => /dev-a — 1 live session disconnected/.test(l)));
  clearInterval(a2._heartbeat);
});

console.log('\nthe admission belt');
test('a socket whose pairing is gone is closed on its next message and nothing it sent is acted on', () => {
  const a = fakeWs(devA), b = fakeWs(devB);
  const rs = server([devA, devB], [a, b]);
  let tuned = 0;
  rs.on('tune', () => tuned++);
  rs._pairedDevices = rs._pairedDevices.filter(d => d.id !== 'dev-a'); // a path that forgot to close the socket
  rs._handleMessage(a, { type: 'tune', freqKhz: 14074 }, null);
  assert.strictEqual(tuned, 0, 'not acted on');
  assert.deepStrictEqual(a.sent, [{ type: 'revoked', reason: 'Access revoked by the desktop operator' }]);
  assert.strictEqual(a.closed.code, 4004);
  assert.strictEqual(a._authenticated, false);
  assert.ok(!rs._clients.has(a));
  assert.ok(rs.logs.some(l => /Casey iPhone sent tune after its pairing was removed — closing \(4004\)/.test(l)), rs.logs.join(' | '));
  rs._handleMessage(b, { type: 'tune', freqKhz: 14074 }, null);
  assert.strictEqual(tuned, 1, 'the device whose pairing exists is served');
  clearInterval(b._heartbeat);
});
test('a Guest Pass socket and a legacy shared-token socket have no pairing and are not touched by the belt', () => {
  const g = fakeWs(undefined, { _passSession: { code: 'otter-newt-mosaic-rooster' } });
  const legacy = fakeWs(undefined);
  const rs = server([devA], [g, legacy]);
  let acted = 0;
  rs.on('tune', () => acted++);
  rs.on('set-mode', () => acted++);
  rs._handleMessage(g, { type: 'tune', freqKhz: 14074 }, null);
  rs._handleMessage(legacy, { type: 'set-mode', mode: 'USB' }, null); // (tune is rate-limited to one per 500 ms)
  assert.strictEqual(acted, 2);
  assert.strictEqual(g.closed, null); assert.strictEqual(legacy.closed, null);
  clearInterval(g._heartbeat); clearInterval(legacy._heartbeat);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
