'use strict';
// lib/rtltcp-demod.js — turns an rtl_tcp IQ stream into audio you can listen
// to (Casey 2026-10-29: "add support for RTL_TCP nodes"). A KiwiSDR or a
// WebSDR.org demodulates on its server and sends audio; an rtl_tcp server
// (RTL-SDR, rsp_tcp for SDRplay) sends raw u8 IQ, so the receiver lives here.
//
// Pure, no Electron, no sockets: lib/rtltcp-audio.js feeds it (in a worker,
// lib/rtltcp-demod-worker.js, because this is steady DSP at up to 2 MS/s).
//
//   u8 IQ -> float -> NCO (the wanted signal to 0 Hz, or to +600 Hz in CW)
//         -> decimate to an IF of ~64 kHz (stages of <= 4)
//         -> SSB / CW / AM: decimate by 5 to ~12.5 kHz, channel filter
//            (complex taps: USB 300-2700 Hz, LSB the mirror, CW 600 +-250 Hz,
//            AM +-4 kHz), real part (SSB/CW) or magnitude (AM), AGC
//         -> FM: +-7.5 kHz channel at the IF, discriminator, decimate by 5
//
// CW follows the KiwiSDR client's convention (KiwiSdrClient.CW_PITCH_KHZ):
// a carrier on the dial plays as a 600 Hz tone.

const CW_PITCH_HZ = 600;

// The three rates lib/sdr-scope.js offers (SPANS) give whole-number audio.
const RATE_PLANS = {
  250000: { stages: [4], d2: 5 },        // IF 62.5 kHz, audio 12.5 kHz
  1024000: { stages: [4, 4], d2: 5 },    // IF 64 kHz,   audio 12.8 kHz
  2048000: { stages: [4, 4, 2], d2: 5 }, // IF 64 kHz,   audio 12.8 kHz
};

/** How a sample rate is brought down to the IF and the audio rate. */
function ratePlan(inputRate) {
  const rate = Number(inputRate) || 250000;
  let plan = RATE_PLANS[rate];
  if (!plan) {
    // Any other rate: stages of 4 (then 2) while the IF stays >= 48 kHz.
    const stages = [];
    let r = rate;
    while (r / 4 >= 48000) { stages.push(4); r /= 4; }
    if (r / 2 >= 48000) { stages.push(2); r /= 2; }
    plan = { stages, d2: 5 };
  }
  const d1 = plan.stages.reduce((a, b) => a * b, 1);
  const ifRate = rate / d1;
  return { inputRate: rate, stages: plan.stages.slice(), d1, ifRate, d2: plan.d2, audioRate: Math.round(ifRate / plan.d2) };
}

/** Windowed-sinc lowpass (Blackman), unity gain at DC. cutoff = fraction of fs (0..0.5). */
function lowpassTaps(n, cutoff) {
  const N = n | 1;
  const m = (N - 1) / 2;
  const h = new Float64Array(N);
  let sum = 0;
  for (let i = 0; i < N; i++) {
    const x = i - m;
    const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
    const w = 0.42 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1)) + 0.08 * Math.cos(4 * Math.PI * i / (N - 1));
    h[i] = sinc * w;
    sum += h[i];
  }
  for (let i = 0; i < N; i++) h[i] /= sum;
  return h;
}

/** Taps for a decimate-by-D stage that keeps +-keepHz clean at rate fs. */
function decimatorTaps(fs, D, keepHz) {
  const out = fs / D;
  const tw = Math.max(0.01, (out - 2 * keepHz) / fs); // transition, as a fraction of fs
  const n = Math.max(15, Math.ceil(5.5 / tw)) | 1;
  return lowpassTaps(n, 0.5 / D);
}

/** A lowpass shifted to centreHz: complex taps for a one-sided passband. */
function bandpassTaps(fs, n, centreHz, halfWidthHz) {
  const lp = lowpassTaps(n, halfWidthHz / fs);
  const re = new Float64Array(lp.length), im = new Float64Array(lp.length);
  const m = (lp.length - 1) / 2;
  for (let i = 0; i < lp.length; i++) {
    const ph = 2 * Math.PI * centreHz * (i - m) / fs;
    re[i] = lp[i] * Math.cos(ph);
    im[i] = lp[i] * Math.sin(ph);
  }
  return { re, im };
}

/**
 * A complex FIR, optionally decimating, with complex or real taps. Keeps its
 * own history, so a stream cut into any chunk sizes gives the same output.
 */
class Fir {
  constructor(tapsRe, tapsIm, decim = 1) {
    this.hr = tapsRe;
    this.hi = tapsIm || null;
    this.D = Math.max(1, decim | 0);
    this.N = tapsRe.length;
    this.histRe = new Float64Array(this.N - 1);
    this.histIm = new Float64Array(this.N - 1);
    this.next = this.N - 1; // index in the work array of the next output's newest sample
  }

  process(inRe, inIm, n) {
    const N = this.N, H = N - 1, D = this.D;
    const total = H + n;
    const wr = new Float64Array(total), wi = new Float64Array(total);
    wr.set(this.histRe, 0); wi.set(this.histIm, 0);
    wr.set(inRe.subarray(0, n), H); wi.set(inIm.subarray(0, n), H);
    const count = this.next < total ? Math.floor((total - 1 - this.next) / D) + 1 : 0;
    const outRe = new Float64Array(count), outIm = new Float64Array(count);
    const hr = this.hr, hi = this.hi;
    let s = this.next;
    for (let o = 0; o < count; o++, s += D) {
      let ar = 0, ai = 0;
      if (hi) {
        for (let k = 0; k < N; k++) {
          const xr = wr[s - k], xi = wi[s - k], tr = hr[k], ti = hi[k];
          ar += tr * xr - ti * xi;
          ai += tr * xi + ti * xr;
        }
      } else {
        for (let k = 0; k < N; k++) { const t = hr[k]; ar += t * wr[s - k]; ai += t * wi[s - k]; }
      }
      outRe[o] = ar; outIm[o] = ai;
    }
    this.next = s - n;
    this.histRe = wr.slice(total - H);
    this.histIm = wi.slice(total - H);
    return { re: outRe, im: outIm };
  }
}

/** Real-input FIR decimator (the FM audio path). */
class RealFir {
  constructor(taps, decim = 1) {
    this._fir = new Fir(taps, null, decim);
  }
  process(x) {
    const zero = new Float64Array(x.length);
    return this._fir.process(x, zero, x.length).re;
  }
}

const MODES = ['usb', 'lsb', 'cw', 'am', 'fm'];

/** The Kiwi-style mode names every tune site sends, reduced to what this demodulates. */
function normalizeMode(mode) {
  const m = String(mode || 'usb').toLowerCase();
  if (m === 'nbfm' || m === 'fm' || m === 'wfm') return 'fm';
  if (m === 'cwn' || m === 'cw' || m === 'cwr' || m === 'cw-r') return 'cw';
  if (m === 'am' || m === 'sam') return 'am';
  if (m === 'lsb' || m === 'digl' || m === 'pktlsb') return 'lsb';
  return 'usb';
}

class Demodulator {
  /**
   * @param {{inputRate?: number, mode?: string, offsetHz?: number, agc?: boolean}} opts
   */
  constructor({ inputRate = 250000, mode = 'usb', offsetHz = 0, agc = true } = {}) {
    this.agc = agc !== false;
    this._agcGain = 1;
    this._agcEnv = 0;
    this._dcPrev = 0;
    this._dcOut = 0;
    this._fmPrevRe = 1;
    this._fmPrevIm = 0;
    this._ncoRe = 1;
    this._ncoIm = 0;
    this.offsetHz = Number(offsetHz) || 0;
    this.mode = normalizeMode(mode);
    this.configure(inputRate);
  }

  configure(inputRate) {
    const p = ratePlan(inputRate);
    this.plan = p;
    this.inputRate = p.inputRate;
    this.audioRate = p.audioRate;
    // Stage filters keep +-10 kHz clean all the way down (the FM channel).
    this._stages = [];
    let fs = p.inputRate;
    for (const D of p.stages) {
      this._stages.push(new Fir(decimatorTaps(fs, D, 10000), null, D));
      fs /= D;
    }
    this._buildModeFilters();
    this._agcRelease = Math.exp(-1 / (0.5 * this.audioRate));
  }

  _buildModeFilters() {
    const p = this.plan;
    // IF -> audio rate, keeping +-4.5 kHz (AM is the widest audio channel).
    this._toAudio = new Fir(decimatorTaps(p.ifRate, p.d2, 4500), null, p.d2);
    const fa = p.audioRate;
    let ch;
    switch (this.mode) {
      case 'lsb': ch = bandpassTaps(fa, 161, -1500, 1250); break;
      case 'cw': ch = bandpassTaps(fa, 201, CW_PITCH_HZ, 250); break;
      case 'am': ch = { re: lowpassTaps(121, 4000 / fa), im: null }; break;
      case 'fm': ch = null; break;
      default: ch = bandpassTaps(fa, 161, 1500, 1250); break; // usb
    }
    this._channel = ch ? new Fir(ch.re, ch.im, 1) : null;
    if (this.mode === 'fm') {
      this._fmChannel = new Fir(lowpassTaps(101, 7500 / p.ifRate), null, 1);
      this._fmAudio = new RealFir(decimatorTaps(p.ifRate, p.d2, 3500), p.d2);
    } else {
      this._fmChannel = null;
      this._fmAudio = null;
    }
  }

  setMode(mode) {
    const m = normalizeMode(mode);
    if (m === this.mode) return;
    this.mode = m;
    this._buildModeFilters();
  }

  /** Where in the IQ (Hz from the SDR's centre) the dial frequency sits. */
  setOffset(hz) { this.offsetHz = Number(hz) || 0; }

  /** The NCO frequency: the dial to 0 Hz, or the carrier to +600 Hz in CW. */
  _shiftHz() { return this.offsetHz - (this.mode === 'cw' ? CW_PITCH_HZ : 0); }

  /**
   * @param {Uint8Array|Buffer} iq interleaved u8 I/Q (an even length)
   * @returns {{audio: Float32Array, sampleRate: number, powerDb: number}}
   */
  processU8(iq) {
    const n = iq.length >> 1;
    const re = new Float64Array(n), im = new Float64Array(n);
    const w = -2 * Math.PI * this._shiftHz() / this.inputRate;
    const cw = Math.cos(w), sw = Math.sin(w);
    let pr = this._ncoRe, pi = this._ncoIm;
    for (let i = 0; i < n; i++) {
      const xr = (iq[2 * i] - 127.5) / 127.5;
      const xi = (iq[2 * i + 1] - 127.5) / 127.5;
      re[i] = xr * pr - xi * pi;
      im[i] = xr * pi + xi * pr;
      const t = pr * cw - pi * sw;
      pi = pr * sw + pi * cw;
      pr = t;
    }
    const mag = Math.hypot(pr, pi) || 1; // keep the phasor on the unit circle
    this._ncoRe = pr / mag; this._ncoIm = pi / mag;

    let s = { re, im };
    for (const st of this._stages) s = st.process(s.re, s.im, s.re.length);

    if (this.mode === 'fm') return this._fm(s);

    const a = this._toAudio.process(s.re, s.im, s.re.length);
    const c = this._channel.process(a.re, a.im, a.re.length);
    const out = new Float32Array(c.re.length);
    let pow = 0;
    for (let i = 0; i < c.re.length; i++) {
      pow += c.re[i] * c.re[i] + c.im[i] * c.im[i];
      let v;
      if (this.mode === 'am') {
        const m = Math.hypot(c.re[i], c.im[i]);
        // DC block: the carrier is the envelope's mean, not audio.
        this._dcOut = m - this._dcPrev + 0.995 * this._dcOut;
        this._dcPrev = m;
        v = this._dcOut;
      } else {
        v = c.re[i];
      }
      out[i] = this._applyAgc(v);
    }
    return { audio: out, sampleRate: this.audioRate, powerDb: dbOf(pow, c.re.length) };
  }

  _fm(s) {
    const ch = this._fmChannel.process(s.re, s.im, s.re.length);
    const n = ch.re.length;
    const disc = new Float64Array(n);
    // 5 kHz deviation = full scale.
    const k = this.plan.ifRate / (2 * Math.PI * 5000);
    let pr = this._fmPrevRe, pi = this._fmPrevIm, pow = 0;
    for (let i = 0; i < n; i++) {
      const r = ch.re[i], q = ch.im[i];
      pow += r * r + q * q;
      disc[i] = Math.atan2(q * pr - r * pi, r * pr + q * pi) * k;
      pr = r; pi = q;
    }
    this._fmPrevRe = pr; this._fmPrevIm = pi;
    const a = this._fmAudio.process(disc);
    const out = new Float32Array(a.length);
    for (let i = 0; i < a.length; i++) out[i] = Math.max(-1, Math.min(1, a[i] * 0.5));
    return { audio: out, sampleRate: this.audioRate, powerDb: dbOf(pow, n) };
  }

  _applyAgc(v) {
    if (!this.agc) return Math.max(-1, Math.min(1, v));
    const a = Math.abs(v);
    this._agcEnv = a > this._agcEnv ? a : this._agcEnv * this._agcRelease;
    const g = Math.min(2000, 0.3 / Math.max(this._agcEnv, 1e-7));
    return Math.max(-1, Math.min(1, v * g));
  }
}

function dbOf(sumPow, n) {
  return n > 0 ? 10 * Math.log10(sumPow / n + 1e-20) : -200;
}

/**
 * A relative S-meter: an RTL-SDR reports no calibrated level, so the channel
 * power is read against a tracked noise floor (falls at once, rises 0.5 dB a
 * second). Noise = S1 (-121 dBm), 48 dB above the floor = S9 (-73 dBm).
 */
class RelativeMeter {
  constructor() { this.floor = null; }
  update(powerDb, seconds) {
    if (!Number.isFinite(powerDb)) return null;
    if (this.floor == null || powerDb < this.floor) this.floor = powerDb;
    else this.floor += Math.min(powerDb - this.floor, 0.5 * Math.max(0, seconds || 0));
    return -121 + Math.max(0, powerDb - this.floor);
  }
}

module.exports = {
  CW_PITCH_HZ, RATE_PLANS, MODES,
  ratePlan, lowpassTaps, decimatorTaps, bandpassTaps, normalizeMode,
  Fir, RealFir, Demodulator, RelativeMeter,
};
