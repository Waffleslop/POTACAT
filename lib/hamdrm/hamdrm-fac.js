'use strict';
// ---------------------------------------------------------------------------
// HamDRM FAC (Fast Access Channel) bit packing.
//
// Ported from src/drmtx/common/FAC/FAC.cpp — specifically CFACTransmit::
// FACParam, which is QSSTV's ham-simplified variant of the ETSI DRM FAC:
//
//   Identity                    2 bits (00→11, 01→01, 10→10)
//   SpectrumOccup (1-bit ham)   1 bit
//   InterleaverDepth            1 bit  (SI_LONG=0, SI_SHORT=1)
//   MSC mode                    1 bit  (CS_3_SM=0, CS_1/2_SM=1)
//   Protection level            1 bit  (MSCPrLe.iPartB)
//   Audio/Data flag             1 bit
//     if audio: 2 dummy bits "11" + 1 no-text bit "0"  (3 bits)
//     if data:  2-bit PacketID  + 1-bit ExtMSC         (3 bits)
//   Label chars (3 chars × 7 bits = 21 bits; frame index iframet selects
//              which slice of the 9-char label we send this frame)
//   ---------- 40 payload bits ----------
//   CRC-8 over the first 4 bytes                       8 bits
//   ---------- 48 bits total (NUM_FAC_BITS_PER_BLOCK) ----------
//
// For our Mode A / SO_3 / QAM4 MSC / Protection A / short-interleaver config,
// the settings are fixed — we just need to assemble the bits for a given
// frame index (0..2) and a 9-char label (typically the operator's callsign).
// ---------------------------------------------------------------------------

const {
  NUM_FAC_BITS_PER_BLOCK,
} = require('./hamdrm-tables');
const { crc8FAC } = require('./hamdrm-crc');

// Service flavor — matches CService::eAudDataFlag (we always use data for SSTV)
const SF_AUDIO = 0;
const SF_DATA = 1;

// Spectrum occupancy enum — we only use SO_1 (1-bit ham code); SO_0 reserved.
const SO_0 = 0;
const SO_1 = 1;

// Interleaver modes
const SI_LONG = 0;
const SI_SHORT = 1;

// MSC coding scheme
const CS_1_SM = 0; // 4-QAM SM  (our choice)
const CS_2_SM = 1;
const CS_3_SM = 2;

/**
 * Build a 48-bit FAC block (40 payload + 8 CRC) for the given frame.
 * Returns a Uint8Array of 6 bytes, MSB-first (as the DRM standard transmits).
 *
 * @param {object} p
 * @param {number} p.frameIdx        0, 1, or 2 (position in superframe)
 * @param {number} [p.spectrumOccup] SO_0 or SO_1 (default SO_1)
 * @param {number} [p.interleaver]   SI_LONG or SI_SHORT (default SI_SHORT)
 * @param {number} [p.mscScheme]     CS_1_SM | CS_2_SM | CS_3_SM (default CS_1_SM)
 * @param {number} [p.protLevelB]    0 or 1 (default 0)
 * @param {number} [p.audioDataFlag] SF_AUDIO or SF_DATA (default SF_DATA)
 * @param {number} [p.packetID]      0..3 (data mode only; default 0)
 * @param {string} [p.label]         up to 9 chars; padded with 0x00
 * @returns {Uint8Array}             6-byte FAC block
 */
function buildFACBlock(p) {
  const frameIdx = p.frameIdx | 0;
  if (frameIdx < 0 || frameIdx > 2) {
    throw new Error(`FAC frameIdx out of range: ${frameIdx}`);
  }
  const spectrumOccup = p.spectrumOccup != null ? p.spectrumOccup : SO_1;
  const interleaver = p.interleaver != null ? p.interleaver : SI_SHORT;
  const mscScheme = p.mscScheme != null ? p.mscScheme : CS_1_SM;
  const protLevelB = (p.protLevelB | 0) & 1;
  const audioDataFlag = p.audioDataFlag != null ? p.audioDataFlag : SF_DATA;
  const packetID = (p.packetID | 0) & 3;
  const label = (p.label || '').slice(0, 9);

  // Bit writer — MSB-first into a byte array.
  const bits = new BitEnqueuer(Math.ceil(NUM_FAC_BITS_PER_BLOCK / 8));

  // Identity: 00→11 (3), 01→01 (1), 10→10 (2)
  const idBits = frameIdx === 0 ? 3 : frameIdx === 1 ? 1 : 2;
  bits.enqueue(idBits, 2);

  // Spectrum occupancy — 1 bit in ham variant
  bits.enqueue(spectrumOccup === SO_1 ? 1 : 0, 1);

  // Interleaver depth — 1 bit
  bits.enqueue(interleaver === SI_SHORT ? 1 : 0, 1);

  // MSC mode — CS_3_SM → 0; CS_1_SM or CS_2_SM → 1
  bits.enqueue(mscScheme === CS_3_SM ? 0 : 1, 1);

  // Protection level — 1 bit (MSCPrLe.iPartB)
  bits.enqueue(protLevelB, 1);

  // Audio/Data flag + its 3 trailing bits
  if (audioDataFlag === SF_AUDIO) {
    bits.enqueue(0, 1);
    bits.enqueue(3, 2);   // "11" dummy
    bits.enqueue(0, 1);   // no-text flag
  } else {
    bits.enqueue(1, 1);
    bits.enqueue(packetID, 2);
    bits.enqueue(mscScheme === CS_1_SM ? 1 : 0, 1);
  }

  // Label slice: 3 chars × 7 bits per frame
  for (let i = 3 * frameIdx; i < 3 * frameIdx + 3; i++) {
    let ch = 0;
    if (i < label.length) ch = label.charCodeAt(i) & 0x7F;
    bits.enqueue(ch, 7);
  }

  // Payload lands at 31 bits (2+1+1+1+1+1+3+21). QSSTV sizes the bit vector
  // to the full 48 bits up-front (zero-initialised) and then computes the
  // CRC over the first 5 bytes = 40 bits. The 9-bit gap between payload and
  // the 40-bit boundary is implicitly zero. We match that: pad with zeros to
  // the next byte boundary, then zero-fill through byte 4, then CRC.
  if (bits.bitCount !== 31) {
    throw new Error(`FAC payload bit count mismatch: ${bits.bitCount} (expected 31)`);
  }
  while (bits.bitCount < 40) bits.enqueue(0, 1);

  // CRC-8 is computed over the 5 zero-padded bytes (bits 0..39).
  const first5 = bits.toBytes().slice(0, 5);
  const crc = crc8FAC(first5);
  bits.enqueue(crc, 8);

  if (bits.bitCount !== NUM_FAC_BITS_PER_BLOCK) {
    throw new Error(`FAC block length mismatch: ${bits.bitCount} (expected ${NUM_FAC_BITS_PER_BLOCK})`);
  }

  return bits.toBytes();
}

// ---------------------------------------------------------------------------
// BitEnqueuer — MSB-first bit packer into a Uint8Array. Matches QSSTV's
// CVector<_BINARY>::Enqueue(value, n) byte layout: each value is right-aligned
// in `n` bits and shifted into the stream high-bit-first.
// ---------------------------------------------------------------------------

class BitEnqueuer {
  constructor(maxBytes) {
    this.buf = new Uint8Array(maxBytes);
    this.bitCount = 0;
  }

  enqueue(value, n) {
    if (n < 0 || n > 32) throw new Error(`bad enqueue width: ${n}`);
    for (let i = n - 1; i >= 0; i--) {
      const bit = (value >>> i) & 1;
      const byteIdx = this.bitCount >>> 3;
      const bitInByte = 7 - (this.bitCount & 7);
      if (bit) this.buf[byteIdx] |= (1 << bitInByte);
      this.bitCount++;
    }
  }

  toBytes() {
    const nBytes = (this.bitCount + 7) >>> 3;
    return this.buf.subarray(0, nBytes);
  }
}

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------

if (require.main === module) {
  const block0 = buildFACBlock({ frameIdx: 0, label: 'K3SBP' });
  const block1 = buildFACBlock({ frameIdx: 1, label: 'K3SBP' });
  const block2 = buildFACBlock({ frameIdx: 2, label: 'K3SBP' });
  const hex = (b) => Array.from(b).map(v => v.toString(16).padStart(2, '0')).join(' ');
  console.log('FAC frame 0 (K3SBP):', hex(block0));
  console.log('FAC frame 1 (K3SBP):', hex(block1));
  console.log('FAC frame 2 (K3SBP):', hex(block2));
  if (block0.length !== 6) { console.log('FAIL: block length'); process.exit(1); }
  // Frame identity must differ across the superframe.
  if (block0[0] === block1[0] && block1[0] === block2[0]) {
    console.log('FAIL: identity byte identical across frames');
    process.exit(1);
  }
  console.log('\nFAC self-tests passed.');
}

module.exports = {
  SF_AUDIO, SF_DATA,
  SO_0, SO_1,
  SI_LONG, SI_SHORT,
  CS_1_SM, CS_2_SM, CS_3_SM,
  buildFACBlock,
  BitEnqueuer,
};
