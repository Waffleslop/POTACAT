/**
 * Watchlist-group matching — SHARED between the main renderer (Spots list),
 * the JTCAT pop-out (FT8/FT4/FT2 decode stroke, ft8-watchlist-stroke-parity
 * spec), and tests. Single source of truth for callsign-list parsing, the
 * group lookup map, and decode matching, so the pop-out can never drift from
 * the Spots-list resolution (the drift the mobile spec calls out).
 *
 * Resolution contract (mirrors ECHOCAT mobile, spec of record:
 * potacat-app docs/desktop-asks/ft8-watchlist-stroke-parity.md):
 *   - manual callsigns beat remote/PoLo entries WITHIN a group
 *   - lower group index wins ACROSS groups
 *   - per-call PoLo emoji beats the group's fallback emoji
 *   - exact call lookups only — never substring
 *
 * Dual-mode: Node `require()` gets `module.exports`; the browser (loaded via
 * a plain <script> tag) gets `window.WatchlistGroups`.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WatchlistGroups = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // --- States (N0KAH 2026-10-06: "highlight states for those that you need
  // to fill out a geographic area") ---
  // A watchlist token may be a STATE instead of a callsign: the POTA form
  // `US-NJ` / `CA-ON` (any `XX-YY` country-dash-region code), or a bare US
  // state / Canadian province code (`NJ`, `ON`). A two-letter token can
  // never be a callsign (a callsign carries a digit), so nothing is taken
  // away from callsign matching. The bare form is limited to the 50 states,
  // DC and the provinces: territories like `AS` (American Samoa) would
  // collide with the `CQ AS` continent tag, so they are written in full.
  var BARE_STATE_CODES = {
    AL: 'US', AK: 'US', AZ: 'US', AR: 'US', CA: 'US', CO: 'US', CT: 'US', DE: 'US', FL: 'US', GA: 'US',
    HI: 'US', ID: 'US', IL: 'US', IN: 'US', IA: 'US', KS: 'US', KY: 'US', LA: 'US', ME: 'US', MD: 'US',
    MA: 'US', MI: 'US', MN: 'US', MS: 'US', MO: 'US', MT: 'US', NE: 'US', NV: 'US', NH: 'US', NJ: 'US',
    NM: 'US', NY: 'US', NC: 'US', ND: 'US', OH: 'US', OK: 'US', OR: 'US', PA: 'US', RI: 'US', SC: 'US',
    SD: 'US', TN: 'US', TX: 'US', UT: 'US', VT: 'US', VA: 'US', WA: 'US', WV: 'US', WI: 'US', WY: 'US',
    DC: 'US',
    AB: 'CA', BC: 'CA', MB: 'CA', NB: 'CA', NL: 'CA', NS: 'CA', NT: 'CA', NU: 'CA', ON: 'CA', PE: 'CA',
    QC: 'CA', SK: 'CA', YT: 'CA',
  };
  /** 'US-NJ' for a state token (`US-NJ`, `nj`, `CA-ON`, `on`), else null. */
  function stateTokenOf(tok) {
    var t = String(tok || '').trim().toUpperCase();
    if (!t) return null;
    if (/^[A-Z]{2}-[A-Z]{2,3}$/.test(t)) return t;
    if (BARE_STATE_CODES[t]) return BARE_STATE_CODES[t] + '-' + t;
    return null;
  }
  /** The states a spot's park location names: 'US-NJ,US-PA' -> ['US-NJ','US-PA']. */
  function spotStates(locationDesc) {
    return String(locationDesc || '').toUpperCase().split(',')
      .map(function (s) { return s.trim(); })
      .filter(function (s) { return /^[A-Z]{2}-[A-Z]{2,3}$/.test(s); });
  }

  // Accepts comma OR whitespace OR newline separators. Strips qualifiers
  // (anything after first ':' — the legacy watchlist syntax uses ':band' /
  // ':mode' qualifiers; groups are simple match-or-not so we drop those).
  function parseCallsignList(str) {
    if (!str) return [];
    return String(str)
      .split(/[\s,;]+/)
      .map(function (s) { return s.split(':')[0].trim().toUpperCase(); })
      .filter(function (s) { return s.length > 0; });
  }

  /**
   * Build Map<UPPERCASE_CALL, { idx, emoji }> from settings.watchlistGroups.
   * First-match-wins in iteration order gives both contract rules: manual
   * entries are added before a group's remote entries, and group 0 is
   * processed before group 1.
   */
  function buildGroupLookup(groups) {
    var lookup = new Map();
    // Extras ride as properties so every existing consumer of the bare Map
    // (the spot table does lookup.get(call) directly) keeps working:
    //   _prefixes — [{pre, idx, emoji}] from "W1AW/*" wildcard entries
    //   _tags     — Map<TAG, {idx, emoji}> from letters-only <=4 tokens
    //               (NA, EU, POTA, TEST...) matched against a decode's CQ
    //               modifier. A real callsign always contains a digit, so
    //               the shapes cannot collide. (RaptorFlight 2026-08-27:
    //               WSJT-X-style highlight lists with tags + wildcards.)
    lookup._prefixes = [];
    lookup._tags = new Map();
    //   _states   — Map<'US-NJ', {idx, emoji}> from state tokens (N0KAH),
    //               matched against a SPOT's park location by matchSpot().
    //               A bare code is ALSO still a CQ tag (additive, so an
    //               existing `NA`/`EU`-style list loses nothing).
    lookup._states = new Map();
    var list = Array.isArray(groups) ? groups : [];
    function addToken(tok, idx, emoji) {
      if (!tok) return;
      var st = stateTokenOf(tok);
      if (st && !lookup._states.has(st)) lookup._states.set(st, { idx: idx, emoji: emoji });
      if (st && tok.indexOf('-') >= 0) return; // `US-NJ` is only ever a state
      if (tok.length > 2 && tok.slice(-2) === '/*') {
        lookup._prefixes.push({ pre: tok.slice(0, -1), idx: idx, emoji: emoji });
      } else if (tok.length <= 4 && /^[A-Z]+$/.test(tok)) {
        if (!lookup._tags.has(tok)) lookup._tags.set(tok, { idx: idx, emoji: emoji });
      } else if (!lookup.has(tok)) {
        lookup.set(tok, { idx: idx, emoji: emoji });
      }
    }
    for (var i = 0; i < list.length; i++) {
      var g = list[i];
      if (!g) continue;
      var groupEmoji = g.emoji || '';
      var manual = parseCallsignList(g.callsigns);
      for (var m = 0; m < manual.length; m++) {
        addToken(manual[m], i, groupEmoji);
      }
      if (Array.isArray(g.remoteEntries)) {
        for (var r = 0; r < g.remoteEntries.length; r++) {
          var entry = g.remoteEntries[r];
          if (!entry || !entry.call) continue;
          // Remote entries are curated CALLSIGN lists (PoLo format) - always
          // exact, never classified. A three-letter entry like "ABC" passes
          // the PoLo validator and must NOT silently become a broad CQ-tag
          // matcher (mobile review ruling, 2026-08-28: spec wins, code fixed).
          var rcall = String(entry.call).toUpperCase();
          if (!lookup.has(rcall)) lookup.set(rcall, { idx: i, emoji: entry.emoji || groupEmoji });
        }
      }
    }
    return lookup;
  }

  /**
   * Match one FT8/FT4/FT2 decode against the group lookup. Spec order:
   *   1. the parsed transmitting call (exact)
   *   2. any whitespace token of the message text, `<`/`>` stripped (FT8
   *      wraps nonstandard calls) — catches a watched friend BEING CALLED.
   * Exact lookups only. Returns { idx, emoji } or null.
   */
  function matchDecode(lookup, call, text, cqTag) {
    if (!lookup) return null;
    var prefixes = lookup._prefixes || [];
    var tags = lookup._tags;
    if (lookup.size === 0 && prefixes.length === 0 && (!tags || tags.size === 0)) return null;
    // Candidate sequence: the parsed transmitting call first, then every
    // whitespace token with <> stripped (catches a watched friend BEING
    // CALLED).
    var seq = [];
    if (call) seq.push(String(call).toUpperCase());
    var tokens = String(text || '').toUpperCase().split(/\s+/);
    for (var i = 0; i < tokens.length; i++) {
      var tok = tokens[i].replace(/[<>]/g, '');
      if (tok) seq.push(tok);
    }
    // PHASED order (mobile review ruling, 2026-08-28): specificity outranks
    // position AND group index. All candidates are tried against exact
    // entries first, then wildcards, then the CQ tag - so an exact entry
    // wins even when a wildcard-matching token appears earlier in the text,
    // and an exact entry in group 2 beats a wildcard in group 0. Group order
    // breaks ties WITHIN a kind (encoded in insertion order).
    for (var e = 0; e < seq.length; e++) {
      var eHit = lookup.get(seq[e]);
      if (eHit) return eHit;
    }
    for (var w = 0; w < seq.length; w++) {
      for (var pi = 0; pi < prefixes.length; pi++) {
        if (seq[w].lastIndexOf(prefixes[pi].pre, 0) === 0) {
          return { idx: prefixes[pi].idx, emoji: prefixes[pi].emoji };
        }
      }
    }
    if (cqTag && tags && tags.size > 0) {
      var gHit = tags.get(String(cqTag).toUpperCase());
      if (gHit) return gHit;
    }
    return null;
  }

  /**
   * Match one SPOT (table / map / pop-out) against the group lookup:
   * the exact call, then a `W1AW/*` prefix, then the park's state(s).
   * Specificity first, as for decodes: a friend in group 2 keeps their
   * colour even when their state is listed in group 0. Returns
   * { idx, emoji } or null. CQ tags never apply to a spot.
   */
  function matchSpot(lookup, call, locationDesc) {
    if (!lookup) return null;
    var c = String(call || '').toUpperCase();
    if (c) {
      var eHit = lookup.get(c);
      if (eHit) return eHit;
      var prefixes = lookup._prefixes || [];
      for (var pi = 0; pi < prefixes.length; pi++) {
        if (c.lastIndexOf(prefixes[pi].pre, 0) === 0) return { idx: prefixes[pi].idx, emoji: prefixes[pi].emoji };
      }
    }
    var states = lookup._states;
    if (states && states.size > 0) {
      var sts = spotStates(locationDesc);
      var best = null;
      for (var si = 0; si < sts.length; si++) {
        var sHit = states.get(sts[si]);
        if (sHit && (!best || sHit.idx < best.idx)) best = sHit; // lower group wins, as everywhere
      }
      if (best) return best;
    }
    return null;
  }

  return {
    parseCallsignList: parseCallsignList,
    buildGroupLookup: buildGroupLookup,
    matchDecode: matchDecode,
    matchSpot: matchSpot,
    stateTokenOf: stateTokenOf,
    spotStates: spotStates,
  };
});
