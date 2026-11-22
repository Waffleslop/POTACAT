'use strict';

// Guest Pass: is the guest using the radio? (ECHOCAT handoff 2026-11-22)
//
// The owner's take-over dialog ("WC5T is on your rig") shows "Active now",
// "Idle for N min" or "Not connected". The desktop sends two facts on
// auth-ok.passGuest and pass-guest-waiting:
//
//   connected     the guest's device is connected now (false inside the 60 s
//                 reconnect hold after a drop)
//   lastActiveAt  epoch ms of the guest's last action on the radio; the
//                 clock starts when the guest's session began, so a guest who
//                 has done nothing reads "Idle for N min"
//
// "An action on the radio" is the same list the hand-back rule uses for the
// owner (lib/pass-owner-activity.js fromEchocatMessage): PTT, a voice macro,
// the ATU tune, CW, a tune / VFO / band / mode change, a JTCAT, JTTY or PSK
// transmission, Winlink, an SSTV photo, JS8, FreeDV transmit. Pings, reads,
// subscriptions and key-ups are not. Nothing else about what the guest did
// leaves this file: the owner sees only the two facts above.
//
// Re-sends to a waiting owner device happen on a real change only: connected
// flips, or an action comes after GUEST_IDLE_MS or more without one (idle to
// active). The phone ages the line itself between sends. Pure.

const OwnerActivity = require('./pass-owner-activity');

/** An action after this long without one moves the guest from idle to active. */
const GUEST_IDLE_MS = 2 * 60 * 1000;

const codeKey = (c) => String(c || '').toLowerCase();

/**
 * A guest's session began (pass auth). The same pass coming back (a reconnect,
 * a second device) keeps its clock; another pass starts a new one.
 */
function startSession(state, code, now) {
  const k = codeKey(code);
  if (!k) return state || null;
  if (state && state.code === k) return state;
  return { code: k, startedAt: now, lastActiveAt: now };
}

/** The activity kind of a guest's ECHOCAT message, or null when it is not use of the radio. */
function actionKind(msg) {
  return OwnerActivity.fromEchocatMessage(msg);
}

/**
 * A message from the guest's socket. Returns { state, woke }: woke is true
 * when this action ends an idle stretch (GUEST_IDLE_MS or more since the last
 * one), the one case that is worth telling a waiting owner.
 */
function noteMessage(state, msg, now, idleMs = GUEST_IDLE_MS) {
  if (!state || !actionKind(msg)) return { state: state || null, woke: false };
  const last = Number.isFinite(state.lastActiveAt) ? state.lastActiveAt : state.startedAt;
  const woke = Number.isFinite(last) && now - last >= idleMs;
  return { state: { ...state, lastActiveAt: now }, woke };
}

/**
 * The fields for passGuest / pass-guest-waiting. lastActiveAt is left out
 * when there is no clock for this pass (code given and not matching).
 */
function waitingFields(state, { connected = false, code = null } = {}) {
  const out = { connected: !!connected };
  if (state && Number.isFinite(state.lastActiveAt) && (!code || codeKey(code) === state.code)) {
    out.lastActiveAt = state.lastActiveAt;
  }
  return out;
}

/** Whether a waiting owner device that last saw `seen` should get `fields` now. */
function shouldResend(seen, fields, woke) {
  if (!fields) return false;
  if (!seen) return true;
  if (!!seen.connected !== !!fields.connected) return true;
  return !!woke;
}

module.exports = {
  GUEST_IDLE_MS,
  startSession,
  actionKind,
  noteMessage,
  waitingFields,
  shouldResend,
};
