#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';
//
// WSPR encoder -> wsprd loopback: the bit-exact on-air validation gate for the
// clean-room encoder's sync vector + convolutional constants.
//
// Builds a realistic 120 s capture from lib/wspr/encode.js (signal placed +1 s
// into the window, WSPR convention), runs it through the real wsprd via the
// decode bridge, and checks the recovered call/grid/power.
//
//   node scripts/wspr-loopback.js
//
// Requires a wsprd binary discoverable by lib/wspr-decoder.js#resolveWsprdPath
// (dev: third_party/wsprd/build/wsprd[.exe]).

const { encodeSymbols, synthesize, SAMPLE_RATE } = require('../lib/wspr/encode');
const { decodeWspr, resolveWsprdPath } = require('../lib/wspr-decoder');

const DIAL_MHZ = 14.0956;
const BASE_HZ = 1500;
const CAPTURE_SEC = 120;

function buildCapture(call, grid, dBm, { noise = 0 } = {}) {
  const total = CAPTURE_SEC * SAMPLE_RATE;
  const buf = new Float32Array(total);
  const sig = synthesize(encodeSymbols(call, grid, dBm), { baseFreqHz: BASE_HZ, rampMs: 20 });
  // optional faint noise so wsprd has a noise floor to estimate SNR against
  if (noise > 0) {
    let s = 1; // simple LCG, deterministic
    for (let i = 0; i < total; i++) {
      s = (1103515245 * s + 12345) & 0x7fffffff;
      buf[i] = (s / 0x7fffffff - 0.5) * 2 * noise;
    }
  }
  // place the 110.6 s waveform starting at +1 s
  const off = 1 * SAMPLE_RATE;
  for (let i = 0; i < sig.length; i++) buf[off + i] += sig[i] * 0.5;
  return buf;
}

// Cover the distinct callsign-normalization paths:
//   K1ABC/W1AW/K3SBP — 1-char prefix (space prepended, digit -> index 2)
//   PA0XYZ           — 2-char prefix (digit already at index 2, no shift)
//   VK7JJ            — short call (trailing-space pad)
const CASES = [
  ['K1ABC', 'FN42', 37],
  ['K3SBP', 'FN20', 30],
  ['W1AW', 'FN31', 33],
  ['PA0XYZ', 'JO22', 23],
  ['VK7JJ', 'QE37', 23],
];

const path = resolveWsprdPath();
console.log(`wsprd: ${path || '(NOT FOUND)'}\n`);
if (!path) { console.error('No wsprd binary — see third_party/wsprd/BUILD.md'); process.exit(2); }

let passed = 0;
for (const [call, grid, dBm] of CASES) {
  const buf = buildCapture(call, grid, dBm, { noise: 0.02 });
  const res = decodeWspr(buf, { dialFreqMHz: DIAL_MHZ });
  const hit = (res.spots || []).find((s) => s.call === call);
  const ok = hit && hit.grid === grid && hit.dBm === dBm;
  if (ok) passed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  sent ${call} ${grid} ${dBm}  ->  ` +
    (res.error ? `ERROR ${res.error}` :
      (res.spots.length ? res.spots.map((s) => `${s.call} ${s.grid} ${s.dBm} (snr ${s.snr})`).join(' | ') : '(no decode)')));
}

console.log(`\nLoopback: ${passed}/${CASES.length} recovered`);
process.exit(passed === CASES.length ? 0 : 1);
