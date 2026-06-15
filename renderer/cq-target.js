/**
 * CQ "Chase Target" — SHARED between the renderers (jtcat-popout.js, remote.js)
 * and the main/test processes. Single source of truth for:
 *   - the universe of valid CQ tags an operator can chase (QUICK_PICKS),
 *   - protocol-safe normalize/validate of a tag (WSJT-X Tx6 allows at most 4
 *     chars between "CQ" and the callsign, UPPERCASE only — lowercase becomes
 *     hash codes and over-long tags won't encode),
 *   - classifying a typed target (continent vs program vs US-state vs DXCC
 *     prefix), and
 *   - deciding whether an incoming decode matches the chased target (so the
 *     popout and the phone highlight the same rows from one rule).
 *
 * "The entity you chase" drives BOTH the outgoing CQ tag (CQ <tag> <call>
 * <grid>) and an incoming decode highlight, to help earn awards (DXCC / WAC /
 * WAS). Casey 2026-06-14.
 *
 * Dual-mode like jtcat-parser.js: Node `require()` gets module.exports; the
 * browser (loaded via a plain <script> tag — the renderers have no require)
 * gets a global window.CqTarget. No DOM or Node dependencies, so it is safe in
 * both, and cty.dat lookups are injected (helpers.resolvePrefixEntity) so this
 * module stays pure and unit-testable.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CqTarget = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Curated quick-picks for the categorized dropdown. The free-text custom
  // field handles US state codes (FL, CA…) and DXCC prefixes (JA, VK, G, I…).
  var QUICK_PICKS = [
    { category: 'Continent / DX', tag: 'DX', label: 'DX (any other continent)' },
    { category: 'Continent / DX', tag: 'NA', label: 'NA — North America' },
    { category: 'Continent / DX', tag: 'SA', label: 'SA — South America' },
    { category: 'Continent / DX', tag: 'EU', label: 'EU — Europe' },
    { category: 'Continent / DX', tag: 'AS', label: 'AS — Asia' },
    { category: 'Continent / DX', tag: 'AF', label: 'AF — Africa' },
    { category: 'Continent / DX', tag: 'OC', label: 'OC — Oceania' },
    { category: 'Continent / DX', tag: 'AN', label: 'AN — Antarctica' },
    { category: 'Program', tag: 'POTA', label: 'POTA — Parks on the Air' },
    { category: 'Program', tag: 'SOTA', label: 'SOTA — Summits on the Air' },
    { category: 'Program', tag: 'FD', label: 'FD — Field Day' },
    { category: 'Program', tag: 'QRP', label: 'QRP — low power' },
    { category: 'Contest', tag: 'TEST', label: 'TEST — contest CQ' },
  ];

  // The 7 continent codes (DX is handled specially as "any non-home continent").
  var CONTINENTS = { NA: 1, SA: 1, EU: 1, AS: 1, AF: 1, OC: 1, AN: 1 };
  // Program / contest tags are matched by the literal CQ tag token in the decode.
  var PROGRAMS = { POTA: 1, SOTA: 1, FD: 1, QRP: 1 };
  var CONTESTS = { TEST: 1 };
  // USPS 2-letter codes (+ DC). A typed 2-letter code in this set is treated as
  // a US state, not a DXCC prefix (the collision rule).
  var US_STATES = {
    AL: 1, AK: 1, AZ: 1, AR: 1, CA: 1, CO: 1, CT: 1, DE: 1, FL: 1, GA: 1,
    HI: 1, ID: 1, IL: 1, IN: 1, IA: 1, KS: 1, KY: 1, LA: 1, ME: 1, MD: 1,
    MA: 1, MI: 1, MN: 1, MS: 1, MO: 1, MT: 1, NE: 1, NV: 1, NH: 1, NJ: 1,
    NM: 1, NY: 1, NC: 1, ND: 1, OH: 1, OK: 1, OR: 1, PA: 1, RI: 1, SC: 1,
    SD: 1, TN: 1, TX: 1, UT: 1, VT: 1, VA: 1, WA: 1, WV: 1, WI: 1, WY: 1,
    DC: 1,
  };

  // Uppercase + strip anything that isn't A-Z. Mirrors the build rule in
  // main.js ('CQ ' + mod + ' ' + call + ' ' + grid) — a tag is letters only.
  function normalizeTag(raw) {
    return String(raw == null ? '' : raw).toUpperCase().replace(/[^A-Z]/g, '');
  }

  // Validate a tag for use in a CQ message. '' (none) is valid. Anything that
  // normalizes to >4 chars cannot encode in WSJT-X Tx6 and is rejected.
  function validateTag(raw) {
    var tag = normalizeTag(raw);
    if (!tag) return { ok: true, tag: '', reason: '' };
    if (tag.length > 4) return { ok: false, tag: tag, reason: 'Tag must be 4 letters or fewer (WSJT-X CQ limit).' };
    return { ok: true, tag: tag, reason: '' };
  }

  // Build the CQ TX message, clamping the modifier to a legal tag. SINGLE
  // source for every CQ builder (popout, phone, Full Auto CQ re-arm) so they
  // can't drift. buildCqTxMsg('K3SBP','FN30','pota') -> 'CQ POTA K3SBP FN30'.
  function buildCqTxMsg(myCall, myGrid, modifier) {
    var mod = normalizeTag(modifier).substring(0, 4);
    return mod ? 'CQ ' + mod + ' ' + myCall + ' ' + myGrid : 'CQ ' + myCall + ' ' + myGrid;
  }

  // Classify a normalized tag. Order is the collision rule:
  // continent -> program -> contest -> US-state -> DXCC prefix. So "POTA" is a
  // program (never a prefix), "FL" is a US state, "JA" is a DXCC prefix.
  function classifyTarget(raw) {
    var tag = normalizeTag(raw);
    if (!tag) return { kind: 'none', tag: '' };
    if (tag === 'DX') return { kind: 'continent', tag: tag };
    if (CONTINENTS[tag]) return { kind: 'continent', tag: tag };
    if (PROGRAMS[tag]) return { kind: 'program', tag: tag };
    if (CONTESTS[tag]) return { kind: 'contest', tag: tag };
    if (US_STATES[tag]) return { kind: 'usstate', tag: tag };
    return { kind: 'dxcc', tag: tag };
  }

  // Extract the CQ tag token from a decode message, or '' if it's a plain CQ /
  // not a CQ. "CQ POTA W1AW FN31" -> "POTA"; "CQ K1ABC FN42" -> ''. A tag is a
  // letters-only token (a callsign always has a digit), so we distinguish the
  // tag from the callsign without a full parse.
  function cqTagOf(text) {
    var parts = String(text || '').trim().toUpperCase().split(/\s+/);
    if (parts[0] !== 'CQ' || parts.length < 3) return '';
    var t = parts[1];
    if (/^[A-Z]{1,4}$/.test(t)) return t; // letters only, ≤4 — a tag, not a call
    return '';
  }

  // Does this decode match the chased target? Pure: cty.dat lookups are
  // injected. decode = { entity, continent, call, grid, text }. helpers:
  //   - homeContinent: the operator's own continent (for DX = "any other").
  //   - targetEntityName: precomputed DXCC entity name for a prefix target
  //       (resolve ONCE per cycle, not per decode), OR
  //   - resolvePrefixEntity(tag): fallback that returns { name, ... } | null.
  // Match reliability: program/contest (literal tag), continent, and DXCC
  // prefix are reliable. US-state is NOT derivable from a callsign via cty.dat
  // (it resolves only "United States"), so US-state highlight is intentionally
  // a no-op in v1 — the outgoing CQ tag still works fully. (Follow-up: a
  // grid->state table would make incoming US-state highlight reliable.)
  function matchesDecode(target, decode, helpers) {
    var c = classifyTarget(target);
    if (c.kind === 'none' || !decode) return false;
    helpers = helpers || {};

    if (c.kind === 'program' || c.kind === 'contest') {
      return cqTagOf(decode.text) === c.tag;
    }

    if (c.kind === 'continent') {
      if (!decode.continent) return false;
      if (c.tag === 'DX') {
        if (!helpers.homeContinent) return false;
        return decode.continent !== helpers.homeContinent;
      }
      return decode.continent === c.tag;
    }

    if (c.kind === 'dxcc') {
      if (!decode.entity) return false;
      var name = helpers.targetEntityName;
      if (name == null && typeof helpers.resolvePrefixEntity === 'function') {
        var e = helpers.resolvePrefixEntity(c.tag);
        name = e && e.name;
      }
      return !!name && decode.entity === name;
    }

    // usstate (and any unknown) — no reliable per-decode match in v1.
    return false;
  }

  return {
    QUICK_PICKS: QUICK_PICKS,
    US_STATES: US_STATES,
    normalizeTag: normalizeTag,
    validateTag: validateTag,
    buildCqTxMsg: buildCqTxMsg,
    classifyTarget: classifyTarget,
    cqTagOf: cqTagOf,
    matchesDecode: matchesDecode,
  };
});
