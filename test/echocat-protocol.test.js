#!/usr/bin/env node
'use strict';
// Tests for lib/echocat-protocol.js — the schema-of-record for the
// ECHOCAT WebSocket wire format. Run: node test/echocat-protocol.test.js

const assert = require('assert');
const protocol = require('../lib/echocat-protocol');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${e.message}`);
  }
}

console.log('\n=== echocat-protocol ===');

test('PROTOCOL_VERSION is an integer', () => {
  assert.strictEqual(typeof protocol.PROTOCOL_VERSION, 'number');
  assert.ok(Number.isInteger(protocol.PROTOCOL_VERSION));
  assert.ok(protocol.PROTOCOL_VERSION >= 1);
});

test('CLOSE_CODES are in the WS application range', () => {
  for (const code of Object.values(protocol.CLOSE_CODES)) {
    assert.ok(code >= 4000 && code <= 4999, `code ${code} out of range`);
  }
});

test('every registered message has a direction', () => {
  for (const [name, def] of Object.entries(protocol.MESSAGES)) {
    assert.ok(def.dir === 's2c' || def.dir === 'c2s' || def.dir === 'both',
      `message ${name} has bad dir: ${def.dir}`);
  }
});

test('isKnownType / describe', () => {
  assert.strictEqual(protocol.isKnownType('hello'), true);
  assert.strictEqual(protocol.isKnownType('definitely-not-a-thing'), false);
  assert.ok(protocol.describe('hello'));
  assert.strictEqual(protocol.describe('not-a-thing'), undefined);
});

test('validate accepts a well-formed hello', () => {
  const r = protocol.validate({ type: 'hello', protocolVersion: 1 });
  assert.strictEqual(r.ok, true);
});

test('validate rejects hello without protocolVersion', () => {
  const r = protocol.validate({ type: 'hello' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.field, 'protocolVersion');
});

test('validate rejects hello with non-integer protocolVersion', () => {
  const r = protocol.validate({ type: 'hello', protocolVersion: '1' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.field, 'protocolVersion');
});

test('validate rejects unknown type', () => {
  const r = protocol.validate({ type: 'unicorn' });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /unknown message type/);
});

test('validate rejects missing type', () => {
  assert.strictEqual(protocol.validate({}).ok, false);
  assert.strictEqual(protocol.validate(null).ok, false);
  assert.strictEqual(protocol.validate('foo').ok, false);
});

test('validate accepts optional fields when omitted', () => {
  const r = protocol.validate({ type: 'auth' }); // all fields optional
  assert.strictEqual(r.ok, true);
});

test('validate enforces direction when expectedDir given', () => {
  // `spots` is s2c — server must not see one inbound from a client
  const r = protocol.validate({ type: 'spots', data: [] }, protocol.Dir.C2S);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /not allowed in direction/);
});

test('validate accepts both-direction messages from either side', () => {
  // `signal` is BOTH
  assert.strictEqual(protocol.validate({ type: 'signal', data: {} }, protocol.Dir.S2C).ok, true);
  assert.strictEqual(protocol.validate({ type: 'signal', data: {} }, protocol.Dir.C2S).ok, true);
});

test('validate type-checks: string vs number', () => {
  // tune.freqKhz must be a string (the wire format the server actually
  // parses — see Gap 5 in echocat-protocol-gaps.md).
  assert.strictEqual(protocol.validate({ type: 'tune', freqKhz: '14250.000' }).ok, true);
  const bad = protocol.validate({ type: 'tune', freqKhz: 14250000 });
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.field, 'freqKhz');
});

test('validate type-checks: integer vs float', () => {
  // delete-qso.idx must be an integer
  assert.strictEqual(protocol.validate({ type: 'delete-qso', idx: 7 }).ok, true);
  assert.strictEqual(protocol.validate({ type: 'delete-qso', idx: 7.5 }).ok, false);
});

test('validate type-checks: array', () => {
  assert.strictEqual(protocol.validate({ type: 'spots', data: [] }).ok, true);
  assert.strictEqual(protocol.validate({ type: 'spots', data: 'oops' }).ok, false);
});

test('validate type-checks: object (not array)', () => {
  assert.strictEqual(protocol.validate({ type: 'set-sources', sources: { pota: true } }).ok, true);
  assert.strictEqual(protocol.validate({ type: 'set-sources', sources: [] }).ok, false);
});

test('parse rejects invalid JSON', () => {
  const r = protocol.parse('{not json');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /invalid JSON/);
});

test('parse round-trips a valid frame', () => {
  const r = protocol.parse('{"type":"hello","protocolVersion":1}');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.msg.type, 'hello');
});

test('encode throws on invalid messages by default', () => {
  assert.throws(
    () => protocol.encode({ type: 'tune' }), // missing required `frequency`
    (err) => err.code === 'PROTOCOL_INVALID',
  );
});

test('encode skipValidate bypasses validation (used for legacy passthroughs)', () => {
  const out = protocol.encode({ type: 'status', anythingGoes: true }, { skipValidate: true });
  assert.strictEqual(out, '{"type":"status","anythingGoes":true}');
});

test('buildServerHello returns a valid hello', () => {
  const h = protocol.buildServerHello({ serverVersion: '1.5.13' });
  assert.strictEqual(h.type, 'hello');
  assert.strictEqual(h.protocolVersion, protocol.PROTOCOL_VERSION);
  assert.strictEqual(h.serverVersion, '1.5.13');
  assert.deepStrictEqual(h.capabilities, []);
  assert.strictEqual(protocol.validate(h).ok, true);
});

test('buildClientHello returns a valid hello', () => {
  const h = protocol.buildClientHello({ clientVersion: '0.1.0', clientPlatform: 'ios' });
  assert.strictEqual(h.type, 'hello');
  assert.strictEqual(h.protocolVersion, protocol.PROTOCOL_VERSION);
  assert.strictEqual(h.clientVersion, '0.1.0');
  assert.strictEqual(h.clientPlatform, 'ios');
  assert.strictEqual(protocol.validate(h).ok, true);
});

test('checkCompatibility same major', () => {
  const r = protocol.checkCompatibility(protocol.PROTOCOL_VERSION);
  assert.strictEqual(r.compatible, true);
});

test('checkCompatibility one-major-off is allowed (downgrade)', () => {
  const r = protocol.checkCompatibility(protocol.PROTOCOL_VERSION - 1);
  assert.strictEqual(r.compatible, true);
  assert.strictEqual(r.downgrade, true);
});

test('checkCompatibility far-future rejects', () => {
  const r = protocol.checkCompatibility(protocol.PROTOCOL_VERSION + 5);
  assert.strictEqual(r.compatible, false);
  assert.match(r.reason, /too far/);
});

test('checkCompatibility rejects nonsense', () => {
  assert.strictEqual(protocol.checkCompatibility('1').compatible, false);
  assert.strictEqual(protocol.checkCompatibility(-1).compatible, false);
  assert.strictEqual(protocol.checkCompatibility(undefined).compatible, false);
});

test('LEGACY_FIRST_MESSAGE_TYPES contains auth', () => {
  // Must not break the legacy browser ECHOCAT, which leads with `auth`.
  assert.ok(protocol.LEGACY_FIRST_MESSAGE_TYPES.includes('auth'));
});

console.log('\n' + '='.repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('SOME TESTS FAILED');
  process.exit(1);
}
