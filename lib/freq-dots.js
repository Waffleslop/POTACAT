/**
 * A frequency the way the VFO writes it, for every place an operator READS one:
 * MHz, a dot, kHz, a dot, tens of hertz. 7100.5 kHz -> "7.100.50",
 * 162550 kHz -> "162.550.00", 475 kHz -> "0.475.00". Never a comma, never bare
 * kHz (Casey 2026-11-11, both apps; the phone writes the same two decimals).
 *
 * DISPLAY ONLY. Wire values, settings, ADIF and log fields, files and anything
 * sent to another program keep their own format. The VFO header and dial keep
 * their full-hertz "14.074.000" and do not use this.
 *
 * Dual-mode: require() in Node/tests, window.FreqDots in the pages (and inlined
 * into ECHOCAT Web by remote-server like spot-row.js).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FreqDots = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** kHz (number or numeric string) -> "14.074.00"; '' when not a frequency. */
  function fromKhz(khz) {
    if (khz == null || khz === '') return '';
    const n = Number(khz);
    if (!Number.isFinite(n) || n <= 0) return '';
    const t = Math.round(n * 100);           // tens of Hz
    const mhz = Math.floor(t / 100000);
    const k = Math.floor((t % 100000) / 100);
    const f = t % 100;
    return mhz + '.' + String(k).padStart(3, '0') + '.' + String(f).padStart(2, '0');
  }
  function fromHz(hz) { const n = Number(hz); return (hz == null || hz === '' || !Number.isFinite(n)) ? '' : fromKhz(n / 1000); }
  function fromMhz(mhz) { const n = Number(mhz); return (mhz == null || mhz === '' || !Number.isFinite(n)) ? '' : fromKhz(n * 1000); }

  /** The same with its unit: "14.074.00 MHz" ('' when not a frequency). */
  function withUnit(s) { return s ? s + ' MHz' : ''; }
  function khzMhz(khz) { return withUnit(fromKhz(khz)); }
  function hzMhz(hz) { return withUnit(fromHz(hz)); }
  function mhzMhz(mhz) { return withUnit(fromMhz(mhz)); }

  return { fromKhz, fromHz, fromMhz, khzMhz, hzMhz, mhzMhz };
});
