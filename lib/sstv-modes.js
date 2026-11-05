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
    // The band-limited Hilbert pair (FL=500, FH=3500) shifts the detected
    // sync rise by a few samples relative to the wide-band model. Re-swept
    // across bars/hstripes/diag patterns: bias=+3 maximises mean PSNR.
    syncBiasSamples: 3,
  },

  // --- Martin M2 ----------------------------------------------------------
  // Half the scan time of M1. Same layout, same VIS prefix, just faster.
  // VIS 40 per the canonical Martin VIS table.
  martin2: {
    name: 'Martin M2',
    visCode: 40,
    width: 320,
    height: 256,
    colorSpace: 'gbr',
    syncMs: 4.862,
    porchMs: 0.572,
    separatorMs: 0.572,
    scanMs: 73.216,
    pixelMs: 73.216 / 320,
    channelOrder: [1, 2, 0],
    syncBiasSamples: 3,
  },

  // --- Martin M3 ----------------------------------------------------------
  // Quarter-resolution variant (160x128). Less common today but still
  // used for quick test images. VIS 36.
  martin3: {
    name: 'Martin M3',
    visCode: 36,
    width: 160,
    height: 128,
    colorSpace: 'gbr',
    syncMs: 4.862,
    porchMs: 0.572,
    separatorMs: 0.572,
    scanMs: 146.432,
    pixelMs: 146.432 / 160,
    channelOrder: [1, 2, 0],
    syncBiasSamples: 3,
  },

  // --- Martin M4 ----------------------------------------------------------
  // Fastest Martin variant. 160x128, half-scan of M3. VIS 32.
  martin4: {
    name: 'Martin M4',
    visCode: 32,
    width: 160,
    height: 128,
    colorSpace: 'gbr',
    syncMs: 4.862,
    porchMs: 0.572,
    separatorMs: 0.572,
    scanMs: 73.216,
    pixelMs: 73.216 / 160,
    channelOrder: [1, 2, 0],
    syncBiasSamples: 3,
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
    // Empirically-fit sync-detection bias. The shared `_findSyncStart`
    // rise-offset model was calibrated against sync pulses preceded by
    // near-silent content (Martin pre-sync, Robot end-of-line). Scottie's
    // sync is preceded by a full B scan which leaves residual energy in
    // the 1200 Hz BPF and pulls the detected rise a few samples late.
    // Sweep on clean SNR shows peak PSNR at -8 samples (+13.7 dB vs 0).
    // Whole scans timed by the clock, not pixel by pixel (each pixel rounded
    // to whole samples made the scan 1.2-2% off the spec line; 2026-11-05).
    exactScan: true,
    syncBiasSamples: -8,
  },

  // --- Scottie DX ---------------------------------------------------------
  // Long-distance variant — very slow line rate gives high SNR margin.
  // 320x256, scanMs 345.6 (≈4.7s/line). Total image: 4 min 36 sec.
  // Same Scottie layout (sep + G + sep + B + sync + porch + R).
  // VIS 76 per the canonical Scottie VIS table.
  scottieDx: {
    name: 'Scottie DX',
    visCode: 76,
    width: 320,
    height: 256,
    colorSpace: 'gbr',
    syncMs: 9.0,
    porchMs: 1.5,
    separatorMs: 1.5,
    scanMs: 345.600,
    pixelMs: 345.600 / 320,
    channelOrder: [1, 2, 0],
    scottieLineOrder: true,
    // Whole scans timed by the clock, not pixel by pixel (each pixel rounded
    // to whole samples made the scan 1.2-2% off the spec line; 2026-11-05).
    exactScan: true,
    syncBiasSamples: -8,
  },

  // --- Scottie S2 ----------------------------------------------------------
  scottie2: {
    name: 'Scottie S2',
    visCode: 56,
    width: 320,
    height: 256,
    colorSpace: 'gbr',
    syncMs: 9.0,
    porchMs: 1.5,
    separatorMs: 1.5,
    scanMs: 88.064,
    pixelMs: 88.064 / 320,     // 0.2752 ms/pixel
    channelOrder: [1, 2, 0],   // G, B, R (same as S1)
    scottieLineOrder: true,
    // Same sync-placement quirk as S1. Bias scales slightly with pixel
    // rate but -8 is within tolerance of the empirical optimum.
    // Whole scans timed by the clock, not pixel by pixel (each pixel rounded
    // to whole samples made the scan 1.2-2% off the spec line; 2026-11-05).
    exactScan: true,
    syncBiasSamples: -8,
  },

  // --- Robot 24 Color ------------------------------------------------------
  // Quarter-resolution YCbCr (160x120). Same half-chroma alternating
  // structure as Robot 36 but smaller image. VIS 4 per the canonical
  // Robot VIS table. Roughly 24 seconds total transmission.
  robot24: {
    name: 'Robot 24',
    visCode: 4,
    width: 160,
    height: 120,
    colorSpace: 'ycbcr',
    syncMs: 6.0,
    porchMs: 2.0,
    yScanMs: 88.0,
    yPixelMs: 88.0 / 160,
    chromScanMs: 44.0,
    chromPixelMs: 44.0 / 80,
    chromWidth: 80,
    chromSepMs: 4.5,
    chromPorchMs: 0.5,
    halfChrom: true,
    syncBiasSamples: -2,
    syncGateMin: 0.2,
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
    // 1900 Hz porch BETWEEN the separator and the chroma (spec, MMSSTV,
    // slowrx): line = 9 + 3 + 88 + 4.5 + 1.5 + 44 = 150 ms. It was a 0.5 ms
    // TRAILING porch, and with each pixel rounded to whole samples the line
    // came to 147 ms: a real 150 ms Robot 36 slid out of step and its chroma
    // was read off sync/porch tones, a green picture (artemisstiles 10-24).
    chromPorchMs: 1.5,
    chromPorchBefore: true,    // the porch above precedes the chroma; scans are exact (not per-pixel rounded)
    // Even lines send Cr (R-Y), odd lines send Cb (B-Y)
    // Chrominance is vertically interpolated at decode
    halfChrom: true,           // alternating Cr/Cb per line
    // Calibrated against the band-limited Hilbert (FL=500/FH=3500); peak
    // mean PSNR across bars/hstripes/diag at bias=-3 (sync detected slightly
    // late because Robot 36's pre-sync chrom region has comparable energy
    // around 1500–2300 Hz, decaying into the 1200 Hz BPF more slowly than
    // the wide-band model assumed).
    // -12 since the porch moved before the chroma (2026-11-05): the sync now
    // follows the chroma scan directly, not a 0.5 ms 1500 Hz porch, so its
    // peak lands later (sweep: -2 = 19.7 dB, -12 = 25.9 dB on the matrix image).
    syncBiasSamples: -12,
    // Decode-quality gate threshold. Robot 36's half-chroma layout means
    // only Y-scan lines register a strong per-line sync; alternating Cr/Cb
    // lines do not, so the observed sync ratio caps near 50% even on a
    // perfect signal. Clean was 47%, AWGN at 15dB drops to ~39%, at 10dB
    // to ~23%. Setting the floor at 0.2 lets degraded-but-locked decodes
    // through — the spread<0.15 check is the actual noise discriminator
    // (verified: pure-noise input never even fires the leader detector,
    // so the gate is only seen for genuine VIS-locked decodes). K3SBP
    // 2026-05-31.
    syncGateMin: 0.2,
  },

  // --- PD modes (Martin Bruchanov) -----------------------------------------
  // PD encodes pairs of lines together: 20 ms long sync pulse, 2.08 ms
  // porch, then four full-width scans — Y(line N), R-Y averaged across
  // lines N and N+1, B-Y averaged across lines N and N+1, Y(line N+1).
  // Vertical chrominance interpolation gives PD its smoother colour
  // gradients vs Robot/Martin/Scottie.
  //
  // Per-mode timings derived from MMSSTV's reference implementation:
  //   PD90:  170.240 ms/scan, 320x256
  //   PD120: 121.600 ms/scan, 640x496
  //   PD160: 195.584 ms/scan, 512x400
  //   PD180: 183.040 ms/scan, 640x496
  //   PD240: 244.480 ms/scan, 640x496
  // Each line-pair = 4 scans + sync(20ms) + porch(2.08ms).
  pd90: {
    name: 'PD-90',
    visCode: 99,
    width: 320,
    height: 256,
    colorSpace: 'pd',
    // PD modes structurally cap at 50% sync (one peak per LINE PAIR
    // = height/2 _finishLine calls vs height denominator). Threshold
    // at 0.25 keeps gate-noise rejection working while admitting
    // genuine PD decodes. K3SBP 2026-05-31.
    syncGateMin: 0.25,
    syncMs: 20,
    porchMs: 2.08,
    scanMs: 170.240,
    pixelMs: 170.240 / 320,
    // Whole scans timed by the clock, not pixel by pixel (each pixel rounded
    // to whole samples made the scan 1.2-2% off the spec line; 2026-11-05).
    exactScan: true,
    syncBiasSamples: 0,
  },
  pd120: {
    name: 'PD-120',
    visCode: 95,
    width: 640,
    height: 496,
    colorSpace: 'pd',
    // PD modes structurally cap at 50% sync (one peak per LINE PAIR
    // = height/2 _finishLine calls vs height denominator). Threshold
    // at 0.25 keeps gate-noise rejection working while admitting
    // genuine PD decodes. K3SBP 2026-05-31.
    syncGateMin: 0.25,
    syncMs: 20,
    porchMs: 2.08,
    scanMs: 121.600,
    pixelMs: 121.600 / 640,
    // Whole scans timed by the clock, not pixel by pixel (each pixel rounded
    // to whole samples made the scan 1.2-2% off the spec line; 2026-11-05).
    exactScan: true,
    syncBiasSamples: 0,
  },
  pd160: {
    name: 'PD-160',
    visCode: 98,
    width: 512,
    height: 400,
    colorSpace: 'pd',
    // PD modes structurally cap at 50% sync (one peak per LINE PAIR
    // = height/2 _finishLine calls vs height denominator). Threshold
    // at 0.25 keeps gate-noise rejection working while admitting
    // genuine PD decodes. K3SBP 2026-05-31.
    syncGateMin: 0.25,
    syncMs: 20,
    porchMs: 2.08,
    scanMs: 195.584,
    pixelMs: 195.584 / 512,
    // Whole scans timed by the clock, not pixel by pixel (each pixel rounded
    // to whole samples made the scan 1.2-2% off the spec line; 2026-11-05).
    exactScan: true,
    syncBiasSamples: 0,
  },
  pd180: {
    name: 'PD-180',
    visCode: 96,
    width: 640,
    height: 496,
    colorSpace: 'pd',
    // PD modes structurally cap at 50% sync (one peak per LINE PAIR
    // = height/2 _finishLine calls vs height denominator). Threshold
    // at 0.25 keeps gate-noise rejection working while admitting
    // genuine PD decodes. K3SBP 2026-05-31.
    syncGateMin: 0.25,
    syncMs: 20,
    porchMs: 2.08,
    scanMs: 183.040,
    pixelMs: 183.040 / 640,
    // Whole scans timed by the clock, not pixel by pixel (each pixel rounded
    // to whole samples made the scan 1.2-2% off the spec line; 2026-11-05).
    exactScan: true,
    syncBiasSamples: 0,
  },
  pd240: {
    name: 'PD-240',
    visCode: 97,
    width: 640,
    height: 496,
    colorSpace: 'pd',
    // PD modes structurally cap at 50% sync (one peak per LINE PAIR
    // = height/2 _finishLine calls vs height denominator). Threshold
    // at 0.25 keeps gate-noise rejection working while admitting
    // genuine PD decodes. K3SBP 2026-05-31.
    syncGateMin: 0.25,
    syncMs: 20,
    porchMs: 2.08,
    scanMs: 244.480,
    pixelMs: 244.480 / 640,
    // Whole scans timed by the clock, not pixel by pixel (each pixel rounded
    // to whole samples made the scan 1.2-2% off the spec line; 2026-11-05).
    exactScan: true,
    syncBiasSamples: 0,
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
    // Separator 4.5 ms (1500 Hz before R-Y, 2300 Hz before B-Y), then a
    // 1.5 ms 1900 Hz porch BEFORE each chroma scan: 9 + 3 + 138 + 2 x (4.5 +
    // 1.5 + 69) = 300 ms, as MMSSTV and slowrx send it. It was a 4.5 ms
    // trailing porch, so each chroma scan started 1.5 ms early (Robot 36's
    // bug, e34671ac) and the line was 298.5 ms after pixel rounding.
    chromSepMs: 4.5,
    chromPorchMs: 1.5,
    chromPorchBefore: true,    // porch precedes each chroma scan; scans are exact
    halfChrom: false,          // full Cr + Cb every line
    // -11 since the porches moved before each chroma scan (2026-11-05): the
    // sync now follows the B-Y scan directly, not a 4.5 ms 1500 Hz porch, so
    // its peak lands later, as on Robot 36 (sweep on the matrix image:
    // +3 = 20.0 dB, -11 = 28.8 dB).
    syncBiasSamples: -11,
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
