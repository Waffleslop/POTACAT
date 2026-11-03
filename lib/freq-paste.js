/**
 * A frequency pasted into the VFO window's type-to-tune box (hoogskev
 * 2026-10-31: "Type a frequency" took no paste). What people copy:
 * "14.074", "14,074" (a decimal comma), "14074 kHz", "14.074 MHz",
 * "14074000 Hz", "14.074.000" (a radio's or logger's dotted display),
 * "14,074.5" (thousands comma). The unit wins when given; otherwise the
 * keypad's own rule: a decimal point means MHz, else > 300000 is Hz,
 * > 300 is kHz, anything smaller is MHz.
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
    if (val > 300000) return val / 1000;
    if (val > 300) return val;
    return val * 1000;
  }

  return { parsePastedFreq };
});
