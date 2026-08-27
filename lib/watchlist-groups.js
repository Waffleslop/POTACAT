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
    var list = Array.isArray(groups) ? groups : [];
    function addToken(tok, idx, emoji) {
      if (!tok) return;
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
          addToken(String(entry.call).toUpperCase(), i, entry.emoji || groupEmoji);
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
    function lookupTok(tok) {
      var hit = lookup.get(tok);
      if (hit) return hit;
      for (var p = 0; p < prefixes.length; p++) {
        if (tok.lastIndexOf(prefixes[p].pre, 0) === 0) {
          return { idx: prefixes[p].idx, emoji: prefixes[p].emoji };
        }
      }
      return null;
    }
    if (call) {
      var cHit = lookupTok(String(call).toUpperCase());
      if (cHit) return cHit;
    }
    var tokens = String(text || '').toUpperCase().split(/\s+/);
    for (var i = 0; i < tokens.length; i++) {
      var tok = tokens[i].replace(/[<>]/g, '');
      if (!tok) continue;
      var tHit = lookupTok(tok);
      if (tHit) return tHit;
    }
    // CQ-tag match last: exact calls and wildcards always outrank a broad
    // tag like NA, so a friend calling "CQ NA" strokes as the friend.
    if (cqTag && tags && tags.size > 0) {
      var gHit = tags.get(String(cqTag).toUpperCase());
      if (gHit) return gHit;
    }
    return null;
  }

  return {
    parseCallsignList: parseCallsignList,
    buildGroupLookup: buildGroupLookup,
    matchDecode: matchDecode,
  };
});
