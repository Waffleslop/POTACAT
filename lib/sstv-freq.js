/**
 * The SSTV window's frequency box (#359).
 *
 *  - It takes kHz or MHz. A number under 1000 is MHz (no amateur SSTV runs
 *    below 1 MHz), so "145.8", "145.800 MHz" and "145800" are the same, and
 *    "14230" and "14.230" are the same. A trailing "kHz" or "MHz" says so
 *    outright; a comma counts as the decimal point.
 *  - The mode for a frequency: FM from 2 m up (the ISS and 2 m / 70 cm SSTV
 *    are FM); below that the voice sideband from lib/ssb-sideband.js, the one
 *    copy of that rule (6 m SSTV on 50.680 stays USB).
 *  - The radio's frequency poll never writes the box while the operator is in
 *    it, nor for a while after he typed and clicked away without tuning: an
 *    edit is his until he tunes it, picks a channel, or leaves it alone for
 *    EDIT_HOLD_MS.
 *
 * Dual-mode: require() in tests, window.SstvFreq in the SSTV window (loaded
 * after lib/ssb-sideband.js).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./ssb-sideband'));
  else root.SstvFreq = factory(root.SsbSideband);
})(typeof self !== 'undefined' ? self : this, function (SsbSideband) {
  'use strict';

  var FM_FROM_KHZ = 144000;      // 2 m and up: FM
  var MIN_KHZ = 1000;            // 1 MHz
  var MAX_KHZ = 1500000;         // 1.5 GHz
  var EDIT_HOLD_MS = 10000;      // an unsent edit is kept this long after the last keystroke

  /**
   * What the operator typed -> kHz (one decimal), or null when it is not a
   * frequency SSTV can use.
   */
  function parseFreqKhz(text) {
    var s = String(text == null ? '' : text).trim().toLowerCase().replace(/,/g, '.').replace(/\s+/g, '');
    var unit = '';
    var m = /^(.*?)(mhz|khz)$/.exec(s);
    if (m) { s = m[1]; unit = m[2]; }
    if (!/^\d+(\.\d+)?$|^\.\d+$/.test(s)) return null;
    var n = parseFloat(s);
    if (!(n > 0)) return null;
    var khz = unit === 'mhz' || (!unit && n < 1000) ? n * 1000 : n;
    if (khz < MIN_KHZ || khz > MAX_KHZ) return null;
    return Math.round(khz * 10) / 10;
  }

  /** The mode SSTV uses on a frequency in kHz: FM from 2 m up, else the voice sideband. */
  function modeForKhz(freqKhz) {
    var k = Number(freqKhz) || 0;
    if (k >= FM_FROM_KHZ) return 'FM';
    return SsbSideband.ssbSideband(k * 1000);
  }

  /**
   * May the radio's frequency poll write the box now?
   * @param {{ focused: boolean, editedAtMs: number, nowMs: number }} s
   *   focused: the box has the keyboard; editedAtMs: the last keystroke of an
   *   edit not yet tuned (0 when there is none).
   */
  function radioMayWriteBox(s) {
    var st = s || {};
    if (st.focused) return false;
    var at = Number(st.editedAtMs) || 0;
    if (at > 0 && (Number(st.nowMs) || 0) - at < EDIT_HOLD_MS) return false;
    return true;
  }

  return {
    FM_FROM_KHZ: FM_FROM_KHZ,
    EDIT_HOLD_MS: EDIT_HOLD_MS,
    parseFreqKhz: parseFreqKhz,
    modeForKhz: modeForKhz,
    radioMayWriteBox: radioMayWriteBox,
  };
});
