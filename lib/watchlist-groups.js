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
    var list = Array.isArray(groups) ? groups : [];
    for (var i = 0; i < list.length; i++) {
      var g = list[i];
      if (!g) continue;
      var groupEmoji = g.emoji || '';
      var manual = parseCallsignList(g.callsigns);
      for (var m = 0; m < manual.length; m++) {
        if (!lookup.has(manual[m])) lookup.set(manual[m], { idx: i, emoji: groupEmoji });
      }
      if (Array.isArray(g.remoteEntries)) {
        for (var r = 0; r < g.remoteEntries.length; r++) {
          var entry = g.remoteEntries[r];
          if (!entry || !entry.call) continue;
          var call = String(entry.call).toUpperCase();
          if (!lookup.has(call)) {
            lookup.set(call, { idx: i, emoji: entry.emoji || groupEmoji });
          }
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
  function matchDecode(lookup, call, text) {
    if (!lookup || lookup.size === 0) return null;
    if (call) {
      var hit = lookup.get(String(call).toUpperCase());
      if (hit) return hit;
    }
    var tokens = String(text || '').toUpperCase().split(/\s+/);
    for (var i = 0; i < tokens.length; i++) {
      var tok = tokens[i].replace(/[<>]/g, '');
      if (!tok) continue;
      var tHit = lookup.get(tok);
      if (tHit) return tHit;
    }
    return null;
  }

  return {
    parseCallsignList: parseCallsignList,
    buildGroupLookup: buildGroupLookup,
    matchDecode: matchDecode,
  };
});
