'use strict';
/**
 * The TX power a logged contact carries, and never a guess (#523).
 *
 * When the radio's power could not be read (TS-590SG, TS-2000), every QSO
 * was logged at 100 W: the log form fell back to a hard-coded 100, and the
 * Settings "Default TX Power" box saved 100 for everyone who pressed Save,
 * whether or not they had ever typed in it. A QRP operator's log said 100 W.
 *
 * The order, on every logging surface:
 *   1. knownW   - the radio's power as POTACAT knows it: read from the radio,
 *                 or the level POTACAT last set on it (main's _currentTxPower,
 *                 which is 0 until one of the two happens);
 *   2. enteredW - the power the operator typed in the log form this session
 *                 (the main window's sticky value; other surfaces pass none);
 *   3. defaultW - the Default TX Power the operator chose in Settings
 *                 (operatorDefaultPower below);
 *   4. null     - TX_PWR left empty.
 *
 * operatorDefaultPower: a saved defaultPower of exactly 100 without
 * defaultPowerSet is the box's old untouched default, not a choice, so it
 * counts as none. Settings now saves a blank box as null and marks a typed
 * value with defaultPowerSet: true, so a 100 W operator who types 100 keeps it.
 *
 * Dual-mode: Node `require()` gets `module.exports`; the main window loads it
 * with a <script> tag as `window.LogTxPower`.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LogTxPower = api;
})(typeof self !== 'undefined' ? self : this, function () {

  // The legacy value the Settings box held before anyone typed in it.
  const LEGACY_UNTOUCHED_DEFAULT_W = 100;

  function positiveWatts(v) {
    if (v == null || v === '') return 0;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  // The operator's own Default TX Power from a settings object, 0 = none.
  function operatorDefaultPower(settings) {
    if (!settings) return 0;
    const w = positiveWatts(settings.defaultPower);
    if (!w) return 0;
    if (w === LEGACY_UNTOUCHED_DEFAULT_W && settings.defaultPowerSet !== true) return 0;
    return w;
  }

  // The watts to log, or null to leave TX_PWR empty.
  function txPowerForLog(src) {
    const s = src || {};
    return positiveWatts(s.knownW) || positiveWatts(s.enteredW) || positiveWatts(s.defaultW) || null;
  }

  // The most a device may log: 10 kW. Anything above is a typing slip.
  const DEVICE_MAX_W = 10000;

  // A power a device sent with a contact (ECHOCAT log-qso `txPower`, #85):
  // a number of watts, positive, finite, at most DEVICE_MAX_W. Returned as the
  // String saveQsoRecord stores, or null for anything else (absent, 0, a
  // negative, NaN, a string, a boolean), so the contact is filled by the order
  // above exactly as it was before devices sent a power.
  function deviceTxPower(v) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > DEVICE_MAX_W) return null;
    return String(v);
  }

  return { txPowerForLog, operatorDefaultPower, positiveWatts, deviceTxPower, DEVICE_MAX_W, LEGACY_UNTOUCHED_DEFAULT_W };
});
