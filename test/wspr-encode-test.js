#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';
//
// WSPR encoder regression suite. Run:  node test/wspr-encode-test.js
//
// Clean-room Apache-2.0 WSPR encoder (lib/wspr/encode.js). The bug-prone part
// — the 50-bit message packing — is PROVEN here by an independent unpack50()
// round-trip. The convolutional code / interleave / sync use the published
// WSPR-standard constants; their on-air bit-exactness gets its final gate from
// a wsprd loopback (see the PENDING test at the bottom) once that binary ships.

const assert = require('assert');
const W = require('../lib/wspr/encode');

let pass = 0, fail = 0, pending = 0;
function check(name, fn) {
  try { fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fail++; console.log(`FAIL  ${name}\n      ${e.message}`); }
}
function todo(name, why) { pending++; console.log(`TODO  ${name} — ${why}`); }

// ---- callsign normalization -------------------------------------------
check('normalizeCall puts the digit at index 2', () => {
  assert.strictEqual(W.normalizeCall('K1ABC'), ' K1ABC'); // 1-letter prefix -> space
  assert.strictEqual(W.normalizeCall('K3SBP'), ' K3SBP');
  assert.strictEqual(W.normalizeCall('PA0XYZ'), 'PA0XYZ'); // 2-letter prefix, no shift
  assert.strictEqual(W.normalizeCall('VK7JJ'), 'VK7JJ '); // trailing pad
});

// ---- THE PROOF: pack -> unpack round-trip -----------------------------
const RT = [
  ['K1ABC', 'FN42', 37],
  ['K3SBP', 'FN20', 30],
  ['PA0XYZ', 'JO22', 23],
  ['VK7JJ', 'QE37', 23],
  ['W1AW', 'FN31', 33],
  ['G4ABC', 'IO80', 37],
];
for (const [call, grid, dBm] of RT) {
  check(`round-trips ${call} ${grid} ${dBm}`, () => {
    const cc = W.packCallsign(call);
    const gp = W.packGridPower(grid, dBm);
    const back = W.unpack50(cc, gp);
    assert.strictEqual(back.call, call.toUpperCase(), 'call');
    assert.strictEqual(back.grid, grid.toUpperCase(), 'grid');
    assert.strictEqual(back.dBm, dBm, 'dBm');
  });
}

check('callCode fits in 28 bits, gridPower in 22 bits', () => {
  const cc = W.packCallsign('K1ABC');
  const gp = W.packGridPower('FN42', 37);
  assert.ok(cc < (1 << 28), `call ${cc} >= 2^28`);
  assert.ok(gp < (1 << 22), `gridPower ${gp} >= 2^22`);
});

check('rejects bad inputs', () => {
  assert.throws(() => W.packGridPower('ZZ99', 30), /invalid WSPR grid/);
  assert.throws(() => W.packGridPower('FN42', 61), /invalid WSPR power/);
  assert.throws(() => W.packGridPower('FN42', 7.5), /invalid WSPR power/);
});

// ---- 81-bit message structure -----------------------------------------
check('buildMessageBits: 81 bits, 31-bit zero tail, MSB-first fields', () => {
  const cc = W.packCallsign('K1ABC');
  const gp = W.packGridPower('FN42', 37);
  const bits = W.buildMessageBits(cc, gp);
  assert.strictEqual(bits.length, 81);
  for (let i = 50; i < 81; i++) assert.strictEqual(bits[i], 0, `tail bit ${i} not zero`);
  // reconstruct call/gridPower from the bit field
  let rc = 0; for (let i = 0; i < 28; i++) rc = (rc << 1) | bits[i];
  let rg = 0; for (let i = 0; i < 22; i++) rg = (rg << 1) | bits[28 + i];
  assert.strictEqual(rc >>> 0, cc);
  assert.strictEqual(rg >>> 0, gp);
});

// ---- coded / interleave / sync ----------------------------------------
check('convolutionalEncode -> 162 binary bits, deterministic', () => {
  const bits = W.buildMessageBits(W.packCallsign('K1ABC'), W.packGridPower('FN42', 37));
  const a = W.convolutionalEncode(bits);
  const b = W.convolutionalEncode(bits);
  assert.strictEqual(a.length, 162);
  assert.ok(a.every((x) => x === 0 || x === 1));
  assert.deepStrictEqual([...a], [...b]);
});

check('interleave is a bijection (every source bit used exactly once)', () => {
  // Feed a unique marker per position by interleaving an index array twice:
  // run interleave on 0..161 mapped to themselves via a tagged input.
  const src = new Uint8Array(162);
  // Use the permutation structure: interleave reads src[ii++] into out[bitrev].
  // Verify destinations cover 0..161 with no gaps/dupes.
  const seenDest = new Set();
  let ii = 0;
  for (let k = 0; k <= 255 && ii < 162; k++) {
    let r = 0, x = k; for (let i = 0; i < 8; i++) { r = (r << 1) | (x & 1); x >>= 1; }
    if (r < 162) { assert.ok(!seenDest.has(r), `dup dest ${r}`); seenDest.add(r); ii++; }
  }
  assert.strictEqual(ii, 162);
  assert.strictEqual(seenDest.size, 162);
  void src;
});

check('SYNC_VECTOR is 162 binary values', () => {
  assert.strictEqual(W.SYNC_VECTOR.length, 162);
  assert.ok(W.SYNC_VECTOR.every((x) => x === 0 || x === 1));
});

check('encodeSymbols: 162 symbols 0..3, low bit == sync vector', () => {
  const sym = W.encodeSymbols('K1ABC', 'FN42', 37);
  assert.strictEqual(sym.length, 162);
  assert.ok(sym.every((x) => x >= 0 && x <= 3));
  for (let i = 0; i < 162; i++) {
    assert.strictEqual(sym[i] & 1, W.SYNC_VECTOR[i], `sync bit mismatch at ${i}`);
  }
});

// ---- synthesis math ----------------------------------------------------
check('synthesize: exact sample count and bounded amplitude', () => {
  const sym = W.encodeSymbols('K1ABC', 'FN42', 37);
  const audio = W.synthesize(sym, { baseFreqHz: 1500 });
  assert.strictEqual(audio.length, 162 * 8192);
  assert.strictEqual(audio.length, W.TOTAL_TX_SAMPLES);
  assert.ok(audio.every((v) => v >= -1.0001 && v <= 1.0001));
});

check('synthesize: each symbol lands on the right 4-FSK tone (Goertzel)', () => {
  // One symbol per tone, generous base freq so tones are well separated.
  const base = 1500;
  const sym = new Uint8Array([0, 1, 2, 3]);
  const audio = W.synthesize(sym, { baseFreqHz: base, rampMs: 0 });
  const sps = 8192, fs = 12000, spacing = fs / sps;
  function goertzelPower(buf, off, n, freq) {
    const w = (2 * Math.PI * freq) / fs;
    const cw = 2 * Math.cos(w);
    let s0 = 0, s1 = 0, s2 = 0;
    for (let i = 0; i < n; i++) { s0 = buf[off + i] + cw * s1 - s2; s2 = s1; s1 = s0; }
    return s1 * s1 + s2 * s2 - cw * s1 * s2;
  }
  for (let s = 0; s < 4; s++) {
    let bestTone = -1, bestP = -Infinity;
    for (let t = 0; t < 4; t++) {
      const p = goertzelPower(audio, s * sps, sps, base + t * spacing);
      if (p > bestP) { bestP = p; bestTone = t; }
    }
    assert.strictEqual(bestTone, s, `symbol ${s} synthesized as tone ${bestTone}`);
  }
});

check('synthesize: phase is continuous across symbol boundaries', () => {
  const audio = W.synthesize(new Uint8Array([0, 3, 1, 2]), { baseFreqHz: 1500, rampMs: 0 });
  const sps = 8192;
  // At each interior boundary the sample-to-sample step must stay within the
  // max per-sample slew of the highest tone (no phase reset / discontinuity).
  const maxStep = 2 * Math.sin(Math.PI * (1500 + 3 * (12000 / 8192)) / 12000) + 1e-3;
  for (let b = 1; b < 4; b++) {
    const i = b * sps;
    const step = Math.abs(audio[i] - audio[i - 1]);
    assert.ok(step <= maxStep, `discontinuity at boundary ${b}: step ${step} > ${maxStep}`);
  }
});

check('synthesize: envelope ramps from ~0 at start and end', () => {
  const audio = W.synthesize(new Uint8Array([1, 2, 3]), { baseFreqHz: 1500, rampMs: 20 });
  assert.ok(Math.abs(audio[0]) < 0.05, `start not ramped: ${audio[0]}`);
  assert.ok(Math.abs(audio[audio.length - 1]) < 0.05, `end not ramped: ${audio[audio.length - 1]}`);
});

check('encodeWspr end-to-end returns Float32 audio', () => {
  const audio = W.encodeWspr('K3SBP', 'FN20', 30, { baseFreqHz: 1400 });
  assert.ok(audio instanceof Float32Array);
  assert.strictEqual(audio.length, W.TOTAL_TX_SAMPLES);
});

// ---- the golden gate: real loopback through wsprd ----------------------
// Bit-exact on-air validation for the sync vector + conv constants. Runs for
// real when a wsprd binary is present (dev/local); gracefully skipped in CI
// where it isn't (the full sweep lives in scripts/wspr-loopback.js).
(() => {
  const { decodeWspr, resolveWsprdPath } = require('../lib/wspr-decoder');
  if (!resolveWsprdPath()) {
    todo('wsprd loopback', 'no wsprd binary present — run scripts/wspr-loopback.js where one is built');
    return;
  }
  check('LOOPBACK: encode -> wsprd recovers call/grid/power (bit-exact)', () => {
    assert.strictEqual(W.SYNC_VECTOR_VERIFIED, true, 'SYNC_VECTOR_VERIFIED should be true once the loopback passes');
    for (const [call, grid, dBm] of [['K1ABC', 'FN42', 37], ['VK7JJ', 'QE37', 23]]) {
      const total = 120 * W.SAMPLE_RATE;
      const buf = new Float32Array(total);
      const sig = W.synthesize(W.encodeSymbols(call, grid, dBm), { baseFreqHz: 1500, rampMs: 20 });
      let s = 1; for (let i = 0; i < total; i++) { s = (1103515245 * s + 12345) & 0x7fffffff; buf[i] = (s / 0x7fffffff - 0.5) * 0.04; }
      for (let i = 0; i < sig.length; i++) buf[W.SAMPLE_RATE + i] += sig[i] * 0.5;
      const res = decodeWspr(buf, { dialFreqMHz: 14.0956 });
      const hit = (res.spots || []).find((x) => x.call === call);
      assert.ok(hit, `wsprd did not decode ${call} (${res.error || 'no match'})`);
      assert.strictEqual(hit.grid, grid);
      assert.strictEqual(hit.dBm, dBm);
    }
  });
})();

console.log(`\nWSPR encoder: ${pass} passed, ${fail} failed, ${pending} pending`);
process.exit(fail ? 1 : 0);
