#!/usr/bin/env node
'use strict';
// The JTCAT auto latency is learned and seeded per audio source: a sound
// card's 1760 ms must never seed the SCU-LAN10, where it moved the decode
// window so far that nothing decoded and the auto loop could not recover.
// Run: node test/jtcat-latency-store-test.js
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const L = require('../lib/jtcat-latency-store');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

test('the old single value still seeds a sound card (no relearning after the update)', () => {
  assert.strictEqual(L.seedFor({ audioSource: 'dax', jtcatAudioLatencyMs: 1760 }), 1760);
  assert.strictEqual(L.seedFor({ jtcatAudioLatencyMs: 300 }), 300, 'no source saved = the sound card');
});

test('it never seeds a network source: the SCU-LAN10, Icom Network and SmartSDR start at 0', () => {
  for (const src of ['yaesu-lan', 'icom-network', 'smartsdr']) {
    assert.strictEqual(L.seedFor({ audioSource: src, jtcatAudioLatencyMs: 1760 }), null, src);
  }
});

test('each source keeps its own learned value', () => {
  const s = { audioSource: 'dax', jtcatAudioLatencyMs: 1760 };
  s.audioSource = 'yaesu-lan';
  assert.strictEqual(L.remember(s, 140), true);
  assert.deepStrictEqual(s.jtcatAudioLatencyBySource, { 'yaesu-lan': 140 });
  assert.strictEqual(s.jtcatAudioLatencyMs, 1760, 'a network value never overwrites the sound card\'s');
  assert.strictEqual(L.seedFor(s), 140);
  s.audioSource = 'dax';
  assert.strictEqual(L.seedFor(s), 1760, 'back on the sound card: its own value');
  assert.strictEqual(L.remember(s, 1700), true);
  assert.strictEqual(s.jtcatAudioLatencyMs, 1700, 'the sound card keeps the field a manual pin and older builds read');
  assert.strictEqual(L.remember(s, 1700), false, 'no change, no save');
  s.audioSource = 'yaesu-lan';
  assert.strictEqual(L.seedFor(s), 140);
});

const main = readSrc(path.join(__dirname, '..', 'main.js'));
test('main seeds and persists through the store, never the single field', () => {
  assert.ok(/const seedMs = JtcatLatencyStore\.seedFor\(settings\);\s*if \(seedMs != null\) ft8Engine\.seedAudioLatencyMs\(seedMs\);/.test(main));
  assert.ok(/if \(auto && JtcatLatencyStore\.remember\(settings, ms\)\) \{\s*\/\/[^\n]*\n\s*saveSettings\(settings\);/.test(main));
});

console.log(`\nJTCAT latency store: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
