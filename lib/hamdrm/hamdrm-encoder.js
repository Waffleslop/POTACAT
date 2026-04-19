'use strict';
// ---------------------------------------------------------------------------
// HamDRM top-level encoder: JPEG bytes + operator label → 48 kHz audio stream.
//
// Flow:
//   1. motEncode() splits the JPEG into header + body segments (each wrapped
//      in its 16-bit segment header).
//   2. A run-in / body / run-out schedule interleaves headers with body
//      segments. For each schedule entry we produce one MSC data group.
//   3. For each superframe (3 frames × 400 ms = 1.2 s), we send 3 MSC data
//      groups (one per frame) plus the 3-frame rotating FAC. The MSC-per-
//      frame byte budget comes from iM[0][1] = 879 bits = ~109 bytes, so we
//      pick `bytesAvailable = 109` for the MOT partitioner — each data group
//      then fits exactly in one frame's MSC budget.
//   4. assembleSuperframe() → 45×57 complex cell grid.
//   5. modulateSuperframe() → 57600 real audio samples @ 48 kHz.
//
// Concatenate all superframes, normalise, return Float32Array.
// ---------------------------------------------------------------------------

const { motEncode, buildDataGroupFromScheduleEntry } = require('./hamdrm-mot');
const { buildFACBlock } = require('./hamdrm-fac');
const { buildCellMappingModeA_SO1 } = require('./hamdrm-cells');
const { mscPuncParams } = require('./hamdrm-mlc');
const { assembleSuperframe } = require('./hamdrm-frame');
const { modulateSuperframe, normalizeAudio, SYMBOL_BLOCK } = require('./hamdrm-ofdm');

// Default MSC partition size so each data group fits in one frame's budget.
// For Mode A / SO_1 / QAM4 / protection A: iM[0][1] = 879 bits ≈ 109.8 bytes.
// Minus MSC-data-group overhead (MOT_GROUP_OVERHEAD_BYTES = 14 from the MOT
// segmenter) leaves 95 bytes of pure segment payload including its 16-bit
// segment header. We use bytesAvailable = 95 so the body partition ends up
// at 95 - 14 = 81 bytes of actual image data per data group.
//
// NOTE: this is conservative to leave headroom. Real tuning comes from a
// QSSTV-instrumented reference — see potacat-docs/hamdrm-port-notes.md §6.
const DEFAULT_BYTES_AVAILABLE = 95;

/**
 * @param {object} p
 * @param {Uint8Array}  p.jpegBytes   the image payload
 * @param {string}      p.filename    (used for the MOT ContentName)
 * @param {string}      p.label       operator label (≤9 chars, appears in FAC)
 * @param {number}      [p.bytesAvailable] MSC partition size (default 95)
 * @param {number}      [p.repetition]     how many times to cycle the schedule
 * @returns {{ audio: Float32Array, superframes: number, schedule: number[] }}
 */
function encodeImage(p) {
  const {
    jpegBytes, filename, label,
    bytesAvailable = DEFAULT_BYTES_AVAILABLE,
    repetition = 1,
  } = p;

  if (!(jpegBytes instanceof Uint8Array)) throw new Error('jpegBytes must be Uint8Array');
  if (!filename) throw new Error('filename required');

  const cellTable = buildCellMappingModeA_SO1();
  const iN_mux = cellTable.iNumUsefMSCCellsPerFrame;
  const mscBitBudget = mscPuncParams(iN_mux).iNumInBitsPartB;
  const mscByteBudget = Math.ceil(mscBitBudget / 8);

  // MOT partition the image.
  const mot = motEncode({
    filename,
    bodyBytes: jpegBytes,
    format: (filename.split('.').pop() || 'jpg').toLowerCase(),
    bytesAvailable,
    repetition,
  });

  const { scheduleList } = mot;
  const ci = { header: 0, body: 0 };

  // Pad the schedule to a multiple of 3 (3 data groups per superframe).
  // Use the last body segment as the filler.
  const nDataGroups = scheduleList.length;
  const padded = [...scheduleList];
  while (padded.length % 3 !== 0) {
    padded.push(mot.bodySegments.length - 1);
  }
  const nSuperframes = padded.length / 3;

  // Pre-build all data groups so we can check size limits up front.
  const dataGroups = padded.map((entry) => buildDataGroupFromScheduleEntry(entry, mot, ci));
  for (const dg of dataGroups) {
    if (dg.length > mscByteBudget) {
      throw new Error(`MOT data group (${dg.length} bytes) exceeds per-frame MSC budget (${mscByteBudget} bytes)`);
    }
  }

  // Build audio for each superframe.
  const superframeSamples = 45 * SYMBOL_BLOCK;   // 57600
  const audio = new Float32Array(nSuperframes * superframeSamples);
  for (let sf = 0; sf < nSuperframes; sf++) {
    const facBlocks = [
      buildFACBlock({ frameIdx: 0, label }),
      buildFACBlock({ frameIdx: 1, label }),
      buildFACBlock({ frameIdx: 2, label }),
    ];
    const mscBytes = [0, 1, 2].map((f) => {
      // Pad data group up to mscByteBudget with zeros so the encoder sees a
      // consistent bit count.
      const dg = dataGroups[sf * 3 + f];
      const padded = new Uint8Array(mscByteBudget);
      padded.set(dg, 0);
      return padded;
    });
    const grid = assembleSuperframe({ facBlocks, mscBytes, cellTable });
    const sfAudio = modulateSuperframe(grid, cellTable.kMin, cellTable.kMax);
    audio.set(sfAudio, sf * superframeSamples);
  }

  normalizeAudio(audio, 0.8);

  return {
    audio,
    superframes: nSuperframes,
    schedule: scheduleList,
    transportId: mot.transportId,
    iN_mux,
    mscByteBudget,
    sampleRate: 48000,
    durationSec: audio.length / 48000,
  };
}

/**
 * Write a Float32Array to a 16-bit PCM mono WAV file.
 * Small self-contained writer (no external deps).
 */
function writeWav(samples, filePath, sampleRate = 48000) {
  const fs = require('fs');
  const numSamples = samples.length;
  const byteRate = sampleRate * 2;
  const dataSize = numSamples * 2;
  const buf = Buffer.alloc(44 + dataSize);
  let off = 0;
  buf.write('RIFF', off); off += 4;
  buf.writeUInt32LE(36 + dataSize, off); off += 4;
  buf.write('WAVE', off); off += 4;
  buf.write('fmt ', off); off += 4;
  buf.writeUInt32LE(16, off); off += 4;       // PCM fmt chunk size
  buf.writeUInt16LE(1, off); off += 2;        // PCM
  buf.writeUInt16LE(1, off); off += 2;        // mono
  buf.writeUInt32LE(sampleRate, off); off += 4;
  buf.writeUInt32LE(byteRate, off); off += 4;
  buf.writeUInt16LE(2, off); off += 2;        // block align
  buf.writeUInt16LE(16, off); off += 2;       // bits per sample
  buf.write('data', off); off += 4;
  buf.writeUInt32LE(dataSize, off); off += 4;
  for (let i = 0; i < numSamples; i++) {
    let v = Math.max(-1, Math.min(1, samples[i]));
    v = Math.round(v * 0x7FFF);
    buf.writeInt16LE(v, off); off += 2;
  }
  fs.writeFileSync(filePath, buf);
  return filePath;
}

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------

if (require.main === module) {
  // Generate a small fake "JPEG" (just bytes — HamDRM's MOT wraps them raw).
  const fake = new Uint8Array(500);
  for (let i = 0; i < fake.length; i++) fake[i] = (i * 31 + 17) & 0xFF;

  const result = encodeImage({
    jpegBytes: fake,
    filename: 'test.jpg',
    label: 'K3SBP',
    repetition: 1,
  });

  console.log(`iN_mux (MSC cells/frame)   = ${result.iN_mux}`);
  console.log(`MSC byte budget per frame  = ${result.mscByteBudget}`);
  console.log(`TransportID                = 0x${result.transportId.toString(16)}`);
  console.log(`Schedule length (DGs)      = ${result.schedule.length}`);
  console.log(`Superframes emitted        = ${result.superframes}`);
  console.log(`Audio samples              = ${result.audio.length}`);
  console.log(`Duration                   = ${result.durationSec.toFixed(3)} s`);

  let hasNaN = false, peak = 0;
  for (let i = 0; i < result.audio.length; i++) {
    if (Number.isNaN(result.audio[i])) hasNaN = true;
    const a = Math.abs(result.audio[i]);
    if (a > peak) peak = a;
  }
  console.log(`Peak amplitude             = ${peak.toFixed(4)} (normalised to 0.8)`);

  let ok = true;
  if (hasNaN) { console.log('FAIL: NaN'); ok = false; }
  if (Math.abs(peak - 0.8) > 0.02) { console.log(`FAIL: peak ${peak} not ~0.8`); ok = false; }
  if (result.durationSec < 1.0 || result.durationSec > 60) {
    console.log(`FAIL: duration ${result.durationSec}s out of reasonable range`);
    ok = false;
  }

  // Optionally write a WAV for manual verification. Toggle with env var.
  if (process.env.HAMDRM_WAV) {
    const out = writeWav(result.audio, process.env.HAMDRM_WAV);
    console.log(`Wrote ${out}`);
  } else {
    console.log('(Set HAMDRM_WAV=path.wav to dump a file for EasyPal/QSSTV decode.)');
  }

  if (ok) console.log('\nHamDRM encoder end-to-end self-tests passed.');
  process.exit(ok ? 0 : 1);
}

module.exports = {
  DEFAULT_BYTES_AVAILABLE,
  encodeImage,
  writeWav,
};
