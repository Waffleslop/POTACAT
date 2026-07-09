'use strict';
/**
 * Hunted-park resolver — match a worked callsign against the live program
 * spot list (POTA/SOTA/WWFF/LLOTA/WWBOTA) so digital-mode QSOs carry the
 * activator's park the same way SSB spot-click logging does.
 *
 * Why this exists (KB2UXB 2026-07-09): hunting a POTA activator over JTCAT
 * (desktop or ECHOCAT) logged plain FT8 QSOs — no SIG/SIG_INFO — because
 * jtcatAutoLog built its record from the QSO state machine alone. The SSB
 * flow gets the park from the clicked spot; JTCAT taps a decode, not a spot,
 * so the park has to be resolved by callsign here.
 *
 * Pure module (no Electron), table-tested in test/hunted-park-test.js.
 */

const { freqToBand } = require('./bands');
const JtcatParser = require('../renderer/jtcat-parser'); // dual-mode, pure

// Spot source → ADIF SIG value + per-program ref field on the QSO record.
// Order = program priority when one activator is spotted in several programs
// (mirrors the spot table's n-fer dedupe priority).
const PROGRAMS = [
  { source: 'pota', sig: 'POTA', refField: 'potaRef' },
  { source: 'sota', sig: 'SOTA', refField: 'sotaRef' },
  { source: 'wwff', sig: 'WWFF', refField: 'wwffRef' },
  { source: 'llota', sig: 'LLOTA', refField: 'llotaRef' },
  { source: 'wwbota', sig: 'WWBOTA', refField: 'wwbotaRef' },
];
const PROGRAM_RANK = new Map(PROGRAMS.map((p, i) => [p.source, i]));
const SIG_FOR_SOURCE = new Map(PROGRAMS.map((p) => [p.source, p.sig]));
const REF_FIELD_FOR_SIG = new Map(PROGRAMS.map((p) => [p.sig, p.refField]));

// Activators re-spot every 10–30 min; the POTA API also expires stale spots
// server-side. 90 min is generous enough to survive a slow band without
// matching yesterday's activation.
const MAX_SPOT_AGE_MS = 90 * 60 * 1000;

function spotAgeMs(spot, now) {
  if (!spot || !spot.spotTime) return null;
  const t = String(spot.spotTime);
  const ms = new Date(t.endsWith('Z') ? t : t + 'Z').getTime();
  return Number.isFinite(ms) ? now - ms : null;
}

/**
 * Find the program refs a worked callsign is currently spotted at.
 *
 * @param {Array}  spots      merged spot list (main.js lastMergedSpots shape:
 *                            {source, callsign, reference, frequency(kHz), spotTime})
 * @param {string} workedCall the call we just worked (may be portable/hashed)
 * @param {object} [opts]
 * @param {number} [opts.freqKhz]  QSO frequency — same-band spots rank first
 * @param {string} [opts.myCall]   our own call — never match ourselves
 * @param {number} [opts.now]      clock override for tests
 * @returns {null | {sig, primaryRef, refField, refs: Array<{sig, ref, refField}>}}
 */
function findHuntedRefs(spots, workedCall, opts = {}) {
  if (!Array.isArray(spots) || !spots.length || !workedCall) return null;
  const now = opts.now != null ? opts.now : Date.now();
  const base = JtcatParser.normalizeCall(workedCall);
  if (!base) return null;
  if (opts.myCall && JtcatParser.normalizeCall(opts.myCall) === base) return null;
  const qsoBand = opts.freqKhz ? (freqToBand(opts.freqKhz / 1000) || '') : '';

  const matches = [];
  for (const s of spots) {
    if (!s || !SIG_FOR_SOURCE.has(s.source)) continue; // program spots only
    const ref = (s.reference || '').toUpperCase().trim();
    if (!ref) continue;
    if (JtcatParser.normalizeCall(s.callsign) !== base) continue;
    const age = spotAgeMs(s, now);
    if (age != null && age > MAX_SPOT_AGE_MS) continue;
    const spotKhz = parseFloat(s.frequency);
    const sameBand = !!(qsoBand && Number.isFinite(spotKhz)
      && (freqToBand(spotKhz / 1000) || '') === qsoBand);
    matches.push({
      sig: SIG_FOR_SOURCE.get(s.source),
      ref,
      refField: REF_FIELD_FOR_SIG.get(SIG_FOR_SOURCE.get(s.source)),
      rank: PROGRAM_RANK.get(s.source),
      sameBand,
      age: age != null ? age : Infinity,
    });
  }
  if (!matches.length) return null;

  // Same band first (the activator we actually heard), then program
  // priority, then freshest spot.
  matches.sort((a, b) => (b.sameBand - a.sameBand) || (a.rank - b.rank) || (a.age - b.age));

  // Distinct program+ref pairs — an n-fer activator is spotted at several
  // parks (and possibly cross-program for the same site).
  const seen = new Set();
  const refs = [];
  for (const m of matches) {
    const key = m.sig + ' ' + m.ref;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({ sig: m.sig, ref: m.ref, refField: m.refField });
  }
  return { sig: refs[0].sig, primaryRef: refs[0].ref, refField: refs[0].refField, refs };
}

module.exports = { findHuntedRefs, MAX_SPOT_AGE_MS };
