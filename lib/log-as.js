'use strict';
// Log as another operator (KD9WI 2026-10-16: "I share a shack with another
// ham, and we often hunt stations together ... log my own contacts to my QRZ
// while also being able to log the other op's contacts").
//
// Operator profiles already give every operator on this machine their own
// callsign, grid, logbook, QRZ Logbook key and Cloud account
// (profiles/<CALL>/settings.json), but switching operators restarts POTACAT.
// "Log as" lets one QSO be written for ANOTHER operator on this machine
// without switching: their logbook file, their callsign in OPERATOR and
// STATION_CALLSIGN, their QRZ key, their Cloud account (journaled under their
// owner id, pushed when they next sign in). The active operator's own caches
// (worked-before, worked parks, events, contest history) are not touched —
// that QSO is not theirs.
//
// Pure: main.js resolves a request with resolveLogAs(), builds the other
// operator's settings view with operatorSettings(), and does the writing.

function normCall(c) {
  return String(c || '').toUpperCase().trim();
}

/**
 * Which operator a QSO is for.
 *   null             — the active operator (no request, or the request names them)
 *   { call }         — another operator profile on this machine
 *   { error }        — a request for an operator that does not exist here
 */
function resolveLogAs(requested, { activeCall, profiles } = {}) {
  const call = normCall(requested);
  if (!call) return null;
  if (call === normCall(activeCall)) return null;
  const known = (profiles || []).map(normCall);
  if (!known.includes(call)) return { error: `Operator ${call} is not set up on this computer (Settings > Summary > Add operator)` };
  return { call };
}

/**
 * Another operator's settings as loadSettings() would see them if they were
 * active: their profile file under this machine's global keys (global wins on
 * a collision, exactly as for the active operator). A profile seeded by Add
 * operator has myCallsign and adifLogPath; both are defaulted here anyway so
 * a hand-edited profile can never log under a blank call or into the active
 * operator's file.
 */
function operatorSettings(profileFile, globalPart, { call, profileLogPath } = {}) {
  const s = Object.assign({}, profileFile || {}, globalPart || {});
  if (!normCall(s.myCallsign)) s.myCallsign = normCall(call);
  if (!s.adifLogPath && profileLogPath) s.adifLogPath = profileLogPath;
  return s;
}

/** The log line / toast tail: '' for the active operator, ' for W9XYZ' otherwise. */
function logAsSuffix(call) {
  const c = normCall(call);
  return c ? ` for ${c}` : '';
}

module.exports = { resolveLogAs, operatorSettings, logAsSuffix, normCall };
