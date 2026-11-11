// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// Mini VFO window sizes (Casey 2026-11-10: "I want to cruise around with VFO
// small"). The VFO window shrinks to the Small VFO, one line (lib/vfo-layout.js
// says what is on it), and grows back to the size it had. Pure.

'use strict';

// One line, as wide as its items (Casey 2026-11-10: "Try not to let it wrap to
// a second line ... maybe it's responsive width-wise and user can make it more
// narrow or not"). The operator's own width is remembered (vfoMiniWidth).
const MINI = Object.freeze({ minWidth: 320, maxWidth: 1600, minHeight: 44, maxHeight: 260, width: 640 });
const FULL_DEFAULT = Object.freeze({ width: 360, height: 760 });

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/**
 * The strip's size. Width: the operator's own (saved) width, else the width
 * the page measured for its line, else 640; kept inside 320..1600. Height: the
 * page's measured height, inside 44..260.
 */
function miniSize({ width, height, saved } = {}) {
  const pick = Number(saved) > 0 ? Number(saved) : Number(width);
  const w = pick > 0 ? clamp(Math.round(pick), MINI.minWidth, MINI.maxWidth) : MINI.width;
  const h = Number(height) > 0 ? clamp(Math.round(Number(height)), MINI.minHeight, MINI.maxHeight) : 52;
  return { width: w, height: h };
}

/** The size to grow back to: the one remembered before shrinking, else the window's default. */
function fullSize(saved, current) {
  const s = saved || {};
  const width = Number(s.width) >= 300 ? Number(s.width) : Math.max(FULL_DEFAULT.width, Number(current && current.width) || 0);
  const height = Number(s.height) >= 360 ? Number(s.height) : FULL_DEFAULT.height;
  return { width: Math.round(width), height: Math.round(height) };
}

/** Bounds to save at close while in mini: where the strip is, at the full size. */
function savedBounds(bounds, fullSaved) {
  const b = bounds || {};
  const f = fullSize(fullSaved, b);
  return { x: b.x, y: b.y, width: f.width, height: f.height };
}

module.exports = { MINI, FULL_DEFAULT, miniSize, fullSize, savedBounds };
