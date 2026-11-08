// Max Spot Age — the one rule for "is this spot too old to show".
//
// The desktop spot table (renderer getFiltered) and every panadapter pop-out
// feed (Band Scope, bandspread) run this, so a spot the table has aged out is
// never drawn on the scope. GitHub #239 (VK4KTW): the scope drew spots 222
// minutes old with a 30-minute Max Spot Age, because its feed filtered by
// source only.
//
// Windows, per source (unchanged from the table):
//   net             never aged out
//   pskr            15 minutes (PSKReporter's own server-side window)
//   sota            sotaMaxAgeMin (SOTA spots are posted once, by a human)
//   dxc             dxcMaxAgeMin (cluster spots are one-shot)
//   pota            pota.app expires its own spots — no limit, unless the
//                   operator ticks potaAgeLimit, then maxAgeMin
//   everything else maxAgeMin
// A spot with no spotTime counts as infinitely old (dropped unless its source
// has no limit), as the table has always done.
//
// Dual-mode like lib/spot-mute-rules.js: require() from main, window.SpotAge
// via <script> in the renderer. No top-level const (page-script-globals).

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SpotAge = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var PSKR_MAX_AGE_SECS = 900;

  /** settings.json → the minutes the table uses (blank or 0 → the default). */
  function ageOptsFromSettings(settings) {
    var s = settings || {};
    return {
      maxAgeMin: parseInt(s.maxAgeMin, 10) || 5,
      sotaMaxAgeMin: parseInt(s.sotaMaxAge, 10) || 30,
      dxcMaxAgeMin: parseInt(s.dxcMaxAge, 10) || 15,
      potaAgeLimit: s.potaAgeLimit === true,
    };
  }

  /** Seconds since the spot; Infinity when it has no time, 0 when the time can't be parsed. */
  function spotAgeSecs(spotTime, nowMs) {
    if (!spotTime) return Infinity;
    var t = String(spotTime);
    var ms = new Date(t.endsWith('Z') ? t : t + 'Z').getTime();
    // An unparseable time was never aged out by the table (its old helper
    // gave NaN, and NaN > limit is false): keep that, so a feed with an odd
    // time format can't silently vanish. Only a missing time counts as old.
    if (!isFinite(ms)) return 0;
    return Math.max(0, ((nowMs != null ? nowMs : Date.now()) - ms) / 1000);
  }

  /** The age limit in seconds for this spot (Infinity = no limit). */
  function spotAgeLimitSecs(spot, opts) {
    var o = opts || {};
    var src = spot && spot.source;
    if (src === 'net') return Infinity;
    if (src === 'pskr') return PSKR_MAX_AGE_SECS;
    if (src === 'sota') return (o.sotaMaxAgeMin || 30) * 60;
    if (src === 'dxc') return (o.dxcMaxAgeMin || 15) * 60;
    if (src === 'pota' && !o.potaAgeLimit) return Infinity;
    return (o.maxAgeMin || 5) * 60;
  }

  function spotWithinAge(spot, opts, nowMs) {
    var limit = spotAgeLimitSecs(spot, opts);
    if (limit === Infinity) return true;
    return spotAgeSecs(spot && spot.spotTime, nowMs) <= limit;
  }

  function filterSpotsByAge(spots, opts, nowMs) {
    var now = nowMs != null ? nowMs : Date.now();
    return (spots || []).filter(function (s) { return spotWithinAge(s, opts, now); });
  }

  return { ageOptsFromSettings, spotAgeSecs, spotAgeLimitSecs, spotWithinAge, filterSpotsByAge, PSKR_MAX_AGE_SECS };
});
