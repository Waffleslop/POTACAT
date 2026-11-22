// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// The SSTV window's Drive: the audio level SSTV sends to the radio (#279).
// Saved as settings.sstvTxGain, 0..1; shown as 0..100 %. A saved 0 is a real
// setting: `|| 0.5` used to turn it back into 50 % on reopen AND at transmit,
// so the bottom of the slider did nothing.
// Pure, dual-mode: `require` in tests, `window.SstvDrive` in the SSTV window.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SstvDrive = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DEFAULT_PCT = 50;

  /** The slider position (0..100) for a saved gain (0..1); 50 when unset or not a number. */
  function pctFromSaved(saved) {
    if (saved === null || saved === undefined || saved === '') return DEFAULT_PCT;
    var n = Number(saved);
    if (!isFinite(n)) return DEFAULT_PCT;
    return Math.round(Math.max(0, Math.min(1, n)) * 100);
  }

  /** The gain (0..1) for a slider position (0..100); 0 stays 0. */
  function gainFromPct(pct) {
    if (pct === null || pct === undefined || pct === '') return DEFAULT_PCT / 100;
    var n = Number(pct);
    if (!isFinite(n)) return DEFAULT_PCT / 100;
    return Math.round(Math.max(0, Math.min(100, n))) / 100;
  }

  /** What the window shows beside the slider. */
  function label(pct) {
    return Math.round(Math.max(0, Math.min(100, Number(pct) || 0))) + '%';
  }

  return { DEFAULT_PCT: DEFAULT_PCT, pctFromSaved: pctFromSaved, gainFromPct: gainFromPct, label: label };
});
