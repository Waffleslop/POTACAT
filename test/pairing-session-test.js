// Simpler pairing (2026-11-25): the code that renews itself, the six-digit
// LAN number, who may ask to pair, and the mDNS keys (lib/pairing-session.js).
// Run: node test/pairing-session-test.js
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const P = require('../lib/pairing-session');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n    ' + (e && e.stack || e)); process.exitCode = 1; }
}

// A fake server token store and a fake clock with manual timers.
function harness(opts = {}) {
  let now = 1_000_000;
  const timers = [];
  const valid = new Map(); // token -> expiresAt
  let n = 0;
  const rotations = [];
  const s = new P.PairingSession({
    mint: (ttl) => { const t = 'tok' + (++n); valid.set(t, now + ttl); return t; },
    revoke: (t) => { valid.delete(t); },
    now: () => now,
    setTimer: (fn, ms) => { const t = { fn, at: now + ms, live: true }; timers.push(t); return t; },
    clearTimer: (t) => { if (t) t.live = false; },
    onRotate: (r) => rotations.push(r),
    ...opts,
  });
  const serverValid = (t) => valid.has(t) && valid.get(t) > now;
  function advance(ms) {
    const end = now + ms;
    for (;;) {
      const due = timers.filter((t) => t.live && t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      now = due.at; due.live = false; due.fn();
    }
    now = end;
  }
  return { s, valid, serverValid, advance, rotations, now: () => now };
}

console.log('pairing-session');

test('lifetimes: tokens live 2 minutes, renew every minute', () => {
  assert.strictEqual(P.TOKEN_TTL_MS, 120000);
  assert.strictEqual(P.ROTATE_MS, 60000);
  assert.ok(P.ROTATE_MS < P.TOKEN_TTL_MS, 'renewal comes before expiry');
});

test('open shows a valid code at once', () => {
  const h = harness();
  const cur = h.s.start('AA:BB');
  assert.ok(cur && cur.token);
  assert.ok(h.serverValid(cur.token));
});

test('20 minutes open: the code on screen is never expired, at most two codes valid', () => {
  const h = harness();
  h.s.start('AA:BB');
  for (let i = 0; i < 20 * 60; i++) {
    h.advance(1000);
    const cur = h.s.current();
    assert.ok(cur && h.serverValid(cur.token), 'current code valid at ' + i + ' s');
    const live = [...h.valid.keys()].filter(h.serverValid);
    assert.ok(live.length <= 2, 'never more than two valid codes (' + live.length + ')');
  }
  assert.ok(h.rotations.length >= 20, 'renewed about once a minute');
});

test('a code scanned just before renewal still pairs', () => {
  const h = harness();
  const first = h.s.start('AA:BB').token;
  h.advance(60000); // renewal
  assert.notStrictEqual(h.s.current().token, first);
  assert.ok(h.serverValid(first), 'previous code still valid until its own 2 minutes');
  assert.ok(h.s.owns(first));
});

test('a used code is replaced at once', () => {
  const h = harness();
  const t = h.s.start('AA:BB').token;
  h.valid.delete(t); // the server consumed it (single use)
  assert.ok(h.s.noteRedeemed(t, 'dev1'));
  const cur = h.s.current().token;
  assert.notStrictEqual(cur, t);
  assert.ok(h.serverValid(cur));
  assert.ok(h.s.pairedDeviceIds.has('dev1'));
  assert.strictEqual(h.rotations[h.rotations.length - 1].reason, 'used');
});

test('a code this screen did not mint is not its business', () => {
  const h = harness();
  h.s.start('AA:BB');
  assert.strictEqual(h.s.noteRedeemed('someone-elses', 'x'), false);
});

test('a certificate change drops every shown code and shows a new one', () => {
  const h = harness();
  const a = h.s.start('AA:BB').token;
  h.advance(60000);
  const b = h.s.current().token;
  assert.ok(h.s.noteFingerprint('CC:DD'));
  assert.ok(!h.serverValid(a) && !h.serverValid(b), 'codes pinning the old certificate are revoked');
  assert.ok(h.serverValid(h.s.current().token));
  assert.strictEqual(h.s.noteFingerprint('CC:DD'), false, 'same fingerprint: nothing to do');
});

test('closing the screen revokes every code; nothing outlives it', () => {
  const h = harness();
  const a = h.s.start('AA:BB').token;
  h.advance(60000);
  const b = h.s.current().token;
  h.s.stop();
  assert.ok(!h.serverValid(a) && !h.serverValid(b));
  assert.strictEqual(h.s.current(), null);
  assert.strictEqual(h.s.owns(b), false);
  const before = h.rotations.length;
  h.advance(10 * 60000);
  assert.strictEqual(h.rotations.length, before, 'no renewal after close');
  assert.strictEqual([...h.valid.keys()].filter(h.serverValid).length, 0);
});

test('rotate() replaces the code (server restarted and forgot it)', () => {
  const h = harness();
  const a = h.s.start('AA:BB').token;
  h.s.rotate('server');
  assert.notStrictEqual(h.s.current().token, a);
});

console.log('pairCode');

test('six digits, from SHA-256 over the documented string', () => {
  const fp = 'AB:CD:EF:01';
  const rid = 'phone-request-0123456789';
  const want = String(crypto.createHash('sha256').update('echocat-pair-code-v1|abcdef01|' + rid).digest().readUInt32BE(0) % 1000000).padStart(6, '0');
  assert.strictEqual(P.pairCode(fp, rid), want);
  assert.match(P.pairCode(fp, rid), /^\d{6}$/);
});

test('the phone (lower-case, no colons) and the desktop (colons) agree', () => {
  assert.strictEqual(P.pairCode('AB:CD:EF:01', 'r'.repeat(20)), P.pairCode('abcdef01', 'r'.repeat(20)));
});

test('a different certificate or request gives a different number', () => {
  const a = P.pairCode('AB:CD', 'x'.repeat(20));
  assert.notStrictEqual(a, P.pairCode('AB:CE', 'x'.repeat(20)));
  assert.notStrictEqual(a, P.pairCode('AB:CD', 'y'.repeat(20)));
});

test('known vector (for the ECHOCAT handoff)', () => {
  // fp "AA:BB:CC", requestId "0123456789abcdef"
  const v = P.pairCode('AA:BB:CC', '0123456789abcdef');
  const want = String(crypto.createHash('sha256').update('echocat-pair-code-v1|aabbcc|0123456789abcdef').digest().readUInt32BE(0) % 1000000).padStart(6, '0');
  assert.strictEqual(v, want);
  console.log('    vector: pairCode("AA:BB:CC", "0123456789abcdef") = ' + v);
});

test('nothing to hash, no number', () => {
  assert.strictEqual(P.pairCode('', 'r'), '');
  assert.strictEqual(P.pairCode('AA', ''), '');
});

console.log('decideLanPairRequest');

test('an allowed request still needs the Approve click; nothing auto-approves', () => {
  const d = P.decideLanPairRequest({ allowPairRequests: true, pairv: 2, requestId: 'r'.repeat(16) });
  assert.strictEqual(d.allow, true);
  assert.strictEqual(d.needsApproveClick, true);
  // Even with a pairing screen open there is no "approved" outcome.
  const open = P.decideLanPairRequest({ allowPairRequests: true, pairingOpen: true, pairv: 2, requestId: 'r'.repeat(16) });
  assert.strictEqual(open.needsApproveClick, true);
  assert.ok(!('approved' in open));
});

test('tap-to-pair switched off refuses', () => {
  assert.deepStrictEqual(P.decideLanPairRequest({ allowPairRequests: false }), { allow: false, error: 'pair_requests_disabled' });
});

test('tunnel-exposed and not a LAN/tailnet source refuses first', () => {
  assert.strictEqual(P.decideLanPairRequest({ tunnelExposed: true, trustedPeer: false }).error, 'pair_request_tunnel_blocked');
  assert.strictEqual(P.decideLanPairRequest({ tunnelExposed: true, trustedPeer: true }).allow, true);
});

test('a pairv 2 phone must send a long requestId; an older phone is unchanged', () => {
  assert.strictEqual(P.decideLanPairRequest({ pairv: 2, requestId: 'short' }).error, 'request_id_too_short');
  assert.strictEqual(P.decideLanPairRequest({ pairv: 0, requestId: 'short' }).allow, true);
  assert.strictEqual(P.decideLanPairRequest({}).allow, true);
});

console.log('mDNS keys');

test('pairv always; pair=1 only while open AND tap-to-pair is on', () => {
  assert.deepStrictEqual(P.advertTxtExtras({}), { pairv: '2' });
  assert.strictEqual(P.advertTxtExtras({ pairingOpen: true }).pair, '1');
  assert.strictEqual(P.advertTxtExtras({ pairingOpen: true, allowPairRequests: false }).pair, undefined);
  assert.strictEqual(P.advertTxtExtras({ pairingOpen: false }).pair, undefined);
});

test('sid is derived, never the raw Cloud deviceId', () => {
  const id = '3f1c2e7a-0000-4000-8000-123456789abc';
  const fp = 'AA:BB:CC';
  const x = P.advertTxtExtras({ cloudDeviceId: id, fingerprint: fp });
  assert.match(x.sid, /^[0-9a-f]{16}$/);
  assert.ok(!JSON.stringify(x).includes(id), 'raw deviceId never in the advert');
  const want = crypto.createHash('sha256').update('potacat-shack-v1|' + id + '|aabbcc').digest('hex').slice(0, 16);
  assert.strictEqual(x.sid, want);
  assert.notStrictEqual(P.shackAdvertId(id, 'AA:BB:CD'), x.sid, 'changes with the certificate');
  assert.strictEqual(P.advertTxtExtras({ fingerprint: fp }).sid, undefined, 'signed out: no sid');
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
