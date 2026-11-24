'use strict';
// My gateways (#254): the Winlink gateways an operator saved, usually from
// the card a good session ends with. One entry per gateway, mode and dial:
// { call, mode, khz, band, savedAt, lastGoodAt }. Kept in the profile's
// settings (winlinkFavourites), newest first, at most MAX.
//
// A gateway the operator typed in (#585, Add a gateway) is an entry with
// `mine: true`, and may carry `note` (60 characters), `via` (packet
// digipeaters, up to 2) and `bw` (its ARDOP bandwidth). Mine entries have a
// cap of their own (MAX_MINE), so starred sessions never push one out. The
// form's rules are lib/winlink-my-gateways.js.
//
// Pure: main.js stores the list and pushes it with winlink-state.

const { freqToBand } = require('./bands');
const Mine = require('./winlink-my-gateways');

const MAX = 40;
const MAX_MINE = 40;
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
  // gateway then gets the bandwidth it offers, up to the operator's own (#663).
  const um = /^([a-z0-9+]+):\/\/\/([A-Z0-9-]+)(\?[A-Za-z0-9=&.%-]*)?$/i.exec(String(g.url || ''));
  const url = um && um[2].toUpperCase() === call ? `${um[1].toLowerCase()}:///${call}${um[3] || ''}` : '';
  const out = {
    call, mode, khz: k, dialKhz: k, url, band: freqToBand(k / 1000) || '',
    savedAt: Number(g.savedAt) > 0 ? Number(g.savedAt) : Date.now(),
    lastGoodAt: Number(g.lastGoodAt) > 0 ? Number(g.lastGoodAt) : 0,
  };
  // #585: the operator's own fields, each kept only when valid (dropped
  // silently otherwise; the entry stays).
  if (g.mine === true) out.mine = true;
  if (typeof g.note === 'string') {
    const note = Mine.cleanNote(g.note);
    if (note && note.length <= Mine.MAX_NOTE) out.note = note;
  }
  if (mode === 'packet' && Array.isArray(g.via) && g.via.length) {
    const v = Mine.parseVia(g.via);
    if (v.ok && v.via.length) out.via = v.via;
  }
  if (mode === 'ardop' && Mine.ARDOP_BWS.includes(Number(g.bw))) out.bw = Number(g.bw);
  return out;
}

/** The stored list, cleaned and de-duplicated (first wins). */
function normalize(list) {
  const seen = new Set();
  const out = [];
  let starred = 0, mine = 0;
  for (const g of Array.isArray(list) ? list : []) {
    const c = clean(g);
    if (!c || seen.has(keyOf(c))) continue;
    if (c.mine ? mine >= MAX_MINE : starred >= MAX) continue;
    if (c.mine) mine++; else starred++;
    seen.add(keyOf(c));
    out.push(c);
  }
  return out;
}

function has(list, g) {
  const k = keyOf(g);
  return normalize(list).some((x) => keyOf(x) === k);
}

/**
 * Saved at the top; saving one already there keeps it, newest first. The star
 * on a listed row never sets `mine`, and starring a Mine entry changes nothing:
 * it is already saved, with the operator's own fields.
 */
function add(list, g, now = Date.now()) {
  const c = clean({ ...g, savedAt: now });
  if (!c) return { ok: false, list: normalize(list), error: 'That gateway has no call, mode or dial to save' };
  const all = normalize(list);
  const rest = all.filter((x) => keyOf(x) !== keyOf(c));
  const prev = all.find((x) => keyOf(x) === keyOf(c));
  if (prev && prev.mine && !c.mine) return { ok: true, list: all };
  if (prev) { c.savedAt = prev.savedAt; c.lastGoodAt = Math.max(prev.lastGoodAt, c.lastGoodAt); if (!c.url) c.url = prev.url; }
  return { ok: true, list: normalize([c, ...rest]) };
}

/**
 * Edit (#585): the entry named by `was` ({ call, mode, dialKhz }) is replaced
 * by `g`, in one save. It keeps when it was first saved. A bad `g` changes
 * nothing.
 */
function edit(list, was, g, now = Date.now()) {
  const all = normalize(list);
  const w = was && typeof was === 'object' ? { call: was.call, mode: was.mode, khz: was.khz != null ? was.khz : was.dialKhz } : null;
  const c = clean({ ...g, savedAt: now });
  if (!c || !w) return { ok: false, list: all, error: 'That gateway has no call, mode or dial to save' };
  const prev = all.find((x) => keyOf(x) === keyOf(w));
  if (prev) { c.savedAt = prev.savedAt; c.lastGoodAt = prev.lastGoodAt; }
  const rest = all.filter((x) => keyOf(x) !== keyOf(w) && keyOf(x) !== keyOf(c));
  return { ok: true, list: normalize([c, ...rest]) };
}

/** The operator's own entry for this call, mode and dial, or null (a starred one is not "mine"). */
function findMine(list, g) {
  if (!g) return null;
  const k = keyOf({ call: g.call, mode: g.mode, khz: g.khz != null ? g.khz : g.dialKhz });
  return normalize(list).find((x) => x.mine === true && keyOf(x) === k) || null;
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

module.exports = { MAX, MAX_MINE, keyOf, clean, normalize, has, add, edit, findMine, remove, markGood };
