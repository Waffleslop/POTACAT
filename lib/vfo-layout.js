// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// The VFO window's two layouts (Casey 2026-11-10, approved as a plan page):
// a Large VFO and a Small VFO, each with its own list of what is shown and in
// what order. The Large VFO keeps the settings it always had (vfoWidgets,
// vfoSections, vfoOrder); the Small VFO is settings.vfoSmall. Both choose
// their CAT buttons from CAT_CHOICES. Pure, dual-mode: `require` in tests,
// `window.VfoLayout` in renderer/vfo-popout.html.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VfoLayout = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // The Small VFO is one line, left to right in this order. "fixed" cannot be
  // switched off or moved (always first); "keep" never hides when the window
  // is too narrow. Casey's defaults: frequency, mode, band, Audio, PTT, Log,
  // S-meter, Volume, Scan. Listen controls sit together and PTT and Log end
  // the line, where a hand goes for them.
  var SMALL_ITEMS = [
    { key: 'freq',   name: 'Frequency',      on: true,  fixed: true, keep: true },
    { key: 'mode',   name: 'Mode',           on: true },
    { key: 'band',   name: 'Band',           on: true },
    { key: 'smeter', name: 'S-meter',        on: true },
    { key: 'scan',   name: 'Scan',           on: true },
    { key: 'audio',  name: 'Audio on/off',   on: true },
    { key: 'volume', name: 'Volume',         on: true },
    { key: 'ptt',    name: 'PTT',            on: true,  keep: true },
    { key: 'log',    name: 'Log',            on: true },
    { key: 'cat',    name: 'CAT buttons',    on: false },
    { key: 'filter', name: 'Filter width',   on: false },
    { key: 'step',   name: 'Tuning step',    on: false },
    { key: 'lock',   name: 'Frequency lock', on: false },
  ];
  var SMALL_KEYS = SMALL_ITEMS.map(function (i) { return i.key; });

  // The Large VFO's body blocks, top to bottom by default. The WebSDR sits
  // under the knob (Casey 2026-11-10: "set the SDR higher up on the large VFO
  // as the default - under the VFO knob"). An operator who already moved a
  // block keeps their own order.
  var LARGE_BLOCKS = [
    { key: 'knob',          name: 'VFO knob and activator' },
    { key: 'kiwi',          name: 'WebSDR' },
    { key: 'band',          name: 'Bands' },
    { key: 'favorites',     name: 'Favorites' },
    { key: 'filter',        name: 'Filter buttons' },
    { key: 'filter-slider', name: 'Filter slider' },
    { key: 'txpower',       name: 'TX power' },
    { key: 'controls',      name: 'CAT buttons' },
    { key: 'solar',         name: 'Solar (SFI, K, A)' },
    { key: 'profiles',      name: 'Profiles' },
    { key: 'cw-controls',   name: 'CW speed and text' },
    { key: 'cw',            name: 'CW macros' },
    { key: 'voice',         name: 'Voice macros' },
  ];
  var LARGE_KEYS = LARGE_BLOCKS.map(function (b) { return b.key; });

  // CAT buttons either size can show. Every action is in lib/rig-controls.js
  // with the same caps flag (test/vfo-layout-test.js holds them together);
  // `state` is the vfo-radio-state field that lights the button.
  var CAT_CHOICES = [
    { key: 'set-nb',     label: 'NB',     caps: 'nb',     state: 'nb' },
    { key: 'set-nr',     label: 'NR',     caps: 'nr',     state: 'nr' },
    { key: 'set-anf',    label: 'ANF',    caps: 'anf',    state: 'anf' },
    { key: 'set-apf',    label: 'APF',    caps: 'apf',    state: 'apf' },
    { key: 'set-preamp', label: 'Preamp', caps: 'preamp', state: 'preamp' },
    { key: 'set-att',    label: 'Att',    caps: 'att',    state: 'att' },
    { key: 'set-comp',   label: 'COMP',   caps: 'comp',   state: 'comp' },
    { key: 'set-vox',    label: 'VOX',    caps: 'vox',    state: 'vox' },
    { key: 'set-mon',    label: 'MON',    caps: 'mon',    state: 'mon' },
    { key: 'set-rit',    label: 'RIT',    caps: 'rit',    state: 'rit' },
    { key: 'set-split',  label: 'Split',  caps: 'split',  state: 'split' },
    { key: 'atu-tune',   label: 'ATU',    caps: 'atu',    state: 'atu', momentary: true },
  ];
  var CAT_KEYS = CAT_CHOICES.map(function (c) { return c.key; });
  // A custom CAT button (Settings > Rig > Custom CAT) is picked by its name.
  var CUSTOM_PREFIX = 'custom:';
  var CAT_DEFAULT_SMALL = ['set-nr', 'set-nb', 'atu-tune'];
  var CAT_DEFAULT_LARGE = ['set-nb', 'atu-tune'];   // what the fixed row always had

  /**
   * A saved order made whole: unknown keys dropped, duplicates dropped, and a
   * key the save never had placed after its default predecessor.
   */
  function normalizeOrder(saved, defaults) {
    var out = [];
    if (Array.isArray(saved)) {
      for (var i = 0; i < saved.length; i++) {
        var k = saved[i];
        if (defaults.indexOf(k) >= 0 && out.indexOf(k) < 0) out.push(k);
      }
    }
    defaults.forEach(function (k, idx) {
      if (out.indexOf(k) >= 0) return;
      var at = 0;
      for (var j = idx - 1; j >= 0; j--) {
        var p = out.indexOf(defaults[j]);
        if (p >= 0) { at = p + 1; break; }
      }
      out.splice(at, 0, k);
    });
    return out;
  }

  /** The CAT picks: known actions and custom names, in the order chosen, no repeats. */
  function normalizeCat(saved, defaults) {
    if (!Array.isArray(saved)) return defaults.slice();
    var out = [];
    saved.forEach(function (k) {
      if (typeof k !== 'string' || out.indexOf(k) >= 0) return;
      if (CAT_KEYS.indexOf(k) >= 0 || (k.indexOf(CUSTOM_PREFIX) === 0 && k.length > CUSTOM_PREFIX.length)) out.push(k);
    });
    return out;
  }

  /** settings.vfoSmall made whole: { order, on, cat }. Frequency is always first and on. */
  function normalizeSmall(saved) {
    var s = saved && typeof saved === 'object' ? saved : {};
    var order = normalizeOrder(s.order, SMALL_KEYS).filter(function (k) { return k !== 'freq'; });
    order.unshift('freq');
    var on = {};
    SMALL_ITEMS.forEach(function (it) {
      var v = s.on && typeof s.on[it.key] === 'boolean' ? s.on[it.key] : it.on;
      on[it.key] = it.fixed ? true : v;
    });
    return { order: order, on: on, cat: normalizeCat(s.cat, CAT_DEFAULT_SMALL) };
  }

  function item(key) {
    for (var i = 0; i < SMALL_ITEMS.length; i++) if (SMALL_ITEMS[i].key === key) return SMALL_ITEMS[i];
    return null;
  }

  /** Move key to index in a copy of order. Frequency stays first. */
  function move(order, key, toIndex) {
    var out = order.slice();
    var from = out.indexOf(key);
    if (from < 0 || key === 'freq') return out;
    var lo = out[0] === 'freq' ? 1 : 0;
    var to = Math.max(lo, Math.min(out.length - 1, toIndex));
    if (to === from) return out;
    out.splice(from, 1);
    out.splice(to, 0, key);
    return out;
  }

  /**
   * When the Small VFO is narrower than its line, what hides first: the shown
   * items from the end of the order back, never frequency or PTT. The page
   * hides them one at a time until the line fits.
   */
  function hideOrder(small) {
    var s = normalizeSmall(small);
    var out = [];
    for (var i = s.order.length - 1; i >= 0; i--) {
      var k = s.order[i];
      var it = item(k);
      if (!s.on[k] || !it || it.keep) continue;
      out.push(k);
    }
    return out;
  }

  /**
   * The CAT buttons to draw from a list of picks: a built-in action only when
   * the radio offers it (caps[flag] true; caps null = not known yet, offer
   * all), a custom one only while that custom button still exists.
   *   customs  [{ name, command, type }]
   * Returns [{ key, label, action?, custom?, state?, momentary? }].
   */
  function catButtons(picks, caps, customs) {
    var out = [];
    (picks || []).forEach(function (k) {
      if (k.indexOf(CUSTOM_PREFIX) === 0) {
        var name = k.slice(CUSTOM_PREFIX.length);
        var c = (customs || []).filter(function (b) { return b && b.name === name && b.command; })[0];
        if (c) out.push({ key: k, label: name, custom: c });
        return;
      }
      var ch = CAT_CHOICES.filter(function (x) { return x.key === k; })[0];
      if (!ch) return;
      if (caps && !caps[ch.caps]) return;
      out.push({ key: k, label: ch.label, action: ch.key, state: ch.state, momentary: !!ch.momentary });
    });
    return out;
  }

  /** What the picker offers: built-ins this radio supports, then the custom buttons. */
  function catOffer(caps, customs) {
    var out = CAT_CHOICES.filter(function (c) { return !caps || caps[c.caps]; })
      .map(function (c) { return { key: c.key, label: c.label }; });
    (customs || []).forEach(function (b) {
      if (b && b.name && b.command) out.push({ key: CUSTOM_PREFIX + b.name, label: b.name });
    });
    return out;
  }

  return {
    SMALL_ITEMS: SMALL_ITEMS, SMALL_KEYS: SMALL_KEYS, LARGE_BLOCKS: LARGE_BLOCKS, LARGE_KEYS: LARGE_KEYS,
    CAT_CHOICES: CAT_CHOICES, CAT_DEFAULT_SMALL: CAT_DEFAULT_SMALL, CAT_DEFAULT_LARGE: CAT_DEFAULT_LARGE,
    CUSTOM_PREFIX: CUSTOM_PREFIX,
    normalizeOrder: normalizeOrder, normalizeCat: normalizeCat, normalizeSmall: normalizeSmall,
    move: move, hideOrder: hideOrder, catButtons: catButtons, catOffer: catOffer, item: item,
  };
});
