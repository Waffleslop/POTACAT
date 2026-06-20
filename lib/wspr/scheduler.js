// SPDX-License-Identifier: Apache-2.0
// Copyright 2024-2026 Casey Stanton
//
// WSPR beacon TX scheduler — pure timing/decision logic for the beacon side.
// No I/O, no radio, no GPL: this is the unit-testable brain that main.js drives.
//
// WSPR rhythm (vs. FT8's 15 s): a 2-minute (120 s) T/R window aligned to even
// minutes. A beacon transmits only a FRACTION of slots (TX%, default 20 %),
// randomized per slot so multiple nearby stations don't always collide — the
// rest of the time it listens. TX begins ~1 s after the even minute and runs
// 162 * 8192 / 12000 = 110.592 s, finishing comfortably inside the 120 s slot.
//
// Everything here takes `nowMs` and an injectable `rng` so tests are
// deterministic; production passes Date.now() and Math.random().

const SLOT_MS = 120000;        // 2-minute WSPR T/R window
const PTT_LEAD_MS = 1000;      // TX starts +1 s into the even minute
const TX_DURATION_MS = 110592; // 162 symbols * 8192 samples / 12000 Hz * 1000
const TX_LATEST_START_MS = 2000; // if we're past slot+2 s, we've missed this slot

/** Slot index (monotonic since epoch; epoch sits on a 2-min boundary). */
function slotNumber(nowMs) {
  return Math.floor(nowMs / SLOT_MS);
}

/** Start-of-slot wall time (ms) for the slot containing nowMs. */
function slotStartMs(nowMs) {
  return Math.floor(nowMs / SLOT_MS) * SLOT_MS;
}

/** ms elapsed since the current slot's even-minute boundary. */
function msIntoSlot(nowMs) {
  return nowMs - slotStartMs(nowMs);
}

/**
 * The TX window for a given slot start: when PTT keys on, when the waveform
 * ends, and the matching slot index.
 */
function txWindowForSlotStart(startMs) {
  const pttOnMs = startMs + PTT_LEAD_MS;
  return {
    slotNumber: startMs / SLOT_MS,
    slotStartMs: startMs,
    pttOnMs,
    pttOffMs: pttOnMs + TX_DURATION_MS,
  };
}

/**
 * The next TX window at/after nowMs that we can still cleanly start (PTT-on in
 * the future, or only a hair late). If we're already past this slot's start
 * window, roll to the next slot.
 */
function nextTxWindow(nowMs) {
  const start = slotStartMs(nowMs);
  const into = nowMs - start;
  if (into <= PTT_LEAD_MS) return txWindowForSlotStart(start);
  return txWindowForSlotStart(start + SLOT_MS);
}

/**
 * Per-slot transmit decision. Pure: given TX% and a uniform rng() in [0,1),
 * returns whether to beacon this slot. 0 % never, 100 % always, otherwise a
 * randomized draw (collision avoidance).
 */
function shouldTransmitSlot(txPct, rng) {
  const p = Number(txPct);
  if (!(p > 0)) return false;
  if (p >= 100) return true;
  return rng() < p / 100;
}

/**
 * Stateful beacon scheduler. main.js ticks this on a timer; it makes ONE TX
 * decision per slot and emits a single TX plan when a transmitting slot opens.
 *
 * Usage:
 *   const sch = new WsprScheduler({ txPct: 20, dBm: 30 });
 *   // on each timer tick:
 *   const plan = sch.tick(Date.now());
 *   if (plan) startBeaconTx(plan);   // plan = { pttOnMs, pttOffMs, dBm, ... }
 */
class WsprScheduler {
  constructor({ txPct = 20, dBm = 30, rng = Math.random } = {}) {
    this._txPct = clampPct(txPct);
    this._dBm = dBm;
    this._rng = rng;
    this._enabled = false;
    this._decidedSlot = -1;   // slot we've already decided
    this._decision = false;   // the decision for _decidedSlot
    this._firedSlot = -1;     // slot we've already emitted a plan for
  }

  setTxPct(p) { this._txPct = clampPct(p); }
  setDbm(d) { this._dBm = d; }
  setEnabled(on) {
    this._enabled = !!on;
    if (!on) { this._decidedSlot = -1; this._firedSlot = -1; }
  }
  get txPct() { return this._txPct; }
  get enabled() { return this._enabled; }

  /**
   * Decide (once) whether the slot containing nowMs transmits. Idempotent
   * within a slot — the random draw happens exactly once per slot.
   */
  decideSlot(nowMs) {
    const s = slotNumber(nowMs);
    if (s !== this._decidedSlot) {
      this._decidedSlot = s;
      this._decision = this._enabled && shouldTransmitSlot(this._txPct, this._rng);
    }
    return this._decision;
  }

  /**
   * Tick: returns a TX plan exactly once, when a transmitting slot's PTT-on
   * moment is at hand (we're in the slot, within the start window, haven't
   * fired yet). Otherwise returns null.
   */
  tick(nowMs) {
    if (!this._enabled) return null;
    const s = slotNumber(nowMs);
    const into = msIntoSlot(nowMs);
    if (into > TX_LATEST_START_MS) return null; // missed this slot's start
    if (s === this._firedSlot) return null;      // already fired this slot
    if (!this.decideSlot(nowMs)) return null;    // this slot is a listen slot
    this._firedSlot = s;
    const win = txWindowForSlotStart(slotStartMs(nowMs));
    return {
      slotNumber: win.slotNumber,
      pttOnMs: win.pttOnMs,
      pttOffMs: win.pttOffMs,
      // How long until PTT should key (>=0 if early in the slot; small negative
      // means we're a touch late and should start ASAP). main.js uses this to
      // schedule the keyed transmission.
      leadMs: win.pttOnMs - nowMs,
      dBm: this._dBm,
      durationMs: TX_DURATION_MS,
    };
  }
}

function clampPct(p) {
  const n = Number(p);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

module.exports = {
  WsprScheduler,
  shouldTransmitSlot,
  nextTxWindow,
  txWindowForSlotStart,
  slotNumber,
  slotStartMs,
  msIntoSlot,
  SLOT_MS,
  PTT_LEAD_MS,
  TX_DURATION_MS,
  TX_LATEST_START_MS,
};
