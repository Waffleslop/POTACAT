/**
 * JTCAT Stations list (#557): one entry per station heard, folded from the
 * FT8 / FT4 / FT2 decodes, as an alternative to the Band Activity stream.
 *
 * Pure data. The rows are drawn by lib/decode-row.js (stationRowInner), so the
 * layout test and, later, ECHOCAT Web draw exactly the same row.
 *
 * Each entry: { call, calling, grid, entity, continent, state, db, dt, df,
 * band, mode, firstHeard, lastHeard, text, decode, gridDecode, park }.
 *   - calling: "CQ", "CQ POTA", "CQ DX"... from the CQ modifier, or the call
 *     the station is answering. Follows the latest message.
 *   - grid: a grid is not in every message, so the last one heard is kept.
 *   - state: only when QRZ already knows it (d.state.source 'qrz' or
 *     'grid+qrz'). Never guessed from a grid or a call (the worked-roster
 *     rule); otherwise blank.
 *   - db / dt / df / text / decode follow the latest decode. `decode` is that
 *     decode object itself, so a click on the row runs the same handler as a
 *     click on the decode, and the needed flags (newDxcc, newGrid, wantedState)
 *     stay readable for the marks (part 2).
 *   - gridDecode: the decode the grid came from, so its newGrid flag (and a
 *     later clearWorkedFlags after a QSO) stays with the grid.
 *   - park: { sig, ref, from } - from 'spot' (main's d.spotRef: the call is
 *     spotted on this band in the spot list Hunt reads) or 'cq' (a reference
 *     written in a CQ message, "CQ POTA US-1234"). A spot beats a CQ.
 *
 * Needed marks (part 2): marksOf(entry, ctx) answers, from data POTACAT
 * already has, what this station would give you: a country, a state, a grid,
 * a call you still need, and whether the country and state are worked or
 * confirmed. Countries and states come from the worked roster under the map
 * overlay's scope (ctx: { roster, scope, confirmedOnly }), so the map and
 * the list agree; with no roster yet the decode's own newDxcc / wantedState
 * flags stand in. Grid and call are the decode's newGrid / newCall (the
 * worked-before checks the decode rows use).
 *
 * Entries expire a chosen number of minutes after they were last heard
 * (EXPIRY_CHOICES, default 5). A band or mode change empties the list, as it
 * empties Band Activity (#517).
 *
 * Dual-mode: require() in Node/tests, window.JtcatStations in the pages.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./worked-roster'));
  else root.JtcatStations = factory(root.WorkedRoster);
})(typeof self !== 'undefined' ? self : this, function (WorkedRoster) {
  'use strict';

  var EXPIRY_CHOICES = [2, 5, 10];
  var DEFAULT_EXPIRY_MIN = 5;
  var SORTS = ['last', 'snr', 'call'];
  var GRID_RE = /^[A-R]{2}[0-9]{2}$/;

  function up(v) { return String(v == null ? '' : v).trim().toUpperCase(); }
  function num(v) { if (v == null || v === '') return null; var n = Number(v); return isFinite(n) ? n : null; }

  /** 2, 5 or 10; anything else is the default, 5. */
  function normalizeExpiryMin(v) {
    var n = Number(v);
    return EXPIRY_CHOICES.indexOf(n) >= 0 ? n : DEFAULT_EXPIRY_MIN;
  }
  function normalizeSort(v) { return SORTS.indexOf(v) >= 0 ? v : 'last'; }

  function create(opts) {
    var o = opts || {};
    return { byCall: {}, band: '', mode: '', expiryMin: normalizeExpiryMin(o.expiryMin) };
  }

  function clear(st) { st.byCall = {}; }

  function setExpiryMin(st, v) { st.expiryMin = normalizeExpiryMin(v); return st.expiryMin; }

  /**
   * The band or mode the list belongs to. A change from a known band or mode
   * empties it (#517: the decodes of another band or mode are not this band's
   * stations). Returns true when it cleared.
   */
  function setContext(st, ctx) {
    var band = up(ctx && ctx.band), mode = up(ctx && ctx.mode);
    var changed = (band && st.band && band !== st.band) || (mode && st.mode && mode !== st.mode);
    if (changed) clear(st);
    if (band) st.band = band;
    if (mode) st.mode = mode;
    return !!changed;
  }

  function stripBrackets(tok) { return String(tok || '').replace(/^<(.*)>$/, '$1'); }

  /** The CQ modifier: letters only, 4 at most ("CQ POTA K1ABC FN42" -> "POTA"). */
  function cqTagOf(text) {
    var parts = up(text).split(/\s+/);
    if (parts[0] !== 'CQ' || parts.length < 3) return '';
    return /^[A-Z]{1,4}$/.test(parts[1]) ? parts[1] : '';
  }

  /**
   * What the station is calling: "CQ" / "CQ POTA" for a CQ, else the call it
   * is answering (the first word of a standard message). '' when the message
   * says nothing a reader could use (free text, an unresolved <...> hash).
   */
  function callingOf(text, sender, cqTag) {
    var parts = up(text).split(/\s+/).filter(Boolean);
    if (!parts.length) return '';
    if (parts[0] === 'CQ') {
      var tag = cqTag != null && cqTag !== '' ? up(cqTag) : cqTagOf(text);
      return tag ? 'CQ ' + tag : 'CQ';
    }
    if (parts[0] === '...' || parts[0] === '<...>') return '';
    var first = stripBrackets(parts[0].replace(/;$/, ''));
    if (!first || first === up(sender)) return '';
    // A call has a digit and a letter; free text ("TNX QSO 73") has not.
    if (!/[0-9]/.test(first) || !/[A-Z]/.test(first) || first.length < 3) return '';
    return first;
  }

  /** The state, when QRZ knows it. A state read off a grid is a guess and is left blank. */
  function stateOf(d) {
    var s = d && d.state;
    if (!s || !s.code) return '';
    if (s.source !== 'qrz' && s.source !== 'grid+qrz') return '';
    return /^[A-Z]{2}$/.test(up(s.code)) ? up(s.code) : '';
  }

  // Program references as activators write them. WWFF before POTA: "KFF-1234"
  // fits the POTA shape too.
  var REF_PATTERNS = [
    { sig: 'WWFF', re: /^[A-Z0-9]{1,4}FF-\d{4}$/ },
    { sig: 'SOTA', re: /^[A-Z0-9]{1,4}\/[A-Z]{2}-\d{3}$/ },
    { sig: 'POTA', re: /^[A-Z0-9]{1,4}-\d{4,5}$/ },
  ];

  /**
   * A reference written in a CQ message ("CQ POTA US-1234", "CQ US-1234
   * K1ABC"): { sig, ref } or null. Only a CQ counts; a reference in someone
   * else's exchange is not this station's park.
   */
  function refFromText(text) {
    var parts = up(text).split(/\s+/).filter(Boolean);
    if (parts[0] !== 'CQ') return null;
    for (var i = 1; i < parts.length; i++) {
      for (var j = 0; j < REF_PATTERNS.length; j++) {
        if (REF_PATTERNS[j].re.test(parts[i])) return { sig: REF_PATTERNS[j].sig, ref: parts[i] };
      }
    }
    return null;
  }

  /** The park a decode tells us: main's spot match first, then a CQ's own reference. */
  function parkOf(d) {
    var s = d && d.spotRef;
    if (s && s.ref) return { sig: up(s.sig) || 'POTA', ref: up(s.ref), from: 'spot' };
    var c = refFromText(d && d.text);
    return c ? { sig: c.sig, ref: c.ref, from: 'cq' } : null;
  }

  /**
   * Fold one decode into the list. ctx: { band, mode, now }. Returns the
   * entry, or null when the decode names no sender (our own TX, free text).
   */
  function noteDecode(st, d, ctx) {
    if (!d) return null;
    var call = up(stripBrackets(d.call));
    if (!call || call === '...') return null;
    var c = ctx || {};
    var now = typeof c.now === 'number' ? c.now : Date.now();
    var e = st.byCall[call];
    if (!e) {
      e = st.byCall[call] = { call: call, calling: '', grid: '', entity: '', continent: '', state: '',
        db: null, dt: null, df: null, band: '', mode: '', firstHeard: now, lastHeard: now, text: '', decode: null,
        gridDecode: null, park: null };
    }
    var grid = up(d.grid).slice(0, 4);
    if (GRID_RE.test(grid) && !/^RR\d\d$/.test(grid)) { e.grid = grid; e.gridDecode = d; }
    var park = parkOf(d);
    if (park && !(park.from === 'cq' && e.park && e.park.from === 'spot')) e.park = park;
    if (d.entity) e.entity = String(d.entity);
    if (d.continent) e.continent = String(d.continent);
    var state = stateOf(d);
    if (state) e.state = state;
    e.calling = callingOf(d.text, call, d.cqTag);
    e.db = num(d.db);
    e.dt = num(d.dt);
    e.df = num(d.df);
    e.band = up(d.band || c.band || e.band).toLowerCase();
    e.mode = up(c.mode || e.mode);
    e.text = String(d.text || '');
    e.decode = d;
    e.lastHeard = Math.max(e.lastHeard, now);
    return e;
  }

  /** Fold one decode cycle. Sets the band/mode context first (a change clears). */
  function addDecodes(st, results, ctx) {
    setContext(st, ctx);
    var n = 0;
    for (var i = 0; i < (results || []).length; i++) if (noteDecode(st, results[i], ctx)) n++;
    return n;
  }

  /** Drop the stations not heard within the expiry. Returns how many went. */
  function expire(st, now) {
    var t = typeof now === 'number' ? now : Date.now();
    var limit = normalizeExpiryMin(st.expiryMin) * 60000;
    var n = 0;
    Object.keys(st.byCall).forEach(function (k) {
      if (t - st.byCall[k].lastHeard >= limit) { delete st.byCall[k]; n++; }
    });
    return n;
  }

  // -------------------------------------------------------------------------
  // Needed marks (#557 part 2)
  // -------------------------------------------------------------------------

  /** The roster's answer for a country or state under the overlay scope, at the station's band and mode. */
  function rosterStatus(ctx, kind, key, e) {
    if (!ctx || !ctx.roster || !key || !WorkedRoster) return null;
    return WorkedRoster.status(ctx.roster, kind, key, {
      scope: ctx.scope || 'band-mode', band: e.band, mode: e.mode, confirmedOnly: !!ctx.confirmedOnly,
    });
  }

  /** 'new' | 'worked' | 'confirmed' from a roster status ('none' is still needed). */
  function fromStatus(s) { return s === 'none' ? 'new' : (s === 'worked' || s === 'confirmed' ? s : ''); }

  /**
   * What this station would give you. ctx: { roster, scope, confirmedOnly }
   * (the map overlay's state). Returns
   *   { entity, state: 'new'|'worked'|'confirmed'|'', grid, call: bool, needed: bool }.
   * needed = any of a new country, state, grid or call.
   */
  function marksOf(e, ctx) {
    var out = { entity: '', state: '', grid: false, call: false, needed: false };
    if (!e) return out;
    var d = e.decode || {};
    // Country: the roster under the scope (the map's answer); without a
    // roster yet, the decode's own new-DXCC flag.
    if (e.entity) {
      var es = rosterStatus(ctx, 'entity', e.entity, e);
      out.entity = es ? fromStatus(es) : (d.newDxcc ? 'new' : '');
    }
    // State: only one QRZ knows (e.state), only for the countries the roster
    // tracks. DC counts as Maryland (WorkedRoster.stateKeys).
    var keys = e.state && WorkedRoster ? WorkedRoster.stateKeys(e.entity, e.state) : [];
    if (keys.length && ctx && ctx.roster) {
      var best = 'none';
      for (var i = 0; i < keys.length; i++) {
        var s = rosterStatus(ctx, 'state', keys[i], e);
        if (s === 'confirmed') { best = s; break; }
        if (s === 'worked') best = s;
      }
      out.state = fromStatus(best);
    } else if (keys.length) {
      var ds = d.state;
      out.state = d.wantedState && ds && up(ds.code) === e.state ? 'new' : '';
    }
    out.grid = !!(e.grid && e.gridDecode && e.gridDecode.newGrid);
    out.call = !!d.newCall;
    out.needed = out.entity === 'new' || out.state === 'new' || out.grid || out.call;
    return out;
  }

  /**
   * The Wanted filter on a station: '' shows all; 'wanted' any needed mark;
   * 'dxcc' a new country; 'grid' a new grid (the stream's WANTED_CYCLE).
   */
  function wantedMatch(marks, filter) {
    if (!filter) return true;
    var m = marks || {};
    if (filter === 'dxcc') return m.entity === 'new';
    if (filter === 'grid') return !!m.grid;
    return !!m.needed;
  }

  /** Every decode the list holds (latest and grid source), for DecodeRow.clearWorkedFlags after a QSO. */
  function decodesOf(st) {
    var out = [];
    Object.keys(st.byCall).forEach(function (k) {
      var e = st.byCall[k];
      if (e.decode) out.push(e.decode);
      if (e.gridDecode && e.gridDecode !== e.decode) out.push(e.gridDecode);
    });
    return out;
  }

  function cmpCall(a, b) { return a.call < b.call ? -1 : a.call > b.call ? 1 : 0; }
  function cmpLast(a, b) { return (b.lastHeard - a.lastHeard) || cmpCall(a, b); }
  function cmpSnr(a, b) {
    var x = a.db == null ? -999 : a.db, y = b.db == null ? -999 : b.db;
    return (y - x) || cmpLast(a, b);
  }
  var COMPARE = { last: cmpLast, snr: cmpSnr, call: cmpCall };

  /**
   * The entries to show: expired ones dropped, then sorted. sort: 'last'
   * (newest first, the default), 'snr' (strongest first) or 'call' (A to Z).
   */
  function list(st, opts) {
    var o = opts || {};
    expire(st, o.now);
    var out = Object.keys(st.byCall).map(function (k) { return st.byCall[k]; });
    return out.sort(COMPARE[normalizeSort(o.sort)]);
  }

  function size(st) { return Object.keys(st.byCall).length; }

  return {
    EXPIRY_CHOICES: EXPIRY_CHOICES, DEFAULT_EXPIRY_MIN: DEFAULT_EXPIRY_MIN, SORTS: SORTS,
    normalizeExpiryMin: normalizeExpiryMin, normalizeSort: normalizeSort,
    create: create, clear: clear, setExpiryMin: setExpiryMin, setContext: setContext,
    callingOf: callingOf, stateOf: stateOf, cqTagOf: cqTagOf, refFromText: refFromText, parkOf: parkOf,
    marksOf: marksOf, wantedMatch: wantedMatch, decodesOf: decodesOf,
    noteDecode: noteDecode, addDecodes: addDecodes, expire: expire, list: list, size: size,
  };
});
