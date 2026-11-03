'use strict';
/**
 * JTCAT TX slot lock: Auto / 1st (even) / 2nd (odd) for FT8, FT4 and FT2
 * (Casey 2026-10-24: "lock to Odd or Even … especially if they are activating").
 *
 * WSJT-X keeps ONE "Tx even/1st" box: a CQ goes out in whatever it says, and a
 * double-click on a decode re-sets it to the opposite of that station. So an
 * activator stays put until they click someone in their own slot. Here a LOCK
 * holds: a reply to a station in our locked slot is refused (the operator is
 * offered "Unlock and call"), Hunt never picks one, and Hound replies are the
 * one override (the Fox decides). In Auto a new CQ keeps the slot of our last
 * transmission (the WSJT-X box staying where it is), never the opposite of
 * whatever decode came in last — that is what made an activator's CQ wander.
 *
 * Pure; main.js applies it (jtcatCqSlot / jtcatReplySlot / applyJtcatTxSlotLock).
 * Parity = floor(t / period) % 2, the same arithmetic for every mode.
 */

/** How long our last transmission's slot carries a new Auto CQ. */
const LAST_TX_FRESH_MS = 30 * 60 * 1000;

function isSlot(s) { return s === 'even' || s === 'odd'; }

function normalizeLock(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (s === '1st' || s === 'first') return 'even';
  if (s === '2nd' || s === 'second') return 'odd';
  return isSlot(s) ? s : 'auto';
}

function opposite(slot) { return slot === 'even' ? 'odd' : slot === 'odd' ? 'even' : null; }

function slotAt(ms, periodMs) { return Math.floor(ms / periodMs) % 2 === 0 ? 'even' : 'odd'; }

function slotLabel(slot) {
  const s = normalizeLock(slot);
  return s === 'even' ? '1st (even)' : s === 'odd' ? '2nd (odd)' : 'Auto';
}

/**
 * The slot a new CQ goes out in.
 * @param {{lock, lastTx?: {slot, at}, nowMs, periodMs, lateCapMs}} o
 * @returns {{slot: 'even'|'odd', why: 'locked'|'last-tx'|'soonest'}}
 */
function decideCqSlot(o) {
  const lock = normalizeLock(o && o.lock);
  if (lock !== 'auto') return { slot: lock, why: 'locked' };
  const last = o && o.lastTx;
  if (last && isSlot(last.slot) && typeof last.at === 'number' && o.nowMs - last.at <= LAST_TX_FRESH_MS) {
    return { slot: last.slot, why: 'last-tx' };
  }
  const cur = slotAt(o.nowMs, o.periodMs);
  const into = o.nowMs % o.periodMs;
  return { slot: into <= (o.lateCapMs || 0) ? cur : opposite(cur), why: 'soonest' };
}

/**
 * The slot a reply to a station goes out in, or a refusal.
 * `theirSlot` is the slot the station was decoded in (the decode's own stamp);
 * `fallbackSlot` is the engine's last RX slot, used only in Auto, never to
 * refuse anything.
 * @returns {{ok: boolean, slot: 'even'|'odd'|'auto', why: string, override?: boolean}}
 */
function decideReplySlot(o) {
  const lock = normalizeLock(o && o.lock);
  const their = isSlot(o && o.theirSlot) ? o.theirSlot : null;
  const guess = their || (isSlot(o && o.fallbackSlot) ? o.fallbackSlot : null);
  if (o && o.hound) {
    const slot = guess ? opposite(guess) : (lock !== 'auto' ? lock : 'auto');
    return { ok: true, slot, why: 'hound', override: lock !== 'auto' && slot !== lock };
  }
  if (lock === 'auto') return { ok: true, slot: guess ? opposite(guess) : 'auto', why: 'opposite' };
  if (their === lock) return { ok: false, slot: lock, why: 'same-slot' };
  return { ok: true, slot: lock, why: 'locked' };
}

/** Can an automatic path (Hunt, auto-answer) work a station decoded in `theirSlot`? */
function workableUnderLock(lock, theirSlot) {
  const l = normalizeLock(lock);
  return l === 'auto' || !isSlot(theirSlot) || theirSlot !== l;
}

/** The one wording every surface shows for a refused reply. */
function refusalText(call, lock) {
  return `${call || 'That station'} transmits in ${slotLabel(lock)}, the slot you locked. Unlock to call them.`;
}

module.exports = {
  LAST_TX_FRESH_MS, isSlot, normalizeLock, opposite, slotAt, slotLabel,
  decideCqSlot, decideReplySlot, workableUnderLock, refusalText,
};
