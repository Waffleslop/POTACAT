#!/usr/bin/env node
'use strict';
// APRS phase 7: the gate for a beacon over the radio (lib/aprs-rf-gate.js).
// The 'aprs' keying owner may key only when every one of these holds: the
// APRS window is open with Listen on, a real callsign is set, the dial is on
// the APRS frequency POTACAT set for the band (a frequency match, never a
// band-legality check), nothing else transmits or owns the radio, and a
// beacon request is in flight. Each refusal has its own reason and sentence.
// Run: node test/aprs-rf-gate-test.js

const assert = require('assert');
const G = require('../lib/aprs-rf-gate');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

console.log('APRS beacon over the radio: the gate');

// Everything right, before the press (the button's view).
const ready = (o) => ({
  remote: false, windowOpen: true, listenOn: true, listenState: 'listening', band: '30m',
  settingsCall: 'K3SBP', aprsHz: 10147600, dialHz: 10147600,
  radioOwner: 'none', pttKeyed: false, otherTx: '', swrTripped: false, modemFound: true, inFlight: false,
  ...(o || {}),
});
// Everything right at the shim's key-down (the beacon in flight, owner 'aprs').
const keying = (o) => ready({ inFlight: true, radioOwner: 'aprs', ...(o || {}) });
const reason = (r) => (r && r.reason) || null;

test('all conditions hold: the button may send, and the shim may key', () => {
  assert.strictEqual(G.readiness(ready()), null);
  assert.deepStrictEqual(G.mayKey(keying()), { ok: true });
  assert.strictEqual(G.readiness(ready({ band: '2m', aprsHz: 144390000, dialHz: 144390000 })), null);
});

test('refused: no beacon in flight (every keying outside a beacon)', () => {
  const r = G.mayKey(keying({ inFlight: false }));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'not-asked');
  assert.ok(r.sentence.length > 10);
});

test('refused: the radio owner is not aprs at the key-down', () => {
  assert.strictEqual(G.mayKey(keying({ radioOwner: 'none' })).reason, 'owner');
  assert.strictEqual(G.mayKey(keying({ radioOwner: 'winlink' })).reason, 'owner');
});

test('refused: the APRS window is closed', () => {
  assert.strictEqual(reason(G.readiness(ready({ windowOpen: false }))), 'window');
  assert.strictEqual(G.mayKey(keying({ windowOpen: false })).reason, 'window');
});

test('refused: Listen on my radio is off, or not listening yet', () => {
  assert.strictEqual(reason(G.readiness(ready({ listenOn: false }))), 'listen');
  assert.strictEqual(G.mayKey(keying({ listenOn: false })).reason, 'listen');
  for (const st of ['starting', 'paused', 'refused', 'off']) {
    assert.strictEqual(reason(G.readiness(ready({ listenState: st }))), 'not-listening', st);
    assert.strictEqual(G.mayKey(keying({ listenState: st })).reason, 'not-listening', st);
  }
});

test('refused: no callsign, N0CALL, PCAT placeholders, or a call APRS cannot use', () => {
  assert.strictEqual(reason(G.readiness(ready({ settingsCall: '' }))), 'no-call');
  assert.strictEqual(reason(G.readiness(ready({ settingsCall: 'N0CALL' }))), 'placeholder');
  assert.strictEqual(reason(G.readiness(ready({ settingsCall: 'NOCALL' }))), 'placeholder');
  assert.strictEqual(reason(G.readiness(ready({ settingsCall: 'PCAT4821' }))), 'placeholder');
  assert.strictEqual(reason(G.readiness(ready({ settingsCall: 'K3SBP/P' }))), 'invalid');
  assert.strictEqual(G.mayKey(keying({ settingsCall: 'N0CALL' })).reason, 'placeholder');
});

test('refused: the dial is off the APRS frequency POTACAT set (2 m within 1 kHz, 30 m within 100 Hz)', () => {
  assert.strictEqual(G.readiness(ready({ dialHz: 10147690 })), null, '90 Hz on 30 m passes');
  assert.strictEqual(reason(G.readiness(ready({ dialHz: 10147750 }))), 'dial', '150 Hz on 30 m is off');
  assert.strictEqual(reason(G.readiness(ready({ dialHz: 7171000 }))), 'dial');
  assert.strictEqual(reason(G.readiness(ready({ dialHz: 0 }))), 'dial', 'no readback is not a match');
  const two = { band: '2m', aprsHz: 144390000 };
  assert.strictEqual(G.readiness(ready({ ...two, dialHz: 144390900 })), null);
  assert.strictEqual(reason(G.readiness(ready({ ...two, dialHz: 144395000 }))), 'dial');
  assert.strictEqual(G.mayKey(keying({ dialHz: 14074000 })).reason, 'dial');
  assert.ok(/10\.1476/.test(G.readiness(ready({ dialHz: 7171000 })).sentence));
});

test('never a band-legality check: an APRS frequency outside any ham band is still only matched', () => {
  // A made-up APRS frequency outside the amateur bands: the gate checks the match and nothing else.
  assert.strictEqual(G.readiness(ready({ band: '2m', aprsHz: 149090000, dialHz: 149090000 })), null);
  assert.deepStrictEqual(G.mayKey(keying({ band: '2m', aprsHz: 149090000, dialHz: 149090000 })), { ok: true });
});

test('refused: no APRS frequency for the band', () => {
  assert.strictEqual(reason(G.readiness(ready({ aprsHz: 0 }))), 'no-freq');
  assert.strictEqual(reason(G.readiness(ready({ band: '' }))), 'no-freq');
});

test('refused: another mode owns the radio, by name', () => {
  for (const [owner, word] of [['jtcat', /JTCAT/], ['winlink', /Winlink/], ['mercury', /Mercury/], ['atu-wizard', /tuner/i]]) {
    const r = G.readiness(ready({ radioOwner: owner }));
    assert.strictEqual(reason(r), 'owner', owner);
    assert.ok(word.test(r.sentence), r.sentence);
  }
});

test('refused: something is transmitting or holds PTT', () => {
  assert.strictEqual(reason(G.readiness(ready({ pttKeyed: true }))), 'transmitting');
  const r = G.readiness(ready({ otherTx: 'SSTV' }));
  assert.strictEqual(reason(r), 'transmitting');
  assert.ok(/SSTV/.test(r.sentence));
  assert.strictEqual(G.mayKey(keying({ pttKeyed: true })).reason, 'transmitting');
  assert.strictEqual(G.mayKey(keying({ otherTx: 'FT8' })).reason, 'transmitting');
});

test('refused: the SWR guard has tripped, remote mode, no Dire Wolf', () => {
  assert.strictEqual(reason(G.readiness(ready({ swrTripped: true }))), 'swr');
  assert.strictEqual(reason(G.readiness(ready({ remote: true }))), 'remote');
  assert.strictEqual(reason(G.readiness(ready({ modemFound: false }))), 'no-modem');
  assert.strictEqual(G.mayKey(keying({ swrTripped: true })).reason, 'swr');
});

test('the button is held while a beacon is going out', () => {
  assert.strictEqual(reason(G.readiness(ready({ inFlight: true }))), 'busy');
});

test('every refusal is one plain sentence, no emoji', () => {
  const cases = [
    ready({ remote: true }), ready({ windowOpen: false }), ready({ listenOn: false }), ready({ listenState: 'paused' }),
    ready({ settingsCall: '' }), ready({ aprsHz: 0 }), ready({ dialHz: 1 }), ready({ radioOwner: 'jtcat' }),
    ready({ pttKeyed: true }), ready({ swrTripped: true }), ready({ modemFound: false }), ready({ inFlight: true }),
  ];
  for (const c of cases) {
    const r = G.readiness(c);
    assert.ok(r && r.sentence, JSON.stringify(c));
    assert.ok(/^[A-Z]/.test(r.sentence) && /\.$/.test(r.sentence), r.sentence);
    assert.ok(/^[\x20-\x7e]+$/.test(r.sentence), 'plain ASCII: ' + r.sentence);
  }
  assert.ok(/^[\x20-\x7e]+$/.test(G.mayKey(keying({ inFlight: false })).sentence));
});

test('dialMatches is the frequency match alone, per band', () => {
  assert.strictEqual(G.dialMatches('30m', 10147600, 10147700), true);
  assert.strictEqual(G.dialMatches('30m', 10147600, 10147701), false);
  assert.strictEqual(G.dialMatches('2m', 144390000, 144391000), true);
  assert.strictEqual(G.dialMatches('2m', 144390000, 144391001), false);
  assert.deepStrictEqual(G.DIAL_TOLERANCE_HZ, { '2m': 1000, '30m': 100 });
});

// 2026-11-19: the 8600M's interlock read NOT_READY on 10.1476 MHz and the
// radio refused the beacon. The button says so before the press.
test('refused: the radio reports it is not ready to transmit here (Flex interlock NOT_READY)', () => {
  const r = G.readiness(ready({ txInterlock: 'NOT_READY' }));
  assert.strictEqual(reason(r), 'radio-not-ready');
  assert.strictEqual(r.sentence, 'The radio is not ready to transmit on this band: its interlock is preventing transmission.');
  assert.strictEqual(G.readiness(ready({ txInterlock: 'NOT_READY', txInterlockReason: 'AMP:TG' })).sentence,
    'The radio is not ready to transmit on this band: its interlock is preventing transmission (AMP:TG).');
  assert.strictEqual(G.mayKey(keying({ txInterlock: 'NOT_READY' })).reason, 'radio-not-ready');
  for (const st of ['READY', 'RECEIVE', 'PTT_REQUESTED', 'TRANSMITTING', '']) {
    assert.strictEqual(G.readiness(ready({ txInterlock: st })), null, st || 'unknown');
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
