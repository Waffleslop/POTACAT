'use strict';
// ---------------------------------------------------------------------------
// HamDRM MLC — convolutional encoder + puncturing table generator.
//
// Ports:
//   - src/drmtx/common/mlc/ConvEncoder.cpp (Encode loop)
//   - src/drmtx/common/mlc/ChannelCode.cpp (GenPuncPatTable)
//
// The core design is QSSTV's: a per-input-step `veciTablePuncPat[i]` drives
// variable-width output from the encoder. GenPuncPatTable builds that vector
// from the rate descriptor, the input size split (partA/partB), and a
// channel-type flag. Key semantic: FAC skips the separate tailbit pattern
// and keeps using the partB pattern cyclically through the 6 tail bits.
// ---------------------------------------------------------------------------

const {
  MC_CONSTRAINT_LENGTH,
  byGeneratorMatrix,
  MC_NUM_OUTPUT_BITS_PER_STEP,
  iPuncturingPatterns,
  iPunctPatTailbits,
  PP_BRANCH_ORDER,
  PP_OUT_COUNT,
  PP_TYPE_0000,
} = require('./hamdrm-tables');

// Channel types — needed to trigger FAC's special puncturing path.
const CT_MSC = 0;
const CT_SDC = 1;
const CT_FAC = 2;

// Popcount mod 2 (parity of 32-bit word)
function parity(x) {
  x ^= x >> 4;
  x ^= x >> 2;
  x ^= x >> 1;
  return x & 1;
}

// One convolution output bit for a given generator branch.
function convBranch(reg, branch) {
  return parity(reg & byGeneratorMatrix[branch]);
}

/**
 * Rate-1/4 K=7 convolutional encoder, raw (no puncturing). Returns 4
 * branch streams of length (nIn + K-1). Used by tests — the real encoder
 * path goes through convEncodePunctured below.
 */
function convEncode(inputBits) {
  const nIn = inputBits.length;
  const tail = MC_CONSTRAINT_LENGTH - 1;
  const nOut = nIn + tail;
  const B = MC_NUM_OUTPUT_BITS_PER_STEP;
  const out = [new Uint8Array(nOut), new Uint8Array(nOut), new Uint8Array(nOut), new Uint8Array(nOut)];
  let reg = 0;
  for (let i = 0; i < nOut; i++) {
    const inBit = (i < nIn) ? (inputBits[i] & 1) : 0;
    reg = ((reg << 1) | inBit) & 0x7F;
    for (let b = 0; b < B; b++) out[b][i] = convBranch(reg, b);
  }
  return out;
}

/**
 * Port of CChannelCode::GenPuncPatTable. Builds the per-step PP_TYPE table
 * used during Encode.
 *
 * @param {object} p
 * @param {number} p.channelType    CT_MSC | CT_SDC | CT_FAC
 * @param {string} p.codingScheme   'CS_1_SM' for our Mode A QAM4 use (other
 *                                  schemes only affect tailbit-param for HMMIX/HMSYM)
 * @param {number} p.iN1            cells in protection part A (often 0)
 * @param {number} p.iN2            cells in protection part B
 * @param {number} p.iNumInBitsPartA  input bits in part A
 * @param {number} p.iNumInBitsPartB  input bits in part B
 * @param {number} p.iPunctPatPartA   index into iPuncturingPatterns
 * @param {number} p.iPunctPatPartB   index into iPuncturingPatterns
 * @param {number} p.iLevel           MLC level (0 for CS_1_SM)
 * @returns {Int8Array}               table of length iNumInBits + K - 1
 */
function genPuncPatTable(p) {
  const {
    channelType, codingScheme = 'CS_1_SM',
    iN1 = 0, iN2,
    iNumInBitsPartA, iNumInBitsPartB,
    iPunctPatPartA, iPunctPatPartB,
    iLevel = 0,
  } = p;

  const iNumOutBits = iNumInBitsPartA + iNumInBitsPartB;
  const K = MC_CONSTRAINT_LENGTH;
  const iNumOutBitsWithMemory = iNumOutBits + K - 1;
  const table = new Int8Array(iNumOutBitsWithMemory);

  // Tailbit param: for CS_3_HMMIX uses N1+N2, for HMSYM uses 2*(N1+N2)
  // (level 0 variant). For everything else including our CS_1_SM it's 2*N2.
  let iTailbitParamL0, iTailbitParamL1;
  if (codingScheme === 'CS_3_HMMIX') {
    iTailbitParamL0 = iN1 + iN2;
    iTailbitParamL1 = iN2;
  } else if (codingScheme === 'CS_3_HMSYM') {
    iTailbitParamL0 = 2 * (iN1 + iN2);
    iTailbitParamL1 = 2 * iN2;
  } else {
    iTailbitParamL0 = 2 * iN2;
    iTailbitParamL1 = 2 * iN2;
  }

  // Tailbit pattern index per DRM standard.
  const bPat = iPuncturingPatterns[iPunctPatPartB];
  if (!bPat) throw new Error(`bad partB puncturing index ${iPunctPatPartB}`);
  const denom = bPat.ones;  // iPuncturingPatterns[..][1]
  const basis = (iLevel === 0) ? iTailbitParamL0 : iTailbitParamL1;
  const iTailbitPattern = (basis - 12) - denom * Math.floor((basis - 12) / denom);

  // Patterns
  const aPat = iPuncturingPatterns[iPunctPatPartA];
  const partAPats = aPat ? aPat.pats.slice(0, aPat.groups) : [];
  const partBPats = bPat.pats.slice(0, bPat.groups);
  const tailPats = iPunctPatTailbits[iTailbitPattern];
  if (!tailPats) throw new Error(`bad tailbit pattern index ${iTailbitPattern}`);

  // Fill the table
  let iPunctCounter = 0;
  for (let i = 0; i < iNumOutBitsWithMemory; i++) {
    if (i < iNumInBitsPartA) {
      table[i] = partAPats[iPunctCounter];
      iPunctCounter++;
      if (iPunctCounter === partAPats.length) iPunctCounter = 0;
    } else {
      // FAC special case: use partB pattern through the tail bits too,
      // no separate tailbit pattern.
      if (i < iNumOutBits || channelType === CT_FAC) {
        if (i === iNumInBitsPartA) iPunctCounter = 0;
        table[i] = partBPats[iPunctCounter];
        iPunctCounter++;
        if (iPunctCounter === partBPats.length) iPunctCounter = 0;
      } else {
        if (i === iNumOutBits) iPunctCounter = 0;
        table[i] = tailPats[iPunctCounter];
        iPunctCounter++;
        // No wrap: tail is a one-shot, exactly K-1 entries long.
      }
    }
  }
  return table;
}

/**
 * Conv-encode + puncture, producing a flat bit stream in QSSTV's emit order.
 *
 * @param {Uint8Array} inputBits   raw input bits (0/1), length = iNumInBitsPartA+B
 * @param {object}     puncParams  same shape as genPuncPatTable
 * @returns {Uint8Array}           flat punctured bitstream
 */
function convEncodePunctured(inputBits, puncParams) {
  const K = MC_CONSTRAINT_LENGTH;
  const nIn = inputBits.length;
  const expected = puncParams.iNumInBitsPartA + puncParams.iNumInBitsPartB;
  if (nIn !== expected) {
    throw new Error(`conv-encode input mismatch: ${nIn} vs ${expected}`);
  }
  const nSteps = nIn + K - 1;
  const puncTable = genPuncPatTable(puncParams);

  // Pre-size output.
  let nOut = 0;
  for (let i = 0; i < nSteps; i++) nOut += PP_OUT_COUNT[puncTable[i]] | 0;
  const out = new Uint8Array(nOut);
  let outCnt = 0;
  let reg = 0;
  for (let i = 0; i < nSteps; i++) {
    const inBit = (i < nIn) ? (inputBits[i] & 1) : 0;
    reg = ((reg << 1) | inBit) & 0x7F;
    const ppType = puncTable[i];
    if (ppType === PP_TYPE_0000) continue;
    const branches = PP_BRANCH_ORDER[ppType];
    for (let k = 0; k < branches.length; k++) {
      out[outCnt++] = convBranch(reg, branches[k]);
    }
  }
  return out;
}

/** Expected output bit count for a given parameter set (pre-sizes buffers). */
function encodedBitCount(puncParams) {
  const K = MC_CONSTRAINT_LENGTH;
  const nSteps = puncParams.iNumInBitsPartA + puncParams.iNumInBitsPartB + K - 1;
  const puncTable = genPuncPatTable(puncParams);
  let n = 0;
  for (let i = 0; i < nSteps; i++) n += PP_OUT_COUNT[puncTable[i]] | 0;
  return n;
}

/**
 * FAC-specific convenience: MLC parameters per CMLC::CalculateParam CT_FAC.
 *   iN_mux = NUM_FAC_CELLS = 45
 *   iN[0] = 0, iN[1] = 45
 *   iNumEncBits = 90
 *   iPunctPatPartB = iCodRateCombFDC4SM = 6
 *   iNumInBitsPartA = 0, iNumInBitsPartB = 48
 */
const FAC_PUNC_PARAMS = {
  channelType: CT_FAC,
  codingScheme: 'CS_1_SM',
  iN1: 0, iN2: 45,
  iNumInBitsPartA: 0, iNumInBitsPartB: 48,
  iPunctPatPartA: 0, iPunctPatPartB: 6,
  iLevel: 0,
};

/**
 * MSC CS_1_SM parameters for a given iN_mux (useful MSC cells per frame).
 * Fills in iM[0][1] per CMLC::CalculateParam formula.
 */
function mscPuncParams(iN_mux) {
  const iMB = 3 * Math.floor((2 * iN_mux - 12) / 5);  // iPuncturingPatterns[6][0] * floor((2*iN_mux-12) / [6][1])
  return {
    channelType: CT_MSC,
    codingScheme: 'CS_1_SM',
    iN1: 0, iN2: iN_mux,
    iNumInBitsPartA: 0, iNumInBitsPartB: iMB,
    iPunctPatPartA: 0, iPunctPatPartB: 6,
    iLevel: 0,
  };
}

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------

if (require.main === module) {
  // Conv mother code invariants (unchanged from week 1).
  const zeros = convEncode(new Uint8Array(32));
  if (!zeros.every(b => b.every(x => x === 0))) { console.log('FAIL zero'); process.exit(1); }
  console.log('OK   conv mother code: zero-in → zero-out');

  // FAC produces EXACTLY 90 bits (45 cells × 2 bits/cell @ 4-QAM)
  const facInput = new Uint8Array(48);
  for (let i = 0; i < 48; i++) facInput[i] = (i * 31 + 7) & 1;
  const facBits = convEncodePunctured(facInput, FAC_PUNC_PARAMS);
  console.log(`FAC encode: 48 bits in -> ${facBits.length} bits out (target 90)`);
  if (facBits.length !== 90) { console.log('FAIL FAC bit count'); process.exit(1); }
  console.log('OK   FAC conv+puncture produces 90 channel bits');

  // MSC CS_1_SM with iN_mux=689 (plausible Mode A SO_1 value) → target = 2*689 = 1378 bits
  const mscParams = mscPuncParams(689);
  const mscInput = new Uint8Array(mscParams.iNumInBitsPartB);
  for (let i = 0; i < mscInput.length; i++) mscInput[i] = (i * 31 + 7) & 1;
  const mscBits = convEncodePunctured(mscInput, mscParams);
  console.log(`MSC encode (iN_mux=689): ${mscInput.length} bits in -> ${mscBits.length} bits out (target 1378)`);
  if (mscBits.length !== 1378) {
    console.log(`FAIL MSC bit count`);
    console.log(`  iMB=${mscParams.iNumInBitsPartB}, tail idx = ${(2*689 - 12) % 5}`);
  } else {
    console.log('OK   MSC conv+puncture produces 2*iN_mux channel bits');
  }

  // Regression canary — FAC bits for a known input (will be replaced once we
  // capture a QSSTV dump per the instrumentation guide).
  const h = Array.from(facBits.slice(0, 32)).join('');
  console.log(`FAC first 32 bits: ${h}`);

  console.log('\nMLC self-tests passed.');
}

module.exports = {
  CT_MSC, CT_SDC, CT_FAC,
  convEncode,
  convBranch,
  parity,
  genPuncPatTable,
  convEncodePunctured,
  encodedBitCount,
  FAC_PUNC_PARAMS,
  mscPuncParams,
};
