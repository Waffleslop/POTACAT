'use strict';
/**
 * Amplifier drive limit, per rig (B10 row 10).
 *
 * Some amplifiers need very little drive (a Mercury LUX behind a Flex 8600 is
 * the report that asked for this): one power slider moved to 100 W, a WSPR or
 * tune restore, or a phone's power slider can overdrive them. The rig editor
 * holds one number per rig, `ampDriveLimitW`; absent or 0 means no limit.
 *
 * The limit is enforced where the power command leaves POTACAT, in the radio
 * clients themselves (RigController, the legacy CatClient and SmartSdrClient),
 * so every caller is covered, the ones written later included. They ask this
 * module for the current limit through one source main sets at start-up.
 */

const MAX_FIELD_W = 2000;

/** The rig's limit in watts, or 0 for none. */
function limitW(rig) {
  const n = Number(rig && rig.ampDriveLimitW);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(MAX_FIELD_W, Math.round(n * 10) / 10);
}

/** Watts after the limit. A non-number passes through untouched. */
function clampW(watts, lim) {
  const n = Number(watts);
  if (!Number.isFinite(n)) return watts;
  return lim > 0 && n > lim ? lim : n;
}

/**
 * A Flex takes rfpower and tunepower as a percent of the radio's full power.
 * The limit as a percent, rounded DOWN so it never lands above the watts asked
 * for. 0 = no limit. A limit under 1 % still allows 1 % (the lowest setting).
 */
function flexPctLimit(lim, fullW) {
  if (!(lim > 0)) return 0;
  const full = Number(fullW) > 0 ? Number(fullW) : 100;
  return Math.max(1, Math.min(100, Math.floor((lim / full) * 100)));
}

/** A reported level above the limit (half a watt of slack for rounding). */
function overLimit(reportedW, lim) {
  const n = Number(reportedW);
  return lim > 0 && Number.isFinite(n) && n > lim + 0.5;
}

/** The rig editor's field: the box ticked and a positive number, else 0. */
function parseField(checked, value) {
  if (!checked) return 0;
  return limitW({ ampDriveLimitW: parseFloat(value) });
}

// ── The current limit, for the radio clients ─────────────────────────────
// main.js sets the source once; it reads the active rig every call, so a rig
// switch or an edit in the rig editor takes effect on the next command.
let _source = null;
function setLimitSource(fn) { _source = typeof fn === 'function' ? fn : null; }
/** { watts, fullW } for the active rig; watts 0 = no limit. */
function current() {
  if (!_source) return { watts: 0, fullW: 0 };
  try {
    const r = _source() || {};
    return { watts: Number(r.watts) > 0 ? Number(r.watts) : 0, fullW: Number(r.fullW) > 0 ? Number(r.fullW) : 0 };
  } catch {
    return { watts: 0, fullW: 0 };
  }
}
function currentLimitW() { return current().watts; }
function currentFlexPctLimit() { const c = current(); return flexPctLimit(c.watts, c.fullW); }

module.exports = {
  MAX_FIELD_W, limitW, clampW, flexPctLimit, overLimit, parseField,
  setLimitSource, current, currentLimitW, currentFlexPctLimit,
};
