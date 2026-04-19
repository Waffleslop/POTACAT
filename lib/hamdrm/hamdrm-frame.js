'use strict';
// ---------------------------------------------------------------------------
// HamDRM frame assembler — takes a FAC bit block + MSC data bytes and
// produces a 15-symbol × 57-carrier grid of complex cells, ready for OFDM.
//
// Port of the MLC-encode + QAM-map + OFDMCellMapping pipeline:
//   1. FAC: conv-encode with puncturing rate ~53/90 (partB pattern through
//      tail), 90 output bits, QAM4 map → 45 cells per frame.
//   2. MSC: conv-encode + puncture (partB pattern + standard tailbit pattern),
//      bit-interleave with t_0=21, 2*iN_mux output bits, QAM4 map → iN_mux
//      cells per frame, then symbol-interleave (short mode: per-frame perm
//      with t_0=5).
//   3. OFDMCellMapping: for each (sym, car), write FAC cells to FAC positions,
//      MSC cells to MSC positions (with dummy-cell fill), pilots to pilot
//      positions, and zero at DC.
// ---------------------------------------------------------------------------

const {
  rTableQAM4,
} = require('./hamdrm-tables');
const {
  buildCellMappingModeA_SO1,
  CM_MSC, CM_FAC,
  _IsMSC, _IsFAC, _IsPilot, _IsDC,
} = require('./hamdrm-cells');
const {
  convEncodePunctured,
  FAC_PUNC_PARAMS,
  mscPuncParams,
} = require('./hamdrm-mlc');
const {
  BitInterleaver,
  SymbolInterleaver,
} = require('./hamdrm-interleavers');

// QAM4 dummy cells for MSC padding (when bits don't exactly fill a frame).
// From OFDMCellMapping.cpp cDummyCells16QAM — QSSTV uses the 16QAM dummy
// constants even for CS_1_SM (comment: "pa0mbo was CParameter::CS_2_SM").
const DUMMY_CELL_16QAM_A = { re:  0.3162277660, im:  0.3162277660 };
const DUMMY_CELL_16QAM_B = { re:  0.3162277660, im: -0.3162277660 };
const DUMMY_CELLS = [DUMMY_CELL_16QAM_A, DUMMY_CELL_16QAM_B];

/**
 * QAM4 map a flat bitstream to complex cells. 2 bits → 1 cell: first bit
 * selects I sign (rTableQAM4[bit][0]), second selects Q sign
 * (rTableQAM4[bit][1]).
 */
function qam4Map(bits) {
  if (bits.length & 1) throw new Error(`QAM4 expects even bit count, got ${bits.length}`);
  const n = bits.length >> 1;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const bI = bits[i * 2];
    const bQ = bits[i * 2 + 1];
    out[i] = { re: rTableQAM4[bI][0], im: rTableQAM4[bQ][1] };
  }
  return out;
}

/**
 * Encode one FAC block (6 bytes / 48 bits) to the 45 FAC complex cells.
 */
function encodeFacCells(facBytes) {
  if (facBytes.length !== 6) throw new Error('FAC block must be 6 bytes');
  const bits = new Uint8Array(48);
  for (let i = 0; i < 6; i++) {
    const b = facBytes[i];
    for (let j = 0; j < 8; j++) bits[i * 8 + j] = (b >> (7 - j)) & 1;
  }
  const encoded = convEncodePunctured(bits, FAC_PUNC_PARAMS);
  if (encoded.length !== 90) throw new Error(`FAC encode produced ${encoded.length} bits (expected 90)`);
  const cells = qam4Map(encoded);
  if (cells.length !== 45) throw new Error(`FAC produced ${cells.length} cells (expected 45)`);
  return cells;
}

/**
 * Encode one MSC logical frame (up to iM[0][1] bits) to iN_mux QAM4 cells.
 * Input is byte-packed; we take the first `iM_B` bits (MSB first) and pad
 * with zeros if the input is too short.
 */
function encodeMscCells(mscBytes, iN_mux) {
  const params = mscPuncParams(iN_mux);
  const iMB = params.iNumInBitsPartB;
  const bits = new Uint8Array(iMB);
  const nAvailable = Math.min(mscBytes.length * 8, iMB);
  for (let i = 0; i < nAvailable; i++) {
    const byteIdx = i >> 3;
    const bitInByte = 7 - (i & 7);
    bits[i] = (mscBytes[byteIdx] >> bitInByte) & 1;
  }
  // Remaining bits stay zero (implicit padding).

  const encoded = convEncodePunctured(bits, params);
  if (encoded.length !== 2 * iN_mux) {
    throw new Error(`MSC encode produced ${encoded.length} bits (expected ${2 * iN_mux})`);
  }

  // Bit interleaver: ix_in1=0, ix_in2=2*iN_mux, t_0=21 (piInterlSequ[0]=1)
  const bi = new BitInterleaver(0, 2 * iN_mux, 21);
  const interleaved = new Uint8Array(encoded);
  bi.interleave(interleaved);

  // QAM4 map
  const cells = qam4Map(interleaved);
  if (cells.length !== iN_mux) {
    throw new Error(`MSC produced ${cells.length} cells (expected ${iN_mux})`);
  }
  return cells;
}

/**
 * Assemble one superframe: 3 frames × 15 symbols × 57 carriers.
 *
 * @param {object} p
 * @param {Uint8Array[]}      p.facBlocks  length 3, each a 6-byte FAC block
 *                                         for frame 0, 1, 2 respectively
 * @param {Uint8Array[]}      p.mscBytes   length 3, each the MSC payload for
 *                                         one frame (will be padded to iM_B bits)
 * @param {object}            p.cellTable  from buildCellMappingModeA_SO1
 * @param {SymbolInterleaver} [p.symbInterl] optional; created if omitted
 * @returns {Array<Array<{re,im}>>}         [45][57] complex cell grid for
 *                                          the full superframe
 */
function assembleSuperframe(p) {
  const { facBlocks, mscBytes, cellTable } = p;
  if (facBlocks.length !== 3) throw new Error('need 3 FAC blocks');
  if (mscBytes.length !== 3) throw new Error('need 3 MSC payloads');

  const iN_mux = cellTable.iNumUsefMSCCellsPerFrame;
  const nSymPerFrame = cellTable.nSymPerFrame;
  const nSymSuperframe = cellTable.nSymSuperframe;
  const nCarriers = cellTable.nCarriers;

  const symbInterl = p.symbInterl || new SymbolInterleaver(iN_mux, 'short');

  // Grid initialised to zero cells.
  const grid = Array.from({ length: nSymSuperframe },
    () => Array.from({ length: nCarriers }, () => ({ re: 0, im: 0 })));

  for (let f = 0; f < 3; f++) {
    const facCells = encodeFacCells(facBlocks[f]);
    const mscCells = encodeMscCells(mscBytes[f], iN_mux);
    const mscInterleaved = symbInterl.processFrame(mscCells);

    // Walk this frame's cells and route into grid positions.
    let facIdx = 0, mscIdx = 0, dummyIdx = 0;
    for (let s = 0; s < nSymPerFrame; s++) {
      const iSym = f * nSymPerFrame + s;
      // Per-symbol counters for MSC/FAC, per OFDMCellMapping::ProcessData.
      let iMSCCounter = 0;
      for (let car = 0; car < nCarriers; car++) {
        const tag = cellTable.map[iSym][car];
        if (_IsMSC(tag)) {
          if (iMSCCounter < cellTable.veciNumMSCSym[iSym]) {
            grid[iSym][car] = mscInterleaved[mscIdx++];
          } else {
            // Dummy cells at the end of the last symbol only (when the
            // MSC stream doesn't exactly tile into iNumUsefMSCCellsPerFrame).
            grid[iSym][car] = DUMMY_CELLS[dummyIdx & 1];
            dummyIdx++;
          }
          iMSCCounter++;
        } else if (_IsFAC(tag)) {
          grid[iSym][car] = facCells[facIdx++];
        } else if (_IsPilot(tag)) {
          grid[iSym][car] = cellTable.pilots[iSym][car];
        } else if (_IsDC(tag)) {
          grid[iSym][car] = { re: 0, im: 0 };
        }
      }
    }
  }

  return grid;
}

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------

if (require.main === module) {
  const { buildFACBlock } = require('./hamdrm-fac');

  const cellTable = buildCellMappingModeA_SO1();
  console.log(`Cell table: ${cellTable.nSymSuperframe} sym × ${cellTable.nCarriers} car, MSC/frame = ${cellTable.iNumUsefMSCCellsPerFrame}`);

  // 3 FAC blocks (one per frame in the superframe)
  const facBlocks = [
    buildFACBlock({ frameIdx: 0, label: 'K3SBP' }),
    buildFACBlock({ frameIdx: 1, label: 'K3SBP' }),
    buildFACBlock({ frameIdx: 2, label: 'K3SBP' }),
  ];

  // Fake MSC payload bytes for each frame — just deterministic garbage.
  const mscByteLenPerFrame = Math.ceil(mscPuncParams(cellTable.iNumUsefMSCCellsPerFrame).iNumInBitsPartB / 8);
  const mscBytes = [];
  for (let f = 0; f < 3; f++) {
    const b = new Uint8Array(mscByteLenPerFrame);
    for (let i = 0; i < b.length; i++) b[i] = (i * 17 + f * 41) & 0xFF;
    mscBytes.push(b);
  }

  const grid = assembleSuperframe({ facBlocks, mscBytes, cellTable });

  // Stats
  let nonZero = 0, totalMag = 0, maxMag = 0;
  let hasNaN = false;
  for (let s = 0; s < grid.length; s++) {
    for (let c = 0; c < grid[s].length; c++) {
      const cell = grid[s][c];
      if (Number.isNaN(cell.re) || Number.isNaN(cell.im)) hasNaN = true;
      const m = Math.hypot(cell.re, cell.im);
      if (m > 0) nonZero++;
      totalMag += m;
      if (m > maxMag) maxMag = m;
    }
  }
  const totalCells = cellTable.nSymSuperframe * cellTable.nCarriers;
  console.log(`Grid stats: ${nonZero}/${totalCells} non-zero cells, max|cell|=${maxMag.toFixed(4)}, avg|cell|=${(totalMag / totalCells).toFixed(4)}`);

  let ok = true;
  if (hasNaN) { console.log('FAIL: NaN in grid'); ok = false; }
  // Non-zero should cover all cells except DC (which is 0 — but SO_1 has no
  // DC in range). So we expect all cells non-zero.
  if (nonZero !== totalCells) {
    console.log(`FAIL: only ${nonZero}/${totalCells} cells non-zero (expected all)`);
    ok = false;
  }
  // QAM4 data cells have magnitude 1.0 (sqrt(0.5^2 + 0.5^2) = 0.7071... wait,
  // rTableQAM4 is already 0.7071, so magnitude = sqrt(0.7071^2 + 0.7071^2) = 1.0)
  // Boosted pilots are magnitude 2. Regular pilots sqrt(2).
  if (maxMag < 1.99 || maxMag > 2.01) {
    console.log(`FAIL: max magnitude ${maxMag} (expected ~2.0 from boosted pilots)`);
    ok = false;
  }
  // Check FAC cell count: 135 cells across superframe should have been placed.
  // Easiest sanity: no FAC-tagged position in the grid is still zero.
  let facZero = 0;
  for (let s = 0; s < grid.length; s++) {
    for (let c = 0; c < grid[s].length; c++) {
      if (_IsFAC(cellTable.map[s][c])) {
        if (grid[s][c].re === 0 && grid[s][c].im === 0) facZero++;
      }
    }
  }
  if (facZero !== 0) {
    console.log(`FAIL: ${facZero} FAC positions remained zero`);
    ok = false;
  }

  if (ok) console.log('\nFrame assembler self-tests passed.');
  process.exit(ok ? 0 : 1);
}

module.exports = {
  qam4Map,
  encodeFacCells,
  encodeMscCells,
  assembleSuperframe,
  DUMMY_CELLS,
};
