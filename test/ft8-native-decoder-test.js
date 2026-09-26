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
//    future change cannot quietly give back the multi-pass gains, and zero
//    decodes from signal-free slots (scripts/ft8-benchmark.js is the full
//    report).
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
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'ft8-benchmark.js'), '--json', '--noise', '20'], { encoding: 'utf8', timeout: 120000 });
    assert.strictEqual(r.status, 0, 'benchmark failed: ' + (r.stderr || '').slice(0, 400));
    const tot = JSON.parse(r.stdout.trim().split(/\r?\n/).pop());
    // Single pass / 140 candidates (before #87) matched 933 of 1289; multi-pass
    // with refined demodulation + subtraction matches 1251. Deterministic, so
    // the floor sits just under it.
    const FLOOR = +(process.env.FT8_MATCH_FLOOR || 1245);
    assert.ok(tot.matched >= FLOOR, `matched ${tot.matched} < floor ${FLOOR}`);
    assert.strictEqual(tot.implausible, 0, `${tot.implausible} implausible (likely false) decodes`);
    assert.strictEqual(tot.noiseDecodes, 0, `${tot.noiseDecodes} decodes from signal-free slots (false decodes)`);
    console.log(`       matched ${tot.matched}/${tot.ref}, extras ${tot.extra}, ${Math.round(tot.ms / tot.files)} ms/slot mean, ${Math.round(tot.maxMs)} ms max`);
  });

  // 3. SNR is measured, in WSJT-X's definition (signal power over the noise
  //    power in 2500 Hz — ft8sim's), and JTCAT sends it as the signal report.
  //    Known signals in white Gaussian noise must read back within 1.5 dB.
  //    The noise generator matters: an LCG feeding Box-Muller makes
  //    structured "noise" whose quiet bins read 15 dB low.
  test('measured SNR matches the true SNR in white noise', () => {
    const n = require(ADDON);
    let s = 0x9e3779b9;
    const rnd = () => { // mulberry32
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return (((t ^ (t >>> 14)) >>> 0) + 0.5) / 4294967296;
    };
    const gauss = () => Math.sqrt(-2 * Math.log(rnd())) * Math.cos(2 * Math.PI * rnd());
    const text = 'K1ABC W9XYZ EN37';
    const w = n.encode(text, 1234.5, 'FT8');
    let pw = 0; for (let i = 0; i < w.length; i++) pw += w[i] * w[i]; pw /= w.length;
    for (const snr of [-16, -8, 0, 8]) {
      const x = new Float32Array(180000);
      for (let i = 0; i < x.length; i++) x[i] = gauss();
      const g = Math.sqrt((2500 / 6000) * Math.pow(10, snr / 10) / pw);
      for (let i = 0; i < w.length; i++) x[6000 + i] += g * w[i];
      const d = n.decode(x, 'FT8', '', '').find((r) => r.text === text);
      assert.ok(d, `no decode at ${snr} dB`);
      assert.ok(Math.abs(d.db - snr) <= 1.5, `true ${snr} dB read ${d.db.toFixed(1)} dB`);
    }
  });
}

test('the worker keeps the native SNR (fixSNR is the WASM fallback only)', () => {
  const worker = fs.readFileSync(path.join(ROOT, 'lib', 'ft8-worker.js'), 'utf8');
  const nativeFt8 = worker.slice(worker.indexOf("nativeDecode(samples, 'FT8'"), worker.indexOf('WASM decode:'));
  assert.ok(!/fixSNR\(rawResults/.test(nativeFt8.split('} else if (decode)')[0]), 'native FT8 results must not be re-estimated');
});

console.log(`\n${pass} passed, ${fail} failed${skip ? `, ${skip} skipped` : ''}`);
process.exit(fail ? 1 : 0);
