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
//
// History: 'js8call' was a PREEMPTIVE owner here while JS8 was a bridge to
// the external JS8Call application — an app keying the radio on its own
// schedule could only be observed, never refused. Native JS8 (lib/js8-engine)
// transmits through the jtcat dispatch like every other engine, so the
// preemptive machinery below currently has no preemptive owners; it stays
// because the shape is right for any future externally-keyed integration.
// 'winlink' = a Winlink radio session (Pat + ARDOP/Mercury/VARA, keyed through
// POTACAT's rigctld shim) — held from QSY to the end of the session.
// 'atu-wizard' = the ATU Calibration Wizard (lib/atu-wizard.js) keying tune
// carriers and ATU sweeps across every band — held for the whole run so an
// FT8 Auto CQ or the WSPR beacon cannot key in the middle of a measurement.
// 'aprs' = ONE manual APRS beacon over the radio (lib/aprs-rf-beacon.js),
// keyed through POTACAT's rigctld shim — held from the press until the frame
// is sent or refused, a few seconds at most.
// 'setup-test' = Station Setup's Transmit Test — held from its checks to its
// result, so an inbound Mercury call cannot key in the middle of it (#919).
const OWNERS = Object.freeze(['none', 'jtcat', 'mercury', 'winlink', 'atu-wizard', 'aprs', 'setup-test']);

const PREEMPTIVE = Object.freeze([]);

function isOwner(x) {
  return typeof x === 'string' && OWNERS.includes(x);
}

/** True for owners POTACAT observes rather than controls. */
function isPreemptive(x) {
  return PREEMPTIVE.includes(x);
}

/**
 * Decide whether `requester` may acquire the exclusive radio path given the
 * `current` owner. Free (`none`) or already-yours → ok; otherwise blocked.
 * @param {string} current   current owner ('none' | 'jtcat' | 'mercury')
 * @param {string} requester who wants it
 * @returns {{ok:boolean, owner:string, reason?:string, preempted?:string}}
 *   owner = resulting owner. `preempted` names whoever was displaced, so the
 *   caller can stop that engine's TX and say why — a preemption is never
 *   silent.
 */
function decideAcquire(current, requester) {
  const cur = isOwner(current) ? current : 'none';
  if (!isOwner(requester) || requester === 'none') {
    return { ok: false, owner: cur, reason: 'invalid requester' };
  }
  if (cur === 'none' || cur === requester) {
    return { ok: true, owner: requester };
  }
  // An external transmitter reporting that it is keyed. This is an observation,
  // not a request — the only correct response is to record it and get out of
  // the way.
  if (isPreemptive(requester)) {
    return { ok: true, owner: requester, preempted: cur };
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

// Who holds the radio, in plain words, and what the operator can do about it
// (#919). One table so every refusal names the same holder the same way: the
// Station Setup Transmit Test, JTCAT's own refusal, anything else that is
// turned away because the radio is busy. `who` is short, for session.log;
// `busy` is a sentence; `fix` says what to do.
const HOLDERS = Object.freeze({
  tune: { who: 'a tune', busy: 'A tune is in progress.', fix: 'Press Tune again to stop it, or let it finish' },
  jtcat: { who: 'FT8', busy: 'FT8 is transmitting.', fix: 'Let the transmission finish, or press HALT in JTCAT' },
  mercury: { who: 'Mercury (HF data)', busy: 'Mercury (HF data) is in a session.', fix: 'End the session in the Mercury window (Disconnect)' },
  winlink: { who: 'Winlink', busy: 'A Winlink session is using the radio.', fix: 'Let it finish, or stop it in the Winlink window' },
  'atu-wizard': { who: 'the ATU Calibration Wizard', busy: 'The ATU Calibration Wizard is running.', fix: 'Let it finish, or stop it in the wizard' },
  aprs: { who: 'an APRS beacon', busy: 'An APRS beacon is being sent.', fix: 'Wait a few seconds' },
  'setup-test': { who: 'the transmit test', busy: 'A transmit test is already running.', fix: 'Wait for it to finish' },
});

/**
 * Name whoever holds the radio. A tune in progress counts (it keys the radio
 * but is not a radio owner). Returns null when nothing holds it.
 * @param {string} owner                 the current radioOwner
 * @param {{tuneActive?:boolean}} [opts]
 * @returns {null | {holder:string, who:string, busy:string, fix:string}}
 */
function describeRadioHolder(owner, { tuneActive = false } = {}) {
  const key = tuneActive ? 'tune' : (isOwner(owner) && owner !== 'none' ? owner : null);
  if (!key) return null;
  return { holder: key, ...HOLDERS[key] };
}

/**
 * The Transmit Test's refusal when the radio is held: one session.log line
 * and the on-screen message. Null when the radio is free.
 */
function txTestRefusal(owner, opts) {
  const d = describeRadioHolder(owner, opts);
  if (!d) return null;
  return {
    log: `[Setup] test transmit refused: ${d.who} holds the radio`,
    message: `${d.busy} ${d.fix}, then test again.`,
  };
}

module.exports = { OWNERS, PREEMPTIVE, isOwner, isPreemptive, decideAcquire, decideRelease, canAcquire, describeRadioHolder, txTestRefusal };
