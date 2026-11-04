// lib/waterfall-palettes.js
//
// Waterfall / band scope colour palettes (Casey 2026-11-04: "themes for the
// waterfall/bandscope ... We have themes inside ECHOCAT iOS/Android").
//
// The eight phone palettes are copied VERBATIM from the ECHOCAT app
// (potacat-app src/utils/panDisplay.ts, PAN_PALETTES), with the same ids,
// labels, stops and trace colours and the same maths: linear in sRGB per
// channel between neighbouring stops, rounded, baked into a 256-entry table
// (entry i = colorAt(i / 255)). A palette therefore looks the same on the
// phone and the desktop. test/waterfall-palettes-test.js pins the values.
//
// 'auto' (the default) is not a palette: every window keeps the colours it
// has always drawn with, so nobody's waterfall changes on an upgrade.
// 'turbo' and 'spectrum' are the desktop's two built-in maps
// (renderer/waterfall.js cmTurbo / cmClassic), kept as choices.
//
// Tidepool is built from design tokens on the phone; with no token system
// shared here it ships as the phone's Dark resolution, and as its Light
// resolution when the window is in a light theme (`opts.light`).
//
// Dual-mode: require() in main and tests, window.WaterfallPalettes in the
// renderer (<script src="../lib/waterfall-palettes.js">).

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WaterfallPalettes = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function even(hexes) {
    const n = hexes.length;
    return hexes.map((h, i) => [i / (n - 1), h]);
  }

  const PALETTES = [
    { id: 'beacon', label: 'Beacon', trace: '#f5c043',
      stops: even(['#07111b', '#10304a', '#2f7fb0', '#62b6e4', '#f5c043', '#fff3d1']) },
    { id: 'campfire', label: 'Campfire', trace: '#ff8f45',
      stops: even(['#07111b', '#2a1418', '#8f2a22', '#ff8f45', '#f5c043', '#fff3d1']) },
    { id: 'canopy', label: 'Canopy', trace: '#45d6a4',
      stops: even(['#07111b', '#0c2e2a', '#1f7a5c', '#45d6a4', '#c9e86a', '#f5c043']) },
    { id: 'ultraviolet', label: 'Ultraviolet', trace: '#e879f9',
      stops: even(['#0b0d18', '#1d1840', '#5b3fc4', '#b07cff', '#e879f9', '#fde7ff']) },
    { id: 'slate', label: 'Slate', trace: '#e9eef2',
      stops: even(['#07111b', '#142433', '#3c556b', '#8ea3b4', '#e9eef2', '#f5c043']) },
    { id: 'tidepool', label: 'Tidepool', trace: '#38bdf8',
      stops: [[0, '#0b0d10'], [0.35, '#0c2a3a'], [0.6, '#38bdf8'], [0.8, '#52c992'], [1, '#ff6b76']],
      light: { trace: '#0e7490',
        stops: [[0, '#f4f5f7'], [0.35, '#cffafe'], [0.6, '#0e7490'], [0.8, '#047857'], [1, '#c8252f']] } },
    { id: 'classic', label: 'Classic', trace: '#00cccc',
      stops: [[0, '#000033'], [0.3, '#0000cc'], [0.55, '#00cccc'], [0.75, '#ffff00'], [1, '#ff0000']] },
    { id: 'night', label: 'Night', trace: '#ff3b30',
      stops: [[0, '#0a0000'], [0.4, '#4a0000'], [0.75, '#b30000'], [1, '#ff3b30']] },
    // The desktop's own two maps, exactly as renderer/waterfall.js draws them.
    { id: 'turbo', label: 'Turbo', trace: '#00dbb3', desktop: true,
      stops: [[0, '#1f0f47'], [0.25, '#006bdb'], [0.5, '#00dbb3'], [0.7, '#9ef238'], [0.88, '#faba0d'], [1, '#f5291a']] },
    { id: 'spectrum', label: 'Spectrum', trace: '#00ff00', desktop: true,
      stops: [[0, '#000000'], [0.2, '#000080'], [0.4, '#00ccff'], [0.6, '#00ff00'], [0.8, '#ffff00'], [1, '#ffffff']] },
  ];

  const DEFAULT = 'auto';
  const BY_ID = new Map(PALETTES.map(p => [p.id, p]));
  const ALIASES = { ember: 'campfire' };   // the phone's legacy stored id

  /** Unknown or missing → 'auto' (each window's usual colours). */
  function normalize(id) {
    if (typeof id !== 'string') return DEFAULT;
    const k = ALIASES[id] || id;
    return BY_ID.has(k) ? k : DEFAULT;
  }

  /** [{id, label}] in menu order, 'auto' first. */
  function choices() {
    return [{ id: 'auto', label: 'Standard (each window’s usual colours)' }]
      .concat(PALETTES.map(p => ({ id: p.id, label: p.label })));
  }

  function hexRgb(h) {
    const n = parseInt(h.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function variant(id, opts) {
    const p = BY_ID.get(normalize(id));
    if (!p) return null;
    return (opts && opts.light && p.light) ? p.light : p;
  }

  /** The phone's colorAt: t clamped 0..1, linear sRGB between stops, rounded. */
  function colorAt(stops, t) {
    t = t <= 0 ? 0 : t >= 1 ? 1 : t;
    if (t <= stops[0][0]) return hexRgb(stops[0][1]);
    for (let i = 1; i < stops.length; i++) {
      const [p1, h1] = stops[i];
      if (t <= p1) {
        const [p0, h0] = stops[i - 1];
        const f = p1 > p0 ? (t - p0) / (p1 - p0) : 0;
        const a = hexRgb(h0), b = hexRgb(h1);
        return [0, 1, 2].map(k => Math.round(a[k] + (b[k] - a[k]) * f));
      }
    }
    return hexRgb(stops[stops.length - 1][1]);
  }

  const _cache = new Map();
  /** 768-byte RGB table (256 entries) for a palette, or null for 'auto'. */
  function lutRgb(id, opts) {
    const v = variant(id, opts);
    if (!v) return null;
    const key = normalize(id) + (opts && opts.light && v !== BY_ID.get(normalize(id)) ? ':light' : '');
    if (_cache.has(key)) return _cache.get(key);
    const out = new Uint8Array(768);
    for (let i = 0; i < 256; i++) {
      const c = colorAt(v.stops, i / 255);
      out[i * 3] = c[0]; out[i * 3 + 1] = c[1]; out[i * 3 + 2] = c[2];
    }
    _cache.set(key, out);
    return out;
  }

  /** The palette's trace (spectrum line) colour, or null for 'auto'. */
  function trace(id, opts) {
    const v = variant(id, opts);
    return v ? v.trace : null;
  }

  /** Is this window drawn in a light theme? (renderer helper) */
  function isLightDocument(doc) {
    try {
      const h = doc.documentElement;
      return h.getAttribute('data-theme') === 'light';
    } catch (e) { return false; }
  }

  /**
   * Renderer glue: call cb(id, {light}) with the machine's palette now, on
   * every change (`api.onWaterfallPalette`), and when the window flips
   * between light and dark (Tidepool has a light variant). `api` is the
   * window's preload api (getWaterfallPalette / onWaterfallPalette).
   */
  function follow(api, cb) {
    let cur = DEFAULT;
    const doc = typeof document !== 'undefined' ? document : null;
    const fire = () => { try { cb(cur, { light: doc ? isLightDocument(doc) : false }); } catch (e) { /* window's own bug */ } };
    if (api && api.getWaterfallPalette) {
      Promise.resolve(api.getWaterfallPalette()).then((id) => { cur = normalize(id); fire(); }).catch(() => {});
    }
    if (api && api.onWaterfallPalette) api.onWaterfallPalette((id) => { cur = normalize(id); fire(); });
    if (doc && typeof MutationObserver !== 'undefined') {
      new MutationObserver(fire).observe(doc.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    }
    return { current: () => cur };
  }

  /** Fill a <select> with the choices, value = id. */
  function fillSelect(sel, value) {
    if (!sel) return;
    sel.innerHTML = '';
    for (const c of choices()) {
      const o = (sel.ownerDocument || document).createElement('option');
      o.value = c.id; o.textContent = c.label;
      sel.appendChild(o);
    }
    sel.value = normalize(value);
  }

  return { PALETTES, DEFAULT, normalize, choices, colorAt, lutRgb, trace, isLightDocument, follow, fillSelect };
});
