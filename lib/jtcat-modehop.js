// SPDX-License-Identifier: Apache-2.0
// Copyright 2024-2026 Casey Stanton
//
// FTx MODE hopping — "there is nothing happening on FT4, go look at FT8".
//
// Barry (2026-09-07) runs FT4 and FT2 and finds them nearly deserted: you can
// sit on 14080 for twenty minutes and hear four stations. The obvious answer
// is band hopping, but a band change means retuning the antenna — and on a
// wire with an ATU that is a real, slow, sometimes lossy operation nobody
// wants a background timer starting on its own. A MODE hop does not: FT8, FT4
// and FT2 all have watering holes inside the SAME band (20m: 14074 / 14080 /
// 14084), so hopping between them is a few kHz of VFO movement with the
// antenna, the ATU and the amp untouched. So this hops modes and NEVER bands.
//
// Pure policy, no I/O — main.js owns the QSY, the engine and the settings, the
// same split as lib/jtcat-state-machine.js (decideRetryOutcome / decideRunCqPause)
// and lib/wspr/bandhop.js.

// The FT family, in the order a hop walks them. Deliberately not JS8/PSK31
// (different engine classes — Ft8Engine.setMode coerces unknown modes to FT8,
// so crossing families has to rebuild the slice) and not WSPR (a beacon mode
// with no QSO state machine, and its own band-hop scheduler already).
const FT_MODES = ['FT8', 'FT4', 'FT2'];

/** T/R period length in seconds. Mirrors jtcatPeriodUtc's table in main.js. */
function cycleSecFor(mode) {
  const m = String(mode || '').toUpperCase();
  if (m === 'FT2') return 3.8;
  if (m === 'FT4') return 7.5;
  return 15;
}

/**
 * Idle threshold in decode PERIODS for a wall-clock idle time in minutes.
 *
 * The operator's setting is in minutes and the counter is in periods, and the
 * conversion has to happen per-mode or the setting means different things in
 * different modes: 12 periods is 3 minutes of FT8 but 45 SECONDS of FT2. "Hop
 * after 3 minutes of nothing" has to mean three minutes wherever you are.
 */
function periodsForMinutes(minutes, mode) {
  const min = Number(minutes);
  if (!isFinite(min) || min <= 0) return 1;
  return Math.max(1, Math.ceil((min * 60) / cycleSecFor(mode)));
}

/**
 * Clean an operator-supplied mode list: uppercase, drop anything outside the
 * FT family, drop duplicates, and return it in FT_MODES order so the hop
 * sequence is the same no matter what order the chips were clicked in.
 */
function normalizeModes(list) {
  const want = new Set((Array.isArray(list) ? list : []).map((m) => String(m || '').toUpperCase()));
  return FT_MODES.filter((m) => want.has(m));
}

/**
 * The next mode in the carousel after `current`.
 *
 * When `current` is not in the set at all — the operator is sitting on FT8
 * with only FT4 and FT2 enabled — the hop enters the set at its first member
 * rather than refusing. Leaving them parked on a mode they excluded is the
 * one outcome that helps nobody.
 */
function nextMode(modes, current) {
  const list = normalizeModes(modes);
  if (list.length === 0) return null;
  const cur = String(current || '').toUpperCase();
  const i = list.indexOf(cur);
  if (i === -1) return list[0];
  if (list.length < 2) return null;
  return list[(i + 1) % list.length];
}

/**
 * Should we move to another FTx mode right now?
 *
 * "Idle" is NO WORKABLE CALLERS, not "no decodes" — the same
 * jtcatWorkableCallers definition Hunt and Run already run on. Two reasons it
 * has to be that one:
 *
 *   1. A sub-band full of stations you have already worked is, for the
 *      operator, exactly as dead as an empty one. Counting raw decodes would
 *      pin you to FT8 forever precisely because FT8 is always busy.
 *   2. Worked-before is band AND MODE aware (jtcatIsWorkedCall(call, band,
 *      mode)), so every station you just worked out of on FT8 is a fresh
 *      contact again on FT4. The hop does not merely look for activity, it
 *      manufactures workable stations out of the ones already in front of
 *      you. That is the whole return on the feature.
 *
 * `hopsSinceContact` drives the lap check. Without it a carousel of three
 * dead modes would cycle forever and quietly starve the ULTRACAT Hunt→CQ
 * fallback, which is the operator's OTHER answer to a dead band and which
 * they explicitly switched on. A completed lap with nothing to show means
 * every enabled mode is dead, so the hop says so (`lap: true`) and the caller
 * lets the fallback have its turn.
 *
 * @param {object} o
 * @param {boolean}  o.enabled          settings.jtcatModeHop
 * @param {string[]} o.modes            enabled modes that HAVE a dial on this band
 * @param {string}   o.current          the mode the engine is in now
 * @param {number}   o.quietPeriods     consecutive periods with no workable caller
 * @param {number}   o.quietThreshold   periods to wait (periodsForMinutes)
 * @param {number}   o.hopsSinceContact hops since the last workable station appeared
 * @param {boolean}  o.runActive        a Full Auto CQ run is transmitting right now
 * @returns {{action:'stay'|'hop', mode?:string, lap?:boolean, reason:string}}
 */
function decideModeHop(o) {
  o = o || {};
  if (!o.enabled) return { action: 'stay', reason: 'off' };
  const modes = normalizeModes(o.modes);
  // One mode is not a carousel. Distinct from 'off' because the caller shows
  // the operator a different thing: the feature is on but has nowhere to go.
  if (modes.length < 2) return { action: 'stay', reason: 'need-two-modes' };
  const cur = String(o.current || '').toUpperCase();
  if (!FT_MODES.includes(cur)) return { action: 'stay', reason: 'not-ft-family' };
  const threshold = Math.max(1, Math.floor(Number(o.quietThreshold) || 1));
  if ((Number(o.quietPeriods) || 0) < threshold) return { action: 'stay', reason: 'not-idle-yet' };
  const next = nextMode(modes, cur);
  if (!next || next === cur) return { action: 'stay', reason: 'nowhere-to-go' };
  const lap = (Number(o.hopsSinceContact) || 0) >= modes.length;
  // A completed lap while RUNNING means we have called CQ into every enabled
  // mode and nobody came back. Stop the carousel and let run mode take its
  // own drained-band pause: continuing to QSY while transmitting into three
  // dead watering holes is just noise on three frequencies instead of one,
  // and the 30-minute attended watchdog would be the only thing that ever
  // ended it. A lap while merely HUNTING keeps circling — we are only
  // listening, it costs nothing, and bands open again.
  if (lap && o.runActive) return { action: 'stay', reason: 'lap-complete-run-should-pause' };
  return { action: 'hop', mode: next, lap, reason: lap ? 'idle-lap-complete' : 'idle' };
}

module.exports = { FT_MODES, cycleSecFor, periodsForMinutes, normalizeModes, nextMode, decideModeHop };
