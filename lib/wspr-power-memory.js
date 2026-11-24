'use strict';
// WSPR pre-beacon power memory — the pure decisions behind main.js's
// wsprRememberPreCapPower / wsprRestorePreCapPower / wsprReconcilePreCapPower.
//
// The WSPR beacon used to cap the radio at 1 W (wsprForcePowerCap) and, until
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

// Since #521 the beacon changes the radio's power only for a frame whose
// level differs from the radio's, and puts it back when that frame ends; the
// marker carries the level it set (beaconW) so a readback can tell "still at
// the beacon's level" (restore) from "the operator set something else"
// (forget). A marker from a build before #521 has no beaconW: its beacon
// level was the 1 W cap (or less), and the old rule applies to it.
const LEGACY_BEACON_W = 1;

function markerBeaconW(marker, legacyBeaconW) {
  if (marker && Number(marker.beaconW) > 0) return Number(marker.beaconW);
  return Number(legacyBeaconW) > 0 ? Number(legacyBeaconW) : LEGACY_BEACON_W;
}

/** Two readings the radio would call the same setting (readbacks are rounded
 *  to whole watts on several links). */
function nearW(a, b, tolW) {
  const tol = Math.max(Number(tolW) > 0 ? Number(tolW) : 0, 0.5);
  return Math.abs(Number(a) - Number(b)) <= tol;
}

/** A marker is usable when it names a level for THIS rig (a marker with no
 *  rigId, or on a station with no active rig id, is trusted: single-rig
 *  installs never had ids to compare). */
function markerUsable(marker, rigId) {
  if (!marker || !(Number(marker.watts) > 0)) return false;
  if (marker.rigId && rigId && marker.rigId !== rigId) return false;
  return true;
}

/**
 * Before a frame that sets the radio to `beaconW`. `current` is the radio's
 * power setting as POTACAT knows it (0 = unknown). Returns the marker to
 * persist and the watts that will come back after the frame (0 = unknown).
 * A usable prior marker whose restore has not been confirmed (the radio still
 * reads the beacon level, or nothing has been read) is kept, so a lost
 * restore never turns the beacon level into "the operator's level".
 */
function rememberPreBeaconPower({ current, prior, rigId, beaconW, now, legacyBeaconW }) {
  const cur = Number(current) > 0 ? Number(current) : 0;
  if (markerUsable(prior, rigId) && (!cur || nearW(cur, markerBeaconW(prior, legacyBeaconW)))) {
    const marker = Number(prior.beaconW) === Number(beaconW) ? prior : { ...prior, beaconW: Number(beaconW) };
    return { marker, restoreWatts: Number(prior.watts), changed: marker !== prior };
  }
  if (cur > 0) {
    return { marker: { watts: cur, beaconW: Number(beaconW), rigId: rigId || null, at: now || Date.now() }, restoreWatts: cur, changed: true };
  }
  return { marker: null, restoreWatts: 0, changed: !!prior };
}

/**
 * Whether/how to put the remembered level back.
 *   none                - nothing usable to restore
 *   forget-rig-mismatch - marker belongs to another rig; drop it, tell the operator
 *   defer               - a WSPR frame is still going out; retry when it ends
 *   give-up             - the radio never confirmed after maxAttempts commands
 *   command             - send it
 */
function decideRestore({ marker, rigId, txActiveWspr, immediate, attempts, maxAttempts }) {
  if (!marker || !(Number(marker.watts) > 0)) return { action: 'none' };
  if (marker.rigId && rigId && marker.rigId !== rigId) return { action: 'forget-rig-mismatch' };
  if (!immediate && txActiveWspr) return { action: 'defer' };
  if ((attempts || 0) >= (maxAttempts || 3)) return { action: 'give-up' };
  return { action: 'command', watts: Number(marker.watts) };
}

/**
 * On every power readback from the radio, with a marker outstanding:
 *   skip    - a beacon frame is on the air, a deferred restore is pending, a
 *             power command went out moments ago (this reading may predate
 *             it), or the reading is garbage
 *   forget  - the radio is at the remembered level (the restore landed), or
 *             at a level neither ours nor the remembered one (the operator
 *             set it: never fight that)
 *   restore - the radio is still at the beacon's level: a restore that never
 *             landed (crash, kill, a quit before the socket flushed)
 */
function decideReconcile({ marker, frameActive, retryPending, recentCommand, watts, legacyBeaconW, tolW }) {
  if (!marker) return 'skip';
  if (frameActive || retryPending || recentCommand) return 'skip';
  const w = Number(watts);
  if (!(w >= 0) || !Number.isFinite(w)) return 'skip';
  if (!(Number(marker.beaconW) > 0)) {
    // A marker written before #521: the beacon level was the cap.
    return w > markerBeaconW(marker, legacyBeaconW) ? 'forget' : 'restore';
  }
  if (nearW(w, marker.watts, tolW)) return 'forget';
  if (nearW(w, marker.beaconW, tolW)) return 'restore';
  return 'forget';
}

// ---- the beacon's own RF power level (GitHub #268) --------------------------
// The beacon used to force exactly 1 W before every frame. 1 W is 1 % of the
// radio's full-power scale, and on some radios and bands that is below the
// lowest power the radio really makes: NA4DQ's IC-7100 on 2 m keyed three
// frames with ALC moving and its wattmeter at 0 W the whole time, then made
// 2-3 W once he raised the slider to 5 W. The cap also undid him: his 5 W was
// put back to 1 W at the next frame and re-arm, which read as "my power
// settings changed by themselves". A level the operator sets while the beacon
// is armed becomes the beacon's level, kept for every later frame and re-arm
// on this rig, until they set another. Since #521 there is no 1 W default:
// with no level entered the beacon leaves the radio's power alone.

/** Sources whose power sets are not the operator choosing a beacon level:
 *  Station Setup's own test/restore, and a logger pushing its power field. */
const NOT_OPERATOR_SOURCES = new Set(['setup', 'logger-cat']);

/** The beacon level the operator entered, from the saved {watts, rigId}; 0
 *  when none is entered (the beacon then leaves the radio's power alone,
 *  lib/wspr-beacon-power.js, #521). A level saved for another rig does not
 *  apply. */
function beaconWatts(saved, rigId) {
  if (!saved || typeof saved !== 'object') return 0;
  const w = Number(saved.watts);
  if (!(Number.isFinite(w) && w > 0)) return 0;
  if (saved.rigId && rigId && saved.rigId !== rigId) return 0;
  return w;
}

/** A power set while the beacon is armed: the {watts, rigId} to save as the
 *  beacon's level, or null when it is not the operator choosing one. */
function operatorBeaconLevel({ armed, source, watts, rigId }) {
  if (!armed) return null;
  if (NOT_OPERATOR_SOURCES.has(source)) return null;
  const w = Number(watts);
  if (!(Number.isFinite(w) && w > 0)) return null;
  return { watts: w, rigId: rigId || null };
}

/** One line for the log after a beacon frame, from the radio's own forward
 *  power readings during it. null when the radio sent none (it has no meter
 *  over this link; saying "0 W" would be a guess). */
function frameRfVerdict({ meterFrames, peakW, setW }) {
  if (!(meterFrames > 0)) return null;
  const set = Number(setW) > 0 ? `RF power set to ${setW} W` : 'RF power setting unknown';
  if (!(peakW >= 0.5)) {
    return `[JTCAT] WSPR frame: the radio keyed, but its wattmeter read 0 W for the whole frame (${set}). ` +
      'Some radios make almost nothing at their lowest power settings, more so on VHF/UHF. ' +
      'Raise TX Pwr in the JTCAT window until the meter moves during a frame; the beacon keeps the level you set.';
  }
  const peak = peakW >= 10 ? String(Math.round(peakW)) : peakW.toFixed(1);
  return `[JTCAT] WSPR frame: peak ${peak} W measured (${set}).`;
}

module.exports = {
  LEGACY_BEACON_W, markerBeaconW, nearW, markerUsable, rememberPreBeaconPower, decideRestore, decideReconcile,
  beaconWatts, operatorBeaconLevel, frameRfVerdict,
};
