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

// Each size keeps its own place (Casey 2026-11-11: "The mini VFO and big VFO
// don't remember their position well"). One shared position made them drift:
// the Small VFO opened where the Large VFO was pushed to fit the screen, and a
// switch near a screen edge moved both. Large: settings.vfoPopoutBounds.
// Small: settings.vfoMiniPos ({x, y}; its width is vfoMiniWidth).

function hasPos(p) {
  return !!p && p.x != null && p.y != null && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y));
}
function at(p, size) {
  return { x: Math.round(Number(p.x)), y: Math.round(Number(p.y)), width: size.width, height: size.height };
}

/**
 * Where the Small VFO goes: its own last place while that is on a screen,
 * else the top-left of `from` (the Large VFO), else 0,0.
 * onScreen(bounds) -> bool; absent = every place is on screen.
 */
function miniBounds(savedPos, from, size, onScreen) {
  const seen = typeof onScreen === 'function' ? onScreen : () => true;
  if (hasPos(savedPos)) {
    const b = at(savedPos, size);
    if (seen(b)) return b;
  }
  return at(hasPos(from) ? from : { x: 0, y: 0 }, size);
}

/**
 * Where the Large VFO goes: its own last place and size while that is on a
 * screen, else at `current`'s top-left with the remembered (or default) size.
 */
function largeBounds(saved, current, onScreen) {
  const seen = typeof onScreen === 'function' ? onScreen : () => true;
  const size = fullSize(saved, current);
  if (hasPos(saved)) {
    const b = at(saved, size);
    if (seen(b)) return b;
  }
  return at(hasPos(current) ? current : { x: 0, y: 0 }, size);
}

module.exports = { MINI, FULL_DEFAULT, miniSize, fullSize, miniBounds, largeBounds };
