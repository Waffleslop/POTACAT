'use strict';
// My gateways (#254): the Winlink gateways an operator saved, usually from
// the card a good session ends with. One entry per gateway, mode and dial:
// { call, mode, khz, band, savedAt, lastGoodAt }. Kept in the profile's
// settings (winlinkFavourites), newest first, at most MAX.
//
// Pure: main.js stores the list and pushes it with winlink-state.

const { freqToBand } = require('./bands');

const MAX = 40;
const MODES = ['ardop', 'vara', 'varafm', 'packet', 'mercury'];

function keyOf(g) {
  return `${String(g.call || '').toUpperCase()}|${g.mode || ''}|${g.khz != null ? Number(g.khz).toFixed(1) : ''}`;
}

/** A clean entry, or null when the call, mode or dial is not usable. */
function clean(g) {
  if (!g || typeof g !== 'object') return null;
  const call = String(g.call || '').toUpperCase().trim();
  if (!/^[A-Z0-9]{3,10}(-\d{1,2})?$/.test(call)) return null;
  const mode = String(g.mode || '');
  if (!MODES.includes(mode)) return null;
  const khz = Number(g.khz != null ? g.khz : g.dialKhz);
  if (!(khz > 0) || khz > 1.5e6) return null;
  const k = Math.round(khz * 10) / 10;
  // Winlink's own URL for this gateway, kept only when it names the same
  // call and has no host part (no credentials can ride along): calling a saved
  // gateway then gets the bandwidth it offers, not Pat's 500 Hz default.
  const um = /^([a-z0-9+]+):\/\/\/([A-Z0-9-]+)(\?[A-Za-z0-9=&.%-]*)?$/i.exec(String(g.url || ''));
  const url = um && um[2].toUpperCase() === call ? `${um[1].toLowerCase()}:///${call}${um[3] || ''}` : '';
  return {
    call, mode, khz: k, dialKhz: k, url, band: freqToBand(k / 1000) || '',
    savedAt: Number(g.savedAt) > 0 ? Number(g.savedAt) : Date.now(),
    lastGoodAt: Number(g.lastGoodAt) > 0 ? Number(g.lastGoodAt) : 0,
  };
}

/** The stored list, cleaned and de-duplicated (first wins). */
function normalize(list) {
  const seen = new Set();
  const out = [];
  for (const g of Array.isArray(list) ? list : []) {
    const c = clean(g);
    if (!c || seen.has(keyOf(c))) continue;
    seen.add(keyOf(c));
    out.push(c);
  }
  return out.slice(0, MAX);
}

function has(list, g) {
  const k = keyOf(g);
  return normalize(list).some((x) => keyOf(x) === k);
}

/** Saved at the top; saving one already there keeps it, newest first. */
function add(list, g, now = Date.now()) {
  const c = clean({ ...g, savedAt: now });
  if (!c) return { ok: false, list: normalize(list), error: 'That gateway has no call, mode or dial to save' };
  const rest = normalize(list).filter((x) => keyOf(x) !== keyOf(c));
  const prev = normalize(list).find((x) => keyOf(x) === keyOf(c));
  if (prev) { c.savedAt = prev.savedAt; c.lastGoodAt = Math.max(prev.lastGoodAt, c.lastGoodAt); if (!c.url) c.url = prev.url; }
  return { ok: true, list: [c, ...rest].slice(0, MAX) };
}

function remove(list, g) {
  const k = keyOf(g);
  return normalize(list).filter((x) => keyOf(x) !== k);
}

/** A good session with a saved gateway: remember when, no reorder. */
function markGood(list, g, at = Date.now()) {
  const k = keyOf(g);
  let changed = false;
  const out = normalize(list).map((x) => {
    if (keyOf(x) !== k) return x;
    changed = true;
    return { ...x, lastGoodAt: at };
  });
  return { changed, list: out };
}

module.exports = { MAX, keyOf, clean, normalize, has, add, remove, markGood };
