'use strict';
/**
 * Putting the TX power back after a low-power carrier (the Station Setup
 * test transmit, an external RF-sense tune) — and knowing when NOT to.
 *
 * 1.13.10 regression (nocodegeneralwitha7300 IC-7300, df1vb IC-7100, GitHub
 * #111): a radio whose power had never been read was "restored" to the
 * Default power (100 W); the restore marker outlived the tune; and every
 * later power report at or below the tune power (the operator turning the
 * knob down for FT8) was "repaired" back to 100 W, up to three times.
 *
 * Rules now:
 *   - power unknown before the carrier: no restore at all (never a guess);
 *   - the radio still at the tune power: put it back (a lost restore);
 *   - the radio above the tune power: restored, forget it;
 *   - the radio at some OTHER low power: the operator set it, forget it;
 *   - an external-tuner marker older than its window: forget it;
 *   - an operator power change anywhere forgets it (main's set-tx-power).
 */

const TOLERANCE_W = 0.5;
const EXT_ATU_WINDOW_MS = 120000;   // the tune plus its restore, with room
const RETRY_GAP_MS = 10000;
const MAX_ATTEMPTS = 3;

/** The power to restore after the carrier, or null when it was never read. */
function restoreTarget(currentWatts) {
  const w = Number(currentWatts);
  return Number.isFinite(w) && w > 0 ? w : null;
}

/**
 * What to do with a power report while a restore marker exists.
 * @param {object|null} m   settings.setupTxPowerRestore { watts, testWatts, rigId, at, reason, lastAttemptAt }
 * @param {number} watts    the radio's reported power
 * @param {object} s        { now, activeRigId, carrierRunning, attempts }
 * @returns {{ action: 'none'|'clear'|'restore', why: string }}
 */
function decideReconcile(m, watts, s = {}) {
  if (!m) return { action: 'none', why: 'no-marker' };
  if (s.carrierRunning) return { action: 'none', why: 'carrier-running' };
  if (m.rigId && s.activeRigId && m.rigId !== s.activeRigId) return { action: 'none', why: 'other-rig' };
  const now = s.now || Date.now();
  if (m.reason === 'external-atu' && now - (Number(m.at) || 0) > EXT_ATU_WINDOW_MS) return { action: 'clear', why: 'expired' };
  const w = Number(watts);
  if (!Number.isFinite(w)) return { action: 'none', why: 'no-reading' };
  if (w > m.testWatts + TOLERANCE_W) return { action: 'clear', why: 'restored' };
  if (Math.abs(w - m.testWatts) > TOLERANCE_W) return { action: 'clear', why: 'operator' };
  if ((s.attempts || 0) >= MAX_ATTEMPTS || now - (m.lastAttemptAt || 0) < RETRY_GAP_MS) return { action: 'none', why: 'waiting' };
  return { action: 'restore', why: 'still-at-test-power' };
}

module.exports = { restoreTarget, decideReconcile, EXT_ATU_WINDOW_MS, TOLERANCE_W };
