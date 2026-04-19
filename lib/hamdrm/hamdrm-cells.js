'use strict';
// ---------------------------------------------------------------------------
// HamDRM OFDM cell mapping table — Mode A, Spectrum Occupancy SO_1
// (the default ham DRM profile, Kmin=2, Kmax=58, 57 active carriers).
//
// Port of src/drmtx/common/ofdmcellmapping/CellMappingTable.cpp::MakeTable
// — specifically the transmit side: we compute which cells in the
// 45-symbol × 57-carrier superframe are FAC vs scattered pilot vs time
// pilot vs freq pilot vs MSC, and we compute the complex values for pilot
// cells (with boosted-pilot amplitudes at the spectrum edges).
//
// The scattered-pilot phase formula below is the DRM §8.4.4.3.1 equation,
// transcribed verbatim from CellMappingTable.cpp lines ~293-311. W/Z/Q
// tables come from TableCarMap.h (already ported in hamdrm-tables.js).
// ---------------------------------------------------------------------------

const {
  RMA,
  NUM_FRAMES_IN_SUPERFRAME,
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
  RMA_KMIN_SO3,
  RMA_KMAX_SO3,
} = require('./hamdrm-tables');

// Cell tag flags (from CellMappingTable.h), bit-OR-able.
const CM_DC         = 1;
const CM_MSC        = 2;
const CM_SDC        = 4;
const CM_FAC        = 8;
const CM_TI_PI      = 16;
const CM_FRE_PI     = 32;
const CM_SCAT_PI    = 64;
const CM_BOOSTED_PI = 128;

const _IsMSC      = (a) => !!(a & CM_MSC);
const _IsFAC      = (a) => !!(a & CM_FAC);
const _IsTiPil    = (a) => !!(a & CM_TI_PI);
const _IsFreqPil  = (a) => !!(a & CM_FRE_PI);
const _IsScatPil  = (a) => !!(a & CM_SCAT_PI);
const _IsPilot    = (a) => !!(a & (CM_TI_PI | CM_FRE_PI | CM_SCAT_PI));
const _IsBoosPil  = (a) => !!(a & CM_BOOSTED_PI);
const _IsDC       = (a) => !!(a & CM_DC);
const _IsData     = (a) => !!(a & (CM_MSC | CM_SDC | CM_FAC));

// Python-style modulo (handles negative operands the way QSSTV::mod does).
function mod(x, y) {
  return ((x % y) + y) % y;
}

// Polar → Cartesian with phase normalised to 1024.
function polar2Cart(magnitude, phase1024) {
  const theta = (2 * Math.PI * phase1024) / 1024;
  return { re: magnitude * Math.cos(theta), im: magnitude * Math.sin(theta) };
}

/**
 * Build the superframe cell-mapping table for Mode A / SO_1.
 *
 * Returns:
 *   map[sym][car]       integer tag (CM_* bitmap), 45 × 57
 *   pilots[sym][car]    complex {re, im} for pilot cells; zero elsewhere
 *   veciNumMSCSym[sym]  count of MSC cells in each symbol (length 45)
 *   veciNumFACSym[sym]  count of FAC cells in each symbol (length 45)
 *   iNumUsefMSCCellsPerFrame   MSC cells available per 15-symbol frame
 *   kMin, kMax          active carrier range
 */
function buildCellMappingModeA_SO1() {
  const kMin = RMA_KMIN_SO3;
  const kMax = RMA_KMAX_SO3;
  const nCarriers = kMax - kMin + 1;        // 57
  const nSymPerFrame = RMA.NUM_SYM_PER_FRAME;        // 15
  const nSymSuperframe = nSymPerFrame * NUM_FRAMES_IN_SUPERFRAME; // 45

  const map = Array.from({ length: nSymSuperframe }, () => new Int32Array(nCarriers));
  const pilots = Array.from({ length: nSymSuperframe },
    () => Array.from({ length: nCarriers }, () => ({ re: 0, im: 0 })));

  const scatPilConst = iTableScatPilConstRobModA;   // [4, 5, 2]
  const scatPilColSizeWZ = 3;                        // SIZE_COL_WZ_ROB_MOD_A
  const scatPilW = iScatPilWRobModA;                 // 5×3
  const scatPilZ = iScatPilZRobModA;                 // 5×3
  const scatPilQ = iScatPilQRobModA;                 // 36
  // SO_1 → row 1 of iScatPilGainRobModA: [2, 6, 54, 58]
  const scatPilGain = iScatPilGainRobModA[1];

  let freqPilotsCounter = 0;
  let timePilotsCounter = 0;

  for (let iSym = 0; iSym < nSymSuperframe; iSym++) {
    const iFrameSym = iSym % nSymPerFrame;

    // Reset FAC counter at the start of each frame.
    let iFACCounter = (iFrameSym === 0) ? 0 : -1;
    // We need to track the running FAC counter across carriers WITHIN a
    // symbol — reset once per frame (not per symbol). Hoist below the loop.
    // See below: iFACCounter lives outside the carrier loop, reset on
    // iFrameSym === 0.

    // Scattered pilot counter start-value per DRM §8.4.4.3 eq for gain-ref p.
    let iScatPilotsCounter = Math.floor(
      (kMin - Math.floor(RMA_SCAT_PIL_FREQ_INT / 2 + 0.5)
            - RMA_SCAT_PIL_FREQ_INT * mod(iFrameSym, RMA_SCAT_PIL_TIME_INT))
      / (RMA_SCAT_PIL_FREQ_INT * RMA_SCAT_PIL_TIME_INT)
    );

    for (let iCar = kMin; iCar <= kMax; iCar++) {
      const iCarArrInd = iCar - kMin;

      // Start by tagging as MSC; later rules may override.
      map[iSym][iCarArrInd] = CM_MSC;

      // (We handle FAC below with a persistent counter — the way QSSTV
      // does, walking the FAC table in order and matching positions.)

      // Scattered pilots.
      const scatCar = Math.floor(RMA_SCAT_PIL_FREQ_INT / 2 + 0.5)
                    + RMA_SCAT_PIL_FREQ_INT * mod(iFrameSym, RMA_SCAT_PIL_TIME_INT)
                    + RMA_SCAT_PIL_FREQ_INT * RMA_SCAT_PIL_TIME_INT * iScatPilotsCounter;
      if (iCar === scatCar) {
        iScatPilotsCounter++;
        map[iSym][iCarArrInd] = CM_SCAT_PI;

        // Phase calculation per DRM §8.4.4.3.1
        const yConst = scatPilConst[1];   // 5
        const xConst = scatPilConst[0];   // 4
        const k0 = scatPilConst[2];       // 2

        const inRow = mod(iFrameSym, yConst);
        const imCol = Math.floor(iFrameSym / yConst);
        const ip = Math.floor((iCar - k0 - inRow * xConst) / (xConst * yConst));

        const wVal = scatPilW[inRow][imCol];
        const zVal = scatPilZ[inRow][imCol];
        const phase = mod(4 * zVal + ip * wVal + ip * ip * (1 + iFrameSym) * scatPilQ, 1024);

        // Gain: boosted pilot → 2, regular scattered pilot → sqrt(2).
        let boosted = false;
        for (let i = 0; i < NUM_BOOSTED_SCAT_PILOTS; i++) {
          if (scatPilGain[i] === iCar) boosted = true;
        }
        if (boosted) {
          pilots[iSym][iCarArrInd] = polar2Cart(2, phase);
          map[iSym][iCarArrInd] |= CM_BOOSTED_PI;
        } else {
          pilots[iSym][iCarArrInd] = polar2Cart(Math.SQRT2, phase);
        }
      }

      // Time pilots — only at symbol 0 of each frame.
      if (iFrameSym === 0) {
        if (iTableTimePilRobModA[timePilotsCounter][0] === iCar) {
          if (_IsScatPil(map[iSym][iCarArrInd])) {
            map[iSym][iCarArrInd] |= CM_TI_PI;
          } else {
            map[iSym][iCarArrInd] = CM_TI_PI;
          }
          pilots[iSym][iCarArrInd] = polar2Cart(
            Math.SQRT2,
            iTableTimePilRobModA[timePilotsCounter][1]
          );
          if (timePilotsCounter === RMA_NUM_TIME_PIL - 1) timePilotsCounter = 0;
          else timePilotsCounter++;
        }
      }

      // Frequency pilots — present on fixed carriers in every symbol.
      if (iTableFreqPilRobModA[freqPilotsCounter][0] === iCar) {
        if (_IsTiPil(map[iSym][iCarArrInd]) || _IsScatPil(map[iSym][iCarArrInd])) {
          map[iSym][iCarArrInd] |= CM_FRE_PI;
        } else {
          map[iSym][iCarArrInd] = CM_FRE_PI;
        }
        // No "special case" in Mode A (that's Mode E only).
        pilots[iSym][iCarArrInd] = polar2Cart(
          Math.SQRT2,
          iTableFreqPilRobModA[freqPilotsCounter][1]
        );
        if (freqPilotsCounter === NUM_FREQ_PILOTS - 1) freqPilotsCounter = 0;
        else freqPilotsCounter++;
      }

      // DC carrier (iCar === 0) isn't in our active range for SO_1 (kMin=2).
    }
  }

  // --- FAC tagging --------------------------------------------------------
  // FAC positions are (iFrameSym, iCar) pairs in iTableFACRobModA, walked in
  // order, one pointer reset per frame. QSSTV's loop is nested: while the
  // outer (iSym, iCar) sweep runs, the FAC counter advances whenever the
  // current cell matches the next entry in the table.
  for (let frame = 0; frame < NUM_FRAMES_IN_SUPERFRAME; frame++) {
    let iFACCounter = 0;
    for (let iFrameSym = 0; iFrameSym < RMA.NUM_SYM_PER_FRAME; iFrameSym++) {
      const iSym = frame * RMA.NUM_SYM_PER_FRAME + iFrameSym;
      for (let iCar = kMin; iCar <= kMax; iCar++) {
        const iCarArrInd = iCar - kMin;
        if (iFACCounter < NUM_FAC_CELLS) {
          const [tabSym, tabCar] = iTableFACRobModA[iFACCounter];
          if (tabSym === iFrameSym && tabCar === iCar) {
            map[iSym][iCarArrInd] = CM_FAC;
            iFACCounter++;
          }
        }
      }
    }
  }

  // --- Count cells --------------------------------------------------------
  const veciNumMSCSym = new Int32Array(nSymSuperframe);
  const veciNumFACSym = new Int32Array(nSymSuperframe);
  let iMSCCounter = 0;
  for (let iSym = 0; iSym < nSymSuperframe; iSym++) {
    for (let iCar = 0; iCar < nCarriers; iCar++) {
      if (_IsMSC(map[iSym][iCar])) { veciNumMSCSym[iSym]++; iMSCCounter++; }
      if (_IsFAC(map[iSym][iCar])) veciNumFACSym[iSym]++;
    }
  }
  const iNumUsefMSCCellsPerFrame = Math.floor(iMSCCounter / NUM_FRAMES_IN_SUPERFRAME);
  const dummyCells = iMSCCounter - iNumUsefMSCCellsPerFrame * NUM_FRAMES_IN_SUPERFRAME;
  // Correct last MSC count (the trailing dummy cells get pinned there).
  veciNumMSCSym[nSymSuperframe - 1] -= dummyCells;

  return {
    map,
    pilots,
    veciNumMSCSym,
    veciNumFACSym,
    iNumUsefMSCCellsPerFrame,
    iMSCCounter,
    dummyCells,
    kMin,
    kMax,
    nCarriers,
    nSymPerFrame,
    nSymSuperframe,
  };
}

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------

if (require.main === module) {
  const t = buildCellMappingModeA_SO1();
  console.log(`kMin=${t.kMin} kMax=${t.kMax} nCarriers=${t.nCarriers}`);
  console.log(`nSymSuperframe=${t.nSymSuperframe} nCarriers=${t.nCarriers} total cells=${t.nSymSuperframe * t.nCarriers}`);

  // Count cell types across the superframe.
  let counts = { msc: 0, fac: 0, ti: 0, freq: 0, scat: 0, boost: 0, dc: 0 };
  let anyPilotVal = false;
  for (let s = 0; s < t.nSymSuperframe; s++) {
    for (let c = 0; c < t.nCarriers; c++) {
      const f = t.map[s][c];
      if (_IsMSC(f))     counts.msc++;
      if (_IsFAC(f))     counts.fac++;
      if (_IsTiPil(f))   counts.ti++;
      if (_IsFreqPil(f)) counts.freq++;
      if (_IsScatPil(f)) counts.scat++;
      if (_IsBoosPil(f)) counts.boost++;
      if (_IsDC(f))      counts.dc++;
      if (_IsPilot(f) && (t.pilots[s][c].re !== 0 || t.pilots[s][c].im !== 0)) {
        anyPilotVal = true;
      }
    }
  }
  console.log(`Cell counts:`, counts);
  console.log(`iNumUsefMSCCellsPerFrame = ${t.iNumUsefMSCCellsPerFrame}`);
  console.log(`Dummy MSC cells          = ${t.dummyCells}`);
  console.log(`Pilot values populated   = ${anyPilotVal}`);

  let ok = true;
  // FAC must be exactly 45 per frame × 3 frames = 135
  if (counts.fac !== NUM_FAC_CELLS * NUM_FRAMES_IN_SUPERFRAME) {
    console.log(`FAIL FAC count: ${counts.fac} vs ${NUM_FAC_CELLS * NUM_FRAMES_IN_SUPERFRAME}`);
    ok = false;
  }
  // Time pilots: 16 per frame × 3 frames = 48
  if (counts.ti !== RMA_NUM_TIME_PIL * NUM_FRAMES_IN_SUPERFRAME) {
    console.log(`FAIL time pilot count: ${counts.ti} vs ${RMA_NUM_TIME_PIL * NUM_FRAMES_IN_SUPERFRAME}`);
    ok = false;
  }
  // Freq pilots: 3 × 45 = 135
  if (counts.freq !== NUM_FREQ_PILOTS * t.nSymSuperframe) {
    console.log(`FAIL freq pilot count: ${counts.freq} vs ${NUM_FREQ_PILOTS * t.nSymSuperframe}`);
    ok = false;
  }
  // iNumUsefMSCCellsPerFrame must be reasonable: ~hundreds
  if (t.iNumUsefMSCCellsPerFrame < 500 || t.iNumUsefMSCCellsPerFrame > 750) {
    console.log(`FAIL iNumUsefMSCCellsPerFrame out of plausible range: ${t.iNumUsefMSCCellsPerFrame}`);
    ok = false;
  }
  if (!anyPilotVal) { console.log('FAIL: no pilot values populated'); ok = false; }

  if (ok) console.log('\nCell mapping self-tests passed.');
  process.exit(ok ? 0 : 1);
}

module.exports = {
  CM_DC, CM_MSC, CM_SDC, CM_FAC, CM_TI_PI, CM_FRE_PI, CM_SCAT_PI, CM_BOOSTED_PI,
  _IsMSC, _IsFAC, _IsTiPil, _IsFreqPil, _IsScatPil, _IsPilot, _IsBoosPil, _IsDC, _IsData,
  polar2Cart,
  buildCellMappingModeA_SO1,
};
