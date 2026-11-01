'use strict';
// The spot table blanked, then showed WWFF, then POTA came back (wayne,
// 2026-10-31). refreshSpots merges every source with Promise.allSettled and
// keeps only the fulfilled ones, so one failed or rate-limited POTA fetch
// emptied every POTA row until the next good fetch a minute later. Each
// source now keeps its last good list and stands in with it through a
// failure, for up to `maxAgeMs` (spots older than that are stale anyway).
// Pure apart from the injected clock and log.

/**
 * @param {object} [o]
 *   maxAgeMs  how long a last good list may stand in (default 10 min)
 *   now()     clock (tests)
 *   log(line) one line when a source fails and when it recovers
 */
function createSpotSourceCache(o = {}) {
  const maxAgeMs = o.maxAgeMs || 10 * 60 * 1000;
  const now = o.now || (() => Date.now());
  const log = o.log || (() => {});
  const last = new Map();   // source -> { spots, at }
  const failing = new Set();

  /** Resolve to the fresh list, or to the last good one when the fetch fails. */
  function wrap(source, promise) {
    return Promise.resolve(promise).then((spots) => {
      const list = Array.isArray(spots) ? spots : [];
      last.set(source, { spots: list, at: now() });
      if (failing.delete(source)) log(`[Spots] ${source} spots are back (${list.length})`);
      return list;
    }, (err) => {
      const kept = last.get(source);
      const age = kept ? now() - kept.at : Infinity;
      const why = (err && err.message) ? err.message : String(err);
      if (!failing.has(source)) {
        failing.add(source);
        log(kept && age <= maxAgeMs
          ? `[Spots] ${source} fetch failed (${why}) — showing the last ${kept.spots.length} ${source} spots from ${Math.round(age / 1000)} s ago until it answers`
          : `[Spots] ${source} fetch failed (${why}) — no recent ${source} spots to show`);
      }
      return kept && age <= maxAgeMs ? kept.spots : [];
    });
  }

  return { wrap, isFailing: (s) => failing.has(s) };
}

module.exports = { createSpotSourceCache };
