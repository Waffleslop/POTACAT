'use strict';

// JTCAT re-log guard (K9CYT 2026-10-04).
//
// A QSO that ends in RR73 is logged once per QSO object (q._logged). But when
// the other station did not copy the RR73 and sends its R-report again a few
// cycles later, answering it starts a NEW QSO object, and that one logged a
// second contact — pushed on to QRZ, the cloud and the operator's logger — for
// what is the same QSO. This guard remembers each auto-logged call per band and
// mode and refuses a second auto-log inside the cool-down window. The RR73
// still goes out; only the duplicate log entry is skipped.
//
// Pure: main owns the map and the clock.

const DEFAULT_COOLDOWN_MIN = 15;
const MAX_COOLDOWN_MIN = 120;

/** settings.jtcatRelogCooldownMin, clamped. 0 = guard off. */
function cooldownMinutes(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_COOLDOWN_MIN;
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_COOLDOWN_MIN;
  return Math.min(n, MAX_COOLDOWN_MIN);
}

/** Normalised key: a call is the same station with or without brackets. */
function relogKey(call, band, mode) {
  const c = String(call || '').toUpperCase().replace(/[<>]/g, '').trim();
  return `${c}|${String(band || '').toLowerCase()}|${String(mode || '').toUpperCase()}`;
}

/**
 * Decide whether an auto-log is a re-log of a contact logged moments ago.
 * @returns {{ skip: boolean, agoMin?: number }}
 */
function checkRelog(recent, key, nowMs, cooldownMin) {
  if (!cooldownMin || !recent) return { skip: false };
  const at = recent.get(key);
  if (!at) return { skip: false };
  const ageMs = nowMs - at;
  if (ageMs < 0 || ageMs >= cooldownMin * 60000) return { skip: false };
  return { skip: true, agoMin: Math.floor(ageMs / 60000) };
}

/** Record a logged contact and drop entries older than the longest window. */
function noteLogged(recent, key, nowMs) {
  recent.set(key, nowMs);
  const horizon = nowMs - MAX_COOLDOWN_MIN * 60000;
  for (const [k, t] of recent) if (t < horizon) recent.delete(k);
}

module.exports = {
  DEFAULT_COOLDOWN_MIN, MAX_COOLDOWN_MIN,
  cooldownMinutes, relogKey, checkRelog, noteLogged,
};
