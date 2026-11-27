// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// What an SWR meter shows for one wire value (docs/echocat-protocol.md, `swr`:
// 0-255, ratio = 1 + value / 60). A radio reads SWR only while it transmits,
// and a perfect 1.0:1 match comes back as 0. Every display used to draw 0 as
// a dash, so a tuned antenna looked like "no reading" (IC-7100 with an
// external tuner, November 2026). Now:
//   - a value above 0 is that ratio, as before;
//   - 0 while transmitting is a reading: 1.0;
//   - 0 on receive is the rest value POTACAT sends after TX: a dash, as before.
// Callers keep the last wire value and draw again when TX ends, so a 1.0
// shown during the over turns back into a dash on receive.
//
// Pure, dual-mode: `require` in the tests, `window.SwrDisplay` in the main
// window, the VFO window and ECHOCAT Web (inlined by lib/remote-server.js).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SwrDisplay = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DASH = '—';

  /**
   * The SWR ratio to show, or null for a dash.
   * @param {number} value         wire value, 0-255 (null/undefined: nothing yet)
   * @param {boolean} transmitting the station's TX state at the display
   */
  function ratio(value, transmitting) {
    var v = Number(value);
    if (value == null || !isFinite(v)) return null;
    if (v > 0) return 1 + v / 60;
    return v === 0 && transmitting ? 1 : null;
  }

  /** The meter's text for a ratio from ratio(): "1.0", "2.4", ">10" or a dash. */
  function text(r) {
    if (r == null) return DASH;
    return r < 10 ? r.toFixed(1) : '>10';
  }

  return { ratio: ratio, text: text, DASH: DASH };
});
