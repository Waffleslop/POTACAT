'use strict';
/**
 * The grid square an operator typed for a park, remembered per park (#388).
 *
 * Choosing a park fills the activation's grid box from the park's position.
 * An operator who corrected it (the park's centre is not where they set up)
 * lost the correction the next time the box was filled: ending and starting
 * the activation again, a restart, or a resume from the log all re-derived
 * the grid from the park (Discord 2026-11-11).
 *
 * Corrections live in settings.activatorParkGrids as { "US-1234": "FN20AB" }.
 * A typed grid that is blank, not a grid, or the same as the park's own is
 * not a correction, and clears any stored one. Every place that fills the box
 * asks gridFor() first; main's record fill (lib/activation-station.js) does
 * the same, so contacts logged from the phone or by FT8 carry it too.
 *
 * Dual-mode: require() in tests and main, window.ParkGrid in the renderer.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ParkGrid = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  const MAX_PARKS = 200; // oldest correction dropped beyond this
  const GRID_RE = /^[A-R]{2}[0-9]{2}([A-X]{2}([0-9]{2})?)?$/;

  function refKey(ref) {
    // A multi-park record carries "US-1234,US-5678"; the first park's grid is the one in the box.
    return String(ref || '').split(',')[0].trim().toUpperCase();
  }

  /** "fn20ab " -> "FN20AB"; '' when it is not a 4, 6 or 8 character grid. */
  function normalizeGrid(grid) {
    const g = String(grid || '').trim().toUpperCase();
    return GRID_RE.test(g) ? g : '';
  }

  function sameGrid(a, b) {
    return normalizeGrid(a) !== '' && normalizeGrid(a) === normalizeGrid(b);
  }

  /** The grid for a park: the operator's correction, else the park's own. */
  function gridFor(store, ref, derived) {
    const key = refKey(ref);
    const saved = key && store && typeof store === 'object' ? normalizeGrid(store[key]) : '';
    return saved || String(derived || '');
  }

  /**
   * The store after the operator typed `typed` into the grid box for `ref`,
   * whose own grid is `derived`. Returns a new object; never mutates `store`.
   */
  function remember(store, ref, typed, derived) {
    const key = refKey(ref);
    const out = {};
    if (store && typeof store === 'object') {
      for (const k of Object.keys(store)) if (k !== key && normalizeGrid(store[k])) out[k] = normalizeGrid(store[k]);
    }
    if (!key) return out;
    const g = normalizeGrid(typed);
    if (g && !sameGrid(g, derived)) out[key] = g; // added last = newest
    const keys = Object.keys(out);
    for (let i = 0; i < keys.length - MAX_PARKS; i++) delete out[keys[i]];
    return out;
  }

  return { gridFor, remember, normalizeGrid, refKey, MAX_PARKS };
}));
