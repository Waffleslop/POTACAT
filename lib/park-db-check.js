'use strict';
/**
 * Whether the activator's "Not in parks DB" check can judge a reference.
 * POTACAT loads POTA's park lists only, so a WWFF (OHFF-0001), SOTA
 * (OH/KS-001) or other program's reference was always "unknown" and flagged
 * as a typo (og3e, 2026-11-04). Only a POTA reference is checked; the program
 * comes from lib/activation-program.js (normalizeParkRefs), and a reference
 * with no program is POTA, as everywhere else.
 * Dual-mode: require() in tests, window.ParkDbCheck in the renderer.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ParkDbCheck = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  function checkable(park) {
    const program = String((park && park.program) || 'POTA').toUpperCase();
    return program === 'POTA';
  }
  return { checkable };
}));
