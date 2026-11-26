'use strict';

// Text macros that carry the operator's own grid square, when no grid is set.
//
// A fresh install now leaves the grid blank until the operator types one
// (first run, part 1). A macro must never put a broken phrase on the air or
// in a public spot because of that. Each macro gets the treatment that keeps
// its meaning:
//
//   Re-spot comment {QTH} ("59 in {QTH} 73s K1ABC via POTACAT"): the phrase
//   is a courtesy, not information the activator needs. With no grid the
//   "in {QTH}" goes and the rest posts: "59 73s K1ABC via POTACAT".
//
//   PSK $GRID ("QTH grid $GRID $GRID"): the grid IS the message. Dropping it
//   would send "QTH grid" with nothing after it, so the macro is refused with
//   a sentence and nothing goes into the transmit box.
//
// CW {MYGRID} is refused the same way in lib/cw-banks.js (expandVars), and
// an SSTV picture drops its "Grid {GRID}" line part in lib/sstv-templates.js
// (fillVars): a picture still makes sense without it.
//
// Pure. Dual-mode: require() in node, window.GridMacros in a page (index,
// Log pop-out, JTCAT pop-out; ECHOCAT Web gets it inlined by remote-server).

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GridMacros = api;
}(typeof self !== 'undefined' ? self : this, function () {
  const NO_GRID_TEXT = 'Not sent: this macro sends your grid square, and none is set. Add it in Settings > Station.';

  function cleanGrid(grid) {
    return String(grid == null ? '' : grid).trim();
  }

  /**
   * Fill {QTH} in a re-spot comment. With a grid, every {QTH} becomes it.
   * Without one, "in {QTH}" (or "from"/"at"/"near") is removed with its
   * spaces, any other {QTH} is removed, and the spacing is tidied so the
   * comment never reads "59 in  73s".
   */
  function fillRespotQth(text, grid) {
    const g = cleanGrid(grid);
    const s = String(text == null ? '' : text);
    if (g) return s.replace(/\{QTH\}/gi, g);
    if (!/\{QTH\}/i.test(s)) return s;
    return s
      .replace(/\s*\b(?:in|from|at|near)\s+\{QTH\}/gi, '')
      .replace(/\{QTH\}/gi, '')
      .replace(/\s+([;,.!])/g, '$1')
      .replace(/^[\s;,.]+/, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  /** True when a PSK macro uses $GRID and there is no grid to fill it. */
  function pskMacroBlocked(text, grid) {
    return /\$GRID/.test(String(text || '')) && !cleanGrid(grid);
  }

  return { NO_GRID_TEXT, fillRespotQth, pskMacroBlocked };
}));
