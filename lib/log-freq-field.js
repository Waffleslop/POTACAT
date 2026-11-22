'use strict';
/**
 * A log form's frequency box: it SHOWS the frequency to 100 Hz and LOGS it to
 * the hertz (#794). A CW station spotted on 7.0355 MHz was logged 7.036000:
 * the boxes were filled with the dial rounded to whole kHz, and the main log
 * window's "7035.5" was both what it showed and what it saved, so a 1 Hz rig
 * on 7035512 Hz logged 7.035500.
 *
 * The rule: the code fills a box with fill(); the box shows the rounded text
 * and remembers the exact value. value() returns the exact kHz (up to three
 * decimals, 1 Hz) while the box still shows what fill() wrote, and the box's
 * own text once the operator has typed over it. Rounding is for the eye only.
 * (A box set to '' by other code and then typed with the very text fill()
 * last showed gives that fill's exact value: the same frequency within 50 Hz.)
 *
 * Dual-mode: require() in Node/tests; window.LogFreqField in the main window,
 * the Log and Logbook pop-outs, and ECHOCAT Web (inlined by remote-server).
 * `el` is anything with a `value` string and a `dataset` object.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LogFreqField = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  /** kHz to the hertz as text: 7035.512 -> "7035.512", 7035.5 -> "7035.5". '' when not a frequency. */
  function exactKhzText(khz) {
    const n = Number(khz);
    if (!Number.isFinite(n) || n <= 0) return '';
    return String(Math.round(n * 1000) / 1000);
  }

  /** What a box shows: kHz to 100 Hz ("7035.5"), or MHz to 100 Hz ("7.0355") for a box in MHz. */
  function shownText(khz, unit) {
    const n = Number(khz);
    if (!Number.isFinite(n) || n <= 0) return '';
    const tenths = Math.round(n * 10) / 10;
    return unit === 'mhz' ? (tenths / 1000).toFixed(4) : tenths.toFixed(1);
  }

  /** Fill a box from a spot, the dial or a prefill (kHz). Empty or 0 clears it. */
  function fill(el, khz, unit) {
    if (!el) return;
    const exact = exactKhzText(khz);
    const shown = exact ? shownText(khz, unit) : '';
    el.value = shown;
    if (!el.dataset) el.dataset = {};
    el.dataset.exactKhz = exact;
    el.dataset.shownFreq = shown;
  }

  /** The frequency to log, as text: the exact kHz behind an untouched box, else what is typed. */
  function value(el) {
    if (!el) return '';
    const typed = String(el.value == null ? '' : el.value).trim();
    const ds = el.dataset || {};
    if (ds.exactKhz && typed && typed === ds.shownFreq) return ds.exactKhz;
    return typed;
  }

  return { exactKhzText, shownText, fill, value };
});
