/**
 * Map spot markers, reconciled by spot key (GitHub #246).
 *
 * Both maps (the main window's and the pop-out) used to clear every marker on
 * each spots push and rebuild them all, so CW-spot and SOTA pins blinked out
 * on every refresh and the station being chased was lost (electricfalcon).
 * The maps now ask this planner what changed: unchanged markers stay put,
 * changed ones are updated in place, new ones are added, and only spots that
 * are gone are removed.
 *
 * Pure: no Leaflet, no DOM. The caller supplies each spot's key and a
 * signature string of everything its marker shows (position, icon, opacity,
 * popup HTML); equal signatures mean the marker is left alone.
 *
 * Dual-mode: require() in Node/tests, window.MapMarkerReconcile in the page.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MapMarkerReconcile = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** One marker per source + station + frequency (a SOTA spot and a CW spot
   *  of the same activator are two markers, as before). */
  function spotKey(s) {
    if (!s) return '';
    return String(s.source || '') + '|' + String(s.callsign || '').toUpperCase() + '|' + String(s.frequency == null ? '' : s.frequency);
  }

  /**
   * @param {Map<string,string>|null} prev  key -> signature of the markers on the map
   * @param {Array<{key:string, sig:string}>} items  this push, in draw order
   * @returns {{add:string[], update:string[], keep:string[], remove:string[], next:Map<string,string>}}
   *   `next` is the key -> signature map after applying the plan. A key seen
   *   twice in one push is planned once (first occurrence wins).
   */
  function planMarkers(prev, items) {
    const before = prev instanceof Map ? prev : new Map();
    const next = new Map();
    const add = [], update = [], keep = [];
    for (const it of items || []) {
      if (!it || !it.key || next.has(it.key)) continue;
      const sig = String(it.sig == null ? '' : it.sig);
      next.set(it.key, sig);
      if (!before.has(it.key)) add.push(it.key);
      else if (before.get(it.key) !== sig) update.push(it.key);
      else keep.push(it.key);
    }
    const remove = [];
    for (const k of before.keys()) if (!next.has(k)) remove.push(k);
    return { add, update, keep, remove, next };
  }

  return { spotKey, planMarkers };
});
