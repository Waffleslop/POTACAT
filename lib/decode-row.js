/**
 * FT8 / FT4 / FT2 decode rows — one copy of the cell markup for ECHOCAT Web
 * (inlined by remote-server like scope-axis) and the desktop JTCAT window
 * (<script src>), so the layout test (test/layout-alignment-test.js) renders
 * exactly what users see.
 *
 * Why it exists (2026-10-22): FT4 rows showed "+10.9874995727539" because the
 * dB went to the screen as it came; the long number pushed the row's other
 * columns out of line. Every number a row shows is formatted HERE, so a new
 * decoder or mode cannot put a raw float on screen again.
 *
 * Dual-mode: require() in Node/tests, window.DecodeRow in the pages.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DecodeRow = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  // null/''/undefined are "unknown", not 0 (Number(null) is 0).
  function num(v) { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }

  /** Whole dB, signed when not negative: "+11", "-3", "+0". */
  function formatDb(db) {
    const n = num(db);
    if (n === null) return '';
    const r = Math.round(n);
    return (r >= 0 ? '+' : '') + r;
  }
  /** "+0.2" / "-1.8" — one decimal, signed; '' when unknown. */
  function formatDt(dt) {
    const n = num(dt);
    if (n === null) return '';
    const r = Math.round(n * 10) / 10;
    return (r >= 0 ? '+' : '') + r.toFixed(1);
  }
  /** Audio offset in whole Hz. */
  function formatDf(df) {
    const n = num(df);
    return n === null ? '' : String(Math.round(n));
  }

  /** The three numeric cells, class prefix 'ft8' (web) or 'jp' (JTCAT window). */
  function numberCells(d, prefix) {
    const p = prefix || 'ft8';
    return '<span class="' + p + '-db">' + formatDb(d && d.db) + '</span>' +
      '<span class="' + p + '-dt">' + formatDt(d && d.dt) + '</span>' +
      '<span class="' + p + '-df">' + formatDf(d && d.df) + '</span>';
  }

  /**
   * ECHOCAT Web row content. `badgesHtml` / `entityHtml` are built by the
   * page (they are markup it owns); the text is escaped here.
   */
  function webRowInner(d, text, badgesHtml, entityHtml) {
    return numberCells(d, 'ft8') +
      '<span class="ft8-msg">' + esc(text != null ? text : (d && d.text)) + '</span>' +
      (badgesHtml ? '<span class="ft8-badges">' + badgesHtml + '</span>' : '') +
      (entityHtml || '');
  }

  /**
   * JTCAT window row content. opts: { time, bandBadgeHtml, text, wlEmoji,
   * badgesHtml, entityHtml }. `time` adds the leading period-start cell
   * (My Activity rows); Band Activity rows have no time cell.
   */
  function popoutRowInner(d, opts) {
    const o = opts || {};
    const text = o.text != null ? o.text : (d && d.text);
    return (o.time ? '<span class="jp-time">' + esc(o.time) + '</span>' : '') +
      (o.bandBadgeHtml || '') +
      numberCells(d, 'jp') +
      '<span class="jp-msg">' + esc(text) +
        (o.wlEmoji ? '<span class="jp-wl-emoji">' + esc(o.wlEmoji) + '</span>' : '') +
      '</span>' +
      (o.badgesHtml ? '<span class="jp-badges">' + o.badgesHtml + '</span>' : '') +
      (o.entityHtml || '');
  }

  /**
   * Our own transmission in a decode list: "TX" in the dB cell and EMPTY
   * dt/df cells, so the message starts on the same x as every decode. (The
   * TX rows used to skip the dt cell, and on the web the df cell too, so
   * their message sat one or two columns left of the decodes.)
   */
  function txRowInner(message, prefix, dfText) {
    const p = prefix || 'ft8';
    return '<span class="' + p + '-db">TX</span><span class="' + p + '-dt"></span>' +
      '<span class="' + p + '-df">' + esc(dfText == null ? '' : dfText) + '</span>' +
      '<span class="' + p + '-msg">' + esc(message) + '</span>';
  }

  return { esc, formatDb, formatDt, formatDf, numberCells, webRowInner, popoutRowInner, txRowInner };
});
