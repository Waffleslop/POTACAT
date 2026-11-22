// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// Where SSTV may tune the radio by itself (#292, Casey 2026-11-10). Opening
// SSTV, or Idle Mode starting it, moved a radio set up for VHF/UHF only to
// 20 m. SSTV lives on HF here: a radio that cannot use the band is left where
// it is, and the window says why (Casey's choice: do not tune, no 2 m SSTV).
// Pure, dual-mode: `require` in main, `window.SstvStartBand` in the SSTV window.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./rig-bands'));
  else root.SstvStartBand = factory(root.RigBands);
})(typeof self !== 'undefined' ? self : this, function (RigBands) {
  'use strict';

  // Idle Mode's day and night channels (main.js getSstvAutoFreq).
  var DAY = { freqKhz: 14230, mode: 'USB', band: '20m' };
  var NIGHT = { freqKhz: 7171, mode: 'LSB', band: '40m' };

  function ok(bands, band) {
    return RigBands ? RigBands.allowed(bands, band) : true;
  }

  /**
   * Idle Mode's channel: day on 20 m, night on 40 m; the other one when the
   * radio cannot use the preferred band; null when it can use neither (do not
   * tune). A radio whose bands are not known (null) is not restricted.
   */
  function autoChannel(bands, daytime) {
    var first = daytime ? DAY : NIGHT;
    var second = daytime ? NIGHT : DAY;
    if (ok(bands, first.band)) return { freqKhz: first.freqKhz, mode: first.mode };
    if (ok(bands, second.band)) return { freqKhz: second.freqKhz, mode: second.mode };
    return null;
  }

  /**
   * The SSTV window's channel on open: the selected one if the radio can use
   * its band, else the first channel in the list it can use, else null.
   *   choices  [{ value, mode, band }] in list order (the frequency select)
   *   selected the selected choice's value
   */
  function windowChannel(bands, choices, selected) {
    var list = choices || [];
    var sel = list.filter(function (c) { return c.value === selected; })[0];
    if (sel && ok(bands, sel.band)) return sel;
    for (var i = 0; i < list.length; i++) if (ok(bands, list[i].band)) return list[i];
    return null;
  }

  var NO_BAND_NOTE = 'SSTV is on HF (20 m 14.230, 40 m 7.171). This radio is not set up for those bands, so it was left where it is.';

  return { DAY: DAY, NIGHT: NIGHT, autoChannel: autoChannel, windowChannel: windowChannel, NO_BAND_NOTE: NO_BAND_NOTE };
});
