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

/**
 * The parity the engine will transmit in, from its own fields (Ft8Engine:
 * _txSlot, _lockedTxSlot, _lastRxSlot), by the same rule as tryImmediateTx and
 * _onTxBoundary. null = any slot (nothing decided yet).
 */
function effectiveTxSlot(e) {
  if (!e) return null;
  if (isSlot(e.txSlot)) return e.txSlot;
  if (isSlot(e.lockedTxSlot)) return e.lockedTxSlot;
  return opposite(e.lastRxSlot);
}

/**
 * When a reply that reached the station at `nowMs` goes out (2026-11-05 FT4
 * report: the log could not tell a slow phone from a slow station). It goes
 * out in the slot it arrived in when that slot has the right parity and it is
 * no later than the late-start cap (500 ms without late start), else at the
 * next boundary of the right parity. `firedNow`, when given, is what the
 * engine actually did and wins over the arithmetic.
 * @param {{nowMs:number, periodMs:number, slot:'even'|'odd'|null, lateCapMs?:number, firedNow?:boolean}} o
 * @returns {{nowMs:number, arrivedSlotMs:number, msIntoSlot:number, slot:string|null, now:boolean, lateStart:boolean, startMs:number}}
 */
function replyTxPlan(o) {
  const P = o.periodMs;
  const msIntoSlot = ((o.nowMs % P) + P) % P;
  const arrivedSlotMs = o.nowMs - msIntoSlot;
  const slot = isSlot(o.slot) ? o.slot : null;
  const cap = Math.max(500, o.lateCapMs || 0);
  const fits = (!slot || slotAt(arrivedSlotMs, P) === slot) && msIntoSlot <= cap;
  const now = typeof o.firedNow === 'boolean' ? o.firedNow : fits;
  if (now) return { nowMs: o.nowMs, arrivedSlotMs, msIntoSlot, slot, now: true, lateStart: msIntoSlot > 500, startMs: arrivedSlotMs };
  let startMs = arrivedSlotMs + P;
  if (slot && slotAt(startMs, P) !== slot) startMs += P;
  return { nowMs: o.nowMs, arrivedSlotMs, msIntoSlot, slot, now: false, lateStart: false, startMs };
}

/** HH:MM:SS UTC, with tenths when the slot starts off the second (FT4 :07.5). */
function utcClock(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  const tenths = Math.floor((ms % 1000) / 100);
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}${tenths ? '.' + tenths : ''}`;
}

/**
 * The one CAT-log line for a reply request from a device, e.g.
 * "[JTCAT] ECHOCAT reply to KE5ETC reached the station 0.82 s into the 01:13:00 slot (1st (even)); transmits in that slot (late start)"
 * `arrivedMs` = when the request reached the station; `plan` = replyTxPlan at
 * the moment the engine decided (after the encode), so the two differ by the
 * station's own handling time, which the line names when it matters.
 */
function replyArrivalLine(o) {
  const P = o.periodMs;
  const p = o.plan;
  const arrived = Number.isFinite(o.arrivedMs) ? o.arrivedMs : p.nowMs;
  const into = ((((arrived % P) + P) % P) / 1000).toFixed(2);
  const slotStart = arrived - (((arrived % P) + P) % P);
  const head = `[JTCAT] ${o.source || 'ECHOCAT'} reply to ${o.call || '?'} reached the station ${into} s into the ${utcClock(slotStart)} slot (${slotLabel(slotAt(slotStart, P))})`;
  const handled = p.nowMs - arrived;
  const took = handled > 50 ? `, scheduled ${Math.round(handled)} ms later` : '';
  if (p.now) return `${head}${took}; transmits in that slot${p.lateStart ? ' (late start)' : ''}`;
  const wait = ((p.startMs - arrived) / 1000).toFixed(1);
  return `${head}${took}; transmits in the ${utcClock(p.startMs)} slot (${p.slot ? slotLabel(p.slot) : 'next'}), ${wait} s after it arrived`;
}

module.exports = {
  LAST_TX_FRESH_MS, isSlot, normalizeLock, opposite, slotAt, slotLabel,
  decideCqSlot, decideReplySlot, workableUnderLock, refusalText,
  effectiveTxSlot, replyTxPlan, replyArrivalLine, utcClock,
};
