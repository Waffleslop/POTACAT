'use strict';
// QSO detail view on ECHOCAT (Casey 2026-11-27): a device asks get-contact-card
// and gets the Contact details model the desktop window draws, to that device
// only. A Guest Pass guest is refused: the card reads the owner's log and QRZ.
// Run: node test/contact-card-wire-test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { RemoteServer } = require('../lib/remote-server');
const P = require('../lib/echocat-protocol');
const { isGuestAllowed } = require('../lib/guest-pass-authority');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error(`FAIL ${name}\n  ${e.message}`); process.exitCode = 1; }
}

function shack() {
  const rs = new RemoteServer();
  const mk = () => { const sent = []; return { sent, ws: { _authenticated: true, readyState: 1, send: (s) => sent.push(JSON.parse(s)), _clientPlatform: 'ios 18.1 phone', _clientCapabilities: [] } }; };
  const a = mk(), b = mk();
  rs._client = a.ws;
  rs._clients = new Set([a.ws, b.ws]);
  const events = [];
  rs.on('get-contact-card', (d) => events.push(d));
  return { rs, a, b, events };
}

const ID = { APP_POTACAT_UUID: 'u1', CALL: 'K1ABC', QSO_DATE: '20261120', TIME_ON: '1830', BAND: '20M', MODE: 'FT8' };

test('the owner device gets the model, and only that device', () => {
  const s = shack();
  s.rs._handleMessage(s.a.ws, { type: 'get-contact-card', reqId: 'r1', call: 'K1ABC', idx: 4, identity: ID }, {});
  assert.strictEqual(s.events.length, 1);
  const e = s.events[0];
  assert.deepStrictEqual([e.call, e.idx, e.identity], ['K1ABC', 4, ID]);
  e.reply({ ok: true, vm: { call: 'K1ABC', headline: 'Worked once.' } });
  assert.deepStrictEqual(s.a.sent, [{ type: 'contact-card', ok: true, vm: { call: 'K1ABC', headline: 'Worked once.' }, reqId: 'r1' }]);
  assert.deepStrictEqual(s.b.sent, [], 'another device never sees the owner\'s card');
});

test('a Guest Pass guest is refused with the same message type, and main is never asked', () => {
  const s = shack();
  s.a.ws._passSession = { call: 'W1GST' };
  s.rs._handleMessage(s.a.ws, { type: 'get-contact-card', reqId: 'r2', call: 'K1ABC' }, {});
  assert.strictEqual(s.events.length, 0);
  assert.deepStrictEqual(s.a.sent, [{ type: 'contact-card', reqId: 'r2', ok: false, error: 'guest' }]);
});

test('the guest wall lets it through only to be refused inside (reply keeps its shape)', () => {
  assert.strictEqual(isGuestAllowed('get-contact-card'), true);
});

test('both messages are in the protocol registry and validate', () => {
  assert.ok(P.validate({ type: 'get-contact-card', reqId: 'r1', call: 'K1ABC', idx: 4, identity: ID }).ok);
  assert.ok(P.validate({ type: 'contact-card', reqId: 'r1', ok: true, vm: {} }).ok);
  assert.ok(P.validate({ type: 'contact-card', reqId: 'r1', ok: false, error: 'guest' }).ok);
});

const rsSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'remote-server.js'), 'utf8');
test('the shack advertises the contact-card capability', () => {
  assert.match(rsSrc, /^\s*'contact-card',\s*$/m);
});

const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8').replace(/\r\n/g, '\n');
test('main builds it as the window does, without weather, and answers a bad call', () => {
  const at = main.indexOf("remoteServer.on('get-contact-card'");
  assert.ok(at > 0);
  const body = main.slice(at, main.indexOf('\n  });\n', at));
  assert.match(body, /ContactCard\.openRequest\(\{ call, idx, identity \}\)/);
  assert.match(body, /reply\(\{ ok: false, error: 'bad-request' \}\)/);
  assert.match(body, /await contactCardData\(req\)/);
  assert.match(body, /vm\.weatherPending = false/);
  assert.doesNotMatch(body, /withWeather/);
});

const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'echocat-protocol.md'), 'utf8');
test('the protocol doc has both rows', () => {
  assert.match(doc, /\| `get-contact-card` \| C→S \|/);
  assert.match(doc, /\| `contact-card` \| S→C \|/);
});

console.log(`contact-card-wire: ${passed} passed`);
