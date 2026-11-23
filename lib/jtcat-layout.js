/**
 * JTCAT window layout (#857): Full or Compact, picked by itself on a short
 * window (a 1366x768 laptop) unless the operator chose one.
 *
 * Options > The picture > Layout: Automatic (default), Full, Compact. Saved as
 * jtcatLayout (GLOBAL_KEY: a property of this screen). An explicit Full or
 * Compact always wins. Only the operator's choice is saved, never the
 * automatic pick. The window is never moved or resized; only body.jp-compact
 * changes (renderer/jtcat-popout.html holds the compact CSS).
 *
 * The thresholds come from the layout, measured in a scratch Electron window
 * 1100 px wide (2026-11-23): in the Full layout the chrome (title bar,
 * toolbar, audio row, waterfall, the two control rows, the status strip)
 * takes about 520 px, and Band Activity gets half of what is left after its
 * header. Below about 790 px it shows fewer than four decode lines (77 px,
 * two and a half lines, at the default 700 px; nothing at 560 px). So the
 * window goes compact below 800 px and comes back to Full from 840 px: the
 * 40 px between them is the hysteresis, so a drag that wobbles across the
 * edge switches once. The height is the window's own (CSS px), which never
 * exceeds the screen's work area, and zooming out (Ctrl and minus) gives the
 * page more CSS px, so the zoom keys stay a manual way to get the Full layout.
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
  /** Automatic goes compact when the window is shorter than this (CSS px). */
  const COMPACT_BELOW = 800;
  /** ...and back to Full only once it is at least this tall. */
  const FULL_FROM = 840;

  /** A saved value as a choice. Nothing saved (every install before #857) or anything unknown is Automatic. */
  function normalizeChoice(v) {
    return CHOICES.indexOf(v) !== -1 ? v : DEFAULT_CHOICE;
  }

  /**
   * The layout to show.
   * @param {{choice?: string, height?: number, current?: string}} o
   *   choice: the operator's choice; height: the window's inner height (CSS px);
   *   current: the layout on screen now ('full' | 'compact').
   * @returns {'full'|'compact'}
   */
  function pick(o) {
    o = o || {};
    const choice = normalizeChoice(o.choice);
    if (choice === 'full' || choice === 'compact') return choice;
    const current = o.current === 'compact' ? 'compact' : 'full';
    const h = Number(o.height);
    if (!isFinite(h) || h <= 0) return current;
    if (current === 'compact') return h >= FULL_FROM ? 'full' : 'compact';
    return h < COMPACT_BELOW ? 'compact' : 'full';
  }

  return { CHOICES, DEFAULT_CHOICE, COMPACT_BELOW, FULL_FROM, normalizeChoice, pick };
});
