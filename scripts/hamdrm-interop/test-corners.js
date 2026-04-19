#!/usr/bin/env node
'use strict';
// ---------------------------------------------------------------------------
// Corner-case matrix for the HamDRM encoder.
//
// Sweeps payload sizes × labels × filename extensions × repetition counts
// and verifies: encoder doesn't throw, output sample count is consistent,
// no NaN, peak is sane. Does NOT verify interop (that's Tier 1/2) — this
// just catches size-math / edge-case bugs.
//
// Also times each encode for a rough performance profile.
// ---------------------------------------------------------------------------

const { encodeImage } = require('../../lib/hamdrm/hamdrm-encoder');

function makePayload(n, seed = 7) {
  const b = new Uint8Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7FFFFFFF;
    b[i] = s & 0xFF;
  }
  return b;
}

function check(result, expectedSFMin = 1) {
  let ok = true;
  let peak = 0, hasNaN = false;
  for (let i = 0; i < result.audio.length; i++) {
    if (Number.isNaN(result.audio[i])) hasNaN = true;
    const a = Math.abs(result.audio[i]);
    if (a > peak) peak = a;
  }
  const reasons = [];
  if (hasNaN) { ok = false; reasons.push('NaN'); }
  if (result.audio.length !== result.superframes * 57600) { ok = false; reasons.push(`len mismatch`); }
  if (result.superframes < expectedSFMin) { ok = false; reasons.push(`<${expectedSFMin} sf`); }
  if (result.audio.length > 0 && Math.abs(peak - 0.8) > 0.02) { ok = false; reasons.push(`peak=${peak.toFixed(3)}`); }
  return { ok, peak, reasons };
}

function run(name, fn) {
  const t0 = Date.now();
  try {
    const result = fn();
    const check_ = check(result);
    const ms = Date.now() - t0;
    const realTimeX = (result.durationSec * 1000 / Math.max(1, ms)).toFixed(1);
    if (check_.ok) {
      console.log(`  OK    ${name.padEnd(48)} sf=${String(result.superframes).padStart(3)} dur=${result.durationSec.toFixed(1)}s encode=${String(ms).padStart(4)}ms (${realTimeX}× rt)`);
      return 0;
    } else {
      console.log(`  FAIL  ${name.padEnd(48)} ${check_.reasons.join(', ')}`);
      return 1;
    }
  } catch (err) {
    console.log(`  THROW ${name.padEnd(48)} ${err.message}`);
    return 1;
  }
}

(function main() {
  let fails = 0;

  console.log('\n-- Payload sizes --');
  for (const size of [1, 50, 95, 100, 500, 1000, 5000, 20000]) {
    fails += run(`payload=${size} bytes`,
      () => encodeImage({ jpegBytes: makePayload(size), filename: 'x.jpg', label: 'K3SBP' }));
  }

  console.log('\n-- Labels --');
  const payload = makePayload(500);
  for (const label of ['A', 'K3SBP', 'ABCDEFGHI', 'test123']) {
    fails += run(`label="${label}"`,
      () => encodeImage({ jpegBytes: payload, filename: 'x.jpg', label }));
  }
  // Over-length label: should silently truncate to 9 chars (QSSTV-compatible).
  try {
    encodeImage({ jpegBytes: payload, filename: 'x.jpg', label: 'TENCHARSXX' });
    console.log(`  OK    10-char label truncates to 9 (no throw)`);
  } catch (err) {
    console.log(`  FAIL  10-char label should silently truncate, not throw: ${err.message}`);
    fails++;
  }

  console.log('\n-- File extensions (ContentSubType mapping) --');
  for (const ext of ['jpg', 'jpeg', 'png', 'bmp', 'gif', 'jp2']) {
    fails += run(`ext=${ext}`,
      () => encodeImage({ jpegBytes: payload, filename: `x.${ext}`, label: 'K3SBP' }));
  }

  console.log('\n-- Repetition --');
  for (const rep of [1, 2, 3]) {
    fails += run(`repeat=${rep}`,
      () => encodeImage({ jpegBytes: payload, filename: 'x.jpg', label: 'K3SBP', repetition: rep }));
  }

  console.log('\n-- Payload > MSC budget → must throw gracefully --');
  // DEFAULT_BYTES_AVAILABLE=95 minus 14 overhead = 81 bytes/body segment;
  // tight MSC budget is 110 bytes. Single-segment DGs always fit. A
  // custom bytesAvailable could push past 110 — test that we throw.
  try {
    encodeImage({ jpegBytes: makePayload(1000), filename: 'x.jpg', label: 'K3SBP', bytesAvailable: 200 });
    console.log(`  FAIL  bytesAvailable=200 should exceed MSC budget`);
    fails++;
  } catch (err) {
    if (err.message.includes('exceeds per-frame MSC budget')) {
      console.log(`  OK    bytesAvailable=200 throws (${err.message.slice(0, 60)}…)`);
    } else {
      console.log(`  FAIL  unexpected error: ${err.message}`);
      fails++;
    }
  }

  console.log();
  if (fails === 0) {
    console.log(`All corner-case tests passed.`);
    process.exit(0);
  }
  console.log(`${fails} failure(s). See above.`);
  process.exit(1);
})();
