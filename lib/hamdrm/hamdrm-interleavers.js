'use strict';
// ---------------------------------------------------------------------------
// HamDRM interleavers — bit interleaver, block interleaver table generator,
// symbol interleaver.
//
// Ported from:
//   - src/drmtx/common/mlc/BitInterleaver.cpp
//   - src/drmtx/common/interleaver/BlockInterleaver.cpp
//   - src/drmtx/common/interleaver/SymbolInterleaver.cpp
//
// Mode A / CS_1_SM (QAM4) configuration:
//   - Bit interleaver uses only "block 2" (ix_in1 = 0, ix_in2 = 2 * iN_mux),
//     with t_0 = 21 (iInterlSequ4SM = [1, ...] → BitInterleaver[1]).
//   - Symbol interleaver: short mode → iD = 1 (no cross-frame interleaving,
//     just per-frame permutation via a table made with t_0 = 5).
// ---------------------------------------------------------------------------

// DRM-standard block interleaver table: a linear-congruential permutation
// over {0..N-1}, with collisions skipped. Verbatim from BlockInterleaver::
// MakeTable. Returns an Int32Array of length N.
function makeBlockInterleaverTable(iFrameSize, it_0) {
  if (iFrameSize <= 0) return new Int32Array(0);
  // s = smallest power of 2 ≥ iFrameSize
  let iHighestOne = iFrameSize;
  let is = 1 << 17;            // i.e. (1<<16)<<1 — matches QSSTV's "1 << (16+1)"
  while ((iHighestOne & (1 << 16)) === 0) {
    iHighestOne = (iHighestOne << 1) >>> 0;
    is >>>= 1;
  }
  const iq = (is >> 2) - 1;    // is / 4 - 1
  const table = new Int32Array(iFrameSize);
  table[0] = 0;
  for (let i = 1; i < iFrameSize; i++) {
    let v = (it_0 * table[i - 1] + iq) % is;
    while (v >= iFrameSize) {
      v = (it_0 * v + iq) % is;
    }
    table[i] = v;
  }
  return table;
}

/**
 * Bit interleaver for MLC. Splits input into two (partA, partB) halves and
 * applies an independent permutation table to each. For CS_1_SM / ham-SSTV
 * partA is empty (ix_in1 = 0) and only partB is permuted.
 *
 * QSSTV initialises with Init(2*iN[0], 2*iN[1], t_0=13 or 21). We use t_0=21
 * since piInterlSequ[0] = 1 → BitInterleaver[1].
 */
class BitInterleaver {
  constructor(ix_in1, ix_in2, t_0) {
    this.ix_in1 = ix_in1;
    this.ix_in2 = ix_in2;
    this.table1 = ix_in1 > 0 ? makeBlockInterleaverTable(ix_in1, t_0) : null;
    this.table2 = makeBlockInterleaverTable(ix_in2, t_0);
  }

  /** In-place interleave. Input length must be ix_in1 + ix_in2. */
  interleave(buf) {
    if (buf.length !== this.ix_in1 + this.ix_in2) {
      throw new Error(`BitInterleaver input size mismatch: ${buf.length} vs ${this.ix_in1 + this.ix_in2}`);
    }
    // Block 1 (partA, typically empty)
    if (this.ix_in1 > 0) {
      const tmp = new Uint8Array(this.ix_in1);
      for (let i = 0; i < this.ix_in1; i++) tmp[i] = buf[this.table1[i]];
      for (let i = 0; i < this.ix_in1; i++) buf[i] = tmp[i];
    }
    // Block 2 (partB)
    const tmp2 = new Uint8Array(this.ix_in2);
    for (let i = 0; i < this.ix_in2; i++) tmp2[i] = buf[this.table2[i] + this.ix_in1];
    for (let i = 0; i < this.ix_in2; i++) buf[i + this.ix_in1] = tmp2[i];
  }
}

/**
 * Symbol interleaver. For short mode (iD=1) this is a per-frame permutation
 * using a block-interleaver table with t_0 = 5. For long mode (iD=5) it
 * spreads cells across 5 frames via a virtual cycle buffer.
 *
 * For our v1 target (EasyPal defaults), Mode A uses SI_SHORT.
 */
class SymbolInterleaver {
  constructor(iN_MUX, mode = 'short') {
    this.iN_MUX = iN_MUX;
    this.iD = mode === 'long' ? 5 : 1;
    this.table = makeBlockInterleaverTable(iN_MUX, 5);
    // Ring buffer of iD frames worth of cells, for long-mode cross-frame.
    // For short mode we allocate a 1-frame buffer.
    this.ring = Array.from({ length: this.iD }, () => new Array(iN_MUX).fill(null));
    this.curIndex = new Int32Array(5);
    for (let i = 0; i < 5; i++) this.curIndex[i] = i;
  }

  /**
   * Process one frame of iN_MUX complex cells. Returns a new array of
   * iN_MUX cells. Maintains internal state across calls (matters for long
   * mode; for short mode it's stateless in effect).
   */
  processFrame(cells) {
    if (cells.length !== this.iN_MUX) {
      throw new Error(`SymbolInterleaver cell count mismatch: ${cells.length} vs ${this.iN_MUX}`);
    }
    // Write into "current" slot (index 0 of the ring, per QSSTV convention)
    const wSlot = this.curIndex[0];
    for (let i = 0; i < this.iN_MUX; i++) this.ring[wSlot][i] = cells[i];

    // Read with permutation + block-wise slot selection
    const out = new Array(this.iN_MUX);
    for (let i = 0; i < this.iN_MUX; i++) {
      const slot = this.curIndex[i % this.iD];
      out[i] = this.ring[slot][this.table[i]];
    }

    // Rotate indices backward (cyclic buffer)
    for (let j = 0; j < this.iD; j++) {
      this.curIndex[j]--;
      if (this.curIndex[j] < 0) this.curIndex[j] = this.iD - 1;
    }
    return out;
  }

  reset() {
    for (let i = 0; i < 5; i++) this.curIndex[i] = i;
    for (let r = 0; r < this.ring.length; r++) {
      for (let i = 0; i < this.iN_MUX; i++) this.ring[r][i] = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------

if (require.main === module) {
  // Block-interleaver table should be a permutation: no repeats, no gaps.
  const N = 90;
  const t = makeBlockInterleaverTable(N, 21);
  const seen = new Set();
  for (let i = 0; i < N; i++) seen.add(t[i]);
  if (seen.size !== N) { console.log('FAIL: not a permutation'); process.exit(1); }
  for (let i = 0; i < N; i++) if (!seen.has(i)) { console.log(`FAIL missing ${i}`); process.exit(1); }
  console.log(`OK   block-interleaver table (N=${N}, t_0=21) is a valid permutation`);

  // Bit interleaver: in-place, input length = ix_in1 + ix_in2. For CS_1_SM
  // FAC, ix_in1 = 0, ix_in2 = 2*45 = 90.
  const bi = new BitInterleaver(0, 90, 21);
  const buf = new Uint8Array(90);
  for (let i = 0; i < 90; i++) buf[i] = i & 1;
  const orig = new Uint8Array(buf);
  bi.interleave(buf);
  const changed = buf.some((v, i) => v !== orig[i]);
  if (!changed) { console.log('FAIL: bit interleaver was identity'); process.exit(1); }
  console.log('OK   bit interleaver permutes input');

  // Symbol interleaver: short mode, per-frame permutation.
  const si = new SymbolInterleaver(45, 'short');
  const cells = Array.from({ length: 45 }, (_, i) => ({ re: i, im: 0 }));
  const out = si.processFrame(cells);
  if (out.length !== 45) { console.log('FAIL si length'); process.exit(1); }
  const outIdx = new Set(out.map(c => c.re));
  if (outIdx.size !== 45) { console.log('FAIL si collision'); process.exit(1); }
  console.log('OK   symbol interleaver (short) is a permutation');

  console.log('\nInterleaver self-tests passed.');
}

module.exports = {
  makeBlockInterleaverTable,
  BitInterleaver,
  SymbolInterleaver,
};
