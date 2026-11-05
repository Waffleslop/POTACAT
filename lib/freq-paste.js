/**
 * A frequency pasted into the VFO window's type-to-tune box (hoogskev
 * 2026-10-31: "Type a frequency" took no paste). What people copy:
 * "14.074", "14,074" (a decimal comma), "14074 kHz", "14.074 MHz",
 * "14074000 Hz", "14.074.000" (a radio's or logger's dotted display),
 * "14,074.5" (thousands comma). The unit wins when given; otherwise the
 * keypad's own rule: a decimal point means MHz, else > 300000 is Hz (or kHz
 * when only that lands on an amateur band: 432100, 1296100), > 300 is kHz,
 * anything smaller is MHz.
 * Dual-mode: require() in tests, window.FreqPaste in the VFO window.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FreqPaste = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** @returns {number} kHz, or 0 when the text is not a frequency */
  function parsePastedFreq(text) {
    let s = String(text == null ? '' : text).trim().toLowerCase().replace(/[\s ]+/g, '');
    if (!s) return 0;
    let unit = '';
    const u = /(mhz|khz|hz)$/.exec(s);
    if (u) { unit = u[1]; s = s.slice(0, -unit.length); }
    // 14,074.5: a thousands comma, so the point is not "this is MHz"
    const thousands = s.includes(',') && (s.includes('.') || s.split(',').length > 2);
    if (thousands) s = s.replace(/,/g, '');
    else if (s.includes(',')) s = s.replace(',', '.').replace(/,/g, ''); // 14,074 = 14.074
    const dots = s.split('.');
    if (dots.length > 2) s = dots[0] + '.' + dots.slice(1).join('');   // 14.074.000
    if (!/^\d+(\.\d+)?$/.test(s)) return 0;
    const val = parseFloat(s);
    if (!(val > 0)) return 0;
    if (unit === 'mhz') return val * 1000;
    if (unit === 'khz') return val;
    if (unit === 'hz') return val / 1000;
    if (s.includes('.') && !thousands) return val * 1000;
    return bareToKhz(val);
  }

  // Amateur bands in kHz, for the one ambiguous case below.
  const HAM_KHZ = [[135.7, 137.8], [472, 479], [1800, 2000], [3500, 4000], [5250, 5450], [7000, 7300],
    [10100, 10150], [14000, 14350], [18068, 18168], [21000, 21450], [24890, 24990], [28000, 29700],
    [50000, 54000], [70000, 70500], [144000, 148000], [222000, 225000], [420000, 450000], [902000, 928000],
    [1240000, 1300000], [2300000, 2450000], [3300000, 3500000], [5650000, 5925000], [10000000, 10500000],
    [24000000, 24250000]];
  const inHamBand = (khz) => HAM_KHZ.some(([lo, hi]) => khz >= lo && khz <= hi);
  // Bands a bare number may be read as kHz on: 2 m, 1.25 m, 70 cm and 23 cm
  // only. The whole ham list sent short-wave typed in Hz to microwaves
  // (10000000 for WWV tuned 10 GHz, 5900000 tuned 5.9 GHz), and 33 cm is left
  // out so 915000 stays 915 kHz AM broadcast.
  const KHZ_FALLBACK = [[144000, 148000], [222000, 225000], [420000, 450000], [1240000, 1300000]];
  const inKhzFallback = (khz) => KHZ_FALLBACK.some(([lo, hi]) => khz >= lo && khz <= hi);

  /**
   * A bare number of digits (no point, no unit) in kHz. Above 300000 it is
   * Hz, unless that lands on no amateur band and the number read as kHz
   * lands on 2 m, 1.25 m, 70 cm or 23 cm: 432100 is 70 cm and 1296100 is 23 cm, not 0.43 and 1.3 MHz
   * (davidcappello, IC-9700), while 14074000 stays 14.074 MHz and 10136000
   * stays 30 m. Up to 300000 it is kHz, and 300 or less is MHz.
   */
  function bareToKhz(val) {
    if (val > 300000) {
      if (inHamBand(val / 1000)) return val / 1000;
      if (inKhzFallback(val)) return val;
      return val / 1000;
    }
    if (val > 300) return val;
    return val * 1000;
  }

  /** What the keypad's typed text means, in kHz, or 0 (the same rules as a paste). */
  function typedToKhz(buf) {
    const s = String(buf == null ? '' : buf).trim();
    if (!/^\d+(\.\d*)?$/.test(s)) return 0;
    const val = parseFloat(s);
    if (!(val > 0)) return 0;
    if (s.includes('.')) return val * 1000;
    return bareToKhz(val);
  }

  return { parsePastedFreq, typedToKhz };
});
