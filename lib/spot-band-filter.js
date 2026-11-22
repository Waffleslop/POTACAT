/**
 * The Spots band filter across a rig switch (#291).
 *
 * The filter used to be saved as the bands that were TICKED. Ticks made on
 * an HF radio meant nothing on a VHF-only one: those boxes are hidden there
 * (lib/rig-bands.js), the spot list held only 2 m and 70 cm spots, and the
 * ticked 20 m / 40 m filter emptied the table with no visible reason.
 *
 * The rule: what is remembered is the bands the operator turned OFF by hand,
 * one list for every rig. What a rig shows is its own bands minus that list.
 *
 * - A band is "off" only when its box was visible and unticked. A band the
 *   current rig does not have keeps whatever it was before, so the unticks
 *   made on one radio survive a trip through another.
 * - A band the old rig lacked but the new rig has is shown, unless the
 *   operator once turned it off on a radio that had it.
 * - Nothing left to show (every one of the rig's bands is off) falls back to
 *   All: the table is never emptied by a filter the operator cannot see.
 * - An unrestricted rig (no bands ticked in the rig editor, model not known)
 *   offers every band, so it shows every band that is not off.
 *
 * Bands here are lib/rig-bands.js names ('20m', '70cm'). Dual-mode: require()
 * in main, window.SpotBandFilter in the renderer.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./rig-bands'));
  else root.SpotBandFilter = factory(root.RigBands);
})(typeof self !== 'undefined' ? self : this, function (RigBands) {
  'use strict';

  var ALL = RigBands.ALL_BANDS;

  function norm(list) {
    if (!Array.isArray(list)) return [];
    var set = {};
    list.forEach(function (b) { set[String(b || '').trim().toLowerCase()] = true; });
    return ALL.filter(function (b) { return set[b]; });
  }

  /** The bands a rig offers in the filter: its own list, or every band when unrestricted. */
  function universe(rigBands) {
    var u = norm(rigBands);
    return Array.isArray(rigBands) && u.length ? u : ALL.slice();
  }

  /**
   * The operator's off list after a change in the filter.
   * `ticked` is the ticked bands, or null for All. Bands outside this rig's
   * universe keep their state from `prevOff`.
   */
  function offFromTicks(ticked, rigBands, prevOff) {
    var u = universe(rigBands);
    var keep = norm(prevOff).filter(function (b) { return u.indexOf(b) < 0; });
    var t = ticked == null ? null : norm(ticked).filter(function (b) { return u.indexOf(b) >= 0; });
    // All, or nothing ticked that this rig has: nothing is off here.
    var offHere = t && t.length ? u.filter(function (b) { return t.indexOf(b) < 0; }) : [];
    return norm(keep.concat(offHere));
  }

  /**
   * The ticks to show on a rig: its bands minus the off list, or null (All)
   * when that is every band it has, or none of them.
   */
  function ticksForRig(off, rigBands) {
    var u = universe(rigBands);
    var o = norm(off);
    var t = u.filter(function (b) { return o.indexOf(b) < 0; });
    if (!t.length || t.length === u.length) return null;
    return t;
  }

  /**
   * The off list from a saved filter: `bandsOff` when present, else an older
   * ticked `bands` list read against the rig it is restored on.
   */
  function offFromSaved(saved, rigBands) {
    if (!saved) return [];
    if (Array.isArray(saved.bandsOff)) return norm(saved.bandsOff);
    if (Array.isArray(saved.bands)) return offFromTicks(saved.bands, rigBands, []);
    return [];
  }

  /** Is a spot on `band` shown? `rigBands` limits it first (main does that), then the off list. */
  function shows(band, off, rigBands) {
    if (!RigBands.allowed(rigBands, band)) return false;
    var t = ticksForRig(off, rigBands);
    if (!t) return true;
    var b = String(band || '').trim().toLowerCase();
    if (ALL.indexOf(b) < 0) return true;
    return t.indexOf(b) >= 0;
  }

  function sameList(a, b) {
    return JSON.stringify(a == null ? null : a) === JSON.stringify(b == null ? null : b);
  }

  /**
   * ECHOCAT's saved filter blob (settings.echoFilters) as a client sent it:
   * its ticked `bands` become the off list, read against the shack's rig.
   * Returns a new blob carrying `bandsOff`.
   */
  function fromClient(filters, prevFilters, rigBands) {
    if (!filters || typeof filters !== 'object') return filters;
    var prevOff = offFromSaved(prevFilters, rigBands);
    var off = offFromTicks(filters.bands == null ? null : filters.bands, rigBands, prevOff);
    var out = {};
    for (var k in filters) if (Object.prototype.hasOwnProperty.call(filters, k)) out[k] = filters[k];
    out.bandsOff = off;
    return out;
  }

  /**
   * The same blob after the shack's rig changed bands: `bands` becomes the
   * new rig's bands minus the off list (null = All). An older blob with only
   * `bands` is read against the rig it was made on (`prevRigBands`).
   * Returns null when nothing changed.
   */
  function followRig(filters, prevRigBands, rigBands) {
    if (!filters || typeof filters !== 'object') return null;
    var off = offFromSaved(filters, prevRigBands);
    var ticks = ticksForRig(off, rigBands);
    if (Array.isArray(filters.bandsOff) && sameList(Array.isArray(filters.bands) ? norm(filters.bands) : null, ticks)) return null;
    var out = {};
    for (var k in filters) if (Object.prototype.hasOwnProperty.call(filters, k)) out[k] = filters[k];
    out.bands = ticks;
    out.bandsOff = off;
    return out;
  }

  return {
    universe: universe, offFromTicks: offFromTicks, ticksForRig: ticksForRig,
    offFromSaved: offFromSaved, shows: shows, fromClient: fromClient, followRig: followRig,
  };
});
