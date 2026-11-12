'use strict';
// Winlink message templates (Casey 2026-11-11): the mail window's Templates
// button holds the built-in ones (Position report, POTA spot) and the
// operator's own, each a message to start from: { id, name, to, cc, subject,
// body }. Kept in the profile's settings (winlinkTemplates), at most MAX, in
// the order they were made. Pure.

const MAX = 30;
const LIMITS = { name: 60, to: 500, cc: 500, subject: 128, body: 20000 };

function str(v, n) { return String(v == null ? '' : v).slice(0, n); }

/** A clean template, or null when it has no name. */
function clean(t) {
  if (!t || typeof t !== 'object') return null;
  const name = str(t.name, LIMITS.name).trim();
  if (!name) return null;
  const id = /^[a-z0-9]{6,24}$/.test(String(t.id || '')) ? String(t.id) : null;
  return { id, name, to: str(t.to, LIMITS.to).trim(), cc: str(t.cc, LIMITS.cc).trim(), subject: str(t.subject, LIMITS.subject), body: str(t.body, LIMITS.body) };
}

function newId(now = Date.now()) {
  return (now.toString(36) + Math.random().toString(36).slice(2, 8)).slice(0, 16);
}

/** The stored list, cleaned, every entry with an id, names unique (first wins). */
function normalize(list) {
  const out = [];
  const names = new Set();
  for (const t of Array.isArray(list) ? list : []) {
    const c = clean(t);
    if (!c || names.has(c.name.toLowerCase())) continue;
    if (!c.id) c.id = newId() + out.length;
    names.add(c.name.toLowerCase());
    out.push(c);
  }
  return out.slice(0, MAX);
}

/**
 * Save a template: one with the id of an existing one replaces it in place;
 * a new one goes at the end. A name another template already has is refused.
 */
function save(list, t) {
  const cur = normalize(list);
  const c = clean(t);
  if (!c) return { ok: false, list: cur, error: 'Give the template a name' };
  const at = c.id ? cur.findIndex((x) => x.id === c.id) : -1;
  const clash = cur.find((x, i) => i !== at && x.name.toLowerCase() === c.name.toLowerCase());
  if (clash) return { ok: false, list: cur, error: `There is already a template called "${clash.name}"` };
  if (at >= 0) { const next = cur.slice(); next[at] = c; return { ok: true, list: next, id: c.id }; }
  if (cur.length >= MAX) return { ok: false, list: cur, error: `At most ${MAX} templates; delete one first` };
  c.id = newId();
  return { ok: true, list: [...cur, c], id: c.id };
}

function remove(list, id) {
  return normalize(list).filter((t) => t.id !== id);
}

module.exports = { MAX, LIMITS, clean, normalize, save, remove };
