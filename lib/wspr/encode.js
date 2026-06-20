// SPDX-License-Identifier: Apache-2.0
// Copyright 2024-2026 Casey Stanton
//
// Clean-room WSPR encoder (beacon TX side). 100% first-party Apache-2.0 code —
// NO GPL. Implemented from the public WSPR protocol description (G4JNT, "The
// WSPR Coding Process") and the openly-specified message format. This is the
// counterpart to lib/wspr-decoder.js (which shells out to the GPLv3 wsprd for
// RX); the encoder has no such dependency because the format is fully specified.
//
// Pipeline (all deterministic):
//   1. pack    callsign(28b) + grid(15b) + power(7b) = 50-bit message
//   2. extend  append 31 zero tail bits -> 81 bits (K=32 conv flush)
//   3. convol  rate-1/2, K=32 convolutional code -> 162 bits
//   4. ilace   bit-reversal interleave -> 162 bits
//   5. sync    merge with the 162-symbol sync vector -> 162 channel symbols 0..3
//   6. synth   continuous-phase 4-FSK audio @ 12 kHz (1.4648 Hz tone spacing)
//
// VALIDATION: steps 1-2 are proven by the independent unpack50() round-trip
// (test/wspr-encode-test.js). Steps 3-5 use the WSPR-standard published
// constants (SYNC_VECTOR, the two generator polynomials). Their bit-exact
// on-air correctness is gated by a loopback test (encode -> wsprd -> recover
// call/grid/power) that runs once the wsprd binary is built — see the PENDING
// marker in the test. Step 6 math (sample count, tone frequency, continuous
// phase) is unit-tested via Goertzel.

const SAMPLE_RATE = 12000;
const SYMBOL_COUNT = 162;
const SAMPLES_PER_SYMBOL = 8192;               // @ 12 kHz -> 0.682667 s/symbol
const TONE_SPACING_HZ = SAMPLE_RATE / SAMPLES_PER_SYMBOL; // 1.46484 Hz
const SYMBOL_DURATION_SEC = SAMPLES_PER_SYMBOL / SAMPLE_RATE;
const TOTAL_TX_SAMPLES = SYMBOL_COUNT * SAMPLES_PER_SYMBOL; // 1,327,104 (~110.6 s)

// K=32, rate-1/2 convolutional generator polynomials (WSPR standard).
const POLY_1 = 0xf2d05351;
const POLY_2 = 0xe4613c47;

// WSPR 162-symbol sync vector — the low ("sync") bit of each channel symbol.
//
// VERIFIED (2026-06-19). The exact bits are the WSPR-standard pr3[162] array,
// and the full encode chain (this vector + the generator polynomials + packing
// + synthesis) is confirmed bit-exact by a loopback through the real wsprd
// decoder: encode K1ABC/FN42/37 -> wsprd -> recovers K1ABC FN42 37. See
// scripts/wspr-loopback.js and the loopback case in test/wspr-encode-test.js.
// Laid out 27-per-row (6 rows = 162) so the length is self-evident.
const SYNC_VECTOR = [
  1, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1, 0, 0, 0, 1, 0, 0, 1, 0, 1, 1, 1, 1, // row 1
  0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 1, 1, 0, 0, 1, 1, // row 2
  0, 1, 0, 0, 0, 1, 1, 0, 1, 0, 0, 0, 0, 1, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 0, 1, 0, // row 3
  0, 1, 0, 1, 1, 0, 0, 0, 1, 1, 0, 1, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 1, // row 4
  0, 0, 1, 1, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 1, 0, // row 5
  1, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 1, 0, 1, 1, 0, 0, 0, 1, 1, 0, 0, 0, // row 6
];
// Fail loud at load if a future edit breaks the length — a wrong-length vector
// is how the encoder silently produces garbage. (Caught a 164-entry typo once.)
if (SYNC_VECTOR.length !== 162) {
  throw new Error(`WSPR SYNC_VECTOR must be 162 entries, got ${SYNC_VECTOR.length}`);
}
// Confirmed by the wsprd loopback (see file note above).
const SYNC_VECTOR_VERIFIED = true;

// ---- character set helpers (WSPR call alphabet) ------------------------
// Position-dependent value tables:
//   v37: [0-9 A-Z space] -> 0..36   (call char 0)
//   v36: [0-9 A-Z]       -> 0..35   (call char 1)
//   v10: [0-9]           -> 0..9    (call char 2 — the digit)
//   v27: [A-Z space]     -> 0..26   (call chars 3,4,5; A=0..Z=25, space=26)
function v37(c) {
  if (c >= '0' && c <= '9') return c.charCodeAt(0) - 48;
  if (c >= 'A' && c <= 'Z') return c.charCodeAt(0) - 65 + 10;
  if (c === ' ') return 36;
  throw new Error(`invalid WSPR call char '${c}'`);
}
function v36(c) {
  if (c >= '0' && c <= '9') return c.charCodeAt(0) - 48;
  if (c >= 'A' && c <= 'Z') return c.charCodeAt(0) - 65 + 10;
  throw new Error(`invalid WSPR call char '${c}'`);
}
function v10(c) {
  if (c >= '0' && c <= '9') return c.charCodeAt(0) - 48;
  throw new Error(`WSPR call position 3 must be a digit, got '${c}'`);
}
function v27(c) {
  if (c >= 'A' && c <= 'Z') return c.charCodeAt(0) - 65; // A->0 .. Z->25
  if (c === ' ') return 26;
  throw new Error(`invalid WSPR call char '${c}'`);
}

/**
 * Normalize a callsign to the 6-char WSPR template with the digit at index 2.
 * 1-letter prefixes (digit at index 1, e.g. K1ABC) get a leading space; the
 * field is then space-padded to 6. Returns the 6-char string.
 */
function normalizeCall(call) {
  let c = String(call).toUpperCase().trim();
  if (!/^[A-Z0-9]{3,6}$/.test(c)) throw new Error(`unsupported WSPR callsign: ${call}`);
  // If the 2nd char is a digit, this is a 1-char prefix -> shift right so the
  // digit lands at index 2.
  if (c[1] >= '0' && c[1] <= '9') c = ' ' + c;
  c = (c + '      ').slice(0, 6);
  if (!(c[2] >= '0' && c[2] <= '9')) {
    throw new Error(`WSPR callsign must have its digit in the 3rd position: ${call}`);
  }
  return c;
}

/** Pack a callsign into its 28-bit code. */
function packCallsign(call) {
  const c = normalizeCall(call);
  let n = v37(c[0]);
  n = n * 36 + v36(c[1]);
  n = n * 10 + v10(c[2]);
  n = n * 27 + v27(c[3]);
  n = n * 27 + v27(c[4]);
  n = n * 27 + v27(c[5]);
  return n >>> 0; // fits in 28 bits
}

/**
 * Pack a 4-char Maidenhead grid + power(dBm) into the 22-bit grid/power code
 * (15-bit grid << 7 | (power + 64)).
 */
function packGridPower(grid, dBm) {
  const g = String(grid).toUpperCase().trim();
  if (!/^[A-R][A-R][0-9][0-9]$/.test(g)) throw new Error(`invalid WSPR grid: ${grid}`);
  const p = Number(dBm);
  if (!Number.isInteger(p) || p < 0 || p > 60) throw new Error(`invalid WSPR power dBm: ${dBm}`);
  const lon = g.charCodeAt(0) - 65; // 0..17
  const lat = g.charCodeAt(1) - 65; // 0..17
  const lonSub = g.charCodeAt(2) - 48; // 0..9
  const latSub = g.charCodeAt(3) - 48; // 0..9
  const m = (179 - 10 * lon - lonSub) * 180 + (10 * lat + latSub); // 0..32399 (15 bits)
  return (m * 128 + p + 64) >>> 0;
}

/** Inverse of pack* — recovers {call, grid, dBm}. Used to round-trip the pack. */
function unpack50(callCode, gridPowerCode) {
  // ---- call ----
  let n = callCode >>> 0;
  const d6 = n % 27; n = Math.floor(n / 27);
  const d5 = n % 27; n = Math.floor(n / 27);
  const d4 = n % 27; n = Math.floor(n / 27);
  const d3 = n % 10; n = Math.floor(n / 10);
  const d2 = n % 36; n = Math.floor(n / 36);
  const d1 = n % 37;
  const inv37 = (x) => (x < 10 ? String.fromCharCode(48 + x) : x < 36 ? String.fromCharCode(65 + x - 10) : ' ');
  const inv36 = (x) => (x < 10 ? String.fromCharCode(48 + x) : String.fromCharCode(65 + x - 10));
  const inv27 = (x) => (x === 26 ? ' ' : String.fromCharCode(65 + x));
  const call = (inv37(d1) + inv36(d2) + String.fromCharCode(48 + d3) + inv27(d4) + inv27(d5) + inv27(d6)).trim();
  // ---- grid + power ----
  const code = gridPowerCode >>> 0;
  const dBm = (code & 127) - 64;
  const m = code >>> 7;
  const lonSub = (179 - Math.floor(m / 180)) % 10;
  const lon = Math.floor((179 - Math.floor(m / 180)) / 10);
  const lat = Math.floor((m % 180) / 10);
  const latSub = (m % 180) % 10;
  const grid = String.fromCharCode(65 + lon) + String.fromCharCode(65 + lat) + String(lonSub) + String(latSub);
  return { call, grid, dBm };
}

/** Build the 81-bit message (50 data + 31 zero tail), MSB-first, as 0/1 array. */
function buildMessageBits(callCode, gridPowerCode) {
  const bits = new Uint8Array(81);
  for (let i = 0; i < 28; i++) bits[i] = (callCode >>> (27 - i)) & 1;
  for (let i = 0; i < 22; i++) bits[28 + i] = (gridPowerCode >>> (21 - i)) & 1;
  // bits[50..80] already zero (the conv-code flush tail).
  return bits;
}

function parity32(x) {
  x = x >>> 0;
  x ^= x >>> 16; x ^= x >>> 8; x ^= x >>> 4; x ^= x >>> 2; x ^= x >>> 1;
  return x & 1;
}

/** K=32 rate-1/2 convolutional encode of 81 bits -> 162 bits. */
function convolutionalEncode(messageBits) {
  const out = new Uint8Array(SYMBOL_COUNT);
  let reg = 0;
  let k = 0;
  for (let i = 0; i < messageBits.length; i++) {
    reg = ((reg << 1) | messageBits[i]) >>> 0;
    out[k++] = parity32(reg & POLY_1);
    out[k++] = parity32(reg & POLY_2);
  }
  return out; // 162 bits
}

function bitrev8(x) {
  let r = 0;
  for (let i = 0; i < 8; i++) { r = (r << 1) | (x & 1); x >>= 1; }
  return r;
}

/** Bit-reversal interleave of the 162 coded bits. */
function interleave(coded) {
  const out = new Uint8Array(SYMBOL_COUNT);
  let ii = 0;
  for (let k = 0; k <= 255 && ii < SYMBOL_COUNT; k++) {
    const j = bitrev8(k);
    if (j < SYMBOL_COUNT) out[j] = coded[ii++];
  }
  return out;
}

/** Merge interleaved data bits with the sync vector -> 162 channel symbols 0..3. */
function mergeSync(interleaved) {
  const sym = new Uint8Array(SYMBOL_COUNT);
  for (let i = 0; i < SYMBOL_COUNT; i++) sym[i] = SYNC_VECTOR[i] + 2 * interleaved[i];
  return sym;
}

/**
 * Encode call/grid/power into the 162 WSPR channel symbols (0..3).
 * @returns {Uint8Array} 162 symbols
 */
function encodeSymbols(call, grid, dBm) {
  const callCode = packCallsign(call);
  const gridPowerCode = packGridPower(grid, dBm);
  const msg = buildMessageBits(callCode, gridPowerCode);
  return mergeSync(interleave(convolutionalEncode(msg)));
}

/**
 * Synthesize continuous-phase 4-FSK audio for the given symbols.
 * @param {Uint8Array} symbols  162 values 0..3
 * @param {object} [opts]
 * @param {number} [opts.baseFreqHz=1500] tone-0 audio frequency
 * @param {number} [opts.sampleRate=12000]
 * @param {number} [opts.rampMs=20]   start/end cosine envelope to kill clicks
 * @returns {Float32Array}
 */
function synthesize(symbols, opts = {}) {
  const baseFreq = opts.baseFreqHz != null ? opts.baseFreqHz : 1500;
  const fs = opts.sampleRate || SAMPLE_RATE;
  const sps = Math.round(fs * SYMBOL_DURATION_SEC);
  const toneSpacing = fs / sps;
  const out = new Float32Array(symbols.length * sps);
  let phase = 0;
  let k = 0;
  for (let s = 0; s < symbols.length; s++) {
    const f = baseFreq + symbols[s] * toneSpacing;
    const dphi = (2 * Math.PI * f) / fs;
    for (let j = 0; j < sps; j++) {
      out[k++] = Math.sin(phase);
      phase += dphi;
      if (phase > Math.PI) phase -= 2 * Math.PI; // keep bounded for precision
    }
  }
  // Raised-cosine envelope at the very start/end so PTT key-on/off doesn't click.
  const rampN = Math.min(Math.round((opts.rampMs != null ? opts.rampMs : 20) / 1000 * fs), Math.floor(out.length / 2));
  for (let i = 0; i < rampN; i++) {
    const w = 0.5 * (1 - Math.cos((Math.PI * i) / rampN));
    out[i] *= w;
    out[out.length - 1 - i] *= w;
  }
  return out;
}

/**
 * Full encode: call/grid/power -> 12 kHz mono audio (Float32, −1..1).
 * @returns {Float32Array}
 */
function encodeWspr(call, grid, dBm, opts = {}) {
  return synthesize(encodeSymbols(call, grid, dBm), opts);
}

module.exports = {
  encodeWspr,
  encodeSymbols,
  synthesize,
  packCallsign,
  packGridPower,
  unpack50,
  normalizeCall,
  buildMessageBits,
  convolutionalEncode,
  interleave,
  mergeSync,
  SYNC_VECTOR,
  SYNC_VECTOR_VERIFIED,
  SAMPLE_RATE,
  SYMBOL_COUNT,
  SAMPLES_PER_SYMBOL,
  TONE_SPACING_HZ,
  TOTAL_TX_SAMPLES,
  SYMBOL_DURATION_SEC,
};
