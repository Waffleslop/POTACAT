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

// ---- the beacon's own RF power level (GitHub #268) --------------------------
// The beacon used to force exactly 1 W before every frame. 1 W is 1 % of the
// radio's full-power scale, and on some radios and bands that is below the
// lowest power the radio really makes: NA4DQ's IC-7100 on 2 m keyed three
// frames with ALC moving and its wattmeter at 0 W the whole time, then made
// 2-3 W once he raised the slider to 5 W. The cap also undid him: his 5 W was
// put back to 1 W at the next frame and re-arm, which read as "my power
// settings changed by themselves". The default stays 1 W; a level the
// operator sets while the beacon is armed becomes the beacon's level, kept
// for every later frame and re-arm on this rig, until they set another.

const BEACON_DEFAULT_WATTS = 1;

/** Sources whose power sets are not the operator choosing a beacon level:
 *  Station Setup's own test/restore, and a logger pushing its power field. */
const NOT_OPERATOR_SOURCES = new Set(['setup', 'logger-cat']);

/** The RF power the beacon commands before each frame, from the saved
 *  {watts, rigId}. A level saved for another rig does not apply. */
function beaconWatts(saved, rigId) {
  if (!saved || typeof saved !== 'object') return BEACON_DEFAULT_WATTS;
  const w = Number(saved.watts);
  if (!(Number.isFinite(w) && w > 0)) return BEACON_DEFAULT_WATTS;
  if (saved.rigId && rigId && saved.rigId !== rigId) return BEACON_DEFAULT_WATTS;
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
  markerUsable, rememberPreCapPower, decideRestore, decideReconcile,
  BEACON_DEFAULT_WATTS, beaconWatts, operatorBeaconLevel, frameRfVerdict,
};
