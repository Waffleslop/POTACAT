'use strict';
// JTTY receiver: 12 kHz audio in, messages out.
//
// Port of WSJT-X lib/jtty/jtty_mdecode.f90 (the multi-signal decoder
// jtty_mdecode and its message assembly), jtty_peakup.f90,
// jtty_payload_correlators.f90 and subtract_jtty.f90, at tag v3.2.0-rc1
// (GPL-3.0). Phase 2 of docs/jtty-integration-plan.md.
//
// How a step works (every quarter frame, 0.472 s of new audio):
//   1. The last 1.25 frames of audio become a complex analytic signal at
//      6 kHz (ana64a).
//   2. Sync search: for each 2 ms time offset across one quarter frame, the
//      13-symbol sync waveform is correlated against the signal and an 8192-
//      point FFT turns the product into a spectrum; the peak of the smoothed
//      time/frequency surface s0 is a candidate (frequency, start time).
//   3. The QSO window (your TX frequency ± tolerance) is searched first with
//      a fine time/frequency peak-up; then 300 Hz windows across the band.
//   4. A candidate must get > 6 (QSO) or > 8 (band) of the 13 sync tones
//      right at a usable SNR before the 46 payload symbols are correlated
//      and handed to the tail-biting list decoder (list-decoder.js).
//   5. A decoded frame is subtracted from the signal so a weaker one under
//      it can be found on a second pass, then merged into a message: frames
//      continue a message when they arrive one frame period later at the
//      same frequency; the EOM bit completes it.
// Not ported yet: the "retro re-sweep" of the three previous windows after a
// subtraction (jtty_mdecode_step), and the Bluestein narrow-window FFT.

const codec = require('./source-codec');
const fec = require('./fec');
const { ComplexFFT, analyticSignal, shiftFrequency, complexWaveform, db } = require('./dsp');
const listDecoder = require('./list-decoder');

const FS = 12000;
const FS6 = 6000;
const NSPS = 384;                 // samples per symbol at 12 kHz
const NSS = NSPS / 2;             // at 6 kHz
const NSYNC = 13, NCHAN = 46, NFRAME_SYM = 59;
const NFRAME = NFRAME_SYM * NSPS;          // 22656 samples at 12 kHz
const NCHUNK = NFRAME + NFRAME / 4;        // 28320: one frame plus a quarter
const NCHUNK6 = NCHUNK / 2;                // 14160
const NFRAME6 = NFRAME_SYM * NSS;          // 11328
const NTSTEP = NFRAME6 / 4;                // 2832: quarter frame at 6 kHz
const TGRID = 12;                          // sync search time grid, samples at 6 kHz (2 ms)
const NFFT = 8192;                         // sync search FFT
const DF2 = FS6 / NFFT;                    // 0.732 Hz
const NH2 = NFFT / 2;
const DT = 1 / FS6;
const FRAME_PERIOD = NFRAME / FS;          // 1.888 s
const MAXCAND = 100;
const MAX_ACTIVE = 30;
const MAX_RECENT = MAX_ACTIVE * codec.MAX_FRAMES;
const MAX_GAP = 3;
const MAX_RETRO_STEPS = 3;
const HIST_T_TOL = 0.05, HIST_F_TOL = 3.0, NEAR_F_TOL = 12.0, CONT_T_TOL = 0.1;
const SYNC_TONES = fec.SYNC;

// Shared tables at 6 kHz
const SYNC_RE = new Float64Array(NSYNC * NSS), SYNC_IM = new Float64Array(NSYNC * NSS);
{
  // gen_syncwave: tones SYNC[i]*baud, phase continuous
  let phi = 0, k = 0;
  for (let i = 0; i < NSYNC; i++) {
    const dphi = 2 * Math.PI * (FS6 / NSS) * SYNC_TONES[i] / FS6;
    for (let j = 0; j < NSS; j++) { SYNC_RE[k] = Math.cos(phi); SYNC_IM[k] = Math.sin(phi); k++; phi += dphi; }
  }
}
const TONE_RE = [], TONE_IM = [];
for (let t = 0; t < 4; t++) {
  const re = new Float64Array(NSS), im = new Float64Array(NSS);
  let phi = 0; const dphi = 2 * Math.PI * t / NSS;
  for (let j = 0; j < NSS; j++) { re[j] = Math.cos(phi); im[j] = Math.sin(phi); phi += dphi; }
  TONE_RE.push(re); TONE_IM.push(im);
}
const SUB_WINDOW = (() => { // subtract_jtty's cos^2 smoothing window, 2*NSS+1 taps, unit sum
  const nfilt = 2 * NSS, w = new Float64Array(nfilt + 1);
  let sum = 0;
  for (let j = -nfilt / 2; j <= nfilt / 2; j++) { w[j + nfilt / 2] = Math.cos(Math.PI * j / nfilt) ** 2; sum += w[j + nfilt / 2]; }
  for (let i = 0; i < w.length; i++) w[i] /= sum;
  return w;
})();

/** One decoded frame's text the way the assembler wants it ('~' for TEXT5 spaces). */
function unpackFrameForAssembly(frame) {
  const u = codec.unpackAtom(frame);
  if (!u) return null;
  const r = codec.renderAtom(u.atom);
  if (r === null) return null;
  if (u.atom.kind === codec.ATOM.TEXT5) return { text: r.replace(/ /g, '~'), trailingSep: false, eom: u.eom };
  return { text: r, trailingSep: true, eom: u.eom };
}

function displayText(decoded) {
  let msg = decoded.replace(/~~~~~/g, ' ... ').replace(/~/g, ' ');
  if (msg[0] === ' ') msg = msg.slice(1);
  return msg.replace(/ +$/, '');
}

class JttyDecoder {
  /**
   * @param {object} [o] { qsoFreq=1500, qsoTol=50, bandLo=200, bandHi=2800, smin=4.6, bandWindows=true }
   */
  constructor(o) {
    const opts = o || {};
    this.qsoFreq = opts.qsoFreq == null ? 1500 : opts.qsoFreq;
    this.qsoTol = opts.qsoTol == null ? 50 : opts.qsoTol;
    this.bandLo = opts.bandLo == null ? 200 : opts.bandLo;
    this.bandHi = opts.bandHi == null ? 2800 : opts.bandHi;
    this.bandWindows = opts.bandWindows !== false;
    this.smin = opts.smin == null ? 4.6 : opts.smin;
    this.stats = { steps: 0, ms: 0, candidates: 0, decodes: 0 };
    this._s0 = new Float32Array((NH2 + 1) * (NTSTEP / TGRID + 1));
    this._mask0 = new Uint8Array(this._s0.length);
    this._fftRe = new Float64Array(NFFT); this._fftIm = new Float64Array(NFFT);
    this._c1Re = new Float64Array(NCHUNK6); this._c1Im = new Float64Array(NCHUNK6);
    this._zRe = new Float64Array(4 * NCHAN); this._zIm = new Float64Array(4 * NCHAN); this._hRe = new Float64Array(4 * NCHAN);
    this.reset();
  }

  reset() {
    this._buf = new Float32Array(NCHUNK * 4);
    this._bufStart = 0;     // absolute index of _buf[0]
    this._written = 0;      // absolute count of samples received
    this._istart = 0;       // absolute index of the next step's first sample
    this._active = []; this._recent = []; this._pending = [];
    this._nextId = 1;
  }

  setQsoFreq(hz) { this.qsoFreq = hz; }

  /**
   * Feed 12 kHz mono audio. Returns the message updates this call produced:
   * [{ id, text, complete, freqHz, tStart (s since reset), snrDb }].
   */
  feed(samples) {
    if (!samples || !samples.length) return [];
    // Grow / compact the buffer
    if (this._written - this._bufStart + samples.length > this._buf.length) {
      const keepFrom = Math.max(this._bufStart, this._istart - NCHUNK);
      const live = this._written - keepFrom;
      let next = this._buf;
      if (live + samples.length > next.length) next = new Float32Array(Math.max(next.length * 2, live + samples.length + NCHUNK));
      next.copyWithin ? next.set(this._buf.subarray(keepFrom - this._bufStart, this._written - this._bufStart), 0) : null;
      this._buf = next; this._bufStart = keepFrom;
    }
    this._buf.set(samples, this._written - this._bufStart);
    this._written += samples.length;
    const out = [];
    while (this._written - this._istart >= NCHUNK) {
      this._step(this._istart);
      this._istart += NFRAME / 4;
      while (this._pending.length) out.push(this._pending.shift());
    }
    return out;
  }

  /** Decode a whole buffer (tests, files): feed, then pad with silence so the tail is searched. */
  decodeAll(samples) {
    const out = this.feed(samples);
    const tail = this.feed(new Float32Array(NCHUNK));
    return out.concat(tail);
  }

  // ---- one quarter-frame step ----------------------------------------------
  _step(istart) {
    const t0 = Date.now();
    const seg = this._buf.subarray(istart - this._bufStart, istart - this._bufStart + NCHUNK);
    let any = false;
    for (let i = 0; i < seg.length; i += 97) if (seg[i] !== 0) { any = true; break; }
    this._pruneState(istart / FS);
    if (!any) { this.stats.steps++; return; }
    const an = analyticSignal(seg, NCHUNK);
    this._c0Re = an.re; this._c0Im = an.im; // length NFFT/2 of the analytic FFT, valid NCHUNK6
    this._c0Len = an.re.length;
    this._istartSec = istart / FS;
    this._cands = [];
    this._ch0Ok = [];
    this._anySubtracted = false; this._s0Valid = false;

    // Windows
    const wins = [{ fc: this.qsoFreq, fwid: this.qsoTol, qso: true }];
    if (this.bandWindows) {
      for (let fc = this.bandLo + 150; fc - 150 < this.bandHi; fc += 300) wins.push({ fc, fwid: 150, qso: false });
    }
    for (const w of wins) this._windowBins(w);
    const usable = wins.filter((w) => w.usable);
    if (!usable.length) return;
    this._firstBin = Math.min(...usable.map((w) => w.ja));
    this._lastBin = Math.max(...usable.map((w) => w.jb));

    // Phase A: the QSO window, up to two passes
    for (let pass = 1; pass <= 2; pass++) {
      if (pass === 2 && !this._anySubtracted) break;
      if (!this._s0Valid) this._buildS0();
      this._processWindow(wins[0], pass);
    }
    // Phase B: the band windows
    this._anySubtracted = false;
    for (let pass = 1; pass <= 2; pass++) {
      if (pass === 2 && !this._anySubtracted) break;
      if (!this._s0Valid) this._buildS0();
      for (let k = 1; k < wins.length; k++) this._processWindow(wins[k], pass);
      this._s0Valid = false;
    }
    this.stats.steps++;
    this.stats.ms += Date.now() - t0;
  }

  _windowBins(w) {
    // jtty_search_window
    w.usable = false;
    let fc = w.fc;
    if (!w.qso) fc = Math.max(this.bandLo, Math.min(fc, this.bandHi));
    let ja = Math.max(3, Math.floor((fc - w.fwid) / DF2));
    let jb = Math.min(NH2 - 2, Math.floor((fc + w.fwid) / DF2));
    if (!w.qso) { ja = Math.max(ja, Math.ceil(this.bandLo / DF2)); jb = Math.min(jb, Math.floor(this.bandHi / DF2)); }
    w.ja = ja; w.jb = jb; w.fcUsed = fc;
    w.usable = ja <= jb;
  }

  /** build_s0: the sync-correlation surface, smoothed 1-2-3-2-1 in frequency. */
  _buildS0() {
    const s0 = this._s0, nsteps = NTSTEP / TGRID + 1;
    const re = this._fftRe, im = this._fftIm, fft = ComplexFFT.of(NFFT);
    const c0r = this._c0Re, c0i = this._c0Im;
    const n = NSYNC * NSS, first = this._firstBin, last = this._lastBin;
    let istep = 0;
    for (let i0 = 0; i0 <= NTSTEP; i0 += TGRID, istep++) {
      for (let k = 0; k < n; k++) {
        // conj(csync) * c0
        const ar = SYNC_RE[k], ai = -SYNC_IM[k], br = c0r[i0 + k], bi = c0i[i0 + k];
        re[k] = ar * br - ai * bi; im[k] = ar * bi + ai * br;
      }
      re.fill(0, n); im.fill(0, n);
      fft.forward(re, im);
      let p0 = re[first - 2] ** 2 + im[first - 2] ** 2, p1 = re[first - 1] ** 2 + im[first - 1] ** 2;
      let p2 = re[first] ** 2 + im[first] ** 2, p3 = re[first + 1] ** 2 + im[first + 1] ** 2;
      for (let j = first; j <= last; j++) {
        const p4 = re[j + 2] ** 2 + im[j + 2] ** 2;
        s0[j * nsteps + istep] = p0 + 2 * p1 + 3 * p2 + 2 * p3 + p4;
        p0 = p1; p1 = p2; p2 = p3; p3 = p4;
      }
    }
    this._nsteps = nsteps;
    this._s0Valid = true;
  }

  /** process_channel */
  _processWindow(w, pass) {
    if (!w.usable) return;
    const s0 = this._s0, nsteps = this._nsteps, mask = this._mask0;
    const nfz = Math.round(10 / DF2), ntz = Math.round(0.016 * FS6 / TGRID);
    const ja = w.ja, jb = w.jb;
    let nc = 2;
    if (w.qso) nc = Math.max(2, Math.min(8, Math.round(w.fwid / (nfz * DF2))));
    let decodedAny = false;
    if (!w.qso && this._ch0Ok.length) {
      // Erase channel 0's successes so band windows don't rediscover them
      for (const ok of this._ch0Ok) {
        const lo = Math.max(ja, ok.ja), hi = Math.min(jb, ok.jb);
        for (let j = lo; j <= hi; j++) for (let s = 0; s < nsteps; s++) s0[j * nsteps + s] = 0;
      }
    }
    if (w.qso) for (let j = ja; j <= jb; j++) for (let s = 0; s < nsteps; s++) mask[j * nsteps + s] = 1;

    for (let ic = 0; ic < nc; ic++) {
      // maxloc over the window (and mask for the QSO window)
      let best = -1, bj = -1, bs = -1;
      for (let j = ja; j <= jb; j++) for (let s = 0; s < nsteps; s++) {
        const idx = j * nsteps + s;
        if (w.qso && !mask[idx]) continue;
        const v = s0[idx];
        if (v > best) { best = v; bj = j; bs = s; }
      }
      if (bj < 0 || best <= 0) break;
      const jlo = Math.max(ja, bj - nfz), jhi = Math.min(jb, bj + nfz), slo = Math.max(0, bs - ntz), shi = Math.min(nsteps - 1, bs + ntz);
      for (let j = jlo; j <= jhi; j++) for (let s = slo; s <= shi; s++) {
        if (w.qso) mask[j * nsteps + s] = 0; else s0[j * nsteps + s] = 0;
      }
      let f1 = bj * DF2, xdt = bs * TGRID * DT;
      if (w.qso) { const pk = this._peakup(xdt, f1); xdt = pk.xdt; f1 = pk.f1; }
      if (this._cands.length >= MAXCAND) break;
      const cand = { xdt, f1, snrdb: -99.9, decoded: '', tsync: 0 };
      this._cands.push(cand);
      this.stats.candidates++;
      this._shiftToBaseband(f1);
      const sync = this._syncCheck(xdt);
      cand.snrdb = sync.snrdb; cand.nsync = sync.nsync;
      if (w.qso && (sync.nsync <= 6 || sync.snrdb < this.smin)) continue;
      if (!w.qso && (sync.nsync <= 8 || sync.snrdb < 5.0)) continue;
      const ok = this._decodeAndMerge(cand, w, sync);
      if (ok) { decodedAny = true; if (w.qso) this._recordCh0(cand); }
    }

    if (!decodedAny) {
      // Sticky-sync retry: a continuation due one frame after an active message
      for (const m of this._active) {
        if (m.f1 < w.fcUsed - w.fwid || m.f1 > w.fcUsed + w.fwid) continue;
        if (Math.abs((this._istartSec - m.tsync) - NFRAME6 / FS6) > 0.1) continue;
        const xdtRetry = m.tsync + NFRAME6 / FS6 - this._istartSec;
        if (xdtRetry < 0) continue;
        if (this._cands.length >= MAXCAND) break;
        const cand = { xdt: xdtRetry, f1: m.f1, snrdb: -99.9, decoded: '', tsync: 0, nsync: -1 };
        this._cands.push(cand);
        this._shiftToBaseband(cand.f1);
        const sync = this._syncCheck(cand.xdt);
        const ok = this._decodeAndMerge(cand, w, sync);
        if (ok && w.qso) this._recordCh0(cand);
        break;
      }
    }
  }

  _recordCh0(cand) {
    if (this._ch0Ok.length >= 16) return;
    const nfz = Math.round(10 / DF2);
    this._ch0Ok.push({ ja: Math.round(cand.f1 / DF2) - nfz, jb: Math.round(cand.f1 / DF2) + nfz, f1: cand.f1, tsync: cand.tsync });
  }

  /** jtty_peakup: refine (xdt, f) around a coarse sync candidate (QSO window only). */
  _peakup(xdt0, f0) {
    const npsync = NSYNC * NSS, hop = 4;
    const ia = Math.max(0, Math.round((xdt0 - 0.004) / DT));
    const ib = Math.min(NCHUNK6 - npsync, Math.round((xdt0 + 0.004) / DT));
    if (ia > ib) return { xdt: xdt0, f1: f0 };
    const span = ib + npsync;
    const c1r = this._c1Re, c1i = this._c1Im;
    let pmax = 0, fpk = f0, xdtpk = xdt0;
    const zbestR = new Float64Array(NSYNC), zbestI = new Float64Array(NSYNC);
    const zr = new Float64Array(NSYNC), zi = new Float64Array(NSYNC);
    for (let idf = -5; idf <= 5; idf++) {
      const fsh = f0 + 0.5 * idf;
      shiftFrequency(this._c0Re, this._c0Im, span, FS6, -fsh, c1r, c1i);
      for (let i0 = ia; i0 <= ib; i0 += hop) {
        let p = 0;
        for (let s = 0; s < NSYNC; s++) {
          let sr = 0, si = 0;
          const base = s * NSS;
          for (let n = 0; n < NSS; n++) {
            const ar = SYNC_RE[base + n], ai = -SYNC_IM[base + n], br = c1r[i0 + base + n], bi = c1i[i0 + base + n];
            sr += ar * br - ai * bi; si += ar * bi + ai * br;
          }
          zr[s] = sr; zi[s] = si; p += sr * sr + si * si;
        }
        if (p > pmax) { pmax = p; fpk = fsh; xdtpk = i0 * DT; zbestR.set(zr); zbestI.set(zi); }
      }
    }
    if (pmax > 0) {
      // Stage 2: linear phase ramp across the 13 sync symbols -> sub-0.5 Hz correction
      const tsym = NSS / FS6, uw = new Float64Array(NSYNC);
      let prev = Math.atan2(zbestI[0], zbestR[0]); uw[0] = prev;
      for (let i = 1; i < NSYNC; i++) {
        const ph = Math.atan2(zbestI[i], zbestR[i]);
        let d = ph - prev; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
        uw[i] = uw[i - 1] + d; prev = ph;
      }
      const xm = 6; let ym = 0; for (let i = 0; i < NSYNC; i++) ym += uw[i]; ym /= NSYNC;
      let sxy = 0, sxx = 0;
      for (let i = 0; i < NSYNC; i++) { sxy += (i - xm) * (uw[i] - ym); sxx += (i - xm) ** 2; }
      const slope = sxy / sxx, intercept = ym - slope * xm;
      let rr = 0; for (let i = 0; i < NSYNC; i++) rr += (uw[i] - (slope * i + intercept)) ** 2;
      const residRms = Math.sqrt(rr / NSYNC), dfhz = slope / (2 * Math.PI * tsym);
      if (residRms < 1.0 && Math.abs(dfhz) <= 0.5) fpk += dfhz;
    }
    return { xdt: xdtpk, f1: fpk };
  }

  _shiftToBaseband(f1) {
    shiftFrequency(this._c0Re, this._c0Im, NCHUNK6, FS6, -f1, this._c1Re, this._c1Im);
  }

  /** Tone powers over the 13 sync symbols at baseband: how many are right, and the SNR. */
  _syncCheck(xdt) {
    const c1r = this._c1Re, c1i = this._c1Im;
    let pt = 0, pa = 0, nsync = 0;
    const pow = new Float64Array(4);
    for (let j = 0; j < NSYNC; j++) {
      const i0 = Math.round(xdt / DT) + j * NSS;
      if (i0 + NSS > NCHUNK6) break;
      let bestT = 0, bestP = -1;
      for (let t = 0; t < 4; t++) {
        let sr = 0, si = 0;
        const tr = TONE_RE[t], ti = TONE_IM[t];
        for (let n = 0; n < NSS; n++) { // conj(tone) * c1
          sr += tr[n] * c1r[i0 + n] + ti[n] * c1i[i0 + n];
          si += tr[n] * c1i[i0 + n] - ti[n] * c1r[i0 + n];
        }
        pow[t] = sr * sr + si * si;
        if (pow[t] > bestP) { bestP = pow[t]; bestT = t; }
      }
      if (bestT === SYNC_TONES[j]) nsync++;
      pt += pow[SYNC_TONES[j]];
      pa += pow[0] + pow[1] + pow[2] + pow[3];
    }
    const pn = (pa - pt) / 3;
    return { nsync, snrdb: pn > 0 ? db(pt / pn) : -99.9, pt, pa };
  }

  /** jtty_correlate_payload_symbols: full-symbol complex correlations and half-symbol energies. */
  _payloadCorrelations(payloadStart) {
    const zRe = this._zRe, zIm = this._zIm, hRe = this._hRe;
    zRe.fill(0); zIm.fill(0); hRe.fill(0);
    const c1r = this._c1Re, c1i = this._c1Im;
    const avail = Math.min(NCHAN, Math.floor((NCHUNK6 - payloadStart) / NSS));
    const half = NSS / 2;
    for (let s = 0; s < avail; s++) {
      const first = payloadStart + s * NSS;
      for (let t = 0; t < 4; t++) {
        const tr = TONE_RE[t], ti = TONE_IM[t];
        let fr = 0, fi = 0, energy = 0;
        for (let seg = 0; seg < 2; seg++) {
          let hr = 0, hi = 0;
          for (let n = seg * half; n < (seg + 1) * half; n++) {
            const sr = c1r[first + n], si = c1i[first + n];
            const pr = tr[n] * sr + ti[n] * si, pi = tr[n] * si - ti[n] * sr;
            fr += pr; fi += pi; hr += pr; hi += pi;
          }
          energy += hr * hr + hi * hi;
        }
        zRe[t * NCHAN + s] = fr; zIm[t * NCHAN + s] = fi; hRe[t * NCHAN + s] = Math.sqrt(Math.max(0, energy));
      }
    }
  }

  /** decode_and_merge */
  _decodeAndMerge(cand, w, sync) {
    const payloadStart = Math.round(cand.xdt / DT) + NSYNC * NSS;
    this._payloadCorrelations(payloadStart);
    const d = listDecoder.decode(this._zRe, this._zIm, this._hRe);
    if (!d.ok) return false;
    const frame = Array.from(d.payload).join('');
    const u = unpackFrameForAssembly(frame);
    if (!u) return false;
    cand.decoded = u.text; cand.trailingSep = u.trailingSep; cand.isLast = u.eom;
    this.stats.decodes++;
    // Symbol-error / SNR diagnostic from the re-encoded frame
    const tones = fec.encodeFrame(frame);
    let pt = sync.pt, pa = sync.pa;
    for (let s = 0; s < NCHAN; s++) {
      for (let t = 0; t < 4; t++) {
        const p = this._zRe[t * NCHAN + s] ** 2 + this._zIm[t * NCHAN + s] ** 2;
        pa += p; if (t === tones[s]) pt += p;
      }
    }
    const pn = (pa - pt) / 3;
    if (pn > 0) cand.snrdb = db(pt / pn);
    cand.tsync = this._istartSec + cand.xdt;

    // Dupes within this step
    for (let i = 0; i < this._cands.length - 1; i++) {
      const c = this._cands[i];
      if (c.decoded === cand.decoded && Math.abs(c.tsync - cand.tsync) < 0.032) return true;
    }
    if (!w.qso) for (const ok of this._ch0Ok) if (Math.abs(cand.f1 - ok.f1) < HIST_F_TOL && Math.abs(cand.tsync - ok.tsync) < HIST_T_TOL) return true;

    // Subtract this signal so a weaker one can be found on the next pass
    this._subtract([...SYNC_TONES, ...tones], cand.f1, cand.xdt);
    this._anySubtracted = true; this._s0Valid = false;

    // Merge into messages
    const dec = cand;
    const pureDupe = this._isRecentFrame(dec);
    if (pureDupe) return true;
    let iactive = -1, haveWin = false, bestGap = 1, bestDf = Infinity;
    for (let i = 0; i < this._active.length; i++) {
      const cl = this._classify(this._active[i], dec);
      if (!cl.match) continue;
      if (cl.windowDupe) { haveWin = true; continue; }
      const dfabs = Math.abs(dec.f1 - this._active[i].f1);
      if (dfabs < bestDf) { bestDf = dfabs; iactive = i; bestGap = cl.gap; }
    }
    if (haveWin) return true; // a retro-window duplicate of a frame already assembled
    if (iactive >= 0) this._appendActive(iactive, dec, bestGap);
    else this._startMessage(dec);
    return true;
  }

  /** subtract_jtty with a time-domain smoothing of the complex gain. */
  _subtract(tonesFull, f1, xdt) {
    const ref = complexWaveform(tonesFull, FS6, f1, 2.0);
    const nframe = ref.re.length, nstart = Math.round(xdt * FS6), nvalid = NCHUNK6;
    const c0r = this._c0Re, c0i = this._c0Im;
    const campR = new Float64Array(nframe), campI = new Float64Array(nframe);
    for (let i = 0; i < nframe; i++) {
      const j = nstart + i;
      if (j < 0 || j >= nvalid) continue;
      // c0 * conj(cref)
      campR[i] = c0r[j] * ref.re[i] + c0i[j] * ref.im[i];
      campI[i] = c0i[j] * ref.re[i] - c0r[j] * ref.im[i];
    }
    const w = SUB_WINDOW, hw = (w.length - 1) / 2;
    for (let i = 0; i < nframe; i++) {
      const j = nstart + i;
      if (j < 0 || j >= nvalid) continue;
      let gr = 0, gi = 0;
      const lo = Math.max(0, i - hw), hi = Math.min(nframe - 1, i + hw);
      for (let k = lo; k <= hi; k++) { const wk = w[k - i + hw]; gr += wk * campR[k]; gi += wk * campI[k]; }
      // z = gain * cref
      c0r[j] -= gr * ref.re[i] - gi * ref.im[i];
      c0i[j] -= gr * ref.im[i] + gi * ref.re[i];
    }
  }

  // ---- message assembly (jtty_mdecode's module state) --------------------------
  _isRecentFrame(c) {
    return this._recent.some((r) => Math.abs(c.f1 - r.f1) < NEAR_F_TOL && Math.abs(c.tsync - r.tsync) < HIST_T_TOL);
  }
  _rememberRecent(c) {
    if (this._recent.length >= MAX_RECENT) this._recent.shift();
    this._recent.push({ f1: c.f1, tsync: c.tsync });
  }
  _classify(m, c) {
    const df1 = c.f1 - m.f1, dts = c.tsync - m.tsync;
    const nfp = Math.round(dts / FRAME_PERIOD), fpResid = Math.abs(dts - FRAME_PERIOD * nfp);
    if (nfp >= 1 && nfp <= MAX_GAP && fpResid < CONT_T_TOL) {
      const dfTol = 10 + 3 * (nfp - 1);
      if (Math.abs(df1) < dfTol) return { match: true, windowDupe: false, gap: nfp };
    }
    const q = FRAME_PERIOD / 4, nstep = Math.round(dts / q), resid = Math.abs(dts - q * nstep);
    if (Math.abs(nstep) <= MAX_RETRO_STEPS && Math.abs(df1) < 10 && resid < 0.003 && !(Math.abs(nstep) % 4 === 0 && nstep !== 0)) {
      return { match: true, windowDupe: true, gap: 1 };
    }
    return { match: false };
  }
  _queueUpdate(m, complete) {
    const upd = { id: m.id, text: displayText(m.decoded), complete, freqHz: Math.round(m.f1 * 10) / 10, tStart: m.startTsync, snrDb: m.snrDb };
    const i = this._pending.findIndex((p) => p.id === m.id);
    if (i >= 0) this._pending[i] = upd; else this._pending.push(upd);
  }
  _startMessage(c) {
    if (!c.isLast && this._active.length >= MAX_ACTIVE) return;
    this._rememberRecent(c);
    let decoded = c.decoded;
    if (decoded.startsWith('599 ')) decoded = '~' + decoded;
    const m = { id: this._nextId++, f1: c.f1, tsync: c.tsync, startTsync: c.tsync, decoded, trailingSep: c.trailingSep, snrDb: Math.round(c.snrdb - 20) };
    this._queueUpdate(m, !!c.isLast);
    if (!c.isLast) this._active.push(m);
  }
  _appendActive(i, c, gap) {
    this._rememberRecent(c);
    const m = this._active[i];
    if (gap > 1) {
      const t = c.decoded.startsWith('~') ? c.decoded.slice(1) : c.decoded;
      m.decoded = (m.decoded + '~~~~~' + t).slice(0, 80);
    } else {
      m.decoded = (m.decoded + (m.trailingSep ? ' ' : '') + c.decoded).slice(0, 80);
    }
    m.trailingSep = c.trailingSep; m.f1 = c.f1; m.tsync = c.tsync;
    m.snrDb = Math.round(Math.max(m.snrDb, c.snrdb - 20));
    this._queueUpdate(m, !!c.isLast);
    if (c.isLast) this._active.splice(i, 1);
  }
  _pruneState(forwardTsync) {
    const oldest = forwardTsync - MAX_RETRO_STEPS * FRAME_PERIOD / 4;
    this._recent = this._recent.filter((r) => r.tsync >= oldest - HIST_T_TOL);
    for (let i = this._active.length - 1; i >= 0; i--) {
      if (oldest - this._active[i].tsync > MAX_GAP * FRAME_PERIOD + CONT_T_TOL) {
        this._queueUpdate(this._active[i], false);
        this._active.splice(i, 1);
      }
    }
  }
}

module.exports = { JttyDecoder, NCHUNK, NFRAME, FRAME_PERIOD, unpackFrameForAssembly, displayText };
