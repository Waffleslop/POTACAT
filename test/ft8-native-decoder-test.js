#!/usr/bin/env node
'use strict';
// Native FT8 decoder guards (issue #87).
//
// 1. The callsign hash table must never fill. ft8_lib saves every callsign it
//    unpacks (and our encoder saves every call we transmit), and the table was
//    a fixed 256-slot open-addressing array with no eviction: the 257th
//    distinct call left ht_add probing forever — a decode that never returned,
//    a watchdog "respawn" that cannot interrupt native code, and a spinning
//    core. Here a child process pushes several thousand distinct calls through
//    encode + decode under a timeout, so a regression FAILS instead of hanging.
// 2. Decode sensitivity floor on ft8_lib's WSJT-X-referenced test set, so a
//    future change cannot quietly give back the multi-pass gains
//    (scripts/ft8-benchmark.js is the full report).
//
// Both need the built addon (npm run build-ft8); skipped when it is absent,
// like CI jobs that do not compile natives.
// Run: node test/ft8-native-decoder-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

let pass = 0, fail = 0, skip = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

const ROOT = path.join(__dirname, '..');
const ADDON = path.join(ROOT, 'lib', 'ft8_native', 'build', 'Release', 'ft8_native.node');
const SRC = fs.readFileSync(path.join(ROOT, 'lib', 'ft8_native', 'ft8_addon.c'), 'utf8');

console.log('ft8 native decoder');

test('hash table prunes before it can fill (source guard)', () => {
  assert.ok(/static void ht_prune\(/.test(SRC), 'ht_prune() missing');
  const add = SRC.slice(SRC.indexOf('static void ht_add('), SRC.indexOf('static bool ht_lookup('));
  assert.ok(/hash_table_size\s*>=\s*HASH_PRUNE_AT/.test(add), 'ht_add must prune at HASH_PRUNE_AT');
  const size = +SRC.match(/#define HASH_SIZE (\d+)/)[1];
  const at = SRC.match(/#define HASH_PRUNE_AT \((.*)\)/)[1];
  assert.ok(/HASH_SIZE \* 3 \/ 4/.test(at) && size >= 512, 'prune threshold must leave empty slots');
});

if (!fs.existsSync(ADDON)) {
  skip++;
  console.log('  skip native addon not built (npm run build-ft8)');
} else {
  test('thousands of distinct callsigns never hang encode/decode', () => {
    const child = `
      const n = require(${JSON.stringify(ADDON)});
      const L = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
      let calls = 0;
      const slot = new Float32Array(180000);
      for (let a = 0; a < 26 && calls < 5000; a++) for (let b = 0; b < 26 && calls < 5000; b++) for (let d = 0; d < 10 && calls < 5000; d++) {
        const call = 'K' + d + L[a] + L[b] + 'X';
        const w = n.encode('CQ ' + call + ' FN42', 1000, 'FT8');
        if (!w) throw new Error('encode failed for ' + call);
        calls++;
        if (calls % 500 === 0) {
          // A real decode in between, so lookups walk the table as it churns.
          slot.fill(0);
          for (let i = 0; i < w.length; i++) slot[6000 + i] = 0.3 * w[i];
          const r = n.decode(slot, 'FT8', '', '');
          if (!r.some((x) => x.text === 'CQ ' + call + ' FN42')) throw new Error('decode lost CQ ' + call);
        }
      }
      process.stdout.write('calls=' + calls);
    `;
    const r = spawnSync(process.execPath, ['-e', child], { encoding: 'utf8', timeout: 60000 });
    assert.ok(!r.error, 'child hung or failed to run: ' + (r.error && r.error.message));
    assert.strictEqual(r.status, 0, 'child failed: ' + (r.stderr || '').slice(0, 400));
    assert.ok(/calls=5000/.test(r.stdout), 'unexpected child output: ' + r.stdout);
  });

  test('decode sensitivity floor on the WSJT-X reference set', () => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'ft8-benchmark.js'), '--json'], { encoding: 'utf8', timeout: 120000 });
    assert.strictEqual(r.status, 0, 'benchmark failed: ' + (r.stderr || '').slice(0, 400));
    const tot = JSON.parse(r.stdout.trim().split(/\r?\n/).pop());
    // Baseline (single pass, 140 candidates) matched 933 of 1289 with 0 implausible extras.
    const FLOOR = +(process.env.FT8_MATCH_FLOOR || 933);
    assert.ok(tot.matched >= FLOOR, `matched ${tot.matched} < floor ${FLOOR}`);
    assert.strictEqual(tot.implausible, 0, `${tot.implausible} implausible (likely false) decodes`);
    console.log(`       matched ${tot.matched}/${tot.ref}, extras ${tot.extra}, ${Math.round(tot.ms / tot.files)} ms/slot mean, ${Math.round(tot.maxMs)} ms max`);
  });
}

console.log(`\n${pass} passed, ${fail} failed${skip ? `, ${skip} skipped` : ''}`);
process.exit(fail ? 1 : 0);
