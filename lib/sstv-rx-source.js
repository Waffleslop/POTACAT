// Where SSTV hears pictures from, and the SSTV window's frequency rules
// (Casey 2026-11-11: "tune into the ISS via a SDR and decode SSTV").
//
//  - settings.sstvRxSource 'radio' (default) | 'sdr'. With the SDR, its
//    audio feeds the SSTV decoder and the window's waterfall, the radio's
//    audio does not, the SDR follows the SSTV window's frequency, and SSTV
//    does not transmit (the SDR cannot hear you and is not your radio).
//  - FM above 30 MHz: 2 m and 70 cm SSTV (the ISS on 145.800) is FM. Below,
//    LSB under 10 MHz except 60 m (USB by regulation), USB above.
//  - The frequency box takes kHz or MHz: a number under 1000 is MHz
//    (no amateur SSTV runs below 1 MHz), so "145.8" and "145800" are the same.
// Dual-mode: require() in main, window.SstvRxSource in the SSTV window.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SstvRxSource = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SOURCES = ['radio', 'sdr'];
  var LABELS = { radio: 'Radio', sdr: 'SDR' };

  // The ISS's SSTV downlink (ARISS events): 145.800 MHz FM, worldwide.
  var ISS = { freqKhz: 145800, mode: 'FM', label: 'ISS 145.800 (FM)' };

  /** Anything unknown (an old settings file) is the radio. */
  function normalize(v) { return v === 'sdr' ? 'sdr' : 'radio'; }

  var TX_REFUSAL = 'SSTV is receiving from the SDR, so it does not transmit: the SDR cannot hear you and is not on your radio\'s frequency. To send a picture, set Receive from back to Radio in the SSTV window.';

  /** The refusal for a transmit, or null when TX may go ahead. */
  function txRefusal(source) { return normalize(source) === 'sdr' ? TX_REFUSAL : null; }

  /** The mode SSTV uses on a frequency (kHz). */
  function freqMode(freqKhz) {
    var k = Number(freqKhz);
    if (!(k > 0)) return 'USB';
    if (k >= 30000) return 'FM';
    if (k >= 5250 && k <= 5450) return 'USB';
    return k < 10000 ? 'LSB' : 'USB';
  }

  /**
   * What the operator typed in the frequency box -> kHz, or null.
   * "14230", "14.230", "145.8", "145800", "437.550 MHz", "7171 kHz".
   */
  function parseFreq(text) {
    var s = String(text == null ? '' : text).trim().toLowerCase().replace(/,/g, '.');
    var unit = /mhz$/.test(s) ? 'mhz' : /khz$/.test(s) ? 'khz' : '';
    s = s.replace(/\s*(mhz|khz)$/, '').trim();
    if (!/^\d+(\.\d+)?$/.test(s)) return null;
    var n = parseFloat(s);
    if (!(n > 0)) return null;
    var khz = unit === 'mhz' || (!unit && n < 1000) ? n * 1000 : n;
    if (khz < 1000 || khz > 1.5e6) return null;
    return Math.round(khz * 10) / 10;
  }

  /**
   * The SDR's tune for an SSTV frequency. FM is the satellite channel
   * ('fmw', +-12 kHz, room for the ISS's +-3.5 kHz Doppler) on an rtl_tcp
   * SDR, narrow FM on a KiwiSDR, FM on a WebSDR.org; sidebands as they are.
   * @param {number} freqKhz
   * @param {string} [mode] the SSTV window's mode, else freqMode()
   * @param {string} [sdrKind] 'rtl_tcp' | 'kiwisdr' | 'websdr'
   */
  function sdrTune(freqKhz, mode, sdrKind) {
    var k = Number(freqKhz);
    if (!(k > 0)) return null;
    var m = String(mode || freqMode(k)).toUpperCase();
    var sdrMode;
    if (m === 'FM') sdrMode = sdrKind === 'rtl_tcp' ? 'fmw' : sdrKind === 'kiwisdr' ? 'nbfm' : 'fm';
    else if (m === 'LSB') sdrMode = 'lsb';
    else sdrMode = 'usb';
    return { freqKhz: k, mode: sdrMode };
  }

  return { SOURCES: SOURCES, LABELS: LABELS, ISS: ISS, TX_REFUSAL: TX_REFUSAL, normalize: normalize, txRefusal: txRefusal, freqMode: freqMode, parseFreq: parseFreq, sdrTune: sdrTune };
});
