// Callsign filter for the spot lists (LZ3AW request, 2026-09-18): "option or
// field for filter by single or several callsigns". One field, a list of
// callsigns or prefixes separated by commas or spaces; a spot shows only if
// its callsign matches one of them. A token is a PREFIX ("LZ" shows every LZ
// station; "SP9ABC" shows SP9ABC and SP9ABC/P), `*` and `?` are wildcards
// ("*ABC", "W?AW"). Empty = no filter. Case-insensitive.
//
// Dual-mode: require() in main/tests, window.CallFilter via <script> in the
// desktop renderer. ECHOCAT Web carries a verbatim copy of the two functions
// in renderer/remote.js (the page is served from ALLOWED_FILES, not
// node_modules); test/call-filter-test.js pins the copy to this file.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CallFilter = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** Parse a filter string into matchers. Returns [] for an empty filter. */
  function parseCallFilter(spec) {
    const tokens = String(spec || '').toUpperCase().split(/[\s,;]+/).filter(Boolean);
    return tokens.map((t) => ({
      token: t,
      re: new RegExp('^' + t.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')),
    }));
  }

  /** True when the filter is empty or the callsign matches one of its matchers. */
  function callMatchesFilter(callsign, matchers) {
    if (!matchers || !matchers.length) return true;
    const c = String(callsign || '').toUpperCase();
    for (let i = 0; i < matchers.length; i++) if (matchers[i].re.test(c)) return true;
    return false;
  }

  return { parseCallFilter, callMatchesFilter };
});
