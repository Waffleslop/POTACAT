#!/usr/bin/env node
'use strict';
// Preamp/ATT writes on a rigctld server that names no ladder in dump_caps
// (GitHub #82, GoNoGoTest: IC-7300 through wfview). wfview takes preamp as
// its own step numbers (0/1/2) and ATT as 20; it RPRT-rejects hamlib's dB
// guesses (10, 12). A rejected guess moves on to the next; an accepted or
// reported value is kept. Run: node test/rigctld-gain-fallback-test.js
const assert = require('assert');
const { RigctldCodec } = require('../lib/codecs/rigctld-codec');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + '\n    ' + (e.stack || e.message)); }
}

function makeCodec() {
  const writes = [];
  const codec = new RigctldCodec({ brand: 'Icom', protocol: 'rigctld', caps: {} }, (d) => writes.push(String(d).trim()));
  const logs = [];
  codec.on('log', (l) => logs.push(l));
  return { codec, writes, logs };
}

test('wfview preamp: 10 dB rejected -> tries 1, which is accepted and kept', () => {
  const { codec, writes } = makeCodec();
  codec.setPreamp(true);
  assert.strictEqual(writes.pop(), 'L PREAMP 10');
  codec.onData('RPRT -1\n');
  assert.strictEqual(writes.pop(), 'L PREAMP 1', 'moved on to wfview\'s step number');
  codec.onData('RPRT 0\n');
  codec.setPreamp(false);
  assert.strictEqual(writes.pop(), 'L PREAMP 0');
  codec.setPreamp(true);
  assert.strictEqual(writes.pop(), 'L PREAMP 1', 'the accepted value is used from now on');
});

test('wfview ATT: 12 rejected -> 20 accepted and kept', () => {
  const { codec, writes } = makeCodec();
  codec.setAttenuator(true);
  assert.strictEqual(writes.pop(), 'L ATT 12');
  codec.onData('RPRT -1\n');
  assert.strictEqual(writes.pop(), 'L ATT 20');
  codec.onData('RPRT 0\n');
  codec.setAttenuator(true);
  assert.strictEqual(writes.pop(), 'L ATT 20');
});

test('a value the rig reports on its own is learned before any write', () => {
  const { codec, writes } = makeCodec();
  codec.getAtt();
  codec.onData('20\n');
  codec.setAttenuator(true);
  assert.strictEqual(writes.pop(), 'L ATT 20');
});

test('a rig that rejects every known value says so, once, and stops', () => {
  const { codec, writes, logs } = makeCodec();
  codec.setPreamp(true);
  for (let i = 0; i < 4; i++) codec.onData('RPRT -1\n');
  assert.ok(logs.some(l => /rejected every preamp value/.test(l)), logs.join('\n'));
  assert.strictEqual(writes.filter(w => w.startsWith('L PREAMP')).length, 4, 'tried each value once: ' + writes.join(' | '));
});

test('a rig whose dump_caps named a ladder never gets a guess', () => {
  const { codec, writes } = makeCodec();
  codec._preampDbs = [10, 20];
  codec._preampDb = 10;
  codec.setPreamp(true);
  assert.strictEqual(writes.pop(), 'L PREAMP 10');
  codec.onData('RPRT -1\n');
  assert.strictEqual(writes.length, 0, 'no retry past the rig\'s own ladder: ' + writes.join(' | '));
});

test('a real hamlib IC-7300 (10 dB accepted) is unchanged', () => {
  const { codec, writes } = makeCodec();
  codec.setPreamp(true);
  assert.strictEqual(writes.pop(), 'L PREAMP 10');
  codec.onData('RPRT 0\n');
  codec.setPreamp(true);
  assert.strictEqual(writes.pop(), 'L PREAMP 10');
});

console.log(`\nrigctld gain fallback: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
