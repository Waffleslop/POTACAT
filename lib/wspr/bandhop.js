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

/**
 * Is the WSPR beacon set to transmit? Armed (Beacon TX on) with a TX % above
 * 0. TX 0 % is listen only, and a disarmed beacon never keys.
 * @param {{armed:boolean, txPct:number}} o
 */
function beaconWillTransmit({ armed, txPct } = {}) {
  return !!armed && Number(txPct) > 0;
}

/**
 * "Auto-tune ATU on band change" (settings.enableAtu) for one tune (#747).
 * A WSPR band hop while the beacon is not set to transmit is receive only:
 * the tune would key a carrier and cycle the tuner for a transmission that
 * never comes, so it is skipped. Every other band change (the operator's,
 * or a hop with the beacon set to transmit) tunes exactly as before.
 * A skipped band still becomes the last band, so the next band change is
 * judged from where the radio is; the skipped tune is owed to that band.
 * @param {object} o
 * @param {boolean} o.enableAtu   the operator's setting
 * @param {string|null} o.band    band of the new frequency
 * @param {string|null} o.lastBand band of the last tune
 * @param {boolean} [o.wsprHop]   this tune is a WSPR band hop
 * @param {boolean} [o.beaconTx]  beaconWillTransmit() at the hop
 * @returns {{action:'tune'|'skip'|'none', lastBand:string|null, owedBand:string|null}}
 *   owedBand: the band left untuned by a skip (null otherwise).
 */
function bandChangeAtu({ enableAtu, band, lastBand, wsprHop, beaconTx } = {}) {
  if (!enableAtu || !band || band === lastBand) return { action: 'none', lastBand: lastBand || null, owedBand: null };
  if (wsprHop && !beaconTx) return { action: 'skip', lastBand: band, owedBand: band };
  return { action: 'tune', lastBand: band, owedBand: null };
}

/**
 * The beacon turned on to transmit (armed, or TX % raised from 0) while the
 * radio sits on a band whose hop tune was skipped: run that tune now, before
 * the first transmission. Stale when the radio has since left that band.
 * @param {{owedBand:string|null, currentBand:string|null, beaconTx:boolean, enableAtu:boolean}} o
 */
function owedTuneDue({ owedBand, currentBand, beaconTx, enableAtu } = {}) {
  return !!(enableAtu && beaconTx && owedBand && owedBand === currentBand);
}

// How long the beacon holds its next transmission after an owed tune starts:
// the tune runs 1.5 s after the call (as on a band change) and an ATU cycle is
// a few seconds; a held slot is simply not keyed.
const OWED_TUNE_TX_HOLD_MS = 15000;

module.exports = { bandForSlot, nextBand, slotNumber, bandChangesNext, decideHop, beaconWillTransmit, bandChangeAtu, owedTuneDue, OWED_TUNE_TX_HOLD_MS, SLOT_MS };
