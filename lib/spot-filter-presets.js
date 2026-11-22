// SPDX-License-Identifier: Apache-2.0
// Spot filter presets: named sets of the spot filters, switched with one
// click ("POTA 40m CW", "DX 10m"). A preset holds the filter bar (bands,
// modes, the Calls field), the Spots menu's sources and its Filters
// switches, and the Region (continent) choice. It does not hold the per-band
// region mutes, the hidden spots or Event Focus: those are lists of their
// own and stay as they are.
//
// Presets live in settings.spotFilterPresets (desktop-owned). Every list is
// sanitised here, whatever wrote it (settings.json, the window, an import),
// and the window marks the preset that matches the filters now set, so a
// hand change shows at once that no preset is in force any more.
//
// Dual-mode like lib/spot-mute-rules.js: require() from main and tests,
// window.SpotFilterPresets via <script> in the renderer.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SpotFilterPresets = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MAX_PRESETS = 30;
  const MAX_NAME = 40;
  const MAX_CALLS = 400;

  // The spot sources a preset switches, in the Spots menu's order.
  const SOURCE_KEYS = ['pota', 'sota', 'wwff', 'llota', 'wwbota', 'tiles', 'gma', 'parc',
    'cluster', 'cwspots', 'rbn', 'pskr', 'dxe'];
  // The Spots menu's Filters switches a preset holds.
  const HIDE_KEYS = ['worked', 'workedParks', 'workedCallRef', 'prioritizeNew', 'strictAtno',
    'outOfBand', 'qrt', 'dxOnly'];
  const CONTINENTS = ['AF', 'AN', 'AS', 'EU', 'NA', 'OC', 'SA'];

  const SOURCE_LABELS = {
    pota: 'POTA', sota: 'SOTA', wwff: 'WWFF', llota: 'LLOTA', wwbota: 'WWBOTA', tiles: 'Tiles',
    gma: 'GMA', parc: 'PARC', cluster: 'DX Cluster', cwspots: 'CW Spots', rbn: 'RBN',
    pskr: 'FreeDV', dxe: 'DX Expeditions',
  };
  const HIDE_LABELS = {
    worked: 'hide worked stations', workedParks: 'hide worked parks',
    workedCallRef: 'hide worked call+park', prioritizeNew: 'new parks at top',
    strictAtno: 'strict ATNO', outOfBand: 'hide out-of-privilege', qrt: 'hide QRT', dxOnly: 'DX only',
  };

  /** A preset name: trimmed, inner spaces collapsed, at most MAX_NAME characters. */
  function cleanName(name) {
    return String(name == null ? '' : name).replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
  }

  function nameKey(name) {
    return cleanName(name).toUpperCase();
  }

  // A value list: null means "All". Tokens are short and plain (a band is
  // '40m' or '1.25cm', a mode 'CW' or 'FREEDV'); anything else is dropped.
  // An empty list after cleaning is "All" as well: a preset can never hide
  // every spot by accident.
  function cleanList(list, { upper = false, lower = false, allowed = null } = {}) {
    if (!Array.isArray(list)) return null;
    const out = [];
    for (const v of list) {
      let t = String(v == null ? '' : v).trim();
      if (upper) t = t.toUpperCase();
      if (lower) t = t.toLowerCase();
      if (!/^[A-Za-z0-9.]{1,10}$/.test(t)) continue;
      if (allowed && !allowed.includes(t)) continue;
      if (!out.includes(t)) out.push(t);
    }
    return out.length ? out.sort() : null;
  }

  function cleanFlags(src, keys) {
    if (!src || typeof src !== 'object') return null;
    const out = {};
    for (const k of keys) out[k] = src[k] === true;
    return out;
  }

  // The Calls field as the user typed it, cut to a sane length. Compared by
  // its entries (see callsKey), so "LZ, SP" and "sp,lz" are the same filter.
  function cleanCalls(calls) {
    return String(calls == null ? '' : calls).replace(/[\r\n]+/g, ' ').trim().slice(0, MAX_CALLS);
  }

  function callsKey(calls) {
    return cleanCalls(calls).toUpperCase().split(/[\s,;]+/).filter(Boolean).sort().join(',');
  }

  /**
   * The filters of a preset (or of the window now), sanitised. `bandRadio` /
   * `modeRadio` mean "follow the radio" and win over a band or mode list.
   * `sources` / `hide` missing stay null: such a preset leaves them alone.
   */
  function normalizeFilters(f) {
    const src = f && typeof f === 'object' ? f : {};
    const bandRadio = src.bandRadio === true;
    const modeRadio = src.modeRadio === true;
    return {
      bands: bandRadio ? null : cleanList(src.bands, { lower: true }),
      bandRadio,
      modes: modeRadio ? null : cleanList(src.modes, { upper: true }),
      modeRadio,
      continents: cleanList(src.continents, { upper: true, allowed: CONTINENTS }),
      calls: cleanCalls(src.calls),
      sources: cleanFlags(src.sources, SOURCE_KEYS),
      hide: cleanFlags(src.hide, HIDE_KEYS),
    };
  }

  /** One preset { name, ...filters }, or null when it has no usable name. */
  function normalizePreset(p) {
    if (!p || typeof p !== 'object') return null;
    const name = cleanName(p.name);
    if (!name) return null;
    return { name, ...normalizeFilters(p) };
  }

  /** A preset list from any source: bad entries dropped, the first of a name kept, capped. */
  function normalizePresets(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    const seen = new Set();
    for (const raw of list) {
      const p = normalizePreset(raw);
      if (!p) continue;
      const k = nameKey(p.name);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(p);
      if (out.length >= MAX_PRESETS) break;
    }
    return out;
  }

  function sameList(a, b) {
    if (a === null || b === null) return a === b;
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }

  function sameFlags(a, b, keys) {
    if (!a || !b) return true; // a preset without them does not set them
    return keys.every((k) => a[k] === b[k]);
  }

  /** True when the filters set now are what `preset` sets. */
  function matchesPreset(preset, current) {
    const p = normalizeFilters(preset);
    const c = normalizeFilters(current);
    return p.bandRadio === c.bandRadio && sameList(p.bands, c.bands)
      && p.modeRadio === c.modeRadio && sameList(p.modes, c.modes)
      && sameList(p.continents, c.continents)
      && callsKey(p.calls) === callsKey(c.calls)
      && sameFlags(p.sources, c.sources, SOURCE_KEYS)
      && sameFlags(p.hide, c.hide, HIDE_KEYS);
  }

  /** The first preset that matches the filters set now, or null. */
  function findMatchingPreset(list, current) {
    for (const p of normalizePresets(list)) if (matchesPreset(p, current)) return p;
    return null;
  }

  function indexOfName(list, name) {
    const k = nameKey(name);
    return list.findIndex((p) => nameKey(p.name) === k);
  }

  /**
   * Save `filters` under `name`: replaces the preset of that name (any case)
   * in place, else adds it at the end. { list, error } — error is a sentence
   * for the user, and the list is then unchanged.
   */
  function savePreset(list, name, filters) {
    const cur = normalizePresets(list);
    const clean = cleanName(name);
    if (!clean) return { list: cur, error: 'Give the preset a name.' };
    const preset = { name: clean, ...normalizeFilters(filters) };
    const i = indexOfName(cur, clean);
    if (i >= 0) {
      cur[i] = preset;
      return { list: cur, error: null };
    }
    if (cur.length >= MAX_PRESETS) {
      return { list: cur, error: `There are already ${MAX_PRESETS} presets. Delete one first.` };
    }
    cur.push(preset);
    return { list: cur, error: null };
  }

  /** Rename a preset. { list, error }; a name another preset has is refused. */
  function renamePreset(list, oldName, newName) {
    const cur = normalizePresets(list);
    const i = indexOfName(cur, oldName);
    if (i < 0) return { list: cur, error: 'That preset no longer exists.' };
    const clean = cleanName(newName);
    if (!clean) return { list: cur, error: 'Give the preset a name.' };
    const j = indexOfName(cur, clean);
    if (j >= 0 && j !== i) return { list: cur, error: `There is already a preset called "${cur[j].name}".` };
    cur[i] = { ...cur[i], name: clean };
    return { list: cur, error: null };
  }

  /** The list without the preset of that name. */
  function deletePreset(list, name) {
    const cur = normalizePresets(list);
    const i = indexOfName(cur, name);
    if (i >= 0) cur.splice(i, 1);
    return cur;
  }

  /** Move a preset up (-1) or down (+1); the ends stay where they are. */
  function movePreset(list, name, delta) {
    const cur = normalizePresets(list);
    const i = indexOfName(cur, name);
    const j = i + (delta < 0 ? -1 : 1);
    if (i < 0 || j < 0 || j >= cur.length) return cur;
    const [p] = cur.splice(i, 1);
    cur.splice(j, 0, p);
    return cur;
  }

  /** One line for a tooltip: what the preset sets. */
  function describePreset(preset) {
    const p = normalizeFilters(preset);
    const parts = [];
    parts.push('Band: ' + (p.bandRadio ? 'radio' : p.bands ? p.bands.join(', ') : 'all'));
    parts.push('Mode: ' + (p.modeRadio ? 'radio' : p.modes ? p.modes.join(', ') : 'all'));
    if (p.continents) parts.push('Region: ' + p.continents.join(', '));
    if (p.calls) parts.push('Calls: ' + p.calls);
    if (p.sources) {
      const on = SOURCE_KEYS.filter((k) => p.sources[k]).map((k) => SOURCE_LABELS[k]);
      parts.push('Sources: ' + (on.length ? on.join(', ') : 'none'));
    }
    if (p.hide) {
      const on = HIDE_KEYS.filter((k) => p.hide[k]).map((k) => HIDE_LABELS[k]);
      if (on.length) parts.push(on.join(', '));
    }
    return parts.join(' · ');
  }

  return {
    MAX_PRESETS,
    MAX_NAME,
    SOURCE_KEYS,
    HIDE_KEYS,
    cleanName,
    normalizeFilters,
    normalizePreset,
    normalizePresets,
    matchesPreset,
    findMatchingPreset,
    savePreset,
    renamePreset,
    deletePreset,
    movePreset,
    describePreset,
  };
});
