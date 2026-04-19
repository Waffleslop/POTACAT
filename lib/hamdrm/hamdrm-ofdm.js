'use strict';
// ---------------------------------------------------------------------------
// HamDRM OFDM modulator — turns the superframe cell grid into a 48 kHz audio
// waveform ready to feed to an SSB transmitter.
//
// For Mode A @ 48 kHz:
//   - FFT size N = 1152 (Tu = 24 ms)
//   - Guard interval Tg = Tu/9 = 2.667 ms = 128 samples
//   - Symbol block = 1280 samples
//   - Virtual IF = 6 kHz → FFT bin iIndexDCFreq = 6000 * 1152 / 48000 = 144
//   - Active carriers k ∈ [kMin..kMax] → FFT bins [144+k]
//     For SO_1: bins 146..202, audio freq 6083..8417 Hz
//
// Output: Float32Array of real samples, length = 1280 × nSymSuperframe = 57600
// for a full 1.2-second superframe.
//
// The IFFT output is complex. For an SSB feed we transmit the real part —
// the rig's USB modulator strips the mirror image and puts just our 2.3 kHz
// spectrum on the air.
// ---------------------------------------------------------------------------

const { ifft1152, fft1152 } = require('./hamdrm-fft');

const FFT_SIZE = 1152;
const GUARD_SIZE = 128;           // FFT_SIZE / 9
const SYMBOL_BLOCK = FFT_SIZE + GUARD_SIZE;   // 1280
const IDX_DC = 144;               // VIRTUAL_INTERMED_FREQ * FFT / FS = 6000*1152/48000

/**
 * Modulate a single OFDM symbol.
 *
 * @param {Array<{re,im}>} cells   57 complex cells for carriers kMin..kMax
 * @param {number}         kMin    first active carrier (e.g. 2 for SO_1)
 * @param {number}         kMax    last active carrier (e.g. 58 for SO_1)
 * @param {Float32Array}   out     output buffer slice of length SYMBOL_BLOCK
 */
function modulateSymbol(cells, kMin, kMax, out) {
  if (cells.length !== kMax - kMin + 1) {
    throw new Error(`cell count ${cells.length} != ${kMax - kMin + 1}`);
  }
  const specRe = new Float64Array(FFT_SIZE);
  const specIm = new Float64Array(FFT_SIZE);
  // Place active carriers at their FFT bins.
  for (let k = kMin; k <= kMax; k++) {
    const bin = IDX_DC + k;
    const cell = cells[k - kMin];
    specRe[bin] = cell.re;
    specIm[bin] = cell.im;
  }
  // IFFT → 1152 complex time samples
  ifft1152(specRe, specIm);

  // Cyclic prefix: the last GUARD_SIZE samples of the useful part are copied
  // to the front of the symbol. Output = [tail | useful] = 1280 samples.
  // We take the real part (the USB modulator on the rig strips the conjugate
  // mirror — we're running at an audio IF of 6 kHz).
  for (let n = 0; n < GUARD_SIZE; n++) {
    out[n] = specRe[FFT_SIZE - GUARD_SIZE + n];
  }
  for (let n = 0; n < FFT_SIZE; n++) {
    out[GUARD_SIZE + n] = specRe[n];
  }
}

/**
 * Modulate a full superframe (45 symbols × 1280 = 57600 samples).
 *
 * @param {Array<Array<{re,im}>>} grid       [nSym][nCar] from assembleSuperframe
 * @param {number} kMin
 * @param {number} kMax
 * @returns {Float32Array}                   length = 1280 × grid.length
 */
function modulateSuperframe(grid, kMin, kMax) {
  const nSym = grid.length;
  const out = new Float32Array(nSym * SYMBOL_BLOCK);
  for (let s = 0; s < nSym; s++) {
    const slice = out.subarray(s * SYMBOL_BLOCK, (s + 1) * SYMBOL_BLOCK);
    modulateSymbol(grid[s], kMin, kMax, slice);
  }
  return out;
}

/**
 * Normalise the audio to a target peak (in the ±1.0 range expected by
 * most soundcards / Web Audio). Default headroom keeps the peak at 0.8 so
 * the Flex's ALC has room to breathe.
 */
function normalizeAudio(samples, peak = 0.8) {
  let max = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > max) max = a;
  }
  if (max === 0) return samples;
  const scale = peak / max;
  for (let i = 0; i < samples.length; i++) samples[i] *= scale;
  return samples;
}

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------

if (require.main === module) {
  const { buildCellMappingModeA_SO1 } = require('./hamdrm-cells');
  const { assembleSuperframe } = require('./hamdrm-frame');
  const { buildFACBlock } = require('./hamdrm-fac');
  const { mscPuncParams } = require('./hamdrm-mlc');

  const cellTable = buildCellMappingModeA_SO1();
  const facBlocks = [
    buildFACBlock({ frameIdx: 0, label: 'K3SBP' }),
    buildFACBlock({ frameIdx: 1, label: 'K3SBP' }),
    buildFACBlock({ frameIdx: 2, label: 'K3SBP' }),
  ];
  const mscByteLen = Math.ceil(mscPuncParams(cellTable.iNumUsefMSCCellsPerFrame).iNumInBitsPartB / 8);
  const mscBytes = Array.from({ length: 3 }, (_, f) => {
    const b = new Uint8Array(mscByteLen);
    for (let i = 0; i < b.length; i++) b[i] = (i * 17 + f * 41) & 0xFF;
    return b;
  });
  const grid = assembleSuperframe({ facBlocks, mscBytes, cellTable });

  const audio = modulateSuperframe(grid, cellTable.kMin, cellTable.kMax);
  console.log(`audio length = ${audio.length} samples (expected ${45 * SYMBOL_BLOCK})`);

  // Stats
  let hasNaN = false;
  let peak = 0, rms = 0;
  for (let i = 0; i < audio.length; i++) {
    if (Number.isNaN(audio[i])) hasNaN = true;
    const a = Math.abs(audio[i]);
    if (a > peak) peak = a;
    rms += audio[i] * audio[i];
  }
  rms = Math.sqrt(rms / audio.length);
  console.log(`peak = ${peak.toFixed(4)}, rms = ${rms.toFixed(4)}, peak/rms = ${(peak/rms).toFixed(2)}`);

  let ok = true;
  if (hasNaN) { console.log('FAIL: NaN in audio'); ok = false; }
  if (audio.length !== 45 * SYMBOL_BLOCK) { console.log('FAIL: length mismatch'); ok = false; }
  // OFDM peak/rms (crest factor) is typically 10-15 dB = ratio 3-6.
  if (peak / rms < 2 || peak / rms > 10) {
    console.log(`FAIL: suspicious crest factor ${peak/rms}`);
    ok = false;
  }

  // Spectral sanity: run a forward FFT on one symbol's useful part and
  // verify energy is concentrated in bins 146..202.
  const sym0 = audio.subarray(GUARD_SIZE, GUARD_SIZE + FFT_SIZE);
  const specRe = new Float64Array(FFT_SIZE);
  const specIm = new Float64Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) specRe[i] = sym0[i];
  fft1152(specRe, specIm);

  let activeEnergy = 0, totalEnergy = 0;
  for (let k = 0; k < FFT_SIZE; k++) {
    const e = specRe[k] * specRe[k] + specIm[k] * specIm[k];
    totalEnergy += e;
    if (k >= IDX_DC + cellTable.kMin && k <= IDX_DC + cellTable.kMax) activeEnergy += e;
  }
  const activeFrac = activeEnergy / totalEnergy;
  console.log(`symbol 0 active-bin energy fraction = ${(activeFrac * 100).toFixed(1)}%`);
  if (activeFrac < 0.45) {
    // With real() projection we get the active carriers + their conjugate
    // mirrors at (1152 - bin). So ~50% of energy lands at the mirror.
    console.log('FAIL: active bins have too little energy');
    ok = false;
  }

  if (ok) console.log('\nOFDM modulator self-tests passed.');
  process.exit(ok ? 0 : 1);
}

module.exports = {
  FFT_SIZE,
  GUARD_SIZE,
  SYMBOL_BLOCK,
  IDX_DC,
  modulateSymbol,
  modulateSuperframe,
  normalizeAudio,
};
