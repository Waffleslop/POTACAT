/**
 * Worked roster: which US states (and Canadian provinces)
 * and which DXCC entities the operator has WORKED and CONFIRMED, by band and
 * mode, built from the same worked-QSO entries every worked-before check
 * reads (lib/adif.js parseWorkedQsos + the two live-add sites in main.js).
 *
 * Plan: docs/worked-states-countries-plan.md (Casey 2026-10-23, WAS).
 *
 * Rules the roster never bends:
 *  - A QSO counts for a state ONLY from its STATE field. No guessing from a
 *    grid or a callsign; a missing STATE is filled by the QRZ backfill as a
 *    proper log edit, never here.
 *  - DC counts as Maryland for WAS (ARRL rule). The DC key is kept too.
 *  - Confirmed = QSL_RCVD=Y or LOTW_QSL_RCVD=Y, the DXCC tracker's rule.
 *  - Scope: 'any' (ever) / 'band' / 'band-mode' (band + award family:
 *    phone, cw, digital) / 'band-exact' (band + the logged mode) / 'mode'
 *    (any band, award family). The WAS digital endorsement counts FT8 and
 *    FT4 together, so the family is the default.
 *
 * Dual-mode: `require()` in main and `window.WorkedRoster` in the renderer
 * and ECHOCAT Web, so every surface draws the same answer.
 *
 * Shape (JSON-serialisable, pushed to the renderer as `worked-roster`):
 *   { v: 1,
 *     states:   { NJ: node, ... },
 *     entities: { 'United States': node, ... } }
 *   node = { w: 1, c: 0|1, fam: { digital: {w,c} }, modes: { FT8: {w,c} },
 *            bands: { '20m': { w, c, fam: {...}, modes: {...} } } }
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WorkedRoster = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var US_STATES = [
    ['AL', 'Alabama'], ['AK', 'Alaska'], ['AZ', 'Arizona'], ['AR', 'Arkansas'], ['CA', 'California'],
    ['CO', 'Colorado'], ['CT', 'Connecticut'], ['DE', 'Delaware'], ['FL', 'Florida'], ['GA', 'Georgia'],
    ['HI', 'Hawaii'], ['ID', 'Idaho'], ['IL', 'Illinois'], ['IN', 'Indiana'], ['IA', 'Iowa'],
    ['KS', 'Kansas'], ['KY', 'Kentucky'], ['LA', 'Louisiana'], ['ME', 'Maine'], ['MD', 'Maryland'],
    ['MA', 'Massachusetts'], ['MI', 'Michigan'], ['MN', 'Minnesota'], ['MS', 'Mississippi'], ['MO', 'Missouri'],
    ['MT', 'Montana'], ['NE', 'Nebraska'], ['NV', 'Nevada'], ['NH', 'New Hampshire'], ['NJ', 'New Jersey'],
    ['NM', 'New Mexico'], ['NY', 'New York'], ['NC', 'North Carolina'], ['ND', 'North Dakota'], ['OH', 'Ohio'],
    ['OK', 'Oklahoma'], ['OR', 'Oregon'], ['PA', 'Pennsylvania'], ['RI', 'Rhode Island'], ['SC', 'South Carolina'],
    ['SD', 'South Dakota'], ['TN', 'Tennessee'], ['TX', 'Texas'], ['UT', 'Utah'], ['VT', 'Vermont'],
    ['VA', 'Virginia'], ['WA', 'Washington'], ['WV', 'West Virginia'], ['WI', 'Wisconsin'], ['WY', 'Wyoming'],
  ].map(function (p) { return { code: p[0], name: p[1] }; });

  var CA_PROVINCES = [
    ['AB', 'Alberta'], ['BC', 'British Columbia'], ['MB', 'Manitoba'], ['NB', 'New Brunswick'],
    ['NL', 'Newfoundland and Labrador'], ['NS', 'Nova Scotia'], ['NT', 'Northwest Territories'],
    ['NU', 'Nunavut'], ['ON', 'Ontario'], ['PE', 'Prince Edward Island'], ['QC', 'Quebec'],
    ['SK', 'Saskatchewan'], ['YT', 'Yukon'],
  ].map(function (p) { return { code: p[0], name: p[1] }; });

  // The DXCC entities whose STATE field is a US state. Alaska and Hawaii are
  // their own entities in cty.dat but states for WAS.
  var US_ENTITIES = { 'United States': 1, 'Alaska': 1, 'Hawaii': 1 };
  var CA_ENTITIES = { 'Canada': 1 };
  // Australia is deliberately NOT a roster country: its state codes collide
  // with US/Canadian ones (NT, WA, SA), and bare codes are the keys the map
  // overlay and the watchlist share. A VK STATE field is ignored.

  var US_CODES = {}; US_STATES.forEach(function (s) { US_CODES[s.code] = 1; });
  var CA_CODES = {}; CA_PROVINCES.forEach(function (s) { CA_CODES[s.code] = 1; });

  // Older ADIF writers (and QRZ) spell some provinces the pre-2002 way.
  var CA_ALIASES = { PQ: 'QC', NF: 'NL', LB: 'NL', YK: 'YT' };

  var BANDS = ['160m', '80m', '60m', '40m', '30m', '20m', '17m', '15m', '12m', '10m', '6m', '4m', '2m', '70cm', '1.25m', '33cm', '23cm'];

  var SCOPES = ['any', 'band', 'band-mode', 'band-exact', 'mode'];

  /**
   * The award family of a LOGGED mode (as normalizeMode names it: SSB, CW,
   * FT8, FT4, RTTY, PSK31 ...). Not rig-presets' modeFamily, which reads rig
   * modes (USB-D, DIGU). Everything that is not voice or CW is digital, which
   * is how the WAS and DXCC digital endorsements count.
   */
  function awardFamily(mode) {
    var m = String(mode == null ? '' : mode).trim().toUpperCase();
    if (!m) return '';
    if (m === 'SSB' || m === 'USB' || m === 'LSB' || m === 'AM' || m === 'FM' || m === 'FMN' ||
        m === 'DV' || m === 'DSTAR' || m === 'C4FM' || m === 'DMR' || m === 'FREEDV' || m === 'DIGITALVOICE' || m === 'PHONE') return 'phone';
    if (m === 'CW' || m === 'CWR') return 'cw';
    return 'digital';
  }

  /**
   * The roster key for a logged STATE, given the DXCC entity the call
   * resolves to. '' = not a state this roster tracks (a Mexican state, a
   * typo, a province on a US call). DC maps to MD for WAS; the caller marks
   * both (`stateKeys`).
   */
  function stateKeys(entity, state) {
    var code = String(state == null ? '' : state).trim().toUpperCase();
    if (!code) return [];
    var ent = String(entity || '');
    if (US_ENTITIES[ent]) {
      if (code === 'DC') return ['DC', 'MD'];
      return US_CODES[code] ? [code] : [];
    }
    if (CA_ENTITIES[ent]) {
      code = CA_ALIASES[code] || code;
      return CA_CODES[code] ? [code] : [];
    }
    return [];
  }

  /** Is this DXCC entity one whose STATE field the roster tracks? */
  function tracksEntity(entity) {
    var ent = String(entity || '');
    return !!(US_ENTITIES[ent] || CA_ENTITIES[ent]);
  }

  function empty() {
    return { v: 1, states: {}, entities: {} };
  }

  function leaf(obj, key) {
    if (!obj[key]) obj[key] = { w: 0, c: 0 };
    return obj[key];
  }

  function node(obj, key) {
    if (!obj[key]) obj[key] = { w: 0, c: 0, fam: {}, modes: {} };
    return obj[key];
  }

  function markLeaf(l, confirmed) {
    l.w = 1;
    if (confirmed) l.c = 1;
  }

  function markNode(n, fam, mode, confirmed) {
    markLeaf(n, confirmed);
    if (fam) markLeaf(leaf(n.fam, fam), confirmed);
    if (mode) markLeaf(leaf(n.modes, mode), confirmed);
  }

  function normBand(band) {
    return String(band == null ? '' : band).trim().toLowerCase();
  }

  function normMode(mode) {
    return String(mode == null ? '' : mode).trim().toUpperCase();
  }

  /** Mark one place (a state code or an entity name) worked for one QSO. */
  function mark(table, key, entry) {
    if (!key) return;
    var band = normBand(entry.band);
    var mode = normMode(entry.mode);
    var fam = awardFamily(mode);
    var confirmed = !!entry.confirmed;
    var n = node(table, key);
    markNode(n, fam, mode, confirmed);
    if (band) {
      if (!n.bands) n.bands = {};
      markNode(node(n.bands, band), fam, mode, confirmed);
    }
  }

  /**
   * Add one worked-QSO entry for `call`. `entity` is the DXCC entity name
   * the caller resolved (cty.dat), '' when unknown.
   */
  function addEntry(roster, call, entry, entity) {
    if (!roster || !entry) return;
    var ent = String(entity || '');
    if (ent) mark(roster.entities, ent, entry);
    var keys = stateKeys(ent, entry.state);
    for (var i = 0; i < keys.length; i++) mark(roster.states, keys[i], entry);
  }

  /**
   * Build the roster from worked-QSO entries: an iterable of [call, [entry]]
   * pairs (the `workedQsos` Map's entries, or the array the renderer gets).
   * `entityOf(call)` resolves the DXCC entity name, called once per call.
   */
  function build(entries, entityOf) {
    var roster = empty();
    if (!entries) return roster;
    var it = typeof entries.forEach === 'function' && !Array.isArray(entries) ? mapToArray(entries) : entries;
    for (var i = 0; i < it.length; i++) {
      var call = it[i][0];
      var list = it[i][1] || [];
      var entity = entityOf ? (entityOf(call) || '') : '';
      for (var j = 0; j < list.length; j++) addEntry(roster, call, list[j], entity);
    }
    return roster;
  }

  function mapToArray(map) {
    var out = [];
    map.forEach(function (v, k) { out.push([k, v]); });
    return out;
  }

  function leafStatus(l) {
    if (!l || !l.w) return 'none';
    return l.c ? 'confirmed' : 'worked';
  }

  /**
   * 'none' | 'worked' | 'confirmed' for one place under a scope.
   * kind: 'state' | 'entity'; key: 'NJ' | 'Japan'.
   * opts: { scope, band, mode, confirmedOnly }. A scope that needs a band or
   * mode the caller did not supply falls back to the next wider scope, so a
   * radio with no mode reported still colours the map by band.
   */
  function status(roster, kind, key, opts) {
    if (!roster) return 'none';
    var table = kind === 'state' ? roster.states : roster.entities;
    var n = table && table[key];
    if (!n) return 'none';
    var o = opts || {};
    var scope = SCOPES.indexOf(o.scope) >= 0 ? o.scope : 'any';
    var band = normBand(o.band);
    var mode = normMode(o.mode);
    var fam = awardFamily(mode);
    var target = n;
    if (scope === 'band' || scope === 'band-mode' || scope === 'band-exact') {
      if (band) target = (n.bands && n.bands[band]) || null;
    }
    if (!target) return 'none';
    var l = target;
    if ((scope === 'band-mode' || scope === 'mode') && fam) l = target.fam[fam] || null;
    else if (scope === 'band-exact' && mode) l = target.modes[mode] || null;
    var s = leafStatus(l);
    if (o.confirmedOnly && s === 'worked') return 'none';
    return s;
  }

  /** The place is wanted under the scope: not worked, or (confirmedOnly) not confirmed. */
  function isWanted(roster, kind, key, opts) {
    return status(roster, kind, key, opts) === 'none';
  }

  /** Counts over a list of keys: { worked, confirmed, total }. */
  function counts(roster, kind, keys, opts) {
    var out = { worked: 0, confirmed: 0, total: keys.length };
    for (var i = 0; i < keys.length; i++) {
      var s = status(roster, kind, keys[i], opts);
      if (s !== 'none') out.worked++;
      if (s === 'confirmed') out.confirmed++;
    }
    return out;
  }

  /**
   * The matrix the WAS view draws: one row per place with a status per band
   * (under the mode part of the scope) and an overall status.
   */
  function matrix(roster, kind, places, opts) {
    var o = opts || {};
    var modeScope = o.scope === 'band-exact' ? 'band-exact' : 'band-mode';
    var anyScope = o.scope === 'band-exact' ? 'band-exact' : (o.scope === 'any' || o.scope === 'band' ? 'any' : 'mode');
    if (o.scope === 'band') modeScope = 'band';
    return places.map(function (p) {
      var cells = {};
      for (var i = 0; i < BANDS.length; i++) {
        cells[BANDS[i]] = status(roster, kind, p.code, { scope: modeScope, band: BANDS[i], mode: o.mode, confirmedOnly: o.confirmedOnly });
      }
      return { code: p.code, name: p.name, cells: cells, overall: status(roster, kind, p.code, { scope: anyScope, mode: o.mode, confirmedOnly: o.confirmedOnly }) };
    });
  }

  return {
    US_STATES: US_STATES,
    CA_PROVINCES: CA_PROVINCES,
    BANDS: BANDS,
    SCOPES: SCOPES,
    awardFamily: awardFamily,
    stateKeys: stateKeys,
    tracksEntity: tracksEntity,
    empty: empty,
    addEntry: addEntry,
    build: build,
    status: status,
    isWanted: isWanted,
    counts: counts,
    matrix: matrix,
  };
});
