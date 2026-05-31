'use strict';
//
// SSTV post-processing — purely cosmetic image-quality boosters applied
// to decoded imageData. MMSSTV applies unsharp + saturation by default;
// matching that perceived-quality bar is part of the "world class"
// push. These functions DON'T touch the decoder — they take an already-
// decoded RGBA buffer and return a new one with the effect applied.
//
// Pure functions: easy to test, easy to wire in/out at the renderer
// without coupling to the decode pipeline. Default parameters match
// MMSSTV's default-on values within usability tolerance.
//
// Design intent: the decoder's PSNR matrix stays the regression
// invariant. Post-process is opt-in at the UI layer; flipping
// settings.sstvPostProcessEnabled changes perceived quality without
// regressing any test.

// =====================================================================
// Unsharp mask
// =====================================================================
//
// Algorithm: blur the image with a 3×3 Gaussian, subtract from the
// original, scale by strength, add back to the original. Sharpens
// edges without ringing. Strength 0..2 (1.0 = "noticeable", MMSSTV
// default ~0.6).
//
// Edge handling: clamp-to-border (replicate edge pixels). Cheap and
// the visual effect at borders is negligible for 320-pixel-wide
// SSTV images.
function unsharpMask(rgba, width, height, strength) {
  if (!strength || strength <= 0) return new Uint8ClampedArray(rgba);
  const out = new Uint8ClampedArray(rgba.length);
  // 3×3 Gaussian (σ≈0.8): center weight 4, neighbors 2, corners 1, sum=16
  const get = (x, y, c) => {
    const xc = x < 0 ? 0 : x >= width ? width - 1 : x;
    const yc = y < 0 ? 0 : y >= height ? height - 1 : y;
    return rgba[(yc * width + xc) * 4 + c];
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) {
        const orig = rgba[i + c];
        const blur = (
          get(x - 1, y - 1, c) + 2 * get(x, y - 1, c) + get(x + 1, y - 1, c) +
          2 * get(x - 1, y, c) + 4 * orig           + 2 * get(x + 1, y, c) +
          get(x - 1, y + 1, c) + 2 * get(x, y + 1, c) + get(x + 1, y + 1, c)
        ) / 16;
        const detail = orig - blur;
        const v = orig + detail * strength;
        out[i + c] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
      }
      out[i + 3] = 255;
    }
  }
  return out;
}

// =====================================================================
// Saturation boost
// =====================================================================
//
// Push chroma away from gray. RGB → luma + chroma decomposition,
// scale chroma by factor, recombine. factor 1.0 = unchanged, 1.2 =
// MMSSTV-typical default, 1.5 = obvious oversaturation.
//
// Uses BT.601 luma weights (same as our YCbCr coder) so the visual
// brightness is preserved.
function saturationBoost(rgba, width, height, factor) {
  if (factor === 1.0 || factor == null) return new Uint8ClampedArray(rgba);
  const out = new Uint8ClampedArray(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    const r = rgba[i];
    const g = rgba[i + 1];
    const b = rgba[i + 2];
    const luma = 0.299 * r + 0.587 * g + 0.114 * b;
    const nr = luma + (r - luma) * factor;
    const ng = luma + (g - luma) * factor;
    const nb = luma + (b - luma) * factor;
    out[i]     = nr < 0 ? 0 : nr > 255 ? 255 : Math.round(nr);
    out[i + 1] = ng < 0 ? 0 : ng > 255 ? 255 : Math.round(ng);
    out[i + 2] = nb < 0 ? 0 : nb > 255 ? 255 : Math.round(nb);
    out[i + 3] = 255;
  }
  return out;
}

// =====================================================================
// Gamma correction
// =====================================================================
//
// Per-channel pow with a precomputed LUT. Implementation: y = x^(1/gamma).
//   gamma 1.0 = unchanged
//   gamma > 1 lifts midtones (Photoshop "Levels" gamma direction)
//   gamma < 1 darkens midtones
// MMSSTV typically applies γ ≈ 1.05 for a slight midtone lift.
function gammaCorrect(rgba, width, height, gamma) {
  if (gamma === 1.0 || gamma == null) return new Uint8ClampedArray(rgba);
  const inv = 1 / gamma;
  // 256-entry LUT
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) {
    lut[v] = Math.max(0, Math.min(255, Math.round(255 * Math.pow(v / 255, inv))));
  }
  const out = new Uint8ClampedArray(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    out[i]     = lut[rgba[i]];
    out[i + 1] = lut[rgba[i + 1]];
    out[i + 2] = lut[rgba[i + 2]];
    out[i + 3] = 255;
  }
  return out;
}

// =====================================================================
// Apply the full chain
// =====================================================================
//
// One call to get the MMSSTV-style "polished" output. Default options
// match MMSSTV's defaults within usability tolerance.
function postProcess(rgba, width, height, opts) {
  opts = opts || {};
  const unsharp    = opts.unsharpStrength != null ? opts.unsharpStrength : 0.6;
  const saturation = opts.saturation      != null ? opts.saturation      : 1.15;
  const gamma      = opts.gamma           != null ? opts.gamma           : 1.0;

  let cur = unsharpMask(rgba, width, height, unsharp);
  cur = saturationBoost(cur, width, height, saturation);
  cur = gammaCorrect(cur, width, height, gamma);
  return cur;
}

module.exports = {
  unsharpMask,
  saturationBoost,
  gammaCorrect,
  postProcess,
};
