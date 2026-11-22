// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// Favourites: the Landmarks and Channels an operator starred (#329, Casey
// 2026-11-10: "let the user favorite a NOAA station, or any stations here
// they might want to show"). Per operator: settings.landmarkFavorites and
// settings.channelFavorites hold ids in the order they were starred; they
// are not GLOBAL_KEYS, so each operator profile has its own.
//
// One list, three places it shows: the Favorites view of Landmarks and
// Channels, the VFO window's Favorites menu, and markers on the band scope.
// ECHOCAT gets the ids in the `directory` message and stars with C2S
// `favorite-set`. An id the catalog no longer has is kept, not shown, so a
// catalog edit never loses a star.
//
// Dual-mode: require() in main, window.Favorites in the renderer, inlined
// into the ECHOCAT Web page.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Favorites = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MAX = 100;
  var ID_MAX = 64;
  var KINDS = ['landmark', 'channel'];
  var KEY = { landmark: 'landmarkFavorites', channel: 'channelFavorites' };

  /** Ids, cleaned: strings, trimmed, unique, at most MAX, order kept. */
  function normalize(ids) {
    var out = [], seen = {};
    var list = Array.isArray(ids) ? ids : [];
    for (var i = 0; i < list.length && out.length < MAX; i++) {
      var id = typeof list[i] === 'string' ? list[i].trim().slice(0, ID_MAX) : '';
      if (!id || seen[id]) continue;
      seen[id] = true;
      out.push(id);
    }
    return out;
  }

  /** Star (on) or unstar an id; a new star goes to the end. Returns a new list. */
  function toggle(ids, id, on) {
    var list = normalize(ids);
    var k = typeof id === 'string' ? id.trim().slice(0, ID_MAX) : '';
    if (!k) return list;
    var at = list.indexOf(k);
    var want = on === undefined ? at < 0 : !!on;
    if (want && at < 0 && list.length < MAX) list.push(k);
    if (!want && at >= 0) list.splice(at, 1);
    return list;
  }

  function isFavorite(ids, id) {
    return Array.isArray(ids) && ids.indexOf(id) >= 0;
  }

  /** The settings key for a kind, or null. */
  function keyFor(kind) {
    return KEY[kind] || null;
  }

  /**
   * The starred entries that exist, landmarks first, each in starred order:
   * [{kind, id, name, khz, mode, note}]. `note` is the landmark's one line
   * or the channel's group.
   */
  function resolve(opts) {
    var o = opts || {};
    var out = [];
    var byId = function (rows) { var m = {}; (Array.isArray(rows) ? rows : []).forEach(function (r) { if (r && r.id) m[r.id] = r; }); return m; };
    var lm = byId(o.landmarks), ch = byId(o.channels);
    normalize(o.landmarkIds).forEach(function (id) {
      var r = lm[id];
      if (r && Number(r.khz) > 0) out.push({ kind: 'landmark', id: id, name: String(r.name || id), khz: Number(r.khz), mode: String(r.mode || ''), note: String(r.line || '') });
    });
    normalize(o.channelIds).forEach(function (id) {
      var r = ch[id];
      if (r && Number(r.khz) > 0) out.push({ kind: 'channel', id: id, name: String(r.name || id), khz: Number(r.khz), mode: String(r.mode || ''), note: String(r.group || '') });
    });
    return out;
  }

  /** The resolved entries inside [loHz, hiHz] (the band scope's span). */
  function inSpan(items, loHz, hiHz) {
    if (!(hiHz > loHz)) return [];
    return (Array.isArray(items) ? items : []).filter(function (f) {
      var hz = Number(f.khz) * 1000;
      return hz >= loHz && hz <= hiHz;
    });
  }

  /**
   * The star button every surface draws (class fav-star; its colours come
   * from the page's theme tokens, POTACAT blue when on, never yellow). An
   * SVG, not a text glyph, so it looks the same in every font.
   * `data-fav` carries the action for the row's click handler.
   */
  function starHtml(on, name) {
    var label = (on ? 'Remove ' : 'Add ') + String(name || 'this').replace(/[&<>"']/g, '') + (on ? ' from Favorites' : ' to Favorites');
    return '<button type="button" class="fav-star' + (on ? ' on' : '') + '" data-fav="1" aria-pressed="' + (on ? 'true' : 'false') + '" title="' + label + '" aria-label="' + label + '">'
      + '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M12 2.8l2.8 5.9 6.4.8-4.7 4.4 1.2 6.4L12 17.2l-5.7 3.1 1.2-6.4-4.7-4.4 6.4-.8z" '
      + (on ? 'fill="currentColor"' : 'fill="none"') + ' stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg></button>';
  }

  return { MAX: MAX, KINDS: KINDS, normalize: normalize, toggle: toggle, isFavorite: isFavorite, keyFor: keyFor, resolve: resolve, inSpan: inSpan, starHtml: starHtml };
});
