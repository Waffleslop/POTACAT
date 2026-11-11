'use strict';
/**
 * The other parks of an n-fer, from the activator's own spot comments.
 *
 * A POTA spot carries one reference. An activator at several parks at once
 * usually self-spots one of them and lists the rest in the comment ("3-fer
 * DE-1197,DE-0941,DE-0034 FT8"), so a hunted contact matched on the spot list
 * was logged at one park only (DA2PK and DK5UR, 2026-11-11). Only the
 * activator's OWN spots count: hunters' comments name other parks too (a
 * park-to-park contact names the hunter's park).
 *
 * The history comes from POTA (/spot/comments/{call}/{ref}) fetched ahead of
 * time, plus the spots POTACAT already collected from its polls: logging
 * must not wait on the network, because the next TX message is set after it.
 *
 * Pure apart from the injected fetch and clock.
 */

// POTA references: a 1-3 character prefix, a dash, 4 or 5 digits (DE-1197,
// US-12345, K-1234, 9A-0001). WWFF ("DLFF-0123") has a 4-letter prefix, so
// it never matches.
const POTA_REF_RE = /\b[A-Z0-9]{1,3}-\d{4,5}\b/g;

function baseCall(call) {
  const parts = String(call || '').toUpperCase().split('/').filter(Boolean);
  if (parts.length <= 1) return parts[0] || '';
  // The longest part is the call (EA8/DF4UE -> DF4UE, G8XDD/P -> G8XDD).
  return parts.reduce((a, b) => (b.length > a.length ? b : a));
}

/** POTA references named in the activator's own spot comments, in order, deduped. */
function selfSpotRefs(spots, activator) {
  const me = baseCall(activator);
  if (!me || !Array.isArray(spots)) return [];
  const out = [];
  for (const s of spots) {
    if (!s || baseCall(s.spotter) !== me) continue;
    const text = String(s.comments || '').toUpperCase();
    for (const m of text.matchAll(POTA_REF_RE)) if (!out.includes(m[0])) out.push(m[0]);
  }
  return out;
}

/**
 * Prefetched POTA spot histories, keyed by activator + spotted park.
 * prefetch() is cheap to call on every decode: one request per key per ttl.
 */
class NferCache {
  constructor({ fetchHistory, now = Date.now, ttlMs = 30 * 60 * 1000, failTtlMs = 5 * 60 * 1000 } = {}) {
    this._fetch = fetchHistory;
    this._now = now;
    this._ttl = ttlMs;
    this._failTtl = failTtlMs;
    this._map = new Map(); // key -> { refs, at, ttl, pending }
  }

  _key(call, ref) { return `${baseCall(call)}|${String(ref || '').toUpperCase()}`; }

  prefetch(call, ref) {
    if (!call || !ref || !this._fetch) return;
    const key = this._key(call, ref);
    const e = this._map.get(key);
    if (e && (e.pending || this._now() - e.at < e.ttl)) return;
    const entry = { refs: e ? e.refs : [], at: this._now(), ttl: this._ttl, pending: true };
    this._map.set(key, entry);
    Promise.resolve()
      .then(() => this._fetch(call, ref))
      .then((spots) => { entry.refs = selfSpotRefs(spots, call); })
      .catch(() => { entry.ttl = this._failTtl; })
      .finally(() => { entry.pending = false; entry.at = this._now(); });
    if (this._map.size > 500) this._map.delete(this._map.keys().next().value);
  }

  /** The refs known now for this activator at this park ([] when none or not fetched yet). */
  get(call, ref) {
    const e = this._map.get(this._key(call, ref));
    return e ? e.refs.slice() : [];
  }
}

/**
 * The POTA refs to log for a hunted contact: the ones the spot list matched,
 * then the n-fer's others from the activator's own comments (prefetched POTA
 * history and the spots POTACAT collected). Only when the comment names the
 * spotted park itself, so a stale comment from another activation cannot add
 * parks to this one.
 */
function nferExtraRefs({ call, spottedRef, known = [], cached = [], collected = [] }) {
  const ref = String(spottedRef || '').toUpperCase();
  const fromSpots = selfSpotRefs(collected, call);
  const named = [...cached, ...fromSpots.filter((r) => !cached.includes(r))];
  if (!ref || !named.includes(ref)) return [];
  const have = new Set(known.map((r) => String(r).toUpperCase()));
  return named.filter((r) => r !== ref && !have.has(r));
}

module.exports = { POTA_REF_RE, baseCall, selfSpotRefs, NferCache, nferExtraRefs };
