'use strict';
// WSPR pre-beacon power memory — the pure decisions behind main.js's
// wsprRememberPreCapPower / wsprRestorePreCapPower / wsprReconcilePreCapPower.
//
// The WSPR beacon caps the radio at 1 W (wsprForcePowerCap) and, until
// 2026-09-10, the disarm path deliberately left it there as a QRPp fail-safe.
// On a Flex that setting persists IN THE RADIO across POTACAT restarts, Flex
// Direct shows no SmartSDR slider, and the wattmeter of the day read the
// 30 dBm meter as "30 W" — so an 8600M sat at rfpower=1% for weeks of
// unanswered FT8 CQs with nothing on screen saying so (K3SBP). The level the
// beacon found is now remembered as a settings marker {watts, rigId, at} and
// put back when the beacon stands down; the marker is cleared only by the
// radio's own readback confirming a level above the cap, never by a command
// having been *sent*, so a crash, a kill, or a quit that closed the socket
// before the write flushed is repaired by the next session's first readback.

/** A marker is usable when it names a level above the cap for THIS rig
 *  (a marker with no rigId, or on a station with no active rig id, is
 *  trusted — single-rig installs never had ids to compare). */
function markerUsable(marker, rigId, cap) {
  if (!marker || !(marker.watts > cap)) return false;
  if (marker.rigId && rigId && marker.rigId !== rigId) return false;
  return true;
}

/**
 * At arm, before the cap is forced. `current` is the radio's current RF power
 * setting as POTACAT knows it (0 = unknown). Returns the marker to persist
 * (or the prior one to keep) and the watts the operator will be told about.
 */
function rememberPreCapPower({ current, prior, rigId, cap, now }) {
  if (current > cap) {
    return { marker: { watts: current, rigId: rigId || null, at: now || Date.now() }, restoreWatts: current, changed: true };
  }
  // Already at/below the cap (re-armed without a disarm in between, or the
  // restored level not yet echoed back): keep what we remembered rather than
  // overwrite it with the cap itself.
  if (markerUsable(prior, rigId, cap)) return { marker: prior, restoreWatts: prior.watts, changed: false };
  return { marker: prior || null, restoreWatts: 0, changed: false };
}

/**
 * Whether/how to put the remembered level back.
 *   none                — nothing usable to restore
 *   forget-rig-mismatch — marker belongs to another rig; drop it, tell the operator
 *   defer               — a WSPR frame is still going out; retry when it ends
 *   give-up             — the radio never confirmed after maxAttempts commands
 *   command             — send it
 */
function decideRestore({ marker, rigId, cap, txActiveWspr, immediate, attempts, maxAttempts }) {
  if (!marker || !(marker.watts > cap)) return { action: 'none' };
  if (marker.rigId && rigId && marker.rigId !== rigId) return { action: 'forget-rig-mismatch' };
  if (!immediate && txActiveWspr) return { action: 'defer' };
  if ((attempts || 0) >= (maxAttempts || 3)) return { action: 'give-up' };
  return { action: 'command', watts: marker.watts };
}

/**
 * On every power readback from the radio. With a marker outstanding and no
 * beacon running: a readback above the cap is the confirmation that clears
 * the marker; one still at/below the cap is a restore that never landed.
 *   skip | forget | restore
 */
function decideReconcile({ marker, armed, retryPending, watts, cap }) {
  if (!marker) return 'skip';
  if (armed || retryPending) return 'skip';
  if (!(watts >= 0)) return 'skip';
  if (watts > cap) return 'forget';
  return 'restore';
}

module.exports = { markerUsable, rememberPreCapPower, decideRestore, decideReconcile };
