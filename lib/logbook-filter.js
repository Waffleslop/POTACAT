/**
 * The Logbook filter and the Logbook map, from one set of rules (#702).
 *
 * The desktop Logbook window and the ECHOCAT Web Logbook both show "the QSOs a
 * search + filter set shows"; the desktop Logbook's map plots exactly those
 * rows. All three read the rules here, so a filter can never show one slice
 * in the list and another on the map.
 *
 *   filterQsos(qsos, f, ctx)   the rows a filter shows, in the input order.
 *                              f = { query, band, mode, region, from, to };
 *                              ctx.continentOf(CALL) answers the Region filter
 *                              (cty.dat in the desktop window; no Region on the web).
 *   isActive(f)                is any filter set (the "N / M QSOs" count).
 *   modeMatches(q, want)       the Mode filter: the family an operator means
 *                              (USB/LSB are SSB, PSK31/63 are PSK, MFSK/FT4 is FT4),
 *                              or the raw MODE for an option that names one (DIGI).
 *   mapStations(rows, locate, opts)
 *                              the filtered rows grouped into map points, one per
 *                              station, with the rows that have no location
 *                              counted, and a cap on the number of points.
 *   mapNote(summary)           the line the map shows about what it plots.
 *   debounce(fn, ms, timers)   the map follows the filter without redrawing on
 *                              every keystroke.
 *
 * Read-only: nothing here writes a record.
 *
 * Dual-mode: require() in Node/tests, window.LogbookFilter in the pages (and
 * inlined into ECHOCAT Web by remote-server like adif-mode.js).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./adif-mode'));
  else root.LogbookFilter = factory(root.AdifMode);
})(typeof self !== 'undefined' ? self : this, function (AdifMode) {
  'use strict';

  /** Most stations the map draws at once (each is drawn three times for world wrap). */
  var MAP_STATION_CAP = 5000;

  function up(v) { return String(v == null ? '' : v).trim().toUpperCase(); }

  function recordMode(q) { return AdifMode ? AdifMode.recordMode(q) : up(q && q.MODE); }

  /** The mode family a record is filed under in the Mode filter. */
  function modeFamily(q) {
    var m = recordMode(q);
    if (m === 'USB' || m === 'LSB') return 'SSB';
    if (/^PSK/.test(m)) return 'PSK';
    return m;
  }

  function modeMatches(q, want) {
    var w = up(want);
    if (!w) return true;
    return modeFamily(q) === w || recordMode(q) === w || up(q.MODE) === w;
  }

  /** The text the search box looks in. */
  function searchFields(q) {
    return [q.CALL, q.SIG_INFO || q.POTA_REF, q.COMMENT, recordMode(q), q.MODE, q.BAND];
  }

  function isActive(f) {
    f = f || {};
    return !!(String(f.query || '').trim() || f.band || f.mode || f.region || f.from || f.to);
  }

  /** Does one record pass the filter set? */
  function makeMatcher(f, ctx) {
    f = f || {};
    ctx = ctx || {};
    var query = up(f.query);
    var band = up(f.band);
    var mode = up(f.mode);
    var region = up(f.region);
    var from = String(f.from || '').replace(/-/g, '');
    var to = String(f.to || '').replace(/-/g, '');
    var continentOf = typeof ctx.continentOf === 'function' ? ctx.continentOf : null;
    return function (q) {
      if (!q) return false;
      if (band && up(q.BAND) !== band) return false;
      if (mode && !modeMatches(q, mode)) return false;
      if (region) {
        var c = continentOf ? continentOf(up(q.CALL)) : '';
        if (up(c) !== region) return false;
      }
      var d = String(q.QSO_DATE || '');
      if (from && d < from) return false;
      if (to && d > to) return false;
      if (!query) return true;
      var hay = searchFields(q);
      for (var i = 0; i < hay.length; i++) {
        if (up(hay[i]).indexOf(query) !== -1) return true;
      }
      return false;
    };
  }

  function filterQsos(qsos, f, ctx) {
    if (!Array.isArray(qsos)) return [];
    return qsos.filter(makeMatcher(f, ctx));
  }

  function qsoStamp(q) { return String(q.QSO_DATE || '') + String(q.TIME_ON || ''); }

  /**
   * Group filtered rows into map stations. locate(q) -> { lat, lon } | null.
   * Every row lands in exactly one place: a station's qsos, or the unplaced
   * count. When there are more stations than the cap, the ones worked most
   * recently are kept and the summary says so.
   */
  function mapStations(rows, locate, opts) {
    opts = opts || {};
    var cap = opts.cap == null ? MAP_STATION_CAP : opts.cap;
    var byCall = Object.create(null);
    var order = [];
    var unplaced = 0;
    var list = Array.isArray(rows) ? rows : [];
    for (var i = 0; i < list.length; i++) {
      var q = list[i];
      var call = up(q && q.CALL);
      if (!call) { unplaced++; continue; }
      var st = byCall[call];
      if (!st) {
        var pos = locate ? locate(q) : null;
        if (!pos || pos.lat == null || pos.lon == null || !isFinite(pos.lat) || !isFinite(pos.lon)) {
          // This record has no place; a later record of the same call may.
          unplaced++;
          continue;
        }
        st = byCall[call] = { call: call, lat: pos.lat, lon: pos.lon, qsos: [], last: '' };
        order.push(st);
      }
      st.qsos.push(q);
      var s = qsoStamp(q);
      if (s > st.last) st.last = s;
    }
    var stations = order;
    var capped = false;
    if (cap > 0 && order.length > cap) {
      capped = true;
      stations = order.slice().sort(function (a, b) { return a.last < b.last ? 1 : a.last > b.last ? -1 : 0; }).slice(0, cap);
    }
    var shownContacts = 0;
    for (var j = 0; j < stations.length; j++) shownContacts += stations[j].qsos.length;
    return {
      stations: stations,
      totalStations: order.length,
      shownStations: stations.length,
      contacts: list.length,
      shownContacts: shownContacts,
      unplaced: unplaced,
      capped: capped,
      cap: cap,
    };
  }

  function n(v) { return Number(v || 0).toLocaleString('en-US'); }
  function plural(v, one, many) { return n(v) + ' ' + (v === 1 ? one : many); }

  /** The line under the map: what it plots, the cap when it bites, what has no place. */
  function mapNote(s) {
    if (!s) return '';
    if (!s.contacts) return 'No contacts match the filter';
    var parts = [];
    if (s.capped) {
      parts.push('Showing ' + n(s.shownStations) + ' of ' + n(s.totalStations) + ' stations (most recent first)');
    } else {
      parts.push(plural(s.shownStations, 'station', 'stations') + ' from ' + plural(s.contacts - s.unplaced, 'contact', 'contacts'));
    }
    if (s.unplaced > 0) parts.push(plural(s.unplaced, 'contact', 'contacts') + ' with no location');
    return parts.join(' · ');
  }

  /** Trailing debounce; timers injectable for tests. */
  function debounce(fn, ms, timers) {
    var set = (timers && timers.setTimeout) || setTimeout;
    var clear = (timers && timers.clearTimeout) || clearTimeout;
    var t = null;
    function run() {
      if (t != null) clear(t);
      var args = arguments;
      t = set(function () { t = null; fn.apply(null, args); }, ms);
    }
    run.cancel = function () { if (t != null) clear(t); t = null; };
    return run;
  }

  /**
   * The map's side of the window: it re-plots from the rows the list already
   * holds (o.rows(), never the log file), debounced, only while it is open.
   *   o.rows()       the filtered rows, as the list shows them
   *   o.locate(q)    { lat, lon } | null
   *   o.draw(summ)   put mapStations()'s answer on the map
   *   o.visible()    is the map open
   */
  function mapFollower(o) {
    var delay = o.delay == null ? 150 : o.delay;
    function refreshNow() {
      if (o.visible && !o.visible()) return null;
      var summary = mapStations(o.rows(), o.locate, { cap: o.cap });
      o.draw(summary);
      return summary;
    }
    var later = debounce(refreshNow, delay, o.timers);
    return { filterChanged: later, refreshNow: refreshNow, cancel: later.cancel };
  }

  return {
    MAP_STATION_CAP: MAP_STATION_CAP,
    mapFollower: mapFollower,
    modeFamily: modeFamily,
    modeMatches: modeMatches,
    isActive: isActive,
    makeMatcher: makeMatcher,
    filterQsos: filterQsos,
    mapStations: mapStations,
    mapNote: mapNote,
    debounce: debounce,
  };
});
