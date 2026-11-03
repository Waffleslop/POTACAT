/**
 * The bands a radio can be used on (Casey 2026-10-24: "users without 23cm
 * don't see 23cm as an option ... check all bands you can use with this
 * radio ... pre-selected with those it can natively do ... my Flex could get
 * a transverter for 144 MHz, so I want the option to add bands ... nowhere
 * should those bands the radio isn't configured for be seen").
 *
 * - `rig.bands` (array of band names) is the operator's choice in the rig
 *   editor and always wins.
 * - Without it, a KNOWN model's native bands apply (MODEL_BANDS below; a
 *   model may also carry `bands` in lib/rig-models.js, which wins over this
 *   table).
 * - An unknown model (generic Hamlib, TCI, a rigctld on another machine) is
 *   not restricted: hiding bands from a radio we cannot name would take
 *   away bands it really has.
 *
 * Native lists lean WIDE where versions differ (an extra band costs one
 * untick; a missing one hides real operating). 4 m on EU-only versions is
 * left for the operator to tick.
 *
 * Dual-mode: require() in main, window.RigBands in the renderer, inlined
 * into the ECHOCAT Web page.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RigBands = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** Every band POTACAT knows, low to high (lib/bands.js has the edges). */
  var ALL_BANDS = ['2200m', '630m', '160m', '80m', '60m', '40m', '30m', '20m', '17m', '15m', '12m', '10m',
    '6m', '4m', '2m', '1.25m', '70cm', '33cm', '23cm', '13cm', '9cm', '6cm', '3cm', '1.25cm'];

  var HF = ['160m', '80m', '60m', '40m', '30m', '20m', '17m', '15m', '12m', '10m'];
  var HF6 = HF.concat(['6m']);
  var HF_VU = HF6.concat(['2m', '70cm']);

  /** Native bands by lib/rig-models.js model name. */
  var MODEL_BANDS = {
    // Icom
    'IC-705': HF_VU,
    'IC-706MKII': HF6.concat(['2m']),
    'IC-706MKIIG': HF_VU,
    'IC-7000': HF_VU,
    'IC-7100': HF_VU,
    'IC-7200': HF6,
    'IC-7300': HF6,
    'IC-7300 MK II': HF6,
    'IC-7410': HF6,
    'IC-7600': HF6,
    'IC-7610': HF6,
    'IC-7851': HF6,
    'IC-7760': HF6,
    'IC-9700': ['2m', '70cm', '23cm'],
    // Yaesu
    'FT-450': HF6,
    'FT-710': HF6,
    'FT-817/818': HF_VU,
    'FT-857': HF_VU,
    'FT-897': HF_VU,
    'FT-891': HF6,
    'FT-991/991A': HF_VU,
    'FT-2000': HF6,
    'FTDX3000': HF6,
    'FTDX5000': HF6,
    'FTDX10': HF6,
    'FTDX101D/MP': HF6,
    'FTX-1 Field': HF_VU,
    'FTX-1 Optima': HF_VU,
    // Kenwood
    'TS-2000': HF_VU,
    'TS-480': HF6,
    'TS-590S/SG': HF6,
    'TS-890S': HF6,
    'TS-990S': HF6,
    // Elecraft
    'K3/K3S': HF6,
    'K4/K4D': HF6,
    'KX2/KX3': HF6,
    // QRP kits
    '(tr)uSDX': ['80m', '60m', '40m', '30m', '20m', '17m', '15m', '12m', '10m'],
    'QMX': HF6,
    'QDX': ['80m', '60m', '40m', '30m', '20m', '17m'],
    // Xiegu
    'G90': HF,
    'X6100': HF6,
    // FlexRadio
    'FLEX-6300': HF6,
    'FLEX-6500': HF6,
    'FLEX-6400/6400M': HF6,
    'FLEX-6600/6600M': HF6,
    'FLEX-8400/8600': HF6,
    'FLEX Aurora': HF6,
    'FLEX-6700': HF6.concat(['2m']),
  };

  function order(list) {
    var set = {};
    (list || []).forEach(function (b) { set[b] = true; });
    return ALL_BANDS.filter(function (b) { return set[b]; });
  }

  /** The bands a model does natively, or null when we cannot say. */
  function nativeBands(modelName, model) {
    if (model && Array.isArray(model.bands) && model.bands.length) return order(model.bands);
    var l = MODEL_BANDS[modelName];
    return l ? order(l) : null;
  }

  /** A saved `rig.bands` cleaned to known bands, in order; null when absent or empty. */
  function cleanBands(list) {
    if (!Array.isArray(list)) return null;
    var out = order(list.map(function (b) { return String(b || '').trim().toLowerCase(); }));
    return out.length ? out : null;
  }

  /**
   * The bands this rig is configured for: the operator's choice, else the
   * model's native bands, else null = not restricted (show every band).
   */
  function bandsForRig(rig, modelName, model) {
    var mine = cleanBands(rig && rig.bands);
    if (mine) return mine;
    return nativeBands(modelName, model);
  }

  /** Is `band` usable? A null list allows everything; a band we cannot name is allowed. */
  function allowed(bands, band) {
    if (!bands) return true;
    var b = String(band || '').trim().toLowerCase();
    if (!b || ALL_BANDS.indexOf(b) < 0) return true;
    return bands.indexOf(b) >= 0;
  }

  /** Filter any list by band, using `keyOf(item)` for the item's band. */
  function filterByBand(items, bands, keyOf) {
    if (!bands) return items;
    var key = keyOf || function (x) { return x; };
    return (items || []).filter(function (x) { return allowed(bands, key(x)); });
  }

  /** The band an MHz frequency is in (the ranges lib/bands.js uses), or ''. */
  var EDGES_MHZ = {
    '2200m': [0.1357, 0.1378], '630m': [0.472, 0.479], '160m': [1.8, 2.0], '80m': [3.5, 4.0],
    '60m': [5.25, 5.45], '40m': [7.0, 7.3], '30m': [10.1, 10.15], '20m': [14.0, 14.35],
    '17m': [18.068, 18.168], '15m': [21.0, 21.45], '12m': [24.89, 24.99], '10m': [28.0, 29.7],
    '6m': [50, 54], '4m': [69.9, 70.5], '2m': [144, 148], '1.25m': [222, 225], '70cm': [420, 450],
    '33cm': [902, 928], '23cm': [1240, 1300], '13cm': [2300, 2450], '9cm': [3300, 3500],
    '6cm': [5650, 5925], '3cm': [10000, 10500], '1.25cm': [24000, 24250],
  };
  function bandOfMhz(mhz) {
    var f = Number(mhz);
    if (!isFinite(f) || f <= 0) return '';
    for (var b in EDGES_MHZ) if (f >= EDGES_MHZ[b][0] && f <= EDGES_MHZ[b][1]) return b;
    return '';
  }

  /**
   * Hide every element under `root` matching `selector` whose band is not
   * usable (and show it again when it is). `bandOf(el)` names the element's
   * band; by default `data-band`, else a `data-freq`/`data-khz`/`value`
   * frequency. An <option> is hidden AND disabled (a hidden option can still
   * be reached with the keyboard). Returns the number hidden.
   */
  function applyToElements(root, selector, bands, bandOf) {
    if (!root || !root.querySelectorAll) return 0;
    var hidden = 0;
    var els = root.querySelectorAll(selector);
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var band = bandOf ? bandOf(el) : defaultBandOf(el);
      var ok = allowed(bands, band);
      el.hidden = !ok;
      if (el.tagName === 'OPTION') el.disabled = !ok;
      if (!ok) hidden++;
    }
    return hidden;
  }
  function defaultBandOf(el) {
    var d = el.dataset || {};
    if (d.band) return d.band;
    if (d.khz) return bandOfMhz(Number(d.khz) / 1000);
    if (d.freq) { var n = Number(d.freq); return bandOfMhz(n > 1000 ? n / 1000 : n); }
    var v = el.value != null ? String(el.value) : '';
    if (ALL_BANDS.indexOf(v.toLowerCase()) >= 0) return v.toLowerCase();
    var t = String(el.textContent || '').trim().toLowerCase().split(/\s/)[0];
    return ALL_BANDS.indexOf(t) >= 0 ? t : '';
  }

  /** A <select> whose chosen option was just hidden moves to the first usable one. */
  function fixSelect(sel) {
    if (!sel || !sel.options) return false;
    var cur = sel.options[sel.selectedIndex];
    if (!cur || !cur.hidden) return false;
    for (var i = 0; i < sel.options.length; i++) {
      if (!sel.options[i].hidden && !sel.options[i].disabled) { sel.selectedIndex = i; return true; }
    }
    return false;
  }

  return {
    ALL_BANDS: ALL_BANDS, HF: HF, MODEL_BANDS: MODEL_BANDS,
    nativeBands: nativeBands, cleanBands: cleanBands, bandsForRig: bandsForRig,
    allowed: allowed, filterByBand: filterByBand, bandOfMhz: bandOfMhz,
    applyToElements: applyToElements, fixSelect: fixSelect,
  };
});
