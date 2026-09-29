'use strict';
/**
 * SSTV FSK ID — the callsign MMSSTV, QSSTV and others send after a picture.
 *
 * Format, from MMSSTV's own source (LGPL, n5ac/mmsstv), which QSSTV decodes
 * the same way:
 *   Main.cpp  TMmsstv::OutputFSKID()   what is sent
 *   sstv.cpp  CSSTVMOD::WriteFSK()     how one symbol is sent
 *   sstv.cpp  CSSTVDEM::DecodeFSK()    MMSSTV's own decoder
 *   sstv.h    FSKGARD 100, FSKINTVAL 22, FSKSPACE 2100
 *   https://github.com/n5ac/mmsstv  (fskid.txt describes the same frame)
 *   QSSTV src/sstv/visfskid.cpp  https://github.com/ON4QZ/QSSTV
 *
 *   2100 Hz   100 ms   guard ("space")
 *   1900 Hz    22 ms   start bit
 *   symbols, 6 bits each, 22 ms per bit (45.45 baud),
 *       1 = 1900 Hz, 0 = 2100 Hz, LEAST significant bit first
 *   0x2A                       start of call
 *   C1 .. CN                   ASCII - 0x20 (0x20..0x5F -> 0x00..0x3F)
 *   0x01                       end of call
 *   XSUM = C1 ^ C2 ^ ... ^ CN  (6 bits)
 *   2100 Hz   100 ms   guard
 *
 * fskid.txt lists the bits as "B5 ... B0", but WriteFSK sends `c & 0x01`
 * first and shifts right, and both decoders assemble `c = (c >> 1) | bit<<5`,
 * so the wire order is LSB first. fskid.txt also mentions a 1500 Hz 300 ms
 * lead-in that OutputFSKID does not send; the decoder does not need it.
 * MMSSTV may follow the call with a contest number; this decoder stops at
 * the call.
 *
 * Pure: no Electron, no I/O. Feed audio at any rate with push(); it returns
 * the calls decoded in that block. A call is only reported when the whole
 * frame checks out: a steady guard tone, a start bit, the 0x2A header,
 * callsign characters, the 0x01 end marker and a matching checksum.
 */

const GUARD_MIN_MS = 50;      // a guard must hold this long (MMSSTV looks for 50 + 100)
const BIT_MS = 22;
const MAX_CHARS = 16;         // MMSSTV gives up after 17
const DEC_RATE = 4000;        // working rate of the baseband stream
const CENTER_HZ = 2000;       // halfway between the tones
const SHIFT_HZ = 100;         // tones are CENTER -/+ SHIFT (1900 / 2100)
const MAX_OFFSET_HZ = 80;     // mistuning the guard may show
const GUARD_TONE_SHARE = 0.5; // share of the window's energy that must sit on one tone
const EDGE_MS = 6;            // window for spotting the start bit's edge

function isCallsign(s) {
  return /^[A-Z0-9/]{3,12}$/.test(s) && /[0-9]/.test(s) && /[A-Z]/.test(s);
}

class FskIdDecoder {
  constructor({ sampleRate = 48000 } = {}) {
    this.sampleRate = sampleRate;
    this._dec = Math.max(1, Math.round(sampleRate / DEC_RATE));
    this.rate = sampleRate / this._dec;                    // actual working rate
    this._lpfLen = Math.max(1, Math.round(sampleRate * 0.0025)); // 2.5 ms boxcar: first null 400 Hz
    this._bitLen = this.rate * BIT_MS / 1000;
    this._half = Math.max(2, Math.round(this.rate * 0.007));     // 14 ms of each bit is integrated
    this._guardLen = Math.round(this.rate * GUARD_MIN_MS / 1000);
    this._edgeLen = Math.round(this.rate * EDGE_MS / 1000);
    this._scanEvery = Math.max(1, Math.round(this.rate * 0.005)); // look for a guard every 5 ms
    this._ringLen = 2048;
    this.reset();
  }

  reset() {
    this._n = 0;                       // input sample counter
    this._m = 0;                       // decimated sample counter
    // Mixer phasor, advanced by rotation (no trig per sample) and
    // renormalised now and then so rounding can't let it drift in size.
    this._pc = 1; this._ps = 0;
    this._rc = Math.cos(2 * Math.PI * CENTER_HZ / this.sampleRate);
    this._rs = Math.sin(2 * Math.PI * CENTER_HZ / this.sampleRate);
    this._boxRe = new Float64Array(this._lpfLen);
    this._boxIm = new Float64Array(this._lpfLen);
    this._boxI = 0; this._sumRe = 0; this._sumIm = 0;
    this._re = new Float64Array(this._ringLen);
    this._im = new Float64Array(this._ringLen);
    this._pow = new Float64Array(this._ringLen); // |z|^2 per sample
    this._powSum = 0;
    this._toIdle();
  }

  _toIdle() {
    this._state = 'idle';
    this._offset = 0;
    this._t0 = 0;
    this._bit = 0;
    this._sym = 0;
    this._nbits = 0;
    this._chars = [];
    this._xsum = 0;
    this._phaseStage = 'header';
    this._leaveCount = 0;
    // Sliding mark/space correlators for the start-bit edge.
    this._mRe = 0; this._mIm = 0; this._sRe = 0; this._sIm = 0;
    this._edgeFill = 0;
  }

  /** Feed audio. Returns an array of { call } for frames completed in it. */
  push(samples) {
    const out = [];
    const L = this._lpfLen;
    for (let i = 0; i < samples.length; i++) {
      const x = samples[i];
      // Mix to baseband around 2000 Hz and low-pass with a running boxcar.
      const cr = x * this._pc, ci = -x * this._ps;
      const pc = this._pc * this._rc - this._ps * this._rs;
      this._ps = this._ps * this._rc + this._pc * this._rs;
      this._pc = pc;
      if ((this._n & 1023) === 0) { const g = 1 / Math.hypot(this._pc, this._ps); this._pc *= g; this._ps *= g; }
      const k = this._boxI;
      this._sumRe += cr - this._boxRe[k]; this._sumIm += ci - this._boxIm[k];
      this._boxRe[k] = cr; this._boxIm[k] = ci;
      this._boxI = (k + 1) % L;
      this._n++;
      if (this._n % this._dec) continue;
      const r = this._sumRe / L, im = this._sumIm / L;
      this._onBaseband(r, im, out);
    }
    return out;
  }

  _onBaseband(re, im, out) {
    const m = this._m++;
    const j = m % this._ringLen;
    this._re[j] = re; this._im[j] = im;
    const pw = re * re + im * im;
    const oldIdx = m - this._guardLen;
    if (oldIdx >= 0) this._powSum -= this._pow[oldIdx % this._ringLen];
    this._pow[j] = pw; this._powSum += pw;

    if (this._state === 'idle') {
      // Is most of the last 50 ms one steady tone near 2100 Hz? Energy, not
      // the instantaneous frequency: the frequency estimate falls apart in
      // noise long before a matched sum does.
      if (m < this._guardLen || m % this._scanEvery) return;
      const guard = this._findGuard(m);
      if (guard !== null) {
        this._state = 'guard';
        this._offset = guard;
        this._leaveCount = 0;
        this._mRe = this._mIm = this._sRe = this._sIm = 0;
        this._edgeFill = 0;
      }
      return;
    }

    if (this._state === 'guard') {
      // Sliding correlators over the last EDGE_MS at the mark and space tones.
      const wm = 2 * Math.PI * (-SHIFT_HZ + this._offset) / this.rate;
      const ws = 2 * Math.PI * (SHIFT_HZ + this._offset) / this.rate;
      const add = (k, sign) => {
        const jj = ((k % this._ringLen) + this._ringLen) % this._ringLen;
        const r = this._re[jj], i = this._im[jj];
        this._mRe += sign * (r * Math.cos(wm * k) + i * Math.sin(wm * k));
        this._mIm += sign * (i * Math.cos(wm * k) - r * Math.sin(wm * k));
        this._sRe += sign * (r * Math.cos(ws * k) + i * Math.sin(ws * k));
        this._sIm += sign * (i * Math.cos(ws * k) - r * Math.sin(ws * k));
      };
      add(m, 1);
      if (this._edgeFill >= this._edgeLen) add(m - this._edgeLen, -1); else this._edgeFill++;
      if (this._edgeFill < this._edgeLen) return;
      const mark = this._mRe * this._mRe + this._mIm * this._mIm;
      const space = this._sRe * this._sRe + this._sIm * this._sIm;
      if (mark > 2 * space) {
        // The mark fills about 60 % of the window when it first wins by 3 dB;
        // the 2.5 ms boxcar adds half its length of delay.
        this._t0 = m - Math.round(0.6 * this._edgeLen) - Math.round(this._lpfLen / this._dec / 2);
        this._bit = 0;
        this._sym = 0; this._nbits = 0; this._chars = []; this._xsum = 0;
        this._phaseStage = 'header';
        this._state = 'bits';
        return;
      }
      // Neither tone: the guard has gone without a start bit.
      let e = 0;
      for (let k = 0; k < this._edgeLen; k++) e += this._pow[((m - k) % this._ringLen + this._ringLen) % this._ringLen];
      const share = space / (this._edgeLen * e + 1e-20);
      if (share < 0.3) {
        if (++this._leaveCount > this.rate * 0.02) this._toIdle();
      } else this._leaveCount = 0;
      return;
    }

    // 'bits': decide each bit once its window is complete.
    const center = this._t0 + (this._bit + 0.5) * this._bitLen;
    if (m < center + this._half) return;
    const c = Math.round(center);
    const mark = this._tone(c, -SHIFT_HZ + this._offset);   // 1900
    const space = this._tone(c, SHIFT_HZ + this._offset);   // 2100
    const one = mark > space;
    if (this._bit === 0) {
      // The start bit must be clearly the mark tone.
      if (!(mark > 2 * space)) { this._toIdle(); return; }
      this._bit++;
      return;
    }
    this._bit++;
    this._sym = (this._sym >> 1) | (one ? 0x20 : 0);
    if (++this._nbits < 6) return;
    const sym = this._sym;
    this._sym = 0; this._nbits = 0;
    this._onSymbol(sym, out);
  }

  _onSymbol(sym, out) {
    if (this._phaseStage === 'header') {
      if (sym !== 0x2a) { this._toIdle(); return; }
      this._phaseStage = 'call';
      return;
    }
    if (this._phaseStage === 'call') {
      if (sym === 0x01) {
        if (!this._chars.length) { this._toIdle(); return; }
        this._phaseStage = 'xsum';
        return;
      }
      const ch = String.fromCharCode(sym + 0x20);
      if (!/[A-Z0-9/ ]/.test(ch)) { this._toIdle(); return; }
      this._chars.push(ch);
      this._xsum ^= sym;
      if (this._chars.length > MAX_CHARS) this._toIdle();
      return;
    }
    // Checksum.
    const call = this._chars.join('').trim();
    const ok = sym === (this._xsum & 0x3f) && isCallsign(call);
    this._toIdle();
    if (ok) out.push({ call });
  }

  /** |sum z[k] e^{-j w k}|^2 for k in [a, b], by phasor rotation. */
  _corr(a, b, hz) {
    const w = 2 * Math.PI * hz / this.rate;
    let c = Math.cos(w * a), sn = Math.sin(w * a);
    const rc = Math.cos(w), rs = Math.sin(w);
    let sr = 0, si = 0;
    for (let k = a; k <= b; k++) {
      const j = ((k % this._ringLen) + this._ringLen) % this._ringLen;
      const re = this._re[j], im = this._im[j];
      sr += re * c + im * sn;
      si += im * c - re * sn;
      const nc = c * rc - sn * rs; sn = sn * rc + c * rs; c = nc;
    }
    return sr * sr + si * si;
  }

  /** A steady tone near 2100 Hz over the last guard window? Returns its offset in Hz, or null. */
  _findGuard(m) {
    const N = this._guardLen;
    const total = this._powSum * N;
    if (total <= 0) return null;
    let best = 0, bestHz = 0;
    const scan = (hz) => this._corr(m - N + 1, m, hz) / total;
    for (let off = -MAX_OFFSET_HZ; off <= MAX_OFFSET_HZ; off += 10) {
      const e = scan(SHIFT_HZ + off);
      if (e > best) { best = e; bestHz = off; }
    }
    if (best < GUARD_TONE_SHARE) return null;
    // Refine to the nearest 2 Hz around the best bin.
    let fine = bestHz, fineE = best;
    for (let d = -8; d <= 8; d += 2) { const e = scan(SHIFT_HZ + bestHz + d); if (e > fineE) { fineE = e; fine = bestHz + d; } }
    return fine;
  }

  /** Energy of a tone (Hz from CENTER) over the window around sample c. */
  _tone(c, hz) {
    return this._corr(c - this._half, c + this._half, hz);
  }
}

/**
 * The FSK ID waveform for a call, MMSSTV-compatible (for tests and, later,
 * for transmitting one). Returns Float32Array at `sampleRate`.
 * opts.offsetHz shifts both tones (mistuning), opts.amplitude (default 0.5).
 */
function encodeFskId(call, sampleRate = 48000, opts = {}) {
  const off = opts.offsetHz || 0;
  const amp = opts.amplitude == null ? 0.5 : opts.amplitude;
  const text = String(call || '').toUpperCase();
  const syms = [0x2a];
  let xsum = 0;
  for (const ch of text) {
    const c = (ch.charCodeAt(0) - 0x20) & 0x3f;
    syms.push(c); xsum ^= c;
  }
  syms.push(0x01, xsum & 0x3f);
  const segs = [[2100, 100], [1900, BIT_MS]];
  for (const s of syms) {
    let c = s;
    for (let b = 0; b < 6; b++) { segs.push([c & 1 ? 1900 : 2100, BIT_MS]); c >>= 1; }
  }
  segs.push([2100, 100]);
  // Exact cumulative timing, phase-continuous.
  let total = 0;
  for (const [, ms] of segs) total += ms;
  const n = Math.round(sampleRate * total / 1000);
  const out = new Float32Array(n);
  let ph = 0, idx = 0, tMs = 0;
  for (const [hz, ms] of segs) {
    tMs += ms;
    const end = Math.round(sampleRate * tMs / 1000);
    const d = 2 * Math.PI * (hz + off) / sampleRate;
    for (; idx < end; idx++) { out[idx] = amp * Math.sin(ph); ph += d; }
  }
  return out;
}

module.exports = { FskIdDecoder, encodeFskId, isCallsign };
