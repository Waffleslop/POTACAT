'use strict';
// ---------------------------------------------------------------------------
// Mixed-radix FFT/IFFT for 1152 = 9 × 128.
//
// 1152 is the DRM Mode A FFT size. It's not a power of 2, so we compose a
// Cooley-Tukey factorisation: an outer 9-point DFT (brute force, 81 ops) and
// an inner 128-point radix-2 FFT (iterative Gentleman–Sande).
//
// Complex values are represented as parallel Float64Array pairs (re[] / im[])
// — more cache-friendly than an array of {re, im} objects at this size.
// Only the top-level IFFT interface accepts object-cell arrays because
// that's how the rest of hamdrm uses them.
// ---------------------------------------------------------------------------

const TWO_PI = 2 * Math.PI;

// Bit-reversal permutation in-place for length 2^k.
function bitReverseInPlace(re, im) {
  const n = re.length;
  let j = 0;
  for (let i = 1; i < n - 1; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
}

/**
 * Iterative radix-2 FFT in-place. Length must be a power of 2.
 * Sign: -1 for forward FFT, +1 for IFFT (caller normalises by 1/N).
 */
function radix2InPlace(re, im, sign) {
  const n = re.length;
  bitReverseInPlace(re, im);
  for (let size = 2; size <= n; size <<= 1) {
    const halfSize = size >> 1;
    const tableStep = sign * TWO_PI / size;
    // Precompute twiddles for this butterfly size.
    const wRe = new Float64Array(halfSize);
    const wIm = new Float64Array(halfSize);
    for (let k = 0; k < halfSize; k++) {
      wRe[k] = Math.cos(tableStep * k);
      wIm[k] = Math.sin(tableStep * k);
    }
    for (let i = 0; i < n; i += size) {
      for (let k = 0; k < halfSize; k++) {
        const a = i + k;
        const b = a + halfSize;
        const tRe = re[b] * wRe[k] - im[b] * wIm[k];
        const tIm = re[b] * wIm[k] + im[b] * wRe[k];
        re[b] = re[a] - tRe;
        im[b] = im[a] - tIm;
        re[a] = re[a] + tRe;
        im[a] = im[a] + tIm;
      }
    }
  }
}

/** Forward radix-2 FFT. Writes in-place. */
function fftRadix2(re, im) {
  radix2InPlace(re, im, -1);
}

/** Inverse radix-2 FFT. Writes in-place, normalised by 1/N. */
function ifftRadix2(re, im) {
  const n = re.length;
  radix2InPlace(re, im, +1);
  const scale = 1 / n;
  for (let i = 0; i < n; i++) {
    re[i] *= scale;
    im[i] *= scale;
  }
}

// --- 9-point DFT (brute force) ---------------------------------------------
//
// Used as the outer stage of the 1152 = 9 × 128 factorisation. Precompute
// the twiddle table once (81 entries) and reuse across all inner calls.
const N9 = 9;
const DFT9_COS = new Float64Array(N9 * N9);
const DFT9_SIN = new Float64Array(N9 * N9);
const DFT9_INV_COS = new Float64Array(N9 * N9);
const DFT9_INV_SIN = new Float64Array(N9 * N9);
for (let k = 0; k < N9; k++) {
  for (let n = 0; n < N9; n++) {
    const a = TWO_PI * k * n / N9;
    DFT9_COS[k * N9 + n] = Math.cos(-a);
    DFT9_SIN[k * N9 + n] = Math.sin(-a);
    DFT9_INV_COS[k * N9 + n] = Math.cos(a);
    DFT9_INV_SIN[k * N9 + n] = Math.sin(a);
  }
}

function dft9(inRe, inIm, outRe, outIm, inverse) {
  const cosT = inverse ? DFT9_INV_COS : DFT9_COS;
  const sinT = inverse ? DFT9_INV_SIN : DFT9_SIN;
  for (let k = 0; k < N9; k++) {
    let rR = 0, rI = 0;
    const base = k * N9;
    for (let n = 0; n < N9; n++) {
      const c = cosT[base + n];
      const s = sinT[base + n];
      rR += inRe[n] * c - inIm[n] * s;
      rI += inRe[n] * s + inIm[n] * c;
    }
    outRe[k] = rR;
    outIm[k] = rI;
  }
}

// --- 1152-point composite FFT via Cooley-Tukey -----------------------------
//
// N = N1 * N2 with N1=9, N2=128. Standard decomposition:
//   n = N1*n2 + n1    (n1 = 0..N1-1, n2 = 0..N2-1; n1 is LSB direction)
//   k = N2*k1 + k2    (k1 = 0..N1-1, k2 = 0..N2-1; k2 is LSB direction)
// Steps:
//   1. For each n1: Y[n1][k2] = FFT_{N2}( x[n1 + N1*n2] for n2=0..N2-1 )
//   2. Twiddle: Z[n1][k2] = Y[n1][k2] * W_N^{n1*k2}
//   3. For each k2: R[k1][k2] = DFT_{N1}( Z[:, k2] )
//   4. X[k = N2*k1 + k2] = R[k1][k2]
const N1152 = 1152;
const FFT_N1 = 9;
const FFT_N2 = 128;

function fft1152Impl(re, im, inverse) {
  if (re.length !== N1152) throw new Error(`fft1152 expects ${N1152} samples, got ${re.length}`);

  // Step 1: inner 128-point FFTs, one per n1 slice.
  const sliceRe = new Float64Array(FFT_N2);
  const sliceIm = new Float64Array(FFT_N2);
  // Intermediate Y[n1][k2] in a 9×128 buffer, flat = n1*N2 + k2.
  const yRe = new Float64Array(N1152);
  const yIm = new Float64Array(N1152);
  for (let n1 = 0; n1 < FFT_N1; n1++) {
    for (let n2 = 0; n2 < FFT_N2; n2++) {
      const flatIn = n1 + FFT_N1 * n2;   // n = N1*n2 + n1
      sliceRe[n2] = re[flatIn];
      sliceIm[n2] = im[flatIn];
    }
    radix2InPlace(sliceRe, sliceIm, inverse ? +1 : -1);
    for (let k2 = 0; k2 < FFT_N2; k2++) {
      yRe[n1 * FFT_N2 + k2] = sliceRe[k2];
      yIm[n1 * FFT_N2 + k2] = sliceIm[k2];
    }
  }

  // Step 2: twiddle multiply.
  for (let n1 = 0; n1 < FFT_N1; n1++) {
    for (let k2 = 0; k2 < FFT_N2; k2++) {
      const sign = inverse ? +1 : -1;
      const angle = sign * TWO_PI * n1 * k2 / N1152;
      const c = Math.cos(angle), s = Math.sin(angle);
      const idx = n1 * FFT_N2 + k2;
      const yr = yRe[idx], yi = yIm[idx];
      yRe[idx] = yr * c - yi * s;
      yIm[idx] = yr * s + yi * c;
    }
  }

  // Step 3: outer 9-point DFTs, one per k2.
  const col9Re = new Float64Array(FFT_N1);
  const col9Im = new Float64Array(FFT_N1);
  const out9Re = new Float64Array(FFT_N1);
  const out9Im = new Float64Array(FFT_N1);
  for (let k2 = 0; k2 < FFT_N2; k2++) {
    for (let n1 = 0; n1 < FFT_N1; n1++) {
      col9Re[n1] = yRe[n1 * FFT_N2 + k2];
      col9Im[n1] = yIm[n1 * FFT_N2 + k2];
    }
    dft9(col9Re, col9Im, out9Re, out9Im, inverse);
    // Step 4: X[k = N2*k1 + k2] = R[k1][k2]
    for (let k1 = 0; k1 < FFT_N1; k1++) {
      const kFlat = FFT_N2 * k1 + k2;
      re[kFlat] = out9Re[k1];
      im[kFlat] = out9Im[k1];
    }
  }

  // Normalise once at the end for IFFT.
  if (inverse) {
    const s = 1 / N1152;
    for (let i = 0; i < N1152; i++) {
      re[i] *= s;
      im[i] *= s;
    }
  }
}

function fft1152(re, im) { fft1152Impl(re, im, false); }
function ifft1152(re, im) { fft1152Impl(re, im, true); }

// Convenience: object-cell array (array of {re, im}) → Float64Array pair.
function cellsToArrays(cells) {
  const n = cells.length;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    re[i] = cells[i].re;
    im[i] = cells[i].im;
  }
  return { re, im };
}

function arraysToCells(re, im) {
  const n = re.length;
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = { re: re[i], im: im[i] };
  return out;
}

// --- Reference DFT (for validation) ----------------------------------------
function refDFT(re, im, inverse = false) {
  const n = re.length;
  const outRe = new Float64Array(n);
  const outIm = new Float64Array(n);
  const sign = inverse ? +1 : -1;
  for (let k = 0; k < n; k++) {
    let rR = 0, rI = 0;
    for (let j = 0; j < n; j++) {
      const a = sign * TWO_PI * k * j / n;
      const c = Math.cos(a), s = Math.sin(a);
      rR += re[j] * c - im[j] * s;
      rI += re[j] * s + im[j] * c;
    }
    if (inverse) { rR /= n; rI /= n; }
    outRe[k] = rR;
    outIm[k] = rI;
  }
  return { re: outRe, im: outIm };
}

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------

if (require.main === module) {
  // Validate 128-pt FFT against reference.
  function testRadix2(N) {
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      re[i] = Math.sin(0.1 * i) + 0.3 * Math.cos(0.7 * i);
      im[i] = 0;
    }
    const refRe = new Float64Array(re), refIm = new Float64Array(im);
    const ref = refDFT(refRe, refIm, false);
    fftRadix2(re, im);
    let maxErr = 0;
    for (let i = 0; i < N; i++) {
      maxErr = Math.max(maxErr, Math.abs(re[i] - ref.re[i]), Math.abs(im[i] - ref.im[i]));
    }
    return maxErr;
  }

  // Validate 1152-pt FFT against reference.
  function test1152() {
    const N = 1152;
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      re[i] = Math.cos(0.01 * i);
      im[i] = Math.sin(0.03 * i);
    }
    const refResult = refDFT(new Float64Array(re), new Float64Array(im), false);
    fft1152(re, im);
    let maxErr = 0;
    for (let i = 0; i < N; i++) {
      maxErr = Math.max(maxErr, Math.abs(re[i] - refResult.re[i]), Math.abs(im[i] - refResult.im[i]));
    }
    return maxErr;
  }

  // Roundtrip: x → FFT → IFFT → x
  function roundtrip(N) {
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      re[i] = Math.random() - 0.5;
      im[i] = Math.random() - 0.5;
    }
    const orig = { re: new Float64Array(re), im: new Float64Array(im) };
    if (N === 1152) { fft1152(re, im); ifft1152(re, im); }
    else { fftRadix2(re, im); ifftRadix2(re, im); }
    let maxErr = 0;
    for (let i = 0; i < N; i++) {
      maxErr = Math.max(maxErr, Math.abs(re[i] - orig.re[i]), Math.abs(im[i] - orig.im[i]));
    }
    return maxErr;
  }

  let fails = 0;
  const err128 = testRadix2(128);
  console.log(`radix-2 N=128 vs ref: max err = ${err128.toExponential(3)}`);
  if (err128 > 1e-10) { console.log('FAIL radix-2 128 accuracy'); fails++; }

  const err1152 = test1152();
  console.log(`mixed-radix N=1152 vs ref: max err = ${err1152.toExponential(3)}`);
  if (err1152 > 1e-9) { console.log('FAIL 1152-pt accuracy'); fails++; }

  const rt128 = roundtrip(128);
  console.log(`radix-2 128 roundtrip:  max err = ${rt128.toExponential(3)}`);
  if (rt128 > 1e-12) { console.log('FAIL 128 roundtrip'); fails++; }

  const rt1152 = roundtrip(1152);
  console.log(`mixed-radix 1152 roundtrip: max err = ${rt1152.toExponential(3)}`);
  if (rt1152 > 1e-10) { console.log('FAIL 1152 roundtrip'); fails++; }

  if (fails === 0) console.log('\nFFT self-tests passed.');
  process.exit(fails ? 1 : 0);
}

module.exports = {
  fftRadix2,
  ifftRadix2,
  fft1152,
  ifft1152,
  cellsToArrays,
  arraysToCells,
  refDFT,
};
