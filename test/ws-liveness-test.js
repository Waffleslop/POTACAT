'use strict';
// ECHOCAT Web keeps a dead socket after the phone's screen wakes (activation
// review 2026-11-17, item 2): it pinged every 3 s but never acted on a missing
// pong, and did not check the socket on wake, so a log sent on a socket that
// still read OPEN was lost. lib/ws-liveness.js decides "is it dead, should we
// reconnect"; renderer/remote.js only runs the existing reconnect path.
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const WsLiveness = require('../lib/ws-liveness');

let passed = 0;
function t(name, fn) { fn(); passed++; console.log('  ok', name); }
const read = (p) => readSrc(path.join(__dirname, '..', p));

t('defaults: 3 s ping interval, about 10 s for a pong', () => {
  assert.strictEqual(WsLiveness.PING_INTERVAL_MS, 3000);
  assert.strictEqual(WsLiveness.PONG_TIMEOUT_MS, 10000);
});

t('a fresh socket is alive', () => {
  const l = WsLiveness.create();
  l.reset(1000);
  assert.strictEqual(l.isDead(1000), false);
  assert.strictEqual(l.isDead(60000), false, 'no ping sent yet: nothing to time out');
});

t('pongs keep it alive', () => {
  const l = WsLiveness.create();
  l.reset(0);
  for (let now = 3000; now <= 60000; now += 3000) {
    l.pingSent(now);
    l.messageReceived(now + 80);
    assert.strictEqual(l.isDead(now + 3000), false, 'at ' + now);
  }
});

t('any message from the shack counts, not only a pong', () => {
  const l = WsLiveness.create();
  l.reset(0);
  l.pingSent(3000);
  l.messageReceived(9000); // a status, spots, anything
  assert.strictEqual(l.isDead(14000), false);
});

t('no answer within about 10 s of a ping: dead', () => {
  const l = WsLiveness.create();
  l.reset(0);
  l.pingSent(3000);
  l.pingSent(6000);
  l.pingSent(9000);
  l.pingSent(12000);
  assert.strictEqual(l.isDead(12000), false, '9 s after the first unanswered ping');
  assert.strictEqual(l.isDead(13000), true, '10 s after the first unanswered ping');
});

t('the clock runs from the FIRST unanswered ping, not the newest', () => {
  const l = WsLiveness.create();
  l.reset(0);
  l.pingSent(3000);
  l.pingSent(12000); // a later ping must not restart the wait
  assert.strictEqual(l.isDead(13000), true);
});

t('a reply after the timeout clears it', () => {
  const l = WsLiveness.create();
  l.reset(0);
  l.pingSent(3000);
  l.messageReceived(14000);
  assert.strictEqual(l.isDead(14000), false);
});

t('reset (a new socket) forgets the old unanswered ping', () => {
  const l = WsLiveness.create();
  l.reset(0);
  l.pingSent(3000);
  l.reset(20000);
  assert.strictEqual(l.isDead(20000), false);
});

t('custom timeout', () => {
  const l = WsLiveness.create({ pongTimeoutMs: 5000 });
  l.reset(0);
  l.pingSent(1000);
  assert.strictEqual(l.isDead(5999), false);
  assert.strictEqual(l.isDead(6000), true);
});

t('wake: an open socket that heard something within the ping interval is kept', () => {
  const l = WsLiveness.create();
  l.reset(0);
  l.messageReceived(10000);
  assert.strictEqual(l.reconnectOnWake(12000, 'open'), false);
  assert.strictEqual(l.reconnectOnWake(13000, 'open'), false);
});

t('wake: an open socket silent for longer than the ping interval is replaced at once', () => {
  const l = WsLiveness.create();
  l.reset(0);
  l.messageReceived(10000);
  assert.strictEqual(l.reconnectOnWake(13001, 'open'), true);
  assert.strictEqual(l.reconnectOnWake(10 * 60000, 'open'), true, 'screen off for ten minutes');
});

t('wake: a closed socket reconnects at once; a connecting one is left alone', () => {
  const l = WsLiveness.create();
  l.reset(0);
  assert.strictEqual(l.reconnectOnWake(1000, 'closed'), true);
  assert.strictEqual(l.reconnectOnWake(60000, 'connecting'), false);
});

t('ECHOCAT Web inlines the module and uses it', () => {
  assert.ok(read('renderer/remote.html').includes('<!-- ws-liveness-js -->'));
  assert.ok(read('lib/remote-server.js').includes("['ws-liveness-js', 'ws-liveness.js']"));
  const js = read('renderer/remote.js');
  assert.ok(js.includes('WsLiveness.create('), 'remote.js creates the liveness tracker');
  assert.ok(/\.isDead\(/.test(js), 'the ping tick checks for a dead socket');
  assert.ok(/\.reconnectOnWake\(/.test(js), 'the visibility handler checks the socket on wake');
  assert.ok(/\.messageReceived\(/.test(js), 'every inbound message is counted');
});

console.log(`ws-liveness: ${passed} passed`);
