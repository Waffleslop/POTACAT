'use strict';
/**
 * Arrow-key row stepping in the Directory (Nets, Broadcast, Landmarks,
 * Channels): where the next Up or Down moves from (#501).
 *
 * The position is remembered per tab, because Nets and Broadcast show a row
 * as tuned only once the radio echoes the frequency back, so the highlighted
 * row cannot be trusted straight after a step. A click on a row sets the
 * position to that row, so the next arrow moves on from the row the operator
 * clicked, not from the last row the arrows reached. Switching tabs drops the
 * position: the new tab starts from its own selected row, or the first row.
 *
 * DOM-free so it can be tested; renderer/app.js finds the rows and clicks them.
 * Dual-mode: require() in tests, window.DirectoryKeyNav in the renderer.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DirectoryKeyNav = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  function initial() { return { tab: null, idx: -1 }; }

  /**
   * A click on row `idx` of `tab`. A click that is not on a row (idx < 0,
   * e.g. the header) leaves the position as it was.
   */
  function clickAt(state, tab, idx) {
    if (!Number.isInteger(idx) || idx < 0) return state || initial();
    return { tab, idx };
  }

  /**
   * One arrow press. `dir` is +1 (Down) or -1 (Up); `rowCount` is the number
   * of visible rows; `selectedIdx` is the row the tab shows as selected or
   * tuned (-1 for none), used when there is no remembered position.
   * Returns the new state; its idx is the row to click (-1 when no rows).
   * The ends clamp: Up on the first row and Down on the last stay put.
   */
  function step(state, tab, rowCount, selectedIdx, dir) {
    if (!(rowCount > 0)) return { tab, idx: -1 };
    let idx = state && state.tab === tab ? state.idx : -1;
    if (!(idx >= 0 && idx < rowCount)) idx = (selectedIdx >= 0 && selectedIdx < rowCount) ? selectedIdx : -1;
    if (idx < 0) idx = dir > 0 ? 0 : rowCount - 1;
    else idx = Math.max(0, Math.min(rowCount - 1, idx + (dir > 0 ? 1 : -1)));
    return { tab, idx };
  }

  return { initial, clickAt, step };
}));
