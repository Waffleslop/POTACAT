// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// Radio-owner arbiter (pure) — a tiny mutual-exclusion decision for the ONE
// exclusive radio TX/audio path. POTACAT has several things that can key the
// rig and own its audio: the JTCAT/FT8 engine and the Mercury HF data modem in
// particular can NOT both be active at once (they'd race PTT and mix audio).
// Today ownership is only an implicit boolean; this makes it explicit and
// testable, the same way decideRetryOutcome() factors the JTCAT retry policy
// out of main.js.
//
// This module is pure policy — no sockets, no timers, no main.js state. main.js
// holds the single `radioOwner` variable and calls these to decide transitions.

'use strict';

// Long-lived exclusive owners. Transient user actions (a manual PTT tap, CW,
// voice) are NOT modeled here — they go straight through handleRemotePtt; the
// arbiter guards the mode engines that hold the radio across a whole session.
const OWNERS = Object.freeze(['none', 'jtcat', 'mercury']);

function isOwner(x) {
  return typeof x === 'string' && OWNERS.includes(x);
}

/**
 * Decide whether `requester` may acquire the exclusive radio path given the
 * `current` owner. Free (`none`) or already-yours → ok; otherwise blocked.
 * @param {string} current   current owner ('none' | 'jtcat' | 'mercury')
 * @param {string} requester who wants it
 * @returns {{ok:boolean, owner:string, reason?:string}} owner = resulting owner
 */
function decideAcquire(current, requester) {
  const cur = isOwner(current) ? current : 'none';
  if (!isOwner(requester) || requester === 'none') {
    return { ok: false, owner: cur, reason: 'invalid requester' };
  }
  if (cur === 'none' || cur === requester) {
    return { ok: true, owner: requester };
  }
  return { ok: false, owner: cur, reason: `radio in use by ${cur}` };
}

/**
 * Decide the owner after `releaser` releases. Only the current owner releases
 * to 'none'; a non-owner release is a no-op (keeps the current owner). Pass
 * releaser 'force' to unconditionally clear (used on hard failsafe/quit).
 * @param {string} current
 * @param {string} releaser
 * @returns {{ok:boolean, owner:string, reason?:string}}
 */
function decideRelease(current, releaser) {
  const cur = isOwner(current) ? current : 'none';
  if (releaser === 'force') return { ok: true, owner: 'none' };
  if (cur === 'none') return { ok: true, owner: 'none' };
  if (cur === releaser) return { ok: true, owner: 'none' };
  return { ok: false, owner: cur, reason: `not owner (held by ${cur})` };
}

/** Convenience boolean: could `requester` take the radio from `current`? */
function canAcquire(current, requester) {
  return decideAcquire(current, requester).ok;
}

module.exports = { OWNERS, isOwner, decideAcquire, decideRelease, canAcquire };
