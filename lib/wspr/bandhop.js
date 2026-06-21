// SPDX-License-Identifier: Apache-2.0
// Copyright 2024-2026 Casey Stanton
//
// WSPR band hopping — the "leave it running and let it sweep every band" mode.
// Pure schedule: deterministic by slot number so a restart resumes in phase and
// (with the standard 2-min cadence) hoppers stay loosely time-aligned. The host
// QSYs the radio to bandForSlot() at each cycle boundary.

const SLOT_MS = 120000; // WSPR 2-minute T/R window (matches lib/wspr/scheduler)

/**
 * Which band a given 2-minute slot beacons on. Round-robin through the enabled
 * bands, `dwell` cycles per band (default 1 = hop every cycle). Deterministic
 * by absolute slot index since the epoch, so it's stable across restarts.
 * @param {number} slotNumber  Math.floor(epochMs / 120000)
 * @param {string[]} bands     enabled band names in hop order, e.g. ['40m','20m']
 * @param {number} [dwell=1]   cycles to dwell on each band before moving on
 * @returns {string|null}
 */
function bandForSlot(slotNumber, bands, dwell) {
  if (!Array.isArray(bands) || bands.length === 0) return null;
  dwell = Math.max(1, Math.floor(dwell || 1));
  const step = Math.floor(slotNumber / dwell);
  const idx = ((step % bands.length) + bands.length) % bands.length; // safe for negatives
  return bands[idx];
}

/** The band to QSY to for the NEXT slot (what the host tunes at cycle end). */
function nextBand(slotNumber, bands, dwell) {
  return bandForSlot(slotNumber + 1, bands, dwell);
}

/** Slot index for a wall-clock time (ms). */
function slotNumber(nowMs) {
  return Math.floor(nowMs / SLOT_MS);
}

/**
 * Would the next slot land on a DIFFERENT band than the current one? Lets the
 * host skip a redundant QSY when dwell>1 keeps us on the same band.
 */
function bandChangesNext(slotNumber, bands, dwell) {
  return bandForSlot(slotNumber, bands, dwell) !== nextBand(slotNumber, bands, dwell);
}

module.exports = { bandForSlot, nextBand, slotNumber, bandChangesNext, SLOT_MS };
