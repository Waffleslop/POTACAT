/**
 * ADIF MODE / SUBMODE, both directions, in one place (#381).
 *
 * ADIF files some modes as a SUBMODE of a family MODE: JS8 is MFSK/JS8, PSK31
 * is PSK/PSK31, FreeDV is DIGITALVOICE/FREEDV, and (spec and WSJT-X) FT4 is
 * MFSK/FT4. Inside POTACAT a contact's mode is the name an operator means:
 * JS8, PSK31, FT4. So:
 *
 *   adifModeSubmode(mode, submode)  app mode -> the { mode, submode } to write.
 *                                   Every ADIF writer goes through this.
 *   adifAppMode(MODE, SUBMODE)      a record's two fields -> the app mode:
 *                                   SUBMODE when MODE only names a family,
 *                                   otherwise MODE. Every reader that shows,
 *                                   filters, counts or matches a mode uses it.
 *
 * Old records keep working: MODE=FT4 (no SUBMODE) reads as FT4, and so does
 * MODE=MFSK SUBMODE=FT4.
 *
 * Dual-mode: require() in Node/tests, window.AdifMode in the pages (and
 * inlined into ECHOCAT Web by remote-server like freq-dots.js).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AdifMode = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** MODEs that only name a family; the SUBMODE is the real mode. */
  var FAMILY_MODES = ['MFSK', 'PSK', 'DIGITALVOICE'];

  function up(v) { return String(v == null ? '' : v).trim().toUpperCase(); }

  function isFamilyMode(mode) { return FAMILY_MODES.indexOf(up(mode)) !== -1; }

  /**
   * Normalize a mode string to ADIF's MODE/SUBMODE vocabulary. PSK31/PSK63/...
   * are SUBMODEs of MODE=PSK: LoTW and most loggers reject MODE=PSK31. An
   * explicit submode always wins (except for JS8, below).
   */
  function adifModeSubmode(mode, submode) {
    var m = up(mode);
    if (!submode && /^PSK\d+[A-Z]*$/.test(m)) return { mode: 'PSK', submode: m };
    // JS8 is a SUBMODE of MFSK in ADIF (3.1.1+). Bare MODE=JS8 is rejected by
    // LoTW and most loggers, the same failure class the PSK31 mapping fixes.
    // UNCONDITIONAL for JS8: the JS8 speed (Normal/Fast/Turbo/Slow/Ultra) is NOT
    // an ADIF distinction, and some callers tag it as `submode` (js8-qso.js);
    // if that leaked through it would write invalid MODE=JS8/SUBMODE=NORMAL. So
    // JS8 always collapses to MFSK/JS8 regardless of any submode passed in.
    if (m === 'JS8') return { mode: 'MFSK', submode: 'JS8' };
    // JTTY (WSJT-X 3.2, 2026-09) has no ADIF enumeration yet. It is 4-GFSK,
    // so MFSK/JTTY is the honest interim, the same shape ADIF gave FT4 and
    // JS8, and what adifAppMode() maps back. LoTW/TQSL will not accept the
    // submode until their config files learn it (the lotw-upload handler says
    // so once); revisit when ADIF does.
    if (m === 'JTTY') return { mode: 'MFSK', submode: 'JTTY' };
    // FT4 stays MODE=FT4 until the phone and the Cloud read SUBMODE (#381).
    return { mode: mode, submode: submode };
  }

  /** A record's MODE + SUBMODE -> the mode it is (uppercase, '' when none). */
  function adifAppMode(mode, submode) {
    var m = up(mode);
    var s = up(submode);
    if (s && isFamilyMode(m)) return s;
    return m;
  }

  /** adifAppMode of a raw ADIF field map ({ MODE, SUBMODE }). */
  function recordMode(rec) {
    return rec ? adifAppMode(rec.MODE, rec.SUBMODE) : '';
  }

  return {
    FAMILY_MODES: FAMILY_MODES,
    isFamilyMode: isFamilyMode,
    adifModeSubmode: adifModeSubmode,
    adifAppMode: adifAppMode,
    recordMode: recordMode,
  };
});
