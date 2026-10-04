'use strict';
// JTTY channel coding: 34-bit frame -> 59 four-tone symbols.
//
// Port of the transmit half of WSJT-X lib/jtty/tbcc.f90 (encode_crc12,
// tbcc_encode) with the one shipped profile from jtty_tbcc_code_profile.f90,
// and the sync sequence from jtty_fec_mod.f90, at tag v3.2.0-rc1 (GPL-3.0).
//
//   payload 34 bits + CRC-12 (polynomial 0x80F, MSB-first) = 46 info bits
//   tail-biting rate-1/2 convolutional code, K=10 (memory 9),
//   generators octal 1167 / 1545, Gray tone map 00/01/11/10 -> 0/1/2/3
//   13-symbol sync [0,2,2,3,0,0,3,2,1,3,1,2,0] + 46 coded symbols = 59/frame

const PAYLOAD_BITS = 34;
const CRC_BITS = 12;
const INFO_BITS = PAYLOAD_BITS + CRC_BITS; // 46
const CRC_POLY = 0x80F;
const CRC_TOP = 0x800;
const CRC_MASK = 0xFFF;
const MEMORY_NU = 9;
const STATE_COUNT = 1 << MEMORY_NU;          // 512
const REGISTER_MASK = (1 << (MEMORY_NU + 1)) - 1; // 0x3FF
const G0 = 0o1167; // 0x277
const G1 = 0o1545; // 0x365
const SYNC = Object.freeze([0, 2, 2, 3, 0, 0, 3, 2, 1, 3, 1, 2, 0]);
const SYMBOLS_PER_FRAME = SYNC.length + INFO_BITS; // 59

function parity(v) { let p = 0; while (v) { p ^= v & 1; v >>>= 1; } return p; }

/** 34 payload bits -> 12 CRC bits (encode_crc12). */
function crc12(payload) {
  let reg = 0;
  for (let i = 0; i < PAYLOAD_BITS; i++) {
    reg ^= (payload[i] & 1) << (CRC_BITS - 1);
    reg = (reg & CRC_TOP) ? ((reg << 1) ^ CRC_POLY) : (reg << 1);
    reg &= CRC_MASK;
  }
  const out = new Array(CRC_BITS);
  for (let i = 0; i < CRC_BITS; i++) out[i] = (reg >> (CRC_BITS - 1 - i)) & 1;
  return out;
}

/** 46 info bits -> 46 tone symbols (tbcc_encode without the CRC step). */
function tbccEncodeInfo(info) {
  if (info.length !== INFO_BITS) throw new Error('tbccEncodeInfo: need ' + INFO_BITS + ' bits');
  // Tail-biting: start in the state the register would hold after the last
  // MEMORY_NU bits, so the trellis closes on itself.
  let state = 0;
  for (let t = 0; t < MEMORY_NU; t++) state = ((state << 1) | info[INFO_BITS - MEMORY_NU + t]) & (STATE_COUNT - 1);
  const tones = new Array(INFO_BITS);
  for (let t = 0; t < INFO_BITS; t++) {
    const bit = info[t] & 1;
    const reg = ((state << 1) | bit) & REGISTER_MASK;
    const b0 = parity(reg & G0), b1 = parity(reg & G1);
    state = ((state << 1) | bit) & (STATE_COUNT - 1);
    tones[t] = b0 === 0 ? (b1 === 0 ? 0 : 1) : (b1 === 1 ? 2 : 3);
  }
  return tones;
}

/** A 34-char frame string -> its 46 coded tone symbols. */
function encodeFrame(frame) {
  if (!/^[01]{34}$/.test(frame)) throw new Error('encodeFrame: need a 34-bit frame string');
  const payload = Array.from(frame, (c) => (c === '1' ? 1 : 0));
  return tbccEncodeInfo(payload.concat(crc12(payload)));
}

/** Frames -> the whole transmission's tone sequence (59 per frame). */
function framesToTones(frames) {
  const tones = [];
  for (const f of frames) { tones.push(...SYNC, ...encodeFrame(f)); }
  return tones;
}

module.exports = {
  PAYLOAD_BITS, CRC_BITS, INFO_BITS, CRC_POLY, MEMORY_NU, STATE_COUNT, G0, G1, SYNC, SYMBOLS_PER_FRAME,
  crc12, tbccEncodeInfo, encodeFrame, framesToTones, parity,
};
