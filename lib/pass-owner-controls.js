'use strict';

// Guest Pass: the owner's three controls in Share My Rig (GitHub #200, #541 step 3).
//
//   Take the radio   Now, or In 5 minutes, with an optional short message
//   Give it back     at once, to the guest's device that was on the air
//   Cancel pass      ends the pass for good (what "Revoke" did; the wire
//                    value stays `revoked` for older phones)
//
// The station keeps two facts about the owner, and only these transitions
// change them:
//   hold  {source, at, lastActiveAt, message, idle?, idleAt?} the owner has
//         the radio (the guest is told waiting/owner-has-radio, with the
//         message; waiting/owner-idle once idle is set, step 4)
//   take  {at, setAt, message}                the owner takes it at `at`
//         (the guest is told on-air/owner-soon with takeAt and the message,
//         and keeps operating until then)
// While either is set the guest cannot claim the radio for another of their
// devices (lib/pass-state.js canClaim).
//
// The hand-back rule (step 4): after 5 minutes with no owner activity the
// guest is told the radio is free and may take it back (lib/pass-state.js
// offerOwnerIdle / canTakeBack). Nothing here hands the radio back on its
// own. Pure: the clock is passed in.

const PassState = require('./pass-state');

const TAKE_DELAY_MS = 5 * 60 * 1000;
const MESSAGE_MAX = PassState.MESSAGE_MAX;

/** The owner's message: one line, no control characters, at most 140 characters. */
function cleanMessage(s) {
  if (typeof s !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const one = s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return Array.from(one).slice(0, MESSAGE_MAX).join('').trim();
}

function initial() {
  return { hold: null, take: null };
}

function norm(c) {
  const x = c || {};
  return { hold: x.hold || null, take: x.take || null };
}

function ms(t) {
  if (t == null) return null;
  const n = typeof t === 'number' ? t : Date.parse(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * Take the radio now. A pending take is replaced by the hold and its message
 * carried over when none is typed. Already held: the hold stays as it was
 * (same time and source); a newly typed message replaces the old one.
 * @returns {{ok: true, controls: object, changed: boolean}}
 */
function takeNow(c, o) {
  const cur = norm(c);
  const x = o || {};
  const now = ms(x.now) ?? Date.now();
  const typed = cleanMessage(x.message);
  if (cur.hold) {
    if (!typed || typed === cur.hold.message) return { ok: true, controls: cur, changed: false };
    return { ok: true, controls: { hold: { ...cur.hold, message: typed }, take: null }, changed: true };
  }
  const message = typed || (cur.take ? cur.take.message : '') || '';
  const source = x.source === 'device' ? 'device' : 'desktop';
  return { ok: true, controls: { hold: { source, at: now, lastActiveAt: now, message }, take: null }, changed: true };
}

/**
 * Take the radio in 5 minutes (delayMs for tests). Refused while the owner
 * already holds it. A second press replaces the pending take (new time,
 * new message).
 * @returns {{ok: boolean, reason?: string, controls: object, takeAt?: number}}
 */
function takeLater(c, o) {
  const cur = norm(c);
  const x = o || {};
  if (cur.hold) return { ok: false, reason: 'owner-holds', controls: cur };
  const now = ms(x.now) ?? Date.now();
  const delay = Number.isFinite(x.delayMs) && x.delayMs >= 0 ? x.delayMs : TAKE_DELAY_MS;
  const take = { at: now + delay, setAt: now, message: cleanMessage(x.message) };
  return { ok: true, controls: { hold: null, take }, takeAt: take.at };
}

/** Cancel a pending take: the guest is back to plain on-air. */
function cancelTake(c) {
  const cur = norm(c);
  if (!cur.take) return { ok: false, reason: 'no-take', controls: cur };
  return { ok: true, controls: { hold: cur.hold, take: null } };
}

/** Is the pending take due at `now`? */
function takeDue(c, now) {
  const cur = norm(c);
  const at = cur.take ? ms(cur.take.at) : null;
  return at != null && (ms(now) ?? Date.now()) >= at;
}

/** Milliseconds until the pending take (0 when due), null when none. */
function msUntilTake(c, now) {
  const cur = norm(c);
  const at = cur.take ? ms(cur.take.at) : null;
  if (at == null) return null;
  return Math.max(0, at - (ms(now) ?? Date.now()));
}

/**
 * The clock ticked: a due take becomes the owner's hold, with the take's
 * message. Not due, or no take: unchanged.
 */
function tick(c, now) {
  const cur = norm(c);
  if (!takeDue(cur, now)) return { ok: true, controls: cur, changed: false };
  return takeNow({ hold: null, take: cur.take }, { now, source: 'desktop' });
}

/**
 * Give it back: at once. Refused when the owner does not hold the radio.
 * Which of the guest's devices gets it is the station's rule (the one that
 * was on the air; a device waiting for it keeps waiting).
 */
function giveBack(c) {
  const cur = norm(c);
  if (!cur.hold) return { ok: false, reason: 'not-held', controls: cur };
  return { ok: true, controls: initial() };
}

/**
 * Cancel pass: the pass ends for good. Nothing of the owner's controls is
 * left. endReason is the pass-ended wire value older phones know.
 */
function cancelPass() {
  return { ok: true, controls: initial(), endReason: 'revoked', state: PassState.build('over', 'cancelled') };
}

/** May the guest move the radio to another of their devices? Not during a take or a hold. */
function claimBlocked(c) {
  const cur = norm(c);
  return !!(cur.hold || (cur.take && ms(cur.take.at) != null));
}

/** 3:42 PM, in the owner's local time. */
function clockTime(t) {
  const d = new Date(t);
  let h = d.getHours();
  const m = d.getMinutes();
  const pm = h >= 12;
  h = h % 12 || 12;
  return h + ':' + (m < 10 ? '0' : '') + m + ' ' + (pm ? 'PM' : 'AM');
}

/**
 * The owner's status line in Share My Rig, in plain words.
 * @param {object} c the controls
 * @param {object} [o]
 * @param {string} [o.guest]      the guest's call ('' = unknown)
 * @param {boolean} [o.connected] the guest's device is connected (default true)
 * @param {function} [o.fmtTime]  ms -> words for a time (default 3:42 PM, local)
 * @returns {{kind: 'guest'|'take-pending'|'owner', text: string, sub: string}}
 */
function ownerStatus(c, o) {
  const cur = norm(c);
  const x = o || {};
  const fmt = typeof x.fmtTime === 'function' ? x.fmtTime : clockTime;
  const guest = String(x.guest || '').trim().toUpperCase() || 'Your guest';
  if (cur.hold && cur.hold.idle) {
    // The guest was told the radio is free (#200 step 4).
    return { kind: 'owner', idle: true, text: 'You have the radio.', sub: guest + ' can take the radio back now: you haven\'t used it for 5 minutes.' };
  }
  if (cur.hold) {
    return { kind: 'owner', text: 'You have the radio.', sub: guest + '\'s pass is paused until you give it back.' };
  }
  const at = cur.take ? ms(cur.take.at) : null;
  if (at != null) {
    return { kind: 'take-pending', text: 'You take the radio at ' + fmt(at) + '.', sub: guest + ' can keep operating until then.' };
  }
  const away = x.connected === false;
  return { kind: 'guest', text: guest + ' has the radio.', sub: away ? 'Not connected right now.' : '' };
}

module.exports = {
  TAKE_DELAY_MS,
  MESSAGE_MAX,
  cleanMessage,
  initial,
  takeNow,
  takeLater,
  cancelTake,
  takeDue,
  msUntilTake,
  tick,
  giveBack,
  cancelPass,
  claimBlocked,
  clockTime,
  ownerStatus,
};
