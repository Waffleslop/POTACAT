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
   * The df cell of our own TX row: the audio offset that transmission went
   * out on, in whole Hz, as WSJT-X shows it (#503). `txHz` is the txFreq of
   * the state:'tx' jtcat-tx-status, stamped when that slot keyed, so a slider
   * moved since does not rewrite history. Unknown (missing, 0) shows
   * `unknownText` ('' when not given).
   */
  function txDfText(txHz, unknownText) {
    const n = num(txHz);
    return n !== null && n > 0 ? String(Math.round(n)) : (unknownText == null ? '' : String(unknownText));
  }

  /**
   * Our own transmission in a decode list: "TX" in the dB cell, an empty dt
   * cell and the TX offset in the df cell, so the message starts on the same
   * x as every decode. (The TX rows used to skip the dt cell, and on the web
   * the df cell too, so their message sat one or two columns left of the
   * decodes.) `txHz` is a number (formatted by txDfText) or a ready string.
   */
  function txRowInner(message, prefix, txHz, unknownText) {
    const p = prefix || 'ft8';
    return '<span class="' + p + '-db">TX</span><span class="' + p + '-dt"></span>' +
      '<span class="' + p + '-df">' + esc(txDfText(txHz, unknownText)) + '</span>' +
      '<span class="' + p + '-msg">' + esc(message) + '</span>';
  }

  /**
   * A QSO was just logged: decodes already on screen stop calling that
   * station a new call, its grid a new grid, and its entity a new DXCC on
   * that band (level_death 2026-10-31: the G stayed after logging). Mutates
   * the decodes; returns how many flags it cleared.
   */
  function clearWorkedFlags(decodes, worked) {
    const w = worked || {};
    const up = (v) => String(v == null ? '' : v).trim().toUpperCase();
    const call = up(w.call), grid = up(w.grid).slice(0, 4), entity = String(w.entity || ''), band = up(w.band);
    let n = 0;
    for (const d of decodes || []) {
      if (!d) continue;
      if (call && d.newCall && up(d.call) === call) { d.newCall = false; n++; }
      if (grid && d.newGrid && up(d.grid).slice(0, 4) === grid) { d.newGrid = false; n++; }
      if (entity && d.newDxcc && d.entity === entity && (!d.band || !band || up(d.band) === band)) { d.newDxcc = false; n++; }
    }
    return n;
  }

  // ---------------------------------------------------------------------
  // Stations list rows (#557): one row per station heard, built from a
  // lib/jtcat-stations.js entry. The header uses the same cells, so the
  // layout test can check that every column title sits over its column.
  // ---------------------------------------------------------------------

  /** Columns in order. `sort` names the list order a click on the title picks. */
  const STATION_COLUMNS = [
    { key: 'call', label: 'Call', sort: 'call', title: 'Sort by call, A to Z' },
    { key: 'need', label: 'Need', hint: 'What this station would give you: D a new country, a state code for a new state, G a new grid, C a new call. The key is at the bottom of the list.' },
    { key: 'calling', label: 'Calling' },
    { key: 'park', label: 'Park', hint: 'The park or summit, when the station is spotted there on this band, or names it in its CQ' },
    { key: 'grid', label: 'Grid' },
    { key: 'country', label: 'Country' },
    { key: 'state', label: 'State' },
    { key: 'db', label: 'dB', sort: 'snr', title: 'Sort by signal, strongest first' },
    { key: 'df', label: 'Hz' },
    { key: 'age', label: 'Age', sort: 'last', title: 'Sort by last heard, newest first' },
  ];

  /** Time since last heard: "12s", then whole minutes "3m". '' when unknown. */
  function formatAge(ms) {
    const n = num(ms);
    if (n === null) return '';
    const s = Math.max(0, Math.floor(n / 1000));
    return s < 60 ? s + 's' : Math.floor(s / 60) + 'm';
  }

  /** The header row's cells; the column of the current sort is marked. */
  function stationHeaderInner(prefix, sort) {
    const p = prefix || 'jp';
    return STATION_COLUMNS.map((c) => {
      const on = c.sort && c.sort === sort;
      return '<span class="' + p + '-st-' + c.key + (c.sort ? ' ' + p + '-st-sortable' : '') + (on ? ' ' + p + '-st-sorted' : '') + '"' +
        (c.sort ? ' data-sort="' + c.sort + '" title="' + esc(c.title) + '" role="button" aria-sort="' + (on ? (c.sort === 'call' ? 'ascending' : 'descending') : 'none') + '"' : '') +
        (!c.sort && c.hint ? ' title="' + esc(c.hint) + '"' : '') +
        '>' + esc(c.label) + '</span>';
    }).join('');
  }

  // Needed marks (#557 part 2): the stream's badge letters (D, the state
  // code, G, C), so a mark reads the same in both views.
  /** " on 20m digital" / " (any band)" after a sentence; '' when unknown. */
  function scopePhrase(scopeText) {
    const t = String(scopeText || '').trim();
    if (!t) return '';
    return /^on /.test(t) ? ' ' + t : ' (' + t + ')';
  }

  /** The Need cell's badges for marks from JtcatStations.marksOf. */
  function stationMarksHtml(e, marks, prefix, scopeText) {
    const p = prefix || 'jp';
    const m = marks || {};
    const sc = scopePhrase(scopeText);
    const badge = (kind, text, title) => '<span class="' + p + '-st-mark ' + p + '-st-mark-' + kind + '" title="' + esc(title) + '">' + esc(text) + '</span>';
    let html = '';
    if (m.entity === 'new') html += badge('dxcc', 'D', 'New country: ' + (e.entity || 'this country') + ' is one you still need' + sc);
    if (m.state === 'new') html += badge('state', e.state, 'New state: ' + e.state + ' is one you still need' + sc);
    if (m.grid) html += badge('grid', 'G', 'New grid: you have not worked grid ' + (e.grid || '') + ' before');
    if (m.call) html += badge('call', 'C', 'New call: ' + (e.call || 'this station') + ' is not in your log yet');
    return html;
  }

  /** Worked / confirmed for a country or state cell: a class and the words for its tooltip. */
  function workedClass(status, prefix) {
    const p = prefix || 'jp';
    return status === 'confirmed' ? ' ' + p + '-st-confirmed' : status === 'worked' ? ' ' + p + '-st-worked' : '';
  }
  function workedTitle(name, status, scopeText) {
    const sc = scopePhrase(scopeText);
    if (status === 'confirmed') return name + ': worked and confirmed' + sc;
    if (status === 'worked') return name + ': worked' + sc + ', not confirmed yet';
    if (status === 'new') return name + ': not worked yet' + sc;
    return name;
  }

  /**
   * One station's cells. entry: a lib/jtcat-stations.js entry; now: the clock
   * the age is measured against. opts: { marks (JtcatStations.marksOf),
   * scopeText (WorkedOverlay.scopeText, "on 20m digital") }. Every value is
   * escaped and every number formatted here (whole dB, whole Hz).
   */
  function stationRowInner(entry, now, prefix, opts) {
    const p = prefix || 'jp';
    const e = entry || {};
    const o = opts || {};
    const m = o.marks || {};
    const t = num(now);
    const age = t !== null && num(e.lastHeard) !== null ? formatAge(t - e.lastHeard) : '';
    const cell = (key, text, title, extra) => '<span class="' + p + '-st-' + key + (extra || '') + '"' + (title ? ' title="' + esc(title) + '"' : '') + '>' + esc(text) + '</span>';
    const park = e.park && e.park.ref ? e.park : null;
    const parkTitle = park ? park.sig + ' ' + park.ref + (park.from === 'spot' ? ': spotted there on this band' : ': named in their CQ') : '';
    return cell('call', e.call) +
      '<span class="' + p + '-st-need">' + stationMarksHtml(e, m, p, o.scopeText) + '</span>' +
      cell('calling', e.calling) +
      cell('park', park ? park.ref : '', parkTitle) +
      cell('grid', e.grid) +
      cell('country', e.entity, e.entity ? workedTitle(e.entity, m.entity, o.scopeText) : '', workedClass(m.entity, p)) +
      cell('state', e.state, e.state ? workedTitle(e.state, m.state, o.scopeText) : '', workedClass(m.state, p)) +
      cell('db', formatDb(e.db)) +
      cell('df', formatDf(e.df)) +
      cell('age', age);
  }

  /**
   * The key under the Stations list: what each mark means, in words, with
   * the scope the worked colours are counted in.
   */
  function stationKeyHtml(prefix, scopeText) {
    const p = prefix || 'jp';
    const item = (kind, text, words) => '<span class="' + p + '-st-key-item"><span class="' + p + '-st-mark ' + p + '-st-mark-' + kind + '">' + esc(text) + '</span> ' + esc(words) + '</span>';
    const sc = String(scopeText || '').trim();
    return item('dxcc', 'D', 'new country') + item('state', 'NJ', 'new state (its code)') + item('grid', 'G', 'new grid') + item('call', 'C', 'new call') +
      '<span class="' + p + '-st-key-note">Country or state in this colour: <span class="' + p + '-st-worked">worked</span>, <span class="' + p + '-st-confirmed">confirmed</span>' +
      (sc ? ' (' + esc(sc) + ', as on the map)' : '') + '</span>';
  }

  return { esc, formatDb, formatDt, formatDf, numberCells, webRowInner, popoutRowInner, txDfText, txRowInner, clearWorkedFlags,
    STATION_COLUMNS, formatAge, stationHeaderInner, stationRowInner, stationMarksHtml, stationKeyHtml };
});
