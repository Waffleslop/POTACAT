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

/**
 * Whether to QSY now, given our own beacon (#766). The hop runs from the WSPR
 * decode, which finishes about 15 s into the next slot; when that slot is ours
 * to transmit, a hop would retune the radio mid-frame. So: never while TX audio
 * plays (txActive) or in a slot the beacon has decided to transmit (txSlot).
 * A held hop stays pending and is made at the next eligible decode, to the band
 * the schedule wants then, even where dwell alone would stay put; it is dropped
 * if the radio is already on that band.
 * @param {object} o
 * @param {number} o.slot          current slot index
 * @param {string[]} o.bands       hop bands in order
 * @param {number} [o.dwell]
 * @param {boolean} o.txActive     the engine is sending TX audio
 * @param {boolean} o.txSlot       the current slot is our beacon's TX slot
 * @param {boolean} [o.pending]    a hop was held at an earlier decode
 * @param {string|null} [o.currentBand] the band the radio is on, if known
 * @returns {{action:'hop'|'hold'|'stay', band:string|null, pending:boolean, reason?:string}}
 */
function decideHop({ slot, bands, dwell, txActive, txSlot, pending, currentBand } = {}) {
  const band = nextBand(slot, bands, dwell);
  if (!band) return { action: 'stay', band: null, pending: false };
  const due = bandChangesNext(slot, bands, dwell);
  if (!due && !pending) return { action: 'stay', band, pending: false };
  if (!due && currentBand && currentBand === band) return { action: 'stay', band, pending: false };
  if (txActive || txSlot) return { action: 'hold', band, pending: true, reason: 'transmitting this slot' };
  return { action: 'hop', band, pending: false };
}

module.exports = { bandForSlot, nextBand, slotNumber, bandChangesNext, decideHop, SLOT_MS };
