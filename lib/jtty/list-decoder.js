'use strict';
// JTTY tail-biting convolutional list decoder.
//
// Port of WSJT-X lib/jtty/jtty_tbcc_list_decoder.f90 (the optimized,
// packed-survivor path) and the decode ladder of jtty_tbcc_decoder.f90, at
// tag v3.2.0-rc1 (GPL-3.0). Given the four complex tone correlations for
// each of the 46 coded symbols, it finds the best closed (tail-biting)
// codewords with a wrap-around Viterbi (WAVA) that keeps up to four paths
// per state, scores each distinct closed word on one clean frame, and hands
// at most four hypotheses to the CRC. The ladder tries coherent block
// lengths 1, 2 and 4 (combining phase across symbols), then the
// phase-blind half-symbol energies.
//
// Terms from the reference: P4 = four survivors per state; H4 = at most
// four hypotheses to the CRC; wraps = 2.

const INFO_BITS = 46;
const PAYLOAD_BITS = 34;
const RESERVED_BIT = 33;       // 1-based: payload bit 33 is always 0
const MEMORY_NU = 9;
const STATE_COUNT = 512;
const STATE_MASK = 511;
const REGISTER_MASK = 0x3FF;
const G0 = 0o1167, G1 = 0o1545;
const CRC_POLY = 0x80F, CRC_TOP = 0x800, CRC_MASK = 0xFFF;
const WIDTH = 4;
const WRAPS = 2;
const HYPOTHESES = 4;
const COHERENT_LENGTHS = [1, 2, 4];
const NEG = -Infinity;
const TWO32 = 4294967296;

function popcount(v) { let c = 0; while (v) { v &= v - 1; c++; } return c; }

function transition(state, bit) {
  const reg = ((state << 1) | bit) & REGISTER_MASK;
  const b0 = popcount(reg & G0) & 1, b1 = popcount(reg & G1) & 1;
  return { next: reg & STATE_MASK, tone: 2 * b0 + (b0 ^ b1) };
}

/** Immutable trellis geometry for one coherent block length. */
class Plan {
  constructor(L) {
    this.L = L;
    this.blockCount = Math.ceil(INFO_BITS / L);
    this.nextState = [new Int32Array(STATE_COUNT), new Int32Array(STATE_COUNT)];
    this.tone = [new Int32Array(STATE_COUNT), new Int32Array(STATE_COUNT)];
    for (let bit = 0; bit <= 1; bit++) for (let s = 0; s < STATE_COUNT; s++) {
      const t = transition(s, bit);
      this.nextState[bit][s] = t.next; this.tone[bit][s] = t.tone;
    }
    this.blockStart = new Int32Array(this.blockCount);   // 0-based bit index
    this.blockLength = new Int32Array(this.blockCount);
    this.branchCount = new Int32Array(this.blockCount);
    this.energyOffset = new Int32Array(this.blockCount);
    this.energyCount = 0;
    // branchIdentityLo/Hi[b][word]: the input bits of block b as a 46-bit
    // word with the FIRST info bit as the MSB (bit 45), split into two
    // 32-bit halves (JS bit ops are 32-bit).
    this.branchIdLo = []; this.branchIdHi = [];
    this.branchEnd = []; this.branchSeq = [];
    for (let b = 0; b < this.blockCount; b++) {
      const start = b * L, len = Math.min(L, INFO_BITS - start);
      this.blockStart[b] = start; this.blockLength[b] = len;
      this.branchCount[b] = 1 << len;
      this.energyOffset[b] = this.energyCount;
      this.energyCount += 1 << (2 * len);
      const idLo = new Uint32Array(1 << len), idHi = new Uint32Array(1 << len);
      const end = new Int32Array(STATE_COUNT * (1 << len));
      const seq = new Int32Array(STATE_COUNT * (1 << len));
      for (let word = 0; word < (1 << len); word++) {
        let lo = 0, hi = 0;
        for (let o = 0; o < len; o++) {
          const bit = (word >> (len - 1 - o)) & 1;
          if (!bit) continue;
          const pos = INFO_BITS - 1 - (start + o); // key bit position
          if (pos < 32) lo |= (1 << pos) >>> 0; else hi |= (1 << (pos - 32)) >>> 0;
        }
        idLo[word] = lo >>> 0; idHi[word] = hi >>> 0;
        for (let s = 0; s < STATE_COUNT; s++) {
          let st = s, toneWord = 0;
          for (let o = 0; o < len; o++) {
            const bit = (word >> (len - 1 - o)) & 1;
            toneWord = 4 * toneWord + this.tone[bit][st];
            st = this.nextState[bit][st];
          }
          end[s * (1 << len) + word] = st;
          seq[s * (1 << len) + word] = this.energyOffset[b] + toneWord;
        }
      }
      this.branchIdLo.push(idLo); this.branchIdHi.push(idHi);
      this.branchEnd.push(end); this.branchSeq.push(seq);
    }
    // Does block b contain the reserved (always-zero) bit, and which
    // branch words set it?
    this.pruneBlock = new Uint8Array(this.blockCount);
    this.branchSetsReserved = [];
    const rpos = INFO_BITS - RESERVED_BIT; // key bit position of payload bit 33
    for (let b = 0; b < this.blockCount; b++) {
      const start = this.blockStart[b], len = this.blockLength[b];
      this.pruneBlock[b] = (start < RESERVED_BIT && start + len >= RESERVED_BIT) ? 1 : 0;
      const sets = new Uint8Array(this.branchCount[b]);
      for (let w = 0; w < this.branchCount[b]; w++) {
        sets[w] = rpos < 32 ? ((this.branchIdLo[b][w] >>> rpos) & 1) : ((this.branchIdHi[b][w] >>> (rpos - 32)) & 1);
      }
      this.branchSetsReserved.push(sets);
    }
    // Scratch
    this.energies = new Float64Array(this.energyCount);
    this.prevMetric = new Float64Array(STATE_COUNT * WIDTH);
    this.prevLo = new Uint32Array(STATE_COUNT * WIDTH);
    this.prevHi = new Uint32Array(STATE_COUNT * WIDTH);
    this.prevOrigin = new Int16Array(STATE_COUNT * WIDTH);
    this.prevValid = new Uint8Array(STATE_COUNT * WIDTH);
    this.curMetric = new Float64Array(STATE_COUNT * WIDTH);
    this.curLo = new Uint32Array(STATE_COUNT * WIDTH);
    this.curHi = new Uint32Array(STATE_COUNT * WIDTH);
    this.curOrigin = new Int16Array(STATE_COUNT * WIDTH);
    this.curValid = new Uint8Array(STATE_COUNT * WIDTH);
  }
}

const plans = COHERENT_LENGTHS.map((L) => new Plan(L));

/** precompute_sequence_energies: |coherent sum over the block|^2 / len for every tone sequence. */
function sequenceEnergies(plan, zRe, zIm) {
  const E = plan.energies;
  for (let b = 0; b < plan.blockCount; b++) {
    const start = plan.blockStart[b], len = plan.blockLength[b], count = 1 << (2 * len);
    for (let w = 0; w < count; w++) {
      let sr = 0, si = 0;
      for (let o = 0; o < len; o++) {
        const tone = (w >> (2 * (len - 1 - o))) & 3;
        sr += zRe[tone * INFO_BITS + start + o];
        si += zIm[tone * INFO_BITS + start + o];
      }
      E[plan.energyOffset[b] + w] = (sr * sr + si * si) / len;
    }
  }
}

// Survivor ordering: metric desc, then smaller origin, then smaller bit word.
function precedes(mA, oA, hA, lA, mB, oB, hB, lB) {
  if (mA > mB) return true;
  if (mA < mB) return false;
  if (oA !== oB) return oA < oB;
  if (hA !== hB) return hA < hB;
  return lA < lB;
}

/** advance_packed_survivors for one block, previous -> current. */
function advance(plan, b, prune) {
  const width = WIDTH, L = plan.blockLength[b], branchCount = plan.branchCount[b];
  const stride = STATE_COUNT >> L;
  const E = plan.energies, seq = plan.branchSeq[b], idLo = plan.branchIdLo[b], idHi = plan.branchIdHi[b];
  const pruneBlock = prune && plan.pruneBlock[b];
  const sets = plan.branchSetsReserved[b];
  const pM = plan.prevMetric, pLo = plan.prevLo, pHi = plan.prevHi, pO = plan.prevOrigin, pV = plan.prevValid;
  const cM = plan.curMetric, cLo = plan.curLo, cHi = plan.curHi, cO = plan.curOrigin, cV = plan.curValid;
  const sM = new Float64Array(width), sLo = new Uint32Array(width), sHi = new Uint32Array(width);
  const sO = new Int16Array(width), sV = new Uint8Array(width);
  const dedupe = b === 0;
  for (let end = 0; end < STATE_COUNT; end++) {
    sV.fill(0);
    const word = end & (branchCount - 1);
    const bidLo = idLo[word], bidHi = idHi[word];
    if (!(pruneBlock && sets[word])) {
      for (let state = end >> L; state < STATE_COUNT; state += stride) {
        const bm = E[seq[state * branchCount + word]];
        const base = state * width;
        for (let r = 0; r < width; r++) {
          if (!pV[base + r]) continue;
          const metric = pM[base + r] + bm;
          if (sV[width - 1] && metric < sM[width - 1]) break; // ranks are ordered: no later rank can recover
          const eLo = (pLo[base + r] | bidLo) >>> 0, eHi = (pHi[base + r] | bidHi) >>> 0, eO = pO[base + r];
          // insert_packed_survivor
          let skip = false;
          if (dedupe) {
            for (let slot = 0; slot < width; slot++) {
              if (!sV[slot]) continue;
              if (sLo[slot] === eLo && sHi[slot] === eHi && sO[slot] === eO) {
                if (metric <= sM[slot]) { skip = true; break; }
                for (let k = slot; k < width - 1; k++) { sM[k] = sM[k + 1]; sLo[k] = sLo[k + 1]; sHi[k] = sHi[k + 1]; sO[k] = sO[k + 1]; sV[k] = sV[k + 1]; }
                sV[width - 1] = 0;
                break;
              }
            }
            if (skip) continue;
          }
          let ins = width;
          for (let slot = 0; slot < width; slot++) {
            if (!sV[slot] || precedes(metric, eO, eHi, eLo, sM[slot], sO[slot], sHi[slot], sLo[slot])) { ins = slot; break; }
          }
          if (ins >= width) continue;
          for (let k = width - 1; k > ins; k--) { sM[k] = sM[k - 1]; sLo[k] = sLo[k - 1]; sHi[k] = sHi[k - 1]; sO[k] = sO[k - 1]; sV[k] = sV[k - 1]; }
          sM[ins] = metric; sLo[ins] = eLo; sHi[ins] = eHi; sO[ins] = eO; sV[ins] = 1;
        }
      }
    }
    const base = end * width;
    for (let r = 0; r < width; r++) {
      cV[base + r] = sV[r];
      if (sV[r]) { cM[base + r] = sM[r]; cLo[base + r] = sLo[r]; cHi[base + r] = sHi[r]; cO[base + r] = sO[r]; }
    }
  }
  // swap previous <-> current
  const tM = plan.prevMetric; plan.prevMetric = plan.curMetric; plan.curMetric = tM;
  const tLo = plan.prevLo; plan.prevLo = plan.curLo; plan.curLo = tLo;
  const tHi = plan.prevHi; plan.prevHi = plan.curHi; plan.curHi = tHi;
  const tO = plan.prevOrigin; plan.prevOrigin = plan.curOrigin; plan.curOrigin = tO;
  const tV = plan.prevValid; plan.prevValid = plan.curValid; plan.curValid = tV;
}

/** Key word (first info bit = bit 45) -> bits[0..45] with bits[0] = first info bit. */
function keyToBits(lo, hi) {
  const bits = new Uint8Array(INFO_BITS);
  for (let i = 0; i < INFO_BITS; i++) {
    const pos = INFO_BITS - 1 - i;
    bits[i] = pos < 32 ? (lo >>> pos) & 1 : (hi >>> (pos - 32)) & 1;
  }
  return bits;
}

function crcValid(bits) {
  let reg = 0;
  for (let i = 0; i < INFO_BITS; i++) {
    reg ^= bits[i] << 11;
    reg = (reg & CRC_TOP) ? ((reg << 1) ^ CRC_POLY) : (reg << 1);
    reg &= CRC_MASK;
  }
  return reg === 0;
}

/** score_planned_identity: clean single-frame metric and closure of a word. */
function scoreWord(plan, bits) {
  let start = 0;
  for (let i = INFO_BITS - MEMORY_NU; i < INFO_BITS; i++) start = ((start << 1) | bits[i]) & STATE_MASK;
  let state = start, metric = 0;
  for (let b = 0; b < plan.blockCount; b++) {
    let word = 0;
    for (let o = 0; o < plan.blockLength[b]; o++) word = 2 * word + bits[plan.blockStart[b] + o];
    const idx = state * plan.branchCount[b] + word;
    metric += plan.energies[plan.branchSeq[b][idx]];
    state = plan.branchEnd[b][idx];
  }
  return { metric, closed: state === start };
}

/**
 * jtty_tbcc_list_wava_optimized for one coherent length.
 * @returns ranked candidates [{bits, metric, crcValid, identity}] (≤ HYPOTHESES)
 */
function listWava(plan, zRe, zIm) {
  sequenceEnergies(plan, zRe, zIm);
  // Initial survivors: one per state, metric 0, origin = state.
  plan.prevValid.fill(0);
  for (let s = 0; s < STATE_COUNT; s++) {
    const i = s * WIDTH;
    plan.prevValid[i] = 1; plan.prevMetric[i] = 0; plan.prevLo[i] = 0; plan.prevHi[i] = 0; plan.prevOrigin[i] = s;
  }
  for (let wrap = 0; wrap < WRAPS; wrap++) {
    // reset_packed_frame_identity: a new frame starts at the current state
    for (let s = 0; s < STATE_COUNT; s++) for (let r = 0; r < WIDTH; r++) {
      const i = s * WIDTH + r;
      if (!plan.prevValid[i]) continue;
      plan.prevLo[i] = 0; plan.prevHi[i] = 0; plan.prevOrigin[i] = s;
    }
    for (let b = 0; b < plan.blockCount; b++) advance(plan, b, true);
  }
  // Pool of distinct closed words
  const pool = new Map();
  for (let s = 0; s < STATE_COUNT; s++) for (let r = 0; r < WIDTH; r++) {
    const i = s * WIDTH + r;
    if (!plan.prevValid[i] || plan.prevOrigin[i] !== s) continue;
    const lo = plan.prevLo[i], hi = plan.prevHi[i];
    const identity = hi * TWO32 + lo; // exact: 46 bits
    const metric = plan.prevMetric[i];
    const have = pool.get(identity);
    if (have) {
      if (metric > have.wava || (!(metric < have.wava) && s < have.start)) { have.wava = metric; have.start = s; }
      continue;
    }
    const bits = keyToBits(lo, hi);
    const sc = scoreWord(plan, bits);
    if (!sc.closed) throw new Error('closed TBCC survivor failed clean scoring closure');
    pool.set(identity, { bits, identity, lo, hi, start: s, wava: metric, metric: sc.metric, crcValid: crcValid(bits) });
  }
  const list = [...pool.values()];
  list.sort((a, b) => {
    if (a.metric !== b.metric) return b.metric - a.metric;
    if (a.identity !== b.identity) return a.identity < b.identity ? -1 : 1;
    if (a.start !== b.start) return a.start - b.start;
    return b.wava - a.wava;
  });
  return list.slice(0, HYPOTHESES);
}

/** decode_rung: the first CRC-valid hypothesis, stopping at the all-zero sentinel. */
function acceptFrom(list) {
  for (const c of list) {
    if (!c.crcValid) continue;
    let allZero = true;
    for (let i = 0; i < PAYLOAD_BITS; i++) if (c.bits[i]) { allZero = false; break; }
    if (allZero) return null;
    return c;
  }
  return null;
}

/**
 * The decode ladder. zRe/zIm: Float64Array(4*46), index tone*46+symbol, the
 * full-symbol correlations; hRe: Float64Array(4*46), the half-symbol energy
 * magnitudes (phase-blind, imaginary part zero).
 * @returns { ok, payload: Uint8Array(34), coherentLength, halfSymbol, metric } | { ok:false }
 */
function decode(zRe, zIm, hRe) {
  for (let k = 0; k < plans.length; k++) {
    const c = acceptFrom(listWava(plans[k], zRe, zIm));
    if (c) return { ok: true, payload: c.bits.slice(0, PAYLOAD_BITS), coherentLength: COHERENT_LENGTHS[k], halfSymbol: false, metric: c.metric };
  }
  const zero = new Float64Array(4 * INFO_BITS);
  const c = acceptFrom(listWava(plans[0], hRe, zero));
  if (c) return { ok: true, payload: c.bits.slice(0, PAYLOAD_BITS), coherentLength: 1, halfSymbol: true, metric: c.metric };
  return { ok: false };
}

module.exports = { decode, listWava, plans, transition, crcValid, INFO_BITS, PAYLOAD_BITS, HYPOTHESES, WIDTH, WRAPS };
