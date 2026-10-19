'use strict';
// Editing the general watchlist by OPERATIONS, not by replacing the string
// (ECHOCAT watchlist sync, 2026-10-19): the desktop and a mobile device can
// both add and remove entries, and two edits at once must not overwrite each
// other — so a device sends "add these, remove those" and the desktop applies
// it to whatever the list is NOW.
//
// The list is settings.watchlist, the comma-separated string parseWatchlist
// reads: "K1ABC, W1AW:20m:CW, US-NJ". An entry is a callsign (or a W1AW/*
// prefix, or a state token like US-NJ / NJ) with optional :band and :mode.
// Entries compare case-insensitively and WHOLE (K1ABC and K1ABC:20m are two
// different entries — removing one never removes the other).
//
// Pure. main.js saves, tells the window and re-sends the settings blob.

const MAX_ENTRY = 40;
const MAX_ENTRIES = 1000;

/** The entries of a watchlist string, trimmed, empties dropped. */
function entriesOf(raw) {
  return String(raw || '').split(',').map((s) => s.trim()).filter(Boolean);
}

/** Canonical form for comparison: upper case, no spaces around the colons. */
function keyOf(entry) {
  return String(entry || '').split(':').map((p) => p.trim()).join(':').toUpperCase();
}

/** A well-formed entry: a call/prefix/state token, then optional parts. */
function validEntry(entry) {
  const e = String(entry || '').trim();
  if (!e || e.length > MAX_ENTRY || e.includes(',')) return false;
  const parts = e.split(':').map((p) => p.trim());
  if (!/^[A-Za-z0-9/*?-]+$/.test(parts[0])) return false;
  return parts.slice(1).every((p) => /^[A-Za-z0-9-]+$/.test(p));
}

/**
 * @param {string} raw  the current settings.watchlist
 * @param {{add?: string[], remove?: string[]}} op
 * @returns {{ next: string, changed: boolean, added: string[], removed: string[], rejected: string[] }}
 */
function applyWatchlistEdit(raw, op) {
  const list = entriesOf(raw);
  const added = [], removed = [], rejected = [];
  const rm = new Set();
  for (const e of (op && Array.isArray(op.remove) ? op.remove : [])) {
    if (!validEntry(e)) { rejected.push(String(e)); continue; }
    rm.add(keyOf(e));
  }
  const kept = list.filter((e) => {
    if (rm.has(keyOf(e))) { removed.push(e); return false; }
    return true;
  });
  const have = new Set(kept.map(keyOf));
  for (const e of (op && Array.isArray(op.add) ? op.add : [])) {
    if (!validEntry(e)) { rejected.push(String(e)); continue; }
    const k = keyOf(e);
    if (have.has(k)) continue; // already there: a no-op, not an error
    if (kept.length >= MAX_ENTRIES) { rejected.push(String(e)); continue; }
    const clean = String(e).split(':').map((p) => p.trim()).join(':');
    kept.push(clean);
    have.add(k);
    added.push(clean);
  }
  const changed = added.length > 0 || removed.length > 0;
  return { next: changed ? kept.join(', ') : String(raw || ''), changed, added, removed, rejected };
}

module.exports = { applyWatchlistEdit, entriesOf, keyOf, validEntry };
