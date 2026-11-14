// DXCC tracker progress wording (GitHub #382).
//
// The tracker counts what its data holds. An ADIF log gives every logged QSO,
// confirmed or not, so the labels say "worked" and no "DXCC!" award is
// claimed. A Log4OM SQLite log is read confirmed-only (lib/adif.js
// parseSqliteConfirmed), so there the labels say "confirmed". basis is
// main's buildDxccData() `basis` ('worked' | 'confirmed'); anything else
// reads as 'worked', the claim that is never untrue.
//
// Dual-mode: require() from main and lib/award-tables.js (ECHOCAT), and
// window.DxccProgress via <script> in the main window. No top-level const.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DxccProgress = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var GOAL = 100;

  function dxccProgressText(count, basis, challenge) {
    var b = basis === 'confirmed' ? 'confirmed' : 'worked';
    var n = Number(count) || 0;
    var award = '';
    if (n >= GOAL) award = b === 'confirmed' ? 'DXCC!' : GOAL + ' entities worked';
    return {
      basis: b,
      count: n + ' / ' + GOAL + ' ' + b,
      award: award,
      challenge: challenge == null ? '' : 'Challenge: ' + (Number(challenge) || 0) + ' ' + b,
    };
  }

  return { dxccProgressText: dxccProgressText, GOAL: GOAL };
});
