'use strict';
// Hidden spots, shared by every surface (K8IKO 2026-10-01: "If I hide a
// station on any device, sync that status across all POTACAT/ECHOCAT
// devices"). The desktop's main process owns the one list; the desktop
// window, ECHOCAT Web and the mobile app render it. Wire contract:
// potacat-app docs/desktop-handoffs/spot-hides-sync-contract.md.
//
// Shape: { CALL: { key: expiresAt } }
//   key       '*' (every spot of the call), whole kHz ('14074'), or 'band:20m'
//   expiresAt epoch ms, or null = forever
//
// null, not Infinity, is "forever" everywhere outside the desktop window's
// own memory: JSON turns Infinity into null, and the window's old prune read
// that null as expired, so a desktop "Hide forever" never survived a restart.
//
// Skips sync too (Casey 2026-10-01, agreeing with the app's contract), but
// stay a "not now": main keeps them in memory only and drops them at 0000Z
// and on restart. A skip key is the spot's callsign and frequency, verbatim,
// joined by a tab ("W1ABC	14074.0"), as the desktop window's scan uses it.

/** A hide key a client may send: '*', whole kHz, or band:<label>. */
function validKey(key) {
  if (typeof key !== 'string' || !key || key.length > 24) return false;
  return key === '*' || /^\d{1,7}$/.test(key) || /^band:[0-9a-z.]{1,8}$/i.test(key);
}

function validCall(call) {
  return typeof call === 'string' && /^[A-Z0-9/]{2,20}$/i.test(call.trim());
}

/** An expiry as stored: a finite number of ms, or null for forever. */
function normExpiry(v) {
  if (v === null || v === undefined || v === Infinity) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined; // undefined = drop the key
}

/**
 * Anything stored or received -> { CALL: { key: number|null } }. Accepts the
 * desktop window's legacy shapes: a bare number (or Infinity) per call means
 * { '*': value }, and Infinity anywhere means forever.
 */
function normalizeHides(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [rawCall, entry] of Object.entries(raw)) {
    if (!validCall(rawCall)) continue;
    const call = rawCall.trim().toUpperCase();
    const keys = (entry === null || typeof entry !== 'object') ? { '*': entry } : entry;
    for (const [key, v] of Object.entries(keys)) {
      if (!validKey(key)) continue;
      const exp = normExpiry(v);
      if (exp === undefined) continue;
      if (!out[call]) out[call] = {};
      out[call][key] = exp;
    }
  }
  return out;
}

/** Drop expired keys and empty calls. Returns { hides, changed }. */
function pruneHides(hides, now) {
  const out = {};
  let changed = false;
  for (const [call, entry] of Object.entries(hides || {})) {
    for (const [key, exp] of Object.entries(entry || {})) {
      if (exp !== null && exp <= now) { changed = true; continue; }
      if (!out[call]) out[call] = {};
      out[call][key] = exp;
    }
    if (!out[call]) changed = true;
  }
  return { hides: out, changed };
}

/** Hide `call` under `key` until `expiresAt` (null/absent = forever). */
function applyHide(hides, call, key, expiresAt) {
  if (!validCall(call) || !validKey(key)) return { hides, changed: false };
  const exp = normExpiry(expiresAt);
  if (exp === undefined) return { hides, changed: false };
  const c = call.trim().toUpperCase();
  const prev = hides[c] && Object.prototype.hasOwnProperty.call(hides[c], key) ? hides[c][key] : undefined;
  if (prev === exp) return { hides, changed: false };
  return { hides: { ...hides, [c]: { ...(hides[c] || {}), [key]: exp } }, changed: true };
}

/** Unhide one key of `call`, or every key when `key` is absent. */
function applyUnhide(hides, call, key) {
  if (!validCall(call)) return { hides, changed: false };
  const c = call.trim().toUpperCase();
  if (!hides[c]) return { hides, changed: false };
  const out = { ...hides };
  if (key === undefined || key === null || key === '') {
    delete out[c];
    return { hides: out, changed: true };
  }
  if (!Object.prototype.hasOwnProperty.call(hides[c], key)) return { hides, changed: false };
  const entry = { ...hides[c] };
  delete entry[key];
  if (Object.keys(entry).length) out[c] = entry; else delete out[c];
  return { hides: out, changed: true };
}

/** Union of two lists; the later expiry wins, forever beats any time. Used
 *  once to fold the desktop window's old localStorage list into main's. */
function mergeHides(a, b) {
  const out = normalizeHides(a);
  for (const [call, entry] of Object.entries(normalizeHides(b))) {
    for (const [key, exp] of Object.entries(entry)) {
      const cur = out[call] && Object.prototype.hasOwnProperty.call(out[call], key) ? out[call][key] : undefined;
      const keep = cur === undefined ? exp : (cur === null || exp === null) ? null : Math.max(cur, exp);
      if (!out[call]) out[call] = {};
      out[call][key] = keep;
    }
  }
  return out;
}

/** The skip key for a spot: callsign + TAB + frequency, both verbatim. */
function skipKey(call, frequency) {
  if (typeof call !== 'string' || !call.trim() || call.length > 20) return null;
  if (frequency === undefined || frequency === null) return null;
  const f = String(frequency);
  if (!f || f.length > 16 || /	/.test(f) || /	/.test(call)) return null;
  return call + '	' + f;
}

/** Add or remove one skip. Idempotent (the app replays queued ops). */
function applySkip(skips, call, frequency, skipped) {
  const key = skipKey(call, frequency);
  if (!key) return { skips, changed: false };
  const has = skips.includes(key);
  if (skipped && !has) return { skips: [...skips, key], changed: true };
  if (!skipped && has) return { skips: skips.filter((k) => k !== key), changed: true };
  return { skips, changed: false };
}

module.exports = { skipKey, applySkip, normalizeHides, pruneHides, applyHide, applyUnhide, mergeHides, validKey, validCall };
