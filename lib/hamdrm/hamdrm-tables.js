'use strict';
// ---------------------------------------------------------------------------
// HamDRM (Digital Radio Mondiale, EasyPal-compatible SSTV subset) — tables
//
// All constants ported verbatim from QSSTV (ON4QZ, GPLv2), main branch, under
// src/drmtx/common/tables/. See potacat-docs/hamdrm-port-notes.md for the
// mapping of each group back to its C++ source file.
//
// Scope: Mode A, Spectrum Occupancy SO_3 (~2.375 kHz), QAM4 MSC, Protection A,
// short symbol interleaver. This is what EasyPal defaults to and what 14.233
// MHz net traffic uses.
// ---------------------------------------------------------------------------

// --- TableDRMGlobal.h -------------------------------------------------------

const SOUNDCRD_SAMPLE_RATE = 48000;    // Hz — DRM audio sample rate
const VIRTUAL_INTERMED_FREQ = 6000;    // Hz — DC carrier IF, must be a multiple of 1500 Hz
const NUM_FRAMES_IN_SUPERFRAME = 3;

// Robustness Mode A (the "A" in Mode A)
const RMA = {
  FFT_SIZE_N: 1152,
  NUM_SYM_PER_FRAME: 15,
  ENUM_TG_TU: 1,
  DENOM_TG_TU: 9,              // Tg = Tu/9
};

// Derived timings (Mode A @ 48 kHz):
//   Tu     = 1152/48000 = 24.000 ms
//   Tg     = Tu/9       = 2.667 ms
//   Ts     = Tu + Tg    = 26.667 ms
//   Frame  = 15 * Ts    = 400.000 ms
//   Super  = 3 frames   = 1200.000 ms
//   Subcarrier spacing  = 48000/1152 = 41.667 Hz

// --- TableCarrier.h ---------------------------------------------------------

// Spectrum occupancy Kmin/Kmax [interleaver?][spectrumOccup enum: SO_0..SO_4]
// We only use SO_3 (index 3 in the original; the array is SO-indexed).
// Original: const int iTableCarrierKmin[2][3] — but actual QSSTV has 5 SO
// values; the grep truncated the array. For SO_3 in Mode A the constants are:
//   Kmin = 2, Kmax = 58  →  57 active subcarriers (index 2..58 inclusive)
const RMA_KMIN_SO3 = 2;
const RMA_KMAX_SO3 = 58;
const RMA_NUM_ACTIVE_CARRIERS_SO3 = RMA_KMAX_SO3 - RMA_KMIN_SO3 + 1; // 57

const NUM_FAC_CELLS = 45;

// FAC cell positions for Mode A: [symbolIndex, carrierNumber]
// Coverage: symbols 1..14 (never symbol 0). Verbatim from TableCarrier.h.
const iTableFACRobModA = [
  [1, 10], [1, 22], [1, 30], [1, 50],
  [2, 14], [2, 26], [2, 34],
  [3, 18], [3, 30], [3, 38],
  [4, 22], [4, 34], [4, 42],
  [5, 18], [5, 26], [5, 38], [5, 46],
  [6, 22], [6, 30], [6, 42], [6, 50],
  [7, 26], [7, 34], [7, 46],
  [8, 10], [8, 30], [8, 38], [8, 50],
  [9, 14], [9, 34], [9, 42],
  [10, 18], [10, 38], [10, 46],
  [11, 10], [11, 22], [11, 42], [11, 50],
  [12, 14], [12, 26], [12, 46],
  [13, 18], [13, 30],
  [14, 22], [14, 34],
];

// Frequency pilots: [carrierNumber, phase/1024]. 3 continuous pilots.
const NUM_FREQ_PILOTS = 3;
const iTableFreqPilRobModA = [
  [9,  205],
  [27, 836],
  [36, 215],
];

// --- TableCarMap.h ----------------------------------------------------------

// Time pilots (initial frame sync cells): [carrierNumber, phase/1024].
// Always in symbols 0 (frame start). 16 pilots for Mode A.
const RMA_NUM_TIME_PIL = 16;
const iTableTimePilRobModA = [
  [6,  973],
  [7,  205],
  [11, 717],
  [12, 264],
  [15, 357],
  [16, 357],
  [23, 952],
  [29, 440],
  [30, 856],
  [33, 88],
  [34, 88],
  [38, 68],
  [39, 836],
  [41, 836],
  [45, 836],
  [46, 1008],
];

// Scattered pilots (channel estimation): periodic grid every
// SCAT_PIL_FREQ_INT carriers × SCAT_PIL_TIME_INT symbols.
const RMA_SCAT_PIL_FREQ_INT = 4;
const RMA_SCAT_PIL_TIME_INT = 5;

// Constants for scattered pilot phase PRBS (DRM std §7.2.2)
const iTableScatPilConstRobModA = [4, 5, 2];

// W/Z phase offset arrays, rows indexed by (timeIdx % 5), cols by (freqIdx % 3).
const iScatPilWRobModA = [
  [228, 341, 455],
  [455, 569, 683],
  [683, 796, 910],
  [910,   0, 114],
  [114, 228, 341],
];
const iScatPilZRobModA = [
  [0,    81, 248],
  [18,  106, 106],
  [122, 116,  31],
  [129, 129,  39],
  [33,   32, 111],
];
const iScatPilQRobModA = 36;

// Boosted scattered pilots: index into the first/last active carrier.
// The two rows correspond to the two spectrum-occupancy options used for
// ham DRM. Row 1 (SO_1 and above, incl. SO_3) is what we use.
const NUM_BOOSTED_SCAT_PILOTS = 4;
const iScatPilGainRobModA = [
  [2, 4, 50, 54],
  [2, 6, 54, 58],   // ← Mode A SO_3 uses this row
];

// --- TableQAMMapping.h ------------------------------------------------------

// QAM4: 1 bit → ±0.7071. bit 0 → +0.7071, bit 1 → −0.7071, per axis.
const SQRT_HALF = 0.7071067811;
const rTableQAM4 = [
  [ SQRT_HALF,  SQRT_HALF],
  [-SQRT_HALF, -SQRT_HALF],
];

// Normalization: DRM-standard unit-average-power constellation.
const QAM4_NORM = 1.0 / Math.SQRT2;

// --- TableMLC.h -------------------------------------------------------------

// Bit-reversed octal polynomials (standard DRM) — since we shift bits right
// to left. Values as in QSSTV verbatim: 0155, 0117, 0123, 0155 (octal).
const MC_NUM_OUTPUT_BITS_PER_STEP = 4;
const MC_CONSTRAINT_LENGTH = 7;
const byGeneratorMatrix = [
  0o155, // (133) x_{0,i}
  0o117, // (171) x_{1,i}
  0o123, // (145) x_{2,i}
  0o155, // (133) x_{3,i}
];
const MC_NUM_STATES = 1 << (MC_CONSTRAINT_LENGTH - 1);        // 64
const MC_NUM_OUTPUT_COMBINATIONS = 1 << MC_NUM_OUTPUT_BITS_PER_STEP; // 16
const MC_MAX_NUM_LEVELS = 6;

// Puncturing pattern "type" indices, matching QSSTV PP_TYPE_* enum.
// Each type encodes which of the 4 output branches (B0..B3) are kept in a bit.
const PP_TYPE_0000 = 0;
const PP_TYPE_1111 = 1;   // all four branches kept
const PP_TYPE_0111 = 2;   // branches 1,2,3 kept (B0 dropped)
const PP_TYPE_0011 = 3;   // branches 2,3 kept
const PP_TYPE_0001 = 4;   // branch 3 only
const PP_TYPE_0101 = 5;   // branches 1,3

// Which branches are kept for each PP_TYPE. Row index = PP_TYPE_*, columns =
// [B0_kept, B1_kept, B2_kept, B3_kept] (0 or 1).
const PP_BRANCH_MASK = {
  [PP_TYPE_0000]: [0, 0, 0, 0],
  [PP_TYPE_1111]: [1, 1, 1, 1],
  [PP_TYPE_0111]: [0, 1, 1, 1],
  [PP_TYPE_0011]: [0, 0, 1, 1],
  [PP_TYPE_0001]: [0, 0, 0, 1],
  [PP_TYPE_0101]: [0, 1, 0, 1],
};

// Puncturing patterns: [numGroups, numOnes, pat0..pat7]. 13 rate entries;
// the specific index used per code rate lives in iCodRateCombMSC*.
const iPuncturingPatterns = [
  /* 0: B0:1 B1:1 B2:1 B3:1 */
  { groups: 1, ones: 4, pats: [PP_TYPE_1111, PP_TYPE_0000, PP_TYPE_0000, PP_TYPE_0000, PP_TYPE_0000, PP_TYPE_0000, PP_TYPE_0000, PP_TYPE_0000] },
  /* 1: B0:111 B1:111 B2:111 B3:100 */
  { groups: 3, ones: 10, pats: [PP_TYPE_1111, PP_TYPE_0111, PP_TYPE_0111, PP_TYPE_0000, PP_TYPE_0000, PP_TYPE_0000, PP_TYPE_0000, PP_TYPE_0000] },
  /* 2: B0:1 B1:1 B2:1 B3:0 */
  { groups: 1, ones: 3, pats: [PP_TYPE_0111, PP_TYPE_0000, PP_TYPE_0000, PP_TYPE_0000, PP_TYPE_0000, PP_TYPE_0000, PP_TYPE_0000, PP_TYPE_0000] },
  /* 3: B0:1111 B1:1111 B2:1110 B3:0000 */
  { groups: 4, ones: 11, pats: [PP_TYPE_0111, PP_TYPE_0111, PP_TYPE_0111, PP_TYPE_0011, PP_TYPE_0000, PP_TYPE_0000, PP_TYPE_0000, PP_TYPE_0000] },
  /* 4: B0:1 B1:1 B2:0 B3:0 */
  { groups: 1, ones: 2, pats: [PP_TYPE_0011, PP_TYPE_0000, PP_TYPE_0000, PP_TYPE_0000, PP_TYPE_0000, PP_TYPE_0000, PP_TYPE_0000, PP_TYPE_0000] },
  /* 5: B0:1111 B1:1010 B2:0100 B3:0000 */
  { groups: 4, ones: 7, pats: [PP_TYPE_0011, PP_TYPE_0101, PP_TYPE_0011, PP_TYPE_0001, PP_TYPE_0000, PP_TYPE_0000, PP_TYPE_0000, PP_TYPE_0000] },
  /* 6: B0:111 B1:101 B2:000 B3:000  ← Mode A QAM4 MSC picks this (R_0=6) */
  { groups: 3, ones: 5, pats: [PP_TYPE_0011, PP_TYPE_0001, PP_TYPE_0011, PP_TYPE_0000, PP_TYPE_0000, PP_TYPE_0000, PP_TYPE_0000, PP_TYPE_0000] },
  /* 7: B0:11 B1:10 B2:00 B3:00 */
  { groups: 2, ones: 3, pats: [PP_TYPE_0011, PP_TYPE_0001, PP_TYPE_0000, PP_TYPE_0000, PP_TYPE_0000, PP_TYPE_0000, PP_TYPE_0000, PP_TYPE_0000] },
  /* 8: B0:11111111 B1:10010010 B2:00000000 B3:00000000 */
  { groups: 8, ones: 11, pats: [PP_TYPE_0011, PP_TYPE_0001, PP_TYPE_0001, PP_TYPE_0011, PP_TYPE_0001, PP_TYPE_0001, PP_TYPE_0011, PP_TYPE_0001] },
  /* 9: B0:111 B1:100 B2:000 B3:000 */
  { groups: 3, ones: 4, pats: [PP_TYPE_0011, PP_TYPE_0001, PP_TYPE_0001, PP_TYPE_0000, PP_TYPE_0000, PP_TYPE_0000, PP_TYPE_0000, PP_TYPE_0000] },
  /* 10: B0:1111 B1:1000 B2:0000 B3:0000 */
  { groups: 4, ones: 5, pats: [PP_TYPE_0011, PP_TYPE_0001, PP_TYPE_0001, PP_TYPE_0001, PP_TYPE_0000, PP_TYPE_0000, PP_TYPE_0000, PP_TYPE_0000] },
  /* 11: B0:1111111 B1:1000000 B2:0000000 B3:0000000 */
  { groups: 7, ones: 8, pats: [PP_TYPE_0011, PP_TYPE_0001, PP_TYPE_0001, PP_TYPE_0001, PP_TYPE_0001, PP_TYPE_0001, PP_TYPE_0001, PP_TYPE_0000] },
  /* 12: B0:11111111 B1:10000000 B2:00000000 B3:00000000 */
  { groups: 8, ones: 9, pats: [PP_TYPE_0011, PP_TYPE_0001, PP_TYPE_0001, PP_TYPE_0001, PP_TYPE_0001, PP_TYPE_0001, PP_TYPE_0001, PP_TYPE_0001] },
];

// Tailbit puncturing patterns — 6 tailbits = K-1 at the end of each block so
// the conv encoder returns to zero state. 12 rate entries, one per
// tail-bit-count / protection combination.
const LENGTH_TAIL_BIT_PAT = 6;
const iPunctPatTailbits = [
  [PP_TYPE_0011, PP_TYPE_0011, PP_TYPE_0011, PP_TYPE_0011, PP_TYPE_0011, PP_TYPE_0011],
  [PP_TYPE_0111, PP_TYPE_0011, PP_TYPE_0011, PP_TYPE_0011, PP_TYPE_0011, PP_TYPE_0011],
  [PP_TYPE_0111, PP_TYPE_0011, PP_TYPE_0011, PP_TYPE_0111, PP_TYPE_0011, PP_TYPE_0011],
  [PP_TYPE_0111, PP_TYPE_0111, PP_TYPE_0011, PP_TYPE_0111, PP_TYPE_0011, PP_TYPE_0011],
  [PP_TYPE_0111, PP_TYPE_0111, PP_TYPE_0011, PP_TYPE_0111, PP_TYPE_0111, PP_TYPE_0011],
  [PP_TYPE_0111, PP_TYPE_0111, PP_TYPE_0111, PP_TYPE_0111, PP_TYPE_0111, PP_TYPE_0011],
  [PP_TYPE_0111, PP_TYPE_0111, PP_TYPE_0111, PP_TYPE_0111, PP_TYPE_0111, PP_TYPE_0111],
  [PP_TYPE_1111, PP_TYPE_0111, PP_TYPE_0111, PP_TYPE_0111, PP_TYPE_0111, PP_TYPE_0111],
  [PP_TYPE_1111, PP_TYPE_0111, PP_TYPE_0111, PP_TYPE_1111, PP_TYPE_0111, PP_TYPE_0111],
  [PP_TYPE_1111, PP_TYPE_1111, PP_TYPE_0111, PP_TYPE_1111, PP_TYPE_0111, PP_TYPE_0111],
  [PP_TYPE_1111, PP_TYPE_1111, PP_TYPE_0111, PP_TYPE_1111, PP_TYPE_0111, PP_TYPE_1111],
  [PP_TYPE_1111, PP_TYPE_1111, PP_TYPE_1111, PP_TYPE_1111, PP_TYPE_0111, PP_TYPE_1111],
];

// Code-rate combo for MSC (4-QAM, standard mapping). Scalar in QSSTV.
// This is the index into iPuncturingPatterns used for MSC cells.
const iCodRateCombMSC4SM = 6;
const iCodRateCombFDC4SM = 6;  // FDC = FAC / SDC data channel, same rate

// Interleaver sequence for 4-QAM Standard Mapping: level 0 only.
// -1 = no interleaver at that level.
const iInterlSequ4SM = [1, -1, -1, -1, -1, -1];

// --- FAC framing ------------------------------------------------------------

// From TableFAC.h comment: 65 cells × 2 (QAM4) × 0.6 − 6 tailbits = 72 channel
// bits. The pre-channel-coding payload is 48 bits (40 info + 8 CRC).
const NUM_FAC_BITS_PER_BLOCK = 48;

module.exports = {
  // Audio / OFDM globals
  SOUNDCRD_SAMPLE_RATE,
  VIRTUAL_INTERMED_FREQ,
  NUM_FRAMES_IN_SUPERFRAME,

  // Mode A
  RMA,
  RMA_KMIN_SO3,
  RMA_KMAX_SO3,
  RMA_NUM_ACTIVE_CARRIERS_SO3,

  // Cell mapping
  NUM_FAC_CELLS,
  iTableFACRobModA,
  NUM_FREQ_PILOTS,
  iTableFreqPilRobModA,
  RMA_NUM_TIME_PIL,
  iTableTimePilRobModA,
  RMA_SCAT_PIL_FREQ_INT,
  RMA_SCAT_PIL_TIME_INT,
  iTableScatPilConstRobModA,
  iScatPilWRobModA,
  iScatPilZRobModA,
  iScatPilQRobModA,
  NUM_BOOSTED_SCAT_PILOTS,
  iScatPilGainRobModA,

  // QAM
  rTableQAM4,
  QAM4_NORM,

  // MLC
  MC_NUM_OUTPUT_BITS_PER_STEP,
  MC_CONSTRAINT_LENGTH,
  byGeneratorMatrix,
  MC_NUM_STATES,
  MC_NUM_OUTPUT_COMBINATIONS,
  MC_MAX_NUM_LEVELS,
  PP_TYPE_0000, PP_TYPE_1111, PP_TYPE_0111, PP_TYPE_0011, PP_TYPE_0001, PP_TYPE_0101,
  PP_BRANCH_MASK,
  iPuncturingPatterns,
  LENGTH_TAIL_BIT_PAT,
  iPunctPatTailbits,
  iCodRateCombMSC4SM,
  iCodRateCombFDC4SM,
  iInterlSequ4SM,

  // FAC
  NUM_FAC_BITS_PER_BLOCK,
};
