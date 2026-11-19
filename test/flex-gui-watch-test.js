#!/usr/bin/env node
'use strict';
/**
 * The non-GUI watch of a Flex's GUI clients (lib/flex-gui-watch.js), used
 * while the radio is with ECHOCAT over FlexRadio SmartLink. It must never take
 * the radio's one GUI slot (only `sub client all` is ever sent), must count
 * only real GUI clients (a client_id; never itself, a non-GUI client or a
 * client_id=0 zombie), and must redial after a drop until stopped.
 *
 * Run: node test/flex-gui-watch-test.js
 */
const assert = require('assert');
const EventEmitter = require('events');
const { FlexGuiWatch, parseClientStatus, isGuiClientId } = require('../lib/flex-gui-watch');

let passed = 0, failed = 0;
const pending = [];
function test(name, fn) {
  pending.push(async () => {
    try { await fn(); passed++; console.log('  ok  ' + name); }
    catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message || e)); }
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class FakeSock extends EventEmitter {
  constructor() { super(); this.written = []; this.destroyed = false; }
  write(s) { this.written.push(s); }
  destroy() { this.destroyed = true; }
  feed(lines) { this.emit('data', Buffer.from(lines.map((l) => l + '\n').join(''))); }
}
function harness(opts = {}) {
  const socks = [];
  const w = new FlexGuiWatch({ connect: () => { const s = new FakeSock(); socks.push(s); return s; }, settleMs: 5, retryMs: 10, ...opts });
  const events = [];
  w.on('clients', (l) => events.push(l.map((c) => c.handle)));
  return { w, socks, events };
}

console.log('parseClientStatus');

test('a GUI client connecting', () => {
  const c = parseClientStatus('S1A2B3C4D|client 0x4E1DDC50 connected local_ptt=1 client_id=FC77859A-1111-2222-3333-444455556666 program=SmartSDR-iOS station=Casey\x7fiPhone');
  assert.deepStrictEqual(c, { handle: '4E1DDC50', state: 'connected', clientId: 'FC77859A-1111-2222-3333-444455556666', program: 'SmartSDR-iOS', station: 'Casey iPhone' });
});
test('a client leaving, both spellings', () => {
  assert.strictEqual(parseClientStatus('S0|client 0x4e1ddc50 disconnected forced=0 wan_disconnect=1').state, 'disconnected');
  assert.strictEqual(parseClientStatus('S0|client 0x4E1DDC50 connected=0').state, 'disconnected');
  assert.strictEqual(parseClientStatus('S0|client 0x4e1ddc50 disconnected').handle, '4E1DDC50');
});
test('a non-GUI client has no client_id', () => {
  const c = parseClientStatus('S0|client 0x11111111 connected local_ptt=0 program=DAX');
  assert.strictEqual(c.clientId, undefined);
});
test('not a client line', () => {
  assert.strictEqual(parseClientStatus('S0|slice 0 RF_frequency=14.074000'), null);
  assert.strictEqual(parseClientStatus(''), null);
});
test('GUI ids: a UUID yes; empty, 0 and 0x0 no', () => {
  assert.strictEqual(isGuiClientId('FC77859A-1111-2222-3333-444455556666'), true);
  for (const id of [undefined, null, '', '0', '0x0', ' ']) assert.strictEqual(isGuiClientId(id), false, String(id));
});

console.log('FlexGuiWatch');

test('sends sub client all and nothing that takes a GUI slot', async () => {
  const { w, socks } = harness();
  w.start('192.168.1.60');
  socks[0].emit('connect');
  socks[0].feed(['V1.4.0.0', 'H2C3D4E5F', 'S2C3D4E5F|client 0x2C3D4E5F connected']);
  await sleep(20);
  assert.deepStrictEqual(socks[0].written, ['C1|sub client all\n']);
  assert.ok(!socks[0].written.some((s) => /client (gui|bind)/.test(s)));
  w.stop();
});
test('counts GUI clients after the settle window and on every change', async () => {
  const { w, socks, events } = harness();
  w.start('h');
  const s = socks[0];
  s.emit('connect');
  s.feed(['H00000001',
    'S00000001|client 0x00000001 connected',                                      // this watch
    'S00000001|client 0x00000002 connected program=DAX',                          // non-GUI
    'S00000001|client 0x0000000A connected client_id=AAAA-1 program=SmartSDR-iOS station=Phone']);
  assert.deepStrictEqual(events, [], 'nothing before the radio has listed its clients');
  await sleep(20);
  assert.deepStrictEqual(events, [['0000000A']]);
  s.feed(['S00000001|client 0x0000000A disconnected forced=0']);
  assert.deepStrictEqual(events[1], []);
  s.feed(['S00000001|client 0x0000000B connected client_id=0 program=POTACAT']); // zombie
  assert.strictEqual(events.length, 2, 'a zombie is not a GUI client');
  s.feed(['S00000001|client 0x0000000B connected client_id=BBBB-2 program=Maestro']);
  assert.deepStrictEqual(events[2], ['0000000B']);
  s.feed(['S00000001|client 0x0000000B connected client_id=BBBB-2 program=Maestro station=Shack']);
  assert.strictEqual(events.length, 3, 'a repeat of a known client is not a change');
  assert.deepStrictEqual(w.guiClients(), [{ handle: '0000000B', clientId: 'BBBB-2', program: 'Maestro', station: 'Shack' }]);
  s.feed(['S00000001|client 0x0000000B connected client_id=0']);
  assert.deepStrictEqual(events[3], [], 'a registration torn down (client_id=0) leaves');
  w.stop();
});
test('a drop empties the list, says lost, and redials', async () => {
  const { w, socks } = harness();
  let lost = 0;
  w.on('lost', () => lost++);
  w.start('h');
  socks[0].emit('connect');
  socks[0].feed(['S0|client 0x0A connected client_id=A-1']);
  await sleep(20);
  assert.strictEqual(w.guiClients().length, 1);
  assert.strictEqual(w.settled, true);
  socks[0].emit('close');
  assert.strictEqual(lost, 1);
  assert.strictEqual(w.guiClients().length, 0);
  assert.strictEqual(w.connected, false);
  assert.strictEqual(w.settled, false);
  await sleep(30);
  assert.strictEqual(socks.length, 2, 'redialled');
  w.stop();
});
test('stop() ends it for good: no redial, the socket closed', async () => {
  const { w, socks } = harness();
  w.start('h');
  socks[0].emit('connect');
  w.stop();
  assert.ok(socks[0].destroyed);
  socks[0].emit('close');
  await sleep(30);
  assert.strictEqual(socks.length, 1);
  assert.strictEqual(w.running, false);
});
test('start() on the same host while running does not open a second connection', () => {
  const { w, socks } = harness();
  w.start('h'); w.start('h');
  assert.strictEqual(socks.length, 1);
  w.start('other');
  assert.strictEqual(socks.length, 2);
  assert.ok(socks[0].destroyed);
  w.stop();
});

(async () => {
  for (const t of pending) await t();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
