'use strict';
// ---------------------------------------------------------------------------
// HamDRM CRC primitives — bit-exact ports of QSSTV's CCRC and crc16_bytewise.
// Ported from src/drmtx/common/util/CRC.cpp on the main branch.
//
// Two CRCs are used:
//   1. CRC-8 (DRM FAC): generic CCRC::AddByte with polyMask 0x1C, shifter
//      initialised to all-ones, final 1's-complement. Polynomial:
//      x^8 + x^4 + x^3 + x^2 + 1  (0x11D).
//   2. CRC-16 (MSC data-group / MOT): ITU-T X.25 (poly 0x1021, init 0xFFFF,
//      final 1's-complement on the last two bytes via an input bitflip).
// ---------------------------------------------------------------------------

// Bit mask equivalent to iPolynMask[iDegIndex] in QSSTV. Index is
// (degree - 1). We only need degree 8 for our use; other entries are
// documented for completeness so the file can be audited against CRC.cpp.
const POLY_MASK = {
  1: 0,
  2: (1 << 1),
  3: (1 << 1),
  5: (1 << 1) | (1 << 2) | (1 << 4),
  6: (1 << 1) | (1 << 2) | (1 << 3) | (1 << 5),
  8: (1 << 2) | (1 << 3) | (1 << 4),  // 0x1C — used by FAC CRC-8
  16: (1 << 5) | (1 << 12),           // unused here (QSSTV has a separate CRC-16
                                      // implementation for MOT; this entry is
                                      // informational).
};

/**
 * Port of QSSTV CCRC: bit-serial CRC with a configurable polynomial degree.
 * We use it for CRC-8 (degree=8). Each byte is fed MSB-first.
 *
 * Reset(8) →
 *   iBitOutPosMask = 1<<8 = 0x100
 *   iDegIndex      = 7
 *   iStateShiftReg = 0xFFFFFFFF (all-ones; final step takes the 1's-complement
 *                    of the low-N bits only, via `& (iBitOutPosMask - 1)`).
 */
class CCRC {
  constructor() {
    this.bitOutPosMask = 0;
    this.degIndex = 0;
    this.stateShiftReg = 0;
  }

  reset(degree) {
    this.bitOutPosMask = 1 << degree;
    this.degIndex = degree - 1;
    // Unsigned 32-bit all-ones. JS bitwise ops are 32-bit signed; keep this
    // as a positive number via >>> 0.
    this.stateShiftReg = 0xFFFFFFFF >>> 0;
  }

  addByte(byteVal) {
    const polyMask = POLY_MASK[this.degIndex + 1] | 0;
    const outPos = this.bitOutPosMask | 0;
    let reg = this.stateShiftReg | 0;
    for (let i = 0; i < 8; i++) {
      reg = (reg << 1) | 0;
      if ((reg & outPos) !== 0) {
        reg |= 1;
      }
      // Pick input bit, MSB-first
      if ((byteVal & (1 << (7 - i))) !== 0) {
        reg ^= 1;
      }
      if ((reg & 1) !== 0) {
        reg ^= polyMask;
      }
    }
    this.stateShiftReg = reg >>> 0;
  }

  getCRC() {
    // 1's-complement, keep only low N bits
    const n1 = (~this.stateShiftReg) >>> 0;
    const mask = ((this.bitOutPosMask - 1) >>> 0);
    return (n1 & mask) >>> 0;
  }
}

/**
 * FAC CRC-8 helper — the only caller shape we need for week-1 tests.
 * Accepts a Uint8Array (or Buffer/array of bytes) and returns the 8-bit CRC.
 */
function crc8FAC(bytes) {
  const c = new CCRC();
  c.reset(8);
  for (let i = 0; i < bytes.length; i++) c.addByte(bytes[i] & 0xFF);
  return c.getCRC() & 0xFF;
}

/**
 * Port of QSSTV crc16_bytewise (ITU-T X.25 over a byte array).
 *   init  = 0xFFFF
 *   poly  = 0x1021 (CRC-CCITT)
 *   On the last two bytes, the input bit is XOR-ed with 1 before feedback
 *   (this is the "final complement" step baked into the input bitstream).
 *
 * @param {Uint8Array} bytes   the data-group bytes WITH the 2 trailing CRC
 *                             placeholder bytes; length N; CRC is computed
 *                             over the full N (QSSTV does N-2 normal rounds,
 *                             then 2 final-complement rounds). The returned
 *                             uint16 is what you write into those placeholder
 *                             bytes.
 * @returns {number} 16-bit CRC
 */
function crc16Mot(bytes) {
  const N = bytes.length;
  const x = 0x1021;
  let b = 0xFFFF;
  for (let i = 0; i < N - 2; i++) {
    const inByte = bytes[i];
    for (let j = 7; j >= 0; j--) {
      const inBit = (inByte >> j) & 0x01;
      const y = (((b >> 15) + inBit) & 0x01) & 0x01;
      if (y === 1) b = ((b << 1) ^ x) & 0xFFFF;
      else         b = (b << 1) & 0xFFFF;
    }
  }
  for (let i = N - 2; i < N; i++) {
    const inByte = bytes[i];
    for (let j = 7; j >= 0; j--) {
      const inBit = (inByte >> j) & 0x01;
      const y = (((b >> 15) + inBit) ^ 0x01) & 0x01;
      if (y === 1) b = ((b << 1) ^ x) & 0xFFFF;
      else         b = (b << 1) & 0xFFFF;
    }
  }
  return b & 0xFFFF;
}

// ---------------------------------------------------------------------------
// Self-test — run `node lib/hamdrm/hamdrm-crc.js` and watch for "OK".
// Cross-check vectors are not from QSSTV directly (no bundled vectors in the
// repo); they're computed from the reference algorithm at porting time. The
// round-trip canary is what matters — once we have a QSSTV dump (see
// potacat-docs/hamdrm-port-notes.md), we replace these with real vectors.
// ---------------------------------------------------------------------------

if (require.main === module) {
  let pass = true;
  const log = (name, got, want) => {
    const ok = got === want;
    pass = pass && ok;
    console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name.padEnd(36)} got=0x${got.toString(16).padStart(4, '0')}  want=0x${want.toString(16).padStart(4, '0')}`);
  };

  // CRC-8 of the empty message: init=0xFF, no bits shifted, final complement → 0x00.
  log('crc8 empty', crc8FAC(new Uint8Array(0)), 0x00);

  // Regression canaries — these values were captured from the initial port.
  // Ground-truth vectors (from a QSSTV instrumented run) will replace them
  // once the instrumentation guide at potacat-docs/hamdrm-port-notes.md is
  // exercised. For now they just detect accidental regressions in this port.
  log('crc8 [0x00]', crc8FAC(new Uint8Array([0x00])), 0x3b);

  const probe = new Uint8Array([0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x00, 0x00]);
  log('crc16 "123456789"+00 00', crc16Mot(probe), 0x168b);

  console.log(pass ? '\nAll CRC self-tests passed.' : '\nSome CRC self-tests FAILED.');
  process.exit(pass ? 0 : 1);
}

module.exports = {
  CCRC,
  POLY_MASK,
  crc8FAC,
  crc16Mot,
};
