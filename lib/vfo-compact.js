// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// Mini VFO window sizes (Casey 2026-11-10: "I want to cruise around with VFO
// small"). The VFO window shrinks to a strip (frequency, mode and band,
// S-meter, Audio, PTT, Log) and grows back to the size it had. Pure.

'use strict';

const MINI = Object.freeze({ minWidth: 300, maxWidth: 460, minHeight: 84, maxHeight: 260, width: 380 });
const FULL_DEFAULT = Object.freeze({ width: 360, height: 760 });

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/**
 * The strip's size: the current width kept inside 300..460 (380 when unknown),
 * the height the page measured for its content, inside 84..260.
 */
function miniSize({ width, height } = {}) {
  const w = Number(width) > 0 ? clamp(Math.round(Number(width)), MINI.minWidth, MINI.maxWidth) : MINI.width;
  const h = Number(height) > 0 ? clamp(Math.round(Number(height)), MINI.minHeight, MINI.maxHeight) : 110;
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
