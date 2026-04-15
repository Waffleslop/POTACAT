'use strict';

// ---------------------------------------------------------------------------
// SSTV Mode Definitions
// ---------------------------------------------------------------------------
// Each mode defines resolution, timing, color encoding, and VIS code.
// Frequencies: sync 1200 Hz, black 1500 Hz, white 2300 Hz (800 Hz range).
// VIS (Vertical Interval Signaling) identifies the mode at the start of TX.
// ---------------------------------------------------------------------------

const SYNC_FREQ  = 1200;
const BLACK_FREQ = 1500;
const WHITE_FREQ = 2300;
const FREQ_RANGE = WHITE_FREQ - BLACK_FREQ; // 800 Hz

// VIS header timing
const VIS_LEADER_MS   = 300;   // 1900 Hz leader tone
const VIS_BREAK_MS    = 10;    // 1200 Hz start bit
const VIS_BIT_MS      = 30;    // per data/parity bit
const VIS_STOP_MS     = 30;    // 1200 Hz stop bit
const VIS_LEADER_FREQ = 1900;
const VIS_BIT1_FREQ   = 1100;  // logic 1
const VIS_BIT0_FREQ   = 1300;  // logic 0

// ---------------------------------------------------------------------------
// Mode table
// ---------------------------------------------------------------------------
// colorOrder: channel indices into RGBA pixel data (R=0, G=1, B=2)
// For YCrCb modes, encoding handles the conversion internally.
// lineStructure: ordered list of { type, durationMs, freq? } segments per line
// ---------------------------------------------------------------------------

const MODES = {
  // --- Martin M1 -----------------------------------------------------------
  martin1: {
    name: 'Martin M1',
    visCode: 44,
    width: 320,
    height: 256,
    colorSpace: 'gbr',
    // Per-line timing
    syncMs: 4.862,
    porchMs: 0.572,
    separatorMs: 0.572,
    scanMs: 146.432,           // per color channel
    pixelMs: 146.432 / 320,    // 0.4576 ms/pixel
    // Line order: sync -> porch -> G -> sep -> B -> sep -> R -> sep
    channelOrder: [1, 2, 0],   // G, B, R indices into RGBA
  },

  // --- Scottie S1 ----------------------------------------------------------
  scottie1: {
    name: 'Scottie S1',
    visCode: 60,
    width: 320,
    height: 256,
    colorSpace: 'gbr',
    syncMs: 9.0,
    porchMs: 1.5,
    separatorMs: 1.5,
    scanMs: 138.240,
    pixelMs: 138.240 / 320,    // 0.432 ms/pixel
    // Scottie line order differs from Martin:
    // sep -> G -> sep -> B -> sync -> porch -> R
    channelOrder: [1, 2, 0],   // G, B, R
    scottieLineOrder: true,    // flag for different sync placement
  },

  // --- Robot 36 Color ------------------------------------------------------
  robot36: {
    name: 'Robot 36',
    visCode: 8,
    width: 320,
    height: 240,
    colorSpace: 'ycbcr',
    syncMs: 9.0,
    porchMs: 3.0,
    yScanMs: 88.0,             // Y luminance scan
    yPixelMs: 88.0 / 320,      // 0.275 ms/pixel
    chromScanMs: 44.0,         // Cr or Cb scan (half-res, 160 pixels)
    chromPixelMs: 44.0 / 160,  // 0.275 ms/pixel
    chromWidth: 160,
    chromSepMs: 4.5,
    chromPorchMs: 0.5,
    // Even lines send Cr (R-Y), odd lines send Cb (B-Y)
    // Chrominance is vertically interpolated at decode
    halfChrom: true,           // alternating Cr/Cb per line
  },

  // --- Robot 72 Color ------------------------------------------------------
  robot72: {
    name: 'Robot 72',
    visCode: 12,
    width: 320,
    height: 240,
    colorSpace: 'ycbcr',
    syncMs: 9.0,
    porchMs: 3.0,
    yScanMs: 138.0,
    yPixelMs: 138.0 / 320,     // 0.43125 ms/pixel
    chromScanMs: 69.0,         // Cr and Cb each (full 320 pixels)
    chromPixelMs: 69.0 / 320,  // 0.215625 ms/pixel
    chromWidth: 320,
    chromSepMs: 4.5,
    chromPorchMs: 4.5,
    halfChrom: false,          // full Cr + Cb every line
  },
};

// Build reverse VIS lookup: visCode -> mode key
const VIS_TO_MODE = {};
for (const [key, mode] of Object.entries(MODES)) {
  VIS_TO_MODE[mode.visCode] = key;
}

module.exports = {
  MODES,
  VIS_TO_MODE,
  SYNC_FREQ,
  BLACK_FREQ,
  WHITE_FREQ,
  FREQ_RANGE,
  VIS_LEADER_MS,
  VIS_BREAK_MS,
  VIS_BIT_MS,
  VIS_STOP_MS,
  VIS_LEADER_FREQ,
  VIS_BIT1_FREQ,
  VIS_BIT0_FREQ,
};
