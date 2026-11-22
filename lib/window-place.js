// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// Every window opens where it was, at the size it was (Casey 2026-11-11: new
// windows must open in the same theme and remember position, shape and size).
// main.js rememberWindowPlace() is the glue; test/window-rules-test.js holds
// every BrowserWindow to it. Pure.
'use strict';

function num(v) { return v != null && v !== '' && Number.isFinite(Number(v)); }

/** A saved {x, y, width, height} worth restoring: all four numbers, at least the window's minimum. */
function restorable(saved, minWidth = 0, minHeight = 0) {
  if (!saved || typeof saved !== 'object') return false;
  if (!num(saved.x) || !num(saved.y) || !num(saved.width) || !num(saved.height)) return false;
  return Number(saved.width) >= Math.max(1, minWidth) && Number(saved.height) >= Math.max(1, minHeight);
}

/** The bounds to store: whole numbers, nothing else carried along. */
function toSaved(b) {
  return { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) };
}

/** True when the stored place already matches (no write needed). */
function same(saved, b) {
  return !!saved && !!b && saved.x === Math.round(b.x) && saved.y === Math.round(b.y)
    && saved.width === Math.round(b.width) && saved.height === Math.round(b.height);
}

/**
 * True when all four corners of `b` lie on some work area (each corner may be
 * on a different monitor). Such a window is fully usable where it is, even
 * across two monitors, so it is restored exactly; only one hanging off a
 * screen (or into the gap beside a shorter monitor) is pulled back. Before
 * this, every restore was pushed onto ONE display, so a window straddling two
 * monitors came back shifted (Casey 2026-11-11).
 * areas: [{x, y, width, height}] (Electron display.workArea).
 */
function onWorkAreas(b, areas) {
  if (!b || !Array.isArray(areas) || !areas.length) return false;
  const inside = (px, py) => areas.some((a) => a && px >= a.x && px < a.x + a.width && py >= a.y && py < a.y + a.height);
  const r = b.x + b.width - 1, btm = b.y + b.height - 1;
  return inside(b.x, b.y) && inside(r, b.y) && inside(b.x, btm) && inside(r, btm);
}

module.exports = { restorable, toSaved, same, onWorkAreas };
