/**
 * JTCAT window layout (#857): Full or Compact, picked by itself on a short
 * screen (a 1366x768 laptop) unless the operator chose one.
 *
 * Options > The picture > Layout: Automatic (default), Full, Compact. Saved as
 * jtcatLayout (GLOBAL_KEY: a property of this screen). An explicit Full or
 * Compact always wins. Only the operator's choice is saved, never the
 * automatic pick. The window is never moved or resized; only body.jp-compact
 * changes (renderer/jtcat-popout.html holds the compact CSS).
 *
 * Automatic decides by the SCREEN's usable height, its work area (the screen
 * minus the taskbar or menu bar and dock), not by the window's height (Casey,
 * 2026-11-23): Full when the work area fits the Full layout, Compact only on a
 * short screen. So the default 700 px window opens Full on a tall screen, and
 * dragging the window taller or shorter never switches the layout.
 *
 * The threshold comes from the layout, measured in a scratch Electron window
 * 1100 px wide (2026-11-23, #987): in the Full layout the chrome (title bar,
 * toolbar, audio row, waterfall, the two control rows, the status strip)
 * takes about 520 px, and Band Activity shows fewer than four decode lines
 * below about 790 px of window height. A window that tall plus its frame
 * (about 30 to 40 px of title bar) needs a work area of 840 px, the edge #987
 * already used for "back to Full". So: Full from 840 px of work area, Compact
 * below it. 1366x768 (728 px work area) is Compact; 1920x1080 at 100%
 * (1032 px) is Full; 1920x1080 at 125% scaling (about 824 px) is Compact.
 *
 * No hysteresis: the work area only changes when the window moves to another
 * display, a display's settings change, or the zoom steps, and each of those
 * is one discrete step, never a drag that wobbles across the edge.
 *
 * Zoom: the rule is in CSS px, the work area divided by the page zoom (Ctrl
 * and minus / plus). Electron reports screen.availHeight in device-independent
 * px whatever the zoom (measured in Electron 39, 2026-11-23), so the window
 * divides by its zoom factor. Zooming out gives the page more CSS px, so on a
 * 125% laptop one Ctrl and minus (0.9) brings the Full layout back, and
 * zooming in far enough (1.3 on a 1080 screen) goes Compact.
 *
 * Dual-mode: require() in tests, window.JtcatLayout in the JTCAT window.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.JtcatLayout = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CHOICES = ['auto', 'full', 'compact'];
  const DEFAULT_CHOICE = 'auto';
  /** Automatic is Full when the screen's work area is at least this tall (CSS px). */
  const FULL_FROM = 840;
  /** ...and Compact below the same edge: one edge, no hysteresis band. */
  const COMPACT_BELOW = FULL_FROM;

  /** A saved value as a choice. Nothing saved (every install before #857) or anything unknown is Automatic. */
  function normalizeChoice(v) {
    return CHOICES.indexOf(v) !== -1 ? v : DEFAULT_CHOICE;
  }

  /** The work area in CSS px: its height in device-independent px over the page zoom (1 when unknown). */
  function cssScreenHeight(workAreaHeight, zoom) {
    const z = Number(zoom);
    return Number(workAreaHeight) / (isFinite(z) && z > 0 ? z : 1);
  }

  /**
   * The layout to show.
   * @param {{choice?: string, screenHeight?: number, zoom?: number, current?: string}} o
   *   choice: the operator's choice; screenHeight: the work-area height of the
   *   display the window is on (device-independent px); zoom: the page zoom
   *   factor; current: the layout on screen now ('full' | 'compact').
   *   The window's own height is not an input.
   * @returns {'full'|'compact'}
   */
  function pick(o) {
    o = o || {};
    const choice = normalizeChoice(o.choice);
    if (choice === 'full' || choice === 'compact') return choice;
    const current = o.current === 'compact' ? 'compact' : 'full';
    const h = cssScreenHeight(o.screenHeight, o.zoom);
    if (!isFinite(h) || h <= 0) return current;
    return h < COMPACT_BELOW ? 'compact' : 'full';
  }

  return { CHOICES, DEFAULT_CHOICE, COMPACT_BELOW, FULL_FROM, normalizeChoice, cssScreenHeight, pick };
});
