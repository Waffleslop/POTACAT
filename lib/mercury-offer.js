/**
 * What POTACAT offers of Mercury while it is experimental — SHARED between
 * main and the main window.
 *
 * Casey, 2026-11-22 (docs/mercury-winlink-modem-plan.md, decisions 5 and 6):
 * - Bandwidth 2750 is hidden. Mercury runs BW2750 at 2300's speed today, so
 *   offering it would promise speed that is not there. A 2750 saved before
 *   this reads back as 2300.
 * - The July 2026 chat and file window (More > Mercury HF Data) is hidden
 *   until Mercury has been used on the air. Its code stays; only the menu
 *   entry is gated, by `settings.mercuryChatWindow` (default off, no switch in
 *   Settings yet) together with the existing `enableMercury`.
 *
 * Dual-mode: Node `require()` gets `module.exports`; the browser (plain
 * <script> tag) gets `window.MercuryOffer`. No DOM or Node dependencies.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MercuryOffer = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var BANDWIDTHS = [500, 2300];
  var DEFAULT_BANDWIDTH = 2300;

  /** A stored or chosen bandwidth, kept to the offered ones (else 2300). */
  function bandwidthChoice(v) {
    var n = parseInt(v, 10);
    return BANDWIDTHS.indexOf(n) >= 0 ? n : DEFAULT_BANDWIDTH;
  }

  /** Is More > Mercury HF Data shown? Off unless both settings say so. */
  function chatWindowOffered(settings) {
    var s = settings || {};
    return s.enableMercury === true && s.mercuryChatWindow === true;
  }

  return {
    BANDWIDTHS: BANDWIDTHS,
    DEFAULT_BANDWIDTH: DEFAULT_BANDWIDTH,
    bandwidthChoice: bandwidthChoice,
    chatWindowOffered: chatWindowOffered,
  };
});
