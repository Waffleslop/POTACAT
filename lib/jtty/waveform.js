'use strict';
// JTTY waveform: tone symbols -> 4-GFSK audio.
//
// Port of WSJT-X lib/jtty/gen_jttywave.f90 (real-output path) and
// lib/gfsk_pulse.f90 at tag v3.2.0-rc1 (GPL-3.0). 31.25 baud: 384 samples
// per symbol at 12 000 Hz (the rate every POTACAT engine runs at), tone
// spacing equal to the baud rate (modulation index 1), Gaussian frequency
// smoothing with BT = 2 (sjtty's default), a raised-cosine amplitude ramp of
// nsps/8 samples at each end. Output peaks at 1.0 like lib/psk-engine.js and
// lib/wspr/encode.js, so the tx-start dispatch scales it the same way.

const SAMPLE_RATE = 12000;
const BAUD = 31.25;
const NSPS = SAMPLE_RATE / BAUD; // 384
const BT = 2.0;

// erf to ~1.2e-7 (Numerical Recipes erfc Chebyshev fit); the pulse shape
// tolerates far more than that.
function erf(x) {
  const z = Math.abs(x), t = 1 / (1 + 0.5 * z);
  const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 +
    t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? 1 - r : r - 1;
}

/** gfsk_pulse(b, t): the Gaussian-smoothed frequency pulse. */
function gfskPulse(b, t) {
  const c = Math.PI * Math.sqrt(2 / Math.LN2);
  return 0.5 * (erf(c * b * (t + 0.5)) - erf(c * b * (t - 0.5)));
}

/**
 * gen_jttywave: tones -> Float32Array of nsps*tones.length samples.
 * @param {number[]} tones   symbol values 0..3
 * @param {object} [o]       { f0 = 1500 (Hz, lowest tone), sampleRate = 12000, bt = 2 }
 */
function generateWaveform(tones, o) {
  const opts = o || {};
  const fs = opts.sampleRate || SAMPLE_RATE;
  const nsps = Math.round(fs / BAUD);
  if (nsps * BAUD !== fs) throw new Error('JTTY waveform: sample rate must be a multiple of 31.25 Hz');
  const bt = opts.bt || BT;
  const f0 = opts.f0 == null ? 1500 : opts.f0;
  const nsym = tones.length;
  const nwave = nsym * nsps;
  const out = new Float32Array(nwave);
  if (nsym === 0) return out;

  const twopi = 2 * Math.PI, dt = 1 / fs, hmod = 1.0;
  const pulse = new Float64Array(3 * nsps);
  for (let i = 1; i <= 3 * nsps; i++) pulse[i - 1] = gfskPulse(bt, (i - 1.5 * nsps) / nsps);

  // Smoothed frequency waveform, (nsym+2)*nsps long: one dummy symbol at
  // each end carrying the first/last tone so the pulse tails are complete.
  const dphi = new Float64Array((nsym + 2) * nsps);
  const dphiPeak = twopi * hmod / nsps;
  for (let j = 0; j < nsym; j++) {
    const ib = j * nsps, tone = tones[j];
    if (tone === 0) continue;
    for (let i = 0; i < 3 * nsps; i++) dphi[ib + i] += dphiPeak * pulse[i] * tone;
  }
  for (let i = 0; i < 2 * nsps; i++) dphi[i] += dphiPeak * tones[0] * pulse[nsps + i];
  for (let i = 0; i < 2 * nsps; i++) dphi[nsym * nsps + i] += dphiPeak * tones[nsym - 1] * pulse[i];

  const carrier = twopi * f0 * dt;
  let phi = 0;
  for (let j = nsps, k = 0; k < nwave; j++, k++) {
    out[k] = Math.sin(phi);
    phi += dphi[j] + carrier;
    if (phi >= twopi) phi -= twopi;
  }
  // Envelope shaping on the first and last symbols
  const nramp = Math.round(nsps / 8);
  for (let i = 0; i < nramp; i++) {
    const w = (1 - Math.cos(twopi * i / (2 * nramp))) / 2;
    out[i] *= w;
    out[nwave - nramp + i] *= (1 + Math.cos(twopi * i / (2 * nramp))) / 2;
  }
  return out;
}

module.exports = { SAMPLE_RATE, BAUD, NSPS, BT, erf, gfskPulse, generateWaveform };
