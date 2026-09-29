#!/usr/bin/env node
'use strict';
// N3FMC (FTDX10 via rigctld, 1.10.25): "my FTdx10 defaults to 2450 width
// instead of 3000 ... it works until I change bands and then goes back to
// unusually narrow 2450 again." A 20m->40m band change flips USB to LSB.
// Since 709a4d2 main sends no width on a same-family tune (GitHub #85), and
// the rigctld codec counted the sideband flip as a mode change, so it sent
// that mode's default passband (2400; the FTDX10 rounds to 2450). A flip
// inside the family now sends hamlib's "no change" (-1).
// Run: node test/rigctld-sideband-width-test.js
const assert = require('assert');
const { RigctldCodec } = require('../lib/codecs/rigctld-codec');
const { RIG_MODELS } = require('../lib/rig-models');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
function codec() {
  const writes = [];
  const c = new RigctldCodec(RIG_MODELS['FTDX10'], (d) => writes.push(String(d).trim()));
  return { c, writes };
}

console.log('rigctld sideband width');

test('USB -> LSB on a band change keeps the width (hamlib -1)', () => {
  const { c, writes } = codec();
  c.setMode('USB', 14245000);
  c._lastKnownWidth = 3000; // the rig read back 3000
  c.setMode('LSB', 7227000);
  assert.strictEqual(writes[writes.length - 1], 'M LSB -1');
  c.setMode('USB', 14245000);
  assert.strictEqual(writes[writes.length - 1], 'M USB -1', 'and back again');
});

test('the known width survives the flip for the next same-mode resend', () => {
  const { c, writes } = codec();
  c.setMode('USB', 14245000);
  c._lastKnownWidth = 3000;
  c.setMode('LSB', 7227000);
  c.setMode('LSB', 7227000); // band-recall resend
  assert.strictEqual(writes[writes.length - 1], 'M LSB 3000');
});

test('a real mode change still gets the mode default', () => {
  const { c, writes } = codec();
  c.setMode('USB', 14245000);
  c._lastKnownWidth = 3000;
  c.setMode('CW', 14030000);
  assert.ok(/^M CW \d+$/.test(writes[writes.length - 1]) && !/-1$/.test(writes[writes.length - 1]), writes[writes.length - 1]);
});

test('the first mode of a session still gets a real passband', () => {
  const { c, writes } = codec();
  c.setMode('LSB', 7227000);
  assert.ok(/^M LSB \d+$/.test(writes[0]), writes[0]);
});

test('a rig without filter control keeps sending 0', () => {
  const writes = [];
  const c = new RigctldCodec({ ...RIG_MODELS['FTDX10'], caps: { ...RIG_MODELS['FTDX10'].caps, filter: false } }, (d) => writes.push(String(d).trim()));
  c.setMode('USB', 14245000);
  c.setMode('LSB', 7227000);
  assert.deepStrictEqual(writes, ['M USB 0', 'M LSB 0']);
});

console.log(`\nrigctld sideband width: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
