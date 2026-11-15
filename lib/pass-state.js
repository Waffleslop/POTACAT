'use strict';

// Guest Pass: what state the guest is in, and why (GitHub #541 step 2).
//
// The station tells each Guest Pass connection one thing, on connect and on
// every change:
//   pass-state { state, reason, endsAt, takeAt?, message?, device? }
// state is one of four, each with a reason (docs/echocat-protocol.md):
//   on-air        none | ends-soon | owner-soon
//   waiting       owner-has-radio | owner-idle | other-device | other-guest
//                 | rig-in-use | not_started
//   reconnecting  check-failed | network | station-offline | station-unavailable
//   over          expired | cancelled | unknown
// Only "over" means the pass is dead. Every other state keeps the pass good.
// reconnecting/network and /station-offline are decided on the guest's own
// device (no station to say so); the station itself only ever sends
// reconnecting/check-failed, on a refused connection.
//
// The station decides the state from facts it keeps (who holds the radio, which
// of a guest's devices is on the air, the pass's end); this module turns those
// facts into the message, and turns Cloud's validate-session answer and the
// older auth-fail codes into the same shape. Words: lib/pass-wording.js.
//
// The owner's controls (#200, step 3; lib/pass-owner-controls.js): "Take the
// radio" now is the owner's hold (waiting/owner-has-radio, with the owner's
// message); in 5 minutes it is a pending take {at, message} (on-air/owner-soon
// for the guest; no claim while it is pending). The 5-minute idle offer
// (step 4) is ownerIdle (waiting/owner-idle), not set by anything yet; it reads
// when the owner took the radio and was last active through ownerHoldFacts and
// ownerIdleMs below.
//
// Gated on the hello capability 'pass-state': a client that does not advertise
// it gets none of this and keeps the older messages (pass-paused, pass-resumed,
// kicked, auth-fail's code/state/stateReason/text). Pure.

const { classifyCloudPassAnswer } = require('./pass-validate');

const CAPABILITY = 'pass-state';

const REASONS = Object.freeze({
  'on-air': Object.freeze(['none', 'ends-soon', 'owner-soon']),
  waiting: Object.freeze(['owner-has-radio', 'owner-idle', 'other-device', 'other-guest', 'rig-in-use', 'not_started']),
  reconnecting: Object.freeze(['check-failed', 'network', 'station-offline', 'station-unavailable']),
  over: Object.freeze(['expired', 'cancelled', 'unknown']),
});
const STATES = Object.freeze(Object.keys(REASONS));

// The owner's message to the guest: at most this many characters.
const MESSAGE_MAX = 140;

// The reasons for which the owner holds the radio: a claim is refused.
const OWNER_HOLDS = new Set(['owner-has-radio', 'owner-idle']);

function iso(t) {
  if (t == null || t === '') return null;
  const ms = typeof t === 'number' ? t : Date.parse(t);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * The pass-state message. Unknown state or reason -> null (never sent).
 * endsAt is always present (null when the station does not know it); takeAt,
 * message and device only when they carry something.
 */
function build(state, reason, o) {
  if (!REASONS[state] || !REASONS[state].includes(reason)) return null;
  const x = o || {};
  const msg = { type: 'pass-state', state, reason, endsAt: iso(x.endsAt) };
  const takeAt = iso(x.takeAt);
  if (takeAt) msg.takeAt = takeAt;
  const message = typeof x.message === 'string' ? Array.from(x.message.trim()).slice(0, MESSAGE_MAX).join('').trim() : '';
  if (message) msg.message = message;
  const device = typeof x.device === 'string' ? x.device.trim().slice(0, 60) : '';
  if (device) msg.device = device;
  return msg;
}

/**
 * The state of one admitted Guest Pass connection, from the station's facts.
 * @param {object} f
 * @param {boolean} [f.ownerHolds]  the owner took the radio (pass paused)
 * @param {boolean} [f.ownerIdle]   step 4: the owner has held it idle 5 minutes
 * @param {{at: number|string, message?: string}|null} [f.take] step 3: a pending take
 * @param {boolean} [f.standby]     another of this guest's devices is on the air
 * @param {string}  [f.onAirDevice] that device's name (for waiting/other-device)
 * @param {boolean} [f.expiring]    the pass ends within its warning window
 * @param {number|string} [f.endsAt]
 * @param {string}  [f.message]     the owner's message, while the owner holds the radio
 */
function forConnection(f) {
  const x = f || {};
  const endsAt = x.endsAt;
  if (x.ownerHolds) {
    return build('waiting', x.ownerIdle ? 'owner-idle' : 'owner-has-radio', { endsAt, message: x.message });
  }
  if (x.standby) return build('waiting', 'other-device', { endsAt, device: x.onAirDevice || '' });
  if (x.take && iso(x.take.at)) return build('on-air', 'owner-soon', { endsAt, takeAt: x.take.at, message: x.take.message });
  if (x.expiring) return build('on-air', 'ends-soon', { endsAt });
  return build('on-air', 'none', { endsAt });
}

/**
 * May this connection take the radio from the guest's other device
 * (C2S pass-claim)? Only for the same pass session, only while it is waiting
 * for that reason, and never while the owner holds the radio or a take is
 * pending.
 * @param {object} f forConnection's facts plus sameSession (bool)
 */
function canClaim(f) {
  const x = f || {};
  if (!x.sameSession || !x.standby) return false;
  if (x.ownerHolds || (x.take && iso(x.take.at))) return false;
  return true;
}

/** Does this reason mean the owner holds the radio? */
function ownerHoldsReason(reason) {
  return OWNER_HOLDS.has(String(reason || ''));
}

/**
 * Cloud's validate-session answer as a state, for a refused connection.
 *   410 pass_over cancelled|expired -> over with that reason
 *   410 pass_over not_started      -> waiting/not_started, takeAt = at
 *   404 not_found                  -> over/unknown
 *   429, 5xx, any other 410, ...   -> reconnecting/check-failed (the pass is still good)
 *   2xx with a pass                -> null (not a refusal)
 */
function fromCloudAnswer(status, body, o) {
  const a = classifyCloudPassAnswer(status, body);
  if (a.kind === 'valid') return null;
  if (a.kind === 'not_valid') return fromNotValid(a.reason, a.at, o);
  return build('reconnecting', 'check-failed', o);
}

/** pass-validate's not-valid answer {reason, at} as a state. */
function fromNotValid(reason, at, o) {
  const x = o || {};
  if (reason === 'not_started') return build('waiting', 'not_started', { ...x, takeAt: at });
  if (reason === 'expired') return build('over', 'expired', { ...x, endsAt: at || x.endsAt });
  if (reason === 'cancelled') return build('over', 'cancelled', x);
  return build('over', 'unknown', x);
}

/**
 * A refused Guest Pass connection's state, from the auth-fail it gets.
 * @param {{code: string, by?: string, passReason?: string, passAt?: string, endsAt?: string}} p
 * @returns {object|null} null for an auth-fail that is not a Guest Pass case
 */
function fromAuthFail(p) {
  const x = p || {};
  const o = { endsAt: x.endsAt };
  if (x.code === 'pass_check_failed') return build('reconnecting', 'check-failed', o);
  if (x.code === 'pass_not_valid') return fromNotValid(x.passReason, x.passAt, o);
  if (x.code === 'rig_in_use') {
    if (x.by === 'owner') return build('waiting', 'owner-has-radio', o);
    if (x.by === 'guest') return build('waiting', 'other-guest', o);
    return build('waiting', 'rig-in-use', o);
  }
  return null;
}

/**
 * pass-ended's reason as a state: only an expired or revoked (cancelled) pass
 * is over. Every other ending (left, disconnected, superseded,
 * owner_override) closed one session; null = nothing to say.
 */
function fromPassEnded(reason, o) {
  if (reason === 'expired') return build('over', 'expired', o);
  if (reason === 'revoked' || reason === 'cancelled') return build('over', 'cancelled', o);
  return null;
}

// ── Step 4 seams (#200): the owner's hold, as facts ──────────────────
// The hold is lib/pass-owner-controls.js's {source, at, lastActiveAt, message}.
// Step 4 offers the radio back after 5 idle minutes; it reads these and
// decides. Nothing here changes who has the radio.

function msOf(t) {
  if (t == null) return null;
  const n = typeof t === 'number' ? t : Date.parse(t);
  return Number.isFinite(n) ? n : null;
}

/** When the owner took the radio, and when the owner last did something on it (ms, or null). */
function ownerHoldFacts(hold) {
  if (!hold) return { tookAt: null, lastActiveAt: null };
  const tookAt = msOf(hold.at);
  const last = msOf(hold.lastActiveAt);
  return { tookAt, lastActiveAt: last != null && (tookAt == null || last >= tookAt) ? last : tookAt };
}

/** The hold with the owner active at `now` (a new object; no hold -> null). */
function noteOwnerActive(hold, now) {
  if (!hold) return null;
  const t = msOf(now) ?? Date.now();
  const prev = ownerHoldFacts(hold).lastActiveAt;
  return { ...hold, lastActiveAt: prev != null && prev > t ? prev : t };
}

/** How long the owner has held the radio without doing anything (ms), null with no hold. */
function ownerIdleMs(hold, now) {
  const f = ownerHoldFacts(hold);
  if (f.lastActiveAt == null) return null;
  return Math.max(0, (msOf(now) ?? Date.now()) - f.lastActiveAt);
}

/** The name a guest's device goes by in "Your pass is in use on your ...". */
function deviceName(platform) {
  const p = String(platform || '').toLowerCase();
  if (p === 'ios' || /iphone|ipad/.test(p)) return 'iPhone or iPad';
  if (p === 'android') return 'Android phone';
  if (p.startsWith('desktop')) return 'POTACAT desktop';
  if (p === 'web') return 'web browser';
  return '';
}

function hasCapability(caps) {
  return Array.isArray(caps) && caps.includes(CAPABILITY);
}

/** Same state, reason and fields: no need to send it again. */
function same(a, b) {
  if (!a || !b) return false;
  return a.state === b.state && a.reason === b.reason && a.endsAt === b.endsAt
    && (a.takeAt || '') === (b.takeAt || '') && (a.message || '') === (b.message || '')
    && (a.device || '') === (b.device || '');
}

module.exports = {
  CAPABILITY,
  STATES,
  MESSAGE_MAX,
  REASONS,
  build,
  forConnection,
  canClaim,
  ownerHoldsReason,
  fromCloudAnswer,
  fromNotValid,
  fromAuthFail,
  fromPassEnded,
  deviceName,
  ownerHoldFacts,
  noteOwnerActive,
  ownerIdleMs,
  hasCapability,
  same,
};
