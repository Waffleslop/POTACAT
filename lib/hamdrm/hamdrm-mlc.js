'use strict';
// ---------------------------------------------------------------------------
// HamDRM MLC (Multi-Level Coding) — convolutional encoder + puncturing.
//
// Scope for week-1: convolutional encoder only, K=7 rate-1/4 mother code with
// the four QSSTV generator polynomials. Puncturing table driver is present
// but currently unverified against QSSTV's ConvEncoder.cpp — see TODOs. Bit/
// block/symbol interleavers are stubs.
//
// Once a QSSTV-dumped bitstream is in hand (see potacat-docs/hamdrm-port-
// notes.md), we verify byte-for-byte, then flip the TODO gates into tests.
// ---------------------------------------------------------------------------

const {
  MC_CONSTRAINT_LENGTH,
  byGeneratorMatrix,
  MC_NUM_OUTPUT_BITS_PER_STEP,
  iPuncturingPatterns,
  iPunctPatTailbits,
  PP_BRANCH_MASK,
  PP_TYPE_0000,
} = require('./hamdrm-tables');

/**
 * Convolutional encoder, rate 1/4 mother code.
 *
 * Input:  bits as Uint8Array of 0/1 values, any length.
 * Output: 4 output streams (B0..B3), each the same length as input + (K-1)
 *         tail bits (6 zero bits flushed through the shift register so the
 *         encoder ends in the all-zeros state, as required for hard-decision
 *         decoding at the receiver).
 *
 * Polynomial handling: QSSTV stores polynomials BIT-REVERSED in byGenerator
 * Matrix because it shifts right-to-left. Our register shifts left-to-right,
 * so we interpret the polynomial as-is and the shift register holds the most
 * recent bit at LSB. Invariant: bits 0..6 of the register reflect the last 7
 * input bits, newest at LSB.
 *
 * Output bit for branch b is popcount(register & poly[b]) mod 2.
 */
function convEncode(inputBits) {
  const nIn = inputBits.length;
  const tail = MC_CONSTRAINT_LENGTH - 1;   // 6
  const nOut = nIn + tail;
  const B = MC_NUM_OUTPUT_BITS_PER_STEP;   // 4
  const out = [new Uint8Array(nOut), new Uint8Array(nOut), new Uint8Array(nOut), new Uint8Array(nOut)];
  let reg = 0;
  for (let i = 0; i < nOut; i++) {
    const inBit = (i < nIn) ? (inputBits[i] & 1) : 0;
    // Shift in new bit at LSB; old bits move toward MSB.
    reg = ((reg << 1) | inBit) & 0x7F;
    for (let b = 0; b < B; b++) {
      out[b][i] = parity(reg & byGeneratorMatrix[b]);
    }
  }
  return out;
}

function parity(x) {
  x ^= x >> 4;
  x ^= x >> 2;
  x ^= x >> 1;
  return x & 1;
}

/**
 * Apply a puncturing pattern to a 4-branch encoded stream. `puncIdx` is the
 * index into iPuncturingPatterns (e.g., 6 for Mode A QAM4 MSC). The output
 * is a flat bit stream in QSSTV's enqueue order: for each data step, walk
 * through the pattern group; for each PP_TYPE, emit the kept branch bits in
 * B0..B3 order.
 *
 * TODO: verify byte-for-byte against a QSSTV instrumented TX. The pattern
 * traversal order (group × branch) is inferred from the table comments — see
 * docs for what to check.
 */
function applyPuncturing(branches, puncIdx, tailPuncIdx) {
  const nOut = branches[0].length;
  const tail = MC_CONSTRAINT_LENGTH - 1;
  const nIn = nOut - tail;
  const pat = iPuncturingPatterns[puncIdx];
  const tailPat = iPunctPatTailbits[tailPuncIdx];

  const bits = [];
  // Body
  for (let i = 0; i < nIn; i++) {
    const groupIdx = Math.floor(i / pat.groups);
    const withinGroup = i % pat.groups;
    // Each group produces `groups` data steps that share the same pats[]?
    // TODO: clarify. For now we apply pats[0..7] cyclically one per step.
    const ppType = pat.pats[i % 8];
    if (ppType === PP_TYPE_0000) continue;
    const mask = PP_BRANCH_MASK[ppType];
    for (let b = 0; b < 4; b++) {
      if (mask[b]) bits.push(branches[b][i]);
    }
  }
  // Tail
  for (let t = 0; t < tail; t++) {
    const ppType = tailPat[t];
    if (ppType === PP_TYPE_0000) continue;
    const mask = PP_BRANCH_MASK[ppType];
    for (let b = 0; b < 4; b++) {
      if (mask[b]) bits.push(branches[b][nIn + t]);
    }
  }
  return new Uint8Array(bits);
}

/**
 * Bit interleaver — DRM standard uses a PRBS-based bit permutation. TODO:
 * port from QSSTV src/drmtx/common/mlc/BitInterleaver.cpp. For week-1 we
 * pass through (identity).
 */
function bitInterleave(bits) {
  // TODO(week 2): port BitInterleaver::Interleave
  return new Uint8Array(bits);
}

/**
 * Block interleaver — rearranges bits across the conv block. TODO: port
 * from QSSTV src/drmtx/common/mlc/interleaver/BlockInterleaver.cpp.
 */
function blockInterleave(bits) {
  // TODO(week 2): port BlockInterleaver
  return new Uint8Array(bits);
}

/**
 * Symbol interleaver — spans multiple frames (T_0=5 for short interleaver).
 * Maintains state across frames. TODO: port SymbolInterleaver.cpp.
 */
class SymbolInterleaver {
  constructor(mode = 'short') {
    this.T0 = mode === 'short' ? 1 : 5;
    // TODO: back-to-back buffer + permutation tables per DRM §6.2.4.
  }
  push(cells) { return cells; }
  reset() {}
}

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------

if (require.main === module) {
  // Invariant: convolutional output, when fed all zeros, must be all zeros.
  const zeros = convEncode(new Uint8Array(40));
  const allZero = zeros.every(b => b.every(x => x === 0));
  if (!allZero) { console.log('FAIL: conv encode zero input produced nonzero output'); process.exit(1); }
  console.log('OK   conv encode: all-zero in → all-zero out');

  // Invariant: 1 followed by zeros produces the 4 generator polynomials
  // as the first 7 output bits on each branch (impulse response).
  const impulse = new Uint8Array(7);
  impulse[0] = 1;
  const imp = convEncode(impulse);
  // Registers see: 1, 2, 4, 8, 16, 32, 64 (then zeros as the one shifts out).
  // So branch output at step i = parity(2^i & poly[b]).
  let ok = true;
  for (let b = 0; b < 4; b++) {
    for (let i = 0; i < 7; i++) {
      const expected = parity((1 << i) & byGeneratorMatrix[b]);
      if (imp[b][i] !== expected) {
        console.log(`FAIL: impulse b=${b} i=${i} got=${imp[b][i]} want=${expected}`);
        ok = false;
      }
    }
  }
  if (ok) console.log('OK   conv encode: impulse matches generator polynomials');

  // Puncturing smoke test — just make sure it runs and produces some bits.
  const punct = applyPuncturing(imp, 6, 6);
  console.log(`OK   puncturing: produced ${punct.length} bits from 7 input steps + 6 tail`);

  console.log('\nMLC self-tests passed (week-1 scope).');
}

module.exports = {
  convEncode,
  applyPuncturing,
  bitInterleave,
  blockInterleave,
  SymbolInterleaver,
};
