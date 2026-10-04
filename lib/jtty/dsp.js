'use strict';
// DSP primitives for the JTTY receiver: a general-size complex FFT, the
// analytic-signal conversion (WSJT-X lib/jtty/ana64a.f90), the complex
// frequency shift (lib/twkfreq.f90) and the complex GFSK reference waveform
// used for subtraction. Ports of the v3.2.0-rc1 reference (GPL-3.0).

const { gfskPulse, BAUD } = require('./waveform');

const fftCache = new Map();

/** Radix-2 complex FFT of one power-of-two size, tables built once. */
class ComplexFFT {
  constructor(n) {
    if (n < 2 || (n & (n - 1)) !== 0) throw new Error('ComplexFFT: size must be a power of two');
    this.n = n;
    const logN = Math.log2(n);
    this.bitrev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let rev = 0, v = i;
      for (let j = 0; j < logN; j++) { rev = (rev << 1) | (v & 1); v >>= 1; }
      this.bitrev[i] = rev;
    }
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos(2 * Math.PI * i / n);
      this.sin[i] = Math.sin(2 * Math.PI * i / n);
    }
  }
  static of(n) {
    let f = fftCache.get(n);
    if (!f) { f = new ComplexFFT(n); fftCache.set(n, f); }
    return f;
  }
  /** In place. sign -1 = forward (FFTW convention), +1 = inverse, both unnormalized. */
  transform(re, im, sign) {
    const n = this.n, bitrev = this.bitrev, cosT = this.cos, sinT = this.sin;
    for (let i = 0; i < n; i++) {
      const j = bitrev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const wr = cosT[k], wi = sign * sinT[k];
          const xr = re[j + half], xi = im[j + half];
          const tr = xr * wr - xi * wi, ti = xr * wi + xi * wr;
          re[j + half] = re[j] - tr; im[j + half] = im[j] - ti;
          re[j] += tr; im[j] += ti;
        }
      }
    }
  }
  forward(re, im) { this.transform(re, im, -1); }
  inverse(re, im) { this.transform(re, im, 1); }
}

function nextPow2(n) { let p = 1; while (p < n) p <<= 1; return p; }

/**
 * ana64a: real 12 kHz samples -> complex analytic signal at 6 kHz covering
 * 0..3000 Hz. Returns { re, im } of length nfft/2 (the first npts/2 are the
 * signal, the rest zero), nfft = nextPow2(npts). Full scale (1.0) in gives
 * unit amplitude out, as the reference's int16 scaling does.
 */
function analyticSignal(samples, npts) {
  const nfft1 = nextPow2(npts);
  const nfft2 = nfft1 / 2;
  const re = new Float64Array(nfft1), im = new Float64Array(nfft1);
  const fac = 2.0 / nfft1;
  for (let i = 0; i < npts; i++) re[i] = fac * samples[i];
  ComplexFFT.of(nfft1).forward(re, im);
  for (let i = nfft2 / 2 + 1; i < nfft2; i++) { re[i] = 0; im[i] = 0; }
  re[0] *= 0.5; im[0] *= 0.5;
  const re2 = re.subarray(0, nfft2), im2 = im.subarray(0, nfft2);
  ComplexFFT.of(nfft2).inverse(re2, im2);
  const nvalid = npts >> 1;
  for (let i = nvalid; i < nfft2; i++) { re2[i] = 0; im2[i] = 0; }
  return { re: re2, im: im2, nvalid };
}

/** twkfreq with a(2)=a(3)=0: out = in * exp(j 2π fShift n / fs), n from 1. */
function shiftFrequency(re, im, n, fs, fShift, outRe, outIm) {
  const dphi = 2 * Math.PI * fShift / fs;
  const wr = Math.cos(dphi), wi = Math.sin(dphi);
  let cr = 1, ci = 0;
  for (let i = 0; i < n; i++) {
    const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
    outRe[i] = cr * re[i] - ci * im[i];
    outIm[i] = cr * im[i] + ci * re[i];
  }
}

/**
 * gen_jttywave, complex output (icmplx=1): unit-magnitude 4-GFSK reference
 * at sample rate fs for tones at lowest-tone frequency f0. nsps = fs/BAUD.
 */
function complexWaveform(tones, fs, f0, bt) {
  const nsps = Math.round(fs / BAUD);
  const nsym = tones.length, nwave = nsym * nsps;
  const re = new Float64Array(nwave), im = new Float64Array(nwave);
  if (!nsym) return { re, im };
  const twopi = 2 * Math.PI;
  const pulse = new Float64Array(3 * nsps);
  for (let i = 1; i <= 3 * nsps; i++) pulse[i - 1] = gfskPulse(bt || 2.0, (i - 1.5 * nsps) / nsps);
  const dphi = new Float64Array((nsym + 2) * nsps);
  const peak = twopi / nsps;
  for (let j = 0; j < nsym; j++) {
    const ib = j * nsps, t = tones[j];
    if (!t) continue;
    for (let i = 0; i < 3 * nsps; i++) dphi[ib + i] += peak * pulse[i] * t;
  }
  for (let i = 0; i < 2 * nsps; i++) dphi[i] += peak * tones[0] * pulse[nsps + i];
  for (let i = 0; i < 2 * nsps; i++) dphi[nsym * nsps + i] += peak * tones[nsym - 1] * pulse[i];
  const carrier = twopi * f0 / fs;
  let phi = 0;
  for (let j = nsps, k = 0; k < nwave; j++, k++) {
    re[k] = Math.cos(phi); im[k] = Math.sin(phi);
    phi += dphi[j] + carrier;
    if (phi >= twopi) phi -= twopi;
  }
  const nramp = Math.round(nsps / 8);
  for (let i = 0; i < nramp; i++) {
    const a = (1 - Math.cos(twopi * i / (2 * nramp))) / 2, b = (1 + Math.cos(twopi * i / (2 * nramp))) / 2;
    re[i] *= a; im[i] *= a;
    re[nwave - nramp + i] *= b; im[nwave - nramp + i] *= b;
  }
  return { re, im };
}

const db = (x) => (x > 1.259e-10 ? 10 * Math.log10(x) : -99);

module.exports = { ComplexFFT, nextPow2, analyticSignal, shiftFrequency, complexWaveform, db };
