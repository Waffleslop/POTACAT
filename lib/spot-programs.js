// An activator on two programs at once (a park on a summit: POTA + SOTA, a
// park that is also a WWFF site). main.js collapses those spots into one row
// with `sources` and <program>Reference fields; this decides what the spot
// table shows for them.
//
// Why it exists: the Source column is narrow and clips, so on a POTA + SOTA
// row only the POTA pill was visible (the SOTA pill sat behind the "…"), and
// the Ref column only ever added the WWFF reference, never the summit. A
// hunter could not tell from the table that the contact also counts for SOTA.
//
// Pure rules, dual-mode: `require` in tests, `window.SpotPrograms` in the
// renderer.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SpotPrograms = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Activation programs, in main.js's PROGRAM_PRIORITY order. Everything else
  // in `sources` (cluster, CW, RBN ...) is a feed that also reported the spot.
  var PROGRAMS = ['pota', 'sota', 'wwff', 'llota', 'wwbota', 'tiles', 'parc', 'gma'];

  // Programs whose secondary reference is worth showing next to the primary
  // one in the Ref column (the ones the Log QSO window logs).
  var REF_PROGRAMS = ['pota', 'sota', 'wwff', 'llota', 'wwbota'];

  function sourcesOf(spot) {
    return Array.isArray(spot.sources) && spot.sources.length > 0 ? spot.sources : [spot.source];
  }

  /**
   * The pills for the Source cell. A spot on one program keeps every source,
   * as before. A spot on several programs shows only its programs, so they
   * fit (the cell wraps them); the feeds that also reported it are listed in
   * `title` instead of being clipped.
   * @returns {{ pills: string[], multiProgram: boolean, title: string }}
   */
  function sourcePills(spot, labels) {
    var all = sourcesOf(spot);
    var programs = all.filter(function (s) { return PROGRAMS.indexOf(s) !== -1; });
    var multiProgram = programs.length > 1;
    var label = function (s) { return (labels && labels[s]) || s || ''; };
    return {
      pills: multiProgram ? programs : all,
      multiProgram: multiProgram,
      title: all.length > 1 ? 'Spotted by: ' + all.map(label).join(', ') : '',
    };
  }

  /**
   * The Ref cell text: the primary reference, then each other program's
   * reference ("IT-0843 / I/UM-069"). Was the primary plus WWFF only.
   */
  function refDisplay(spot) {
    var refs = [spot.reference];
    REF_PROGRAMS.forEach(function (p) {
      if (p === spot.source) return;
      var ref = spot[p + 'Reference'];
      if (ref && refs.indexOf(ref) === -1) refs.push(ref);
    });
    return refs.filter(Boolean).join(' / ');
  }

  return { PROGRAMS: PROGRAMS, sourcePills: sourcePills, refDisplay: refDisplay };
});
