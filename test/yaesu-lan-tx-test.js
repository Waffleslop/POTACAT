#!/usr/bin/env node
'use strict';
// lib/yaesu-lan-tx.js: one transmitter at a time over the Yaesu SCU-LAN10
// (#227, Casey's review of PR #349). A second owner is refused before PTT,
// a release cancels only its own transmission, and nobody unkeys another's.
// Run: node test/yaesu-lan-tx-test.js

const assert = require('assert');
const { OWNERS, ANY_HOLDER, NO_AUDIO_REFUSAL, YaesuLanTxGate, busyRefusal } = require('../lib/yaesu-lan-tx');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

test('the five owners', () => {
  assert.deepStrictEqual([...OWNERS], ['voice', 'jtcat', 'tune', 'sstv', 'macro']);
  assert.throws(() => new YaesuLanTxGate().claim('winlink'), /unknown SCU-LAN10 TX owner/);
});

test('a free LAN is taken; the holder may take it again', () => {
  const g = new YaesuLanTxGate();
  assert.strictEqual(g.claim('jtcat'), null);
  assert.strictEqual(g.owner, 'jtcat');
  assert.strictEqual(g.claim('jtcat'), null);
});

test('a second owner is refused while the first holds it, every pair', () => {
  for (const a of OWNERS) {
    for (const b of OWNERS) {
      if (a === b) continue;
      const g = new YaesuLanTxGate();
      g.claim(a);
      const why = g.claim(b);
      assert.strictEqual(why, busyRefusal(a), `${b} while ${a}`);
      assert.strictEqual(g.owner, a, `${a} keeps it`);
    }
  }
});

test('the refusal names who is on the air and what to do', () => {
  const g = new YaesuLanTxGate();
  g.claim('jtcat');
  assert.strictEqual(g.claim('voice'), 'JTCAT (FT8/FT4) is transmitting over the Yaesu LAN (SCU-LAN10). Wait until it ends, or stop it first.');
});

test('a release by anyone but the holder does nothing (its buffer is not cancelled)', () => {
  const g = new YaesuLanTxGate();
  g.claim('sstv');
  assert.strictEqual(g.release('voice'), false);
  assert.strictEqual(g.release('jtcat'), false);
  assert.strictEqual(g.release(null), false);
  assert.strictEqual(g.owner, 'sstv');
  assert.strictEqual(g.release('sstv'), true);
  assert.strictEqual(g.owner, null);
  assert.strictEqual(g.release('sstv'), false, 'twice is a no-op');
});

test('releaseAll (stuck-TX limit) frees whoever held it', () => {
  const g = new YaesuLanTxGate();
  assert.strictEqual(g.releaseAll(), null);
  g.claim('tune');
  assert.strictEqual(g.releaseAll(), 'tune');
  assert.strictEqual(g.owner, null);
});

test('key-down off the LAN route always passes', () => {
  const g = new YaesuLanTxGate();
  assert.strictEqual(g.refusal({ route: false }), null);
  g.claim('voice');
  assert.strictEqual(g.refusal({ route: false, asking: null }), null);
});

test('key-down on the route with nobody holding the LAN: a silent carrier, refused', () => {
  const g = new YaesuLanTxGate();
  assert.strictEqual(g.refusal({ route: true }), NO_AUDIO_REFUSAL);
  assert.strictEqual(g.refusal({ route: true, asking: 'jtcat' }), NO_AUDIO_REFUSAL, 'an owner that did not claim');
  assert.strictEqual(g.refusal({ route: true, asking: ANY_HOLDER }), NO_AUDIO_REFUSAL);
  assert.ok(/Winlink would send a silent carrier/.test(NO_AUDIO_REFUSAL));
});

test('key-down on the route while held: the holder passes, anyone else is refused as busy', () => {
  const g = new YaesuLanTxGate();
  g.claim('tune');
  assert.strictEqual(g.refusal({ route: true, asking: 'tune' }), null);
  assert.strictEqual(g.refusal({ route: true, asking: ANY_HOLDER }), null, 'the CAT key-down under the holder\'s own PTT');
  assert.strictEqual(g.refusal({ route: true, asking: 'voice' }), busyRefusal('tune'));
  assert.strictEqual(g.refusal({ route: true, asking: null }), busyRefusal('tune'), 'logger CAT, FreeDV, a custom CAT button');
});

test('only the holder (or anyone, with nobody holding) may unkey on the route', () => {
  const g = new YaesuLanTxGate();
  assert.strictEqual(g.mayUnkey({ route: true, owner: 'jtcat' }), true, 'nobody holds it: a release is always safe');
  g.claim('voice');
  assert.strictEqual(g.mayUnkey({ route: true, owner: 'jtcat' }), false, 'a JTCAT tx-end must not drop a voice over');
  assert.strictEqual(g.mayUnkey({ route: true, owner: 'sstv' }), false);
  assert.strictEqual(g.mayUnkey({ route: true, owner: 'voice' }), true);
  assert.strictEqual(g.mayUnkey({ route: false, owner: 'jtcat' }), true, 'off the route nothing changes');
});

test('the ECHOCAT case: a JTCAT start under an open voice stream is refused and cannot unkey it', () => {
  // Before: the JTCAT start cancelled nothing but keyed and then unkeyed the
  // radio under the open stream, and the engine stayed _txActive until its
  // failsafe 15-19 s after the operator let go.
  const g = new YaesuLanTxGate();
  assert.strictEqual(g.claim('voice'), null);           // phone PTT down
  assert.ok(g.claim('jtcat'));                           // the FT8 slot: refused before PTT
  assert.strictEqual(g.mayUnkey({ route: true, owner: 'jtcat' }), false); // its tx-end leaves PTT alone
  assert.strictEqual(g.release('voice'), true);          // phone PTT up
  assert.strictEqual(g.claim('jtcat'), null);            // the next slot goes out
});

console.log(`\nyaesu-lan-tx: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
