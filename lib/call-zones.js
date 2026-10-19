'use strict';
// CQ and ITU zones for spots and logbook rows (LZ3AW item 30, 2026-10-19).
//
// Zones come from cty.dat via lib/cty.js resolveZones — the entity's zones,
// or the per-prefix override cty.dat lists (W6 -> CQ 3, VE7 -> CQ 3, UA0 ->
// CQ 18). A logged QSO's own CQZ/ITUZ always wins: that is what the station
// sent or what LoTW/QRZ recorded. Derived values ride as `_cqz`/`_ituz`
// (display only, never written back to the ADIF).
//
// Pure: main passes `resolve(call) -> {cqZone, ituZone} | null`.

const CACHE_MAX = 5000;

/** A memoized zone lookup (calls repeat across every spot refresh). */
function zoneResolver(resolve) {
  const cache = new Map();
  return function zonesOf(call) {
    const key = String(call || '').toUpperCase().trim();
    if (!key) return null;
    if (cache.has(key)) return cache.get(key);
    let z = null;
    try { z = resolve(key); } catch { z = null; }
    if (z === undefined) return null; // lookup not ready yet (cty.dat loading): don't cache
    z = z || null;
    if (cache.size >= CACHE_MAX) cache.clear();
    cache.set(key, z);
    return z;
  };
}

/** Stamp `cqZone`/`ituZone` on each spot from its callsign. Returns spots. */
function stampSpotZones(spots, zonesOf) {
  for (const s of spots || []) {
    if (!s || !s.callsign) continue;
    const z = zonesOf(s.callsign);
    s.cqZone = z ? z.cqZone : null;
    s.ituZone = z ? z.ituZone : null;
  }
  return spots;
}

/**
 * Logbook rows: a record's own CQZ/ITUZ is left alone; a missing one gets a
 * derived `_cqz`/`_ituz`. Returns new row objects (the parsed log is not
 * mutated, so nothing derived can reach a rewrite of the file).
 */
function withQsoZones(qsos, zonesOf) {
  return (qsos || []).map((q) => {
    if (!q || (q.CQZ && q.ITUZ)) return q;
    const z = zonesOf(q.CALL);
    if (!z) return q;
    const out = { ...q };
    if (!q.CQZ && z.cqZone != null) out._cqz = String(z.cqZone);
    if (!q.ITUZ && z.ituZone != null) out._ituz = String(z.ituZone);
    return out;
  });
}

/** What a zone cell shows: the record's own value, else the derived one. */
function qsoZone(q, which) {
  if (!q) return '';
  return which === 'itu' ? (q.ITUZ || q._ituz || '') : (q.CQZ || q._cqz || '');
}

module.exports = { zoneResolver, stampSpotZones, withQsoZones, qsoZone };
