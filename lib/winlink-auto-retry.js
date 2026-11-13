// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// One automatic retry after a dropped Winlink link (#425; Casey 2026-11-12:
// "Yes automatically retry after a dropped link").
//
// The rules, each decided here and nowhere else:
//  - Only after outcome "dropped": the link had connected and then ended
//    before the mail exchange finished. Never after "no answer", "not
//    connected", "stopped", a refused password, a PTT or SWR refusal, the
//    operator's Abort, or any other cause POTACAT knows from its own side.
//  - Radio sessions only. Internet sessions are not retried.
//  - Once per session the operator started: a retry that drops is not retried.
//  - The same gateway, dial, mode and url as the session that dropped.
//  - A countdown of COUNTDOWN_S (20 s). Cancel stops it; Try now skips the rest.
//    Any operator action that changes the mode, the gateway or the dial cancels it.
//  - When the countdown ends, the retry starts only if nothing is transmitting,
//    the radio is still free for Winlink, and the SWR guard is clear.
//  - The channel must read clear for CLEAR_S (10 s) by the end of the
//    countdown. If it is busy, wait up to BUSY_WAIT_S (60 s) more for 10 s of
//    clear, then give up and say so. Try now is the operator's own decision
//    and does not wait for the channel (the same as Call anyway, #296).
//  - A radio with no CAT control cannot be checked for its dial. The retry is
//    still allowed, and the countdown says the radio must still be on the
//    gateway's frequency.
//  - Never when a Guest Pass client started the session.
//  - On by default. Settings > Station > Winlink can turn it off.
//
// Pure: no Electron, no timers, no clock. main.js asks, acts and logs; the
// words every surface shows come from lib/winlink-outcome.js.

'use strict';

const COUNTDOWN_S = 20;
const CLEAR_S = 10;
const BUSY_WAIT_S = 60;
// No radio audio reached the busy detector for this long: the channel cannot be checked.
const NO_AUDIO_S = 4;
// The channel is listened to from this long before the countdown ends: CLEAR_S plus a
// margin, so that 10 s of clear are already heard when it reaches zero.
const LISTEN_FROM_S = CLEAR_S + 2;
// The dial moved this far from the gateway's frequency: the operator tuned away.
const DIAL_MOVED_HZ = 100;

/** The retry states a surface can see (session.outcome.retryState). */
const STATES = Object.freeze(['counting', 'waiting-clear', 'starting', 'cancelled', 'skipped']);

/**
 * Should the session that just ended be retried by itself?
 * @param {object} o
 * @param {{kind:string}} o.outcome   describeOutcome() of the session that ended
 * @param {string} o.mode
 * @param {string} [o.gateway]
 * @param {number} [o.dialKhz]
 * @param {string} [o.origin]          who started it: 'mail window' | 'ECHOCAT device' | 'automatic retry' | 'guest-pass' | ...
 * @param {boolean} [o.autoRetry]     the session that ended was itself an automatic retry
 * @param {boolean} [o.enabled]       the setting (on unless turned off)
 * @param {boolean} [o.closing]       POTACAT is quitting or Winlink is being turned off
 * @returns {{retry:boolean, why:string}}  why: '' when retried, else the reason for the log
 */
function shouldRetry(o = {}) {
  const out = o.outcome || {};
  if (out.kind !== 'dropped') return { retry: false, why: '' };     // not a drop: nothing to say
  if (!o.mode || o.mode === 'telnet') return { retry: false, why: 'an internet session is not retried' };
  if (o.enabled === false) return { retry: false, why: 'automatic retry is turned off in Settings > Station > Winlink' };
  if (o.closing) return { retry: false, why: 'Winlink is stopping' };
  if (o.autoRetry) return { retry: false, why: 'this session was already the automatic retry (one per session)' };
  if (/guest/i.test(String(o.origin || ''))) return { retry: false, why: 'a session started by a Guest Pass is never retried' };
  if (!o.gateway || !(Number(o.dialKhz) > 0)) return { retry: false, why: 'the gateway or its dial is not known' };
  return { retry: true, why: '' };
}

/**
 * Has the operator done something that cancels a pending retry?
 * @param {string} action  'connect' | 'gateway-pick' | 'mode' | 'dial' | 'winlink-off' | 'setting-off' | 'cancel'
 * @returns {string} the reason, for the log and the card; '' = no
 */
function cancelReason(action) {
  switch (action) {
    case 'cancel': return 'you cancelled it';
    case 'connect': return 'you started another session';
    case 'gateway-pick': return 'you picked a gateway';
    case 'mode': return 'you changed how to send';
    case 'dial': return 'the radio was tuned away from the gateway';
    case 'winlink-off': return 'Winlink was stopped';
    case 'setting-off': return 'automatic retry was turned off';
    default: return '';
  }
}

/** Was the dial moved away from the gateway (a CAT radio only)? */
function dialMoved({ noCat, nowHz, dialKhz } = {}) {
  if (noCat) return false;
  const n = Number(nowHz), d = Number(dialKhz) * 1000;
  if (!(n > 0) || !(d > 0)) return false;
  return Math.abs(n - d) > DIAL_MOVED_HZ;
}

/**
 * Can the retry start now, as far as the radio goes?
 * @returns {{ok:boolean, why:string}}  why: a clause for "Not retried: <why>."
 */
function radioReady({ transmitting, radioOwner, swrTripped, sessionActive } = {}) {
  if (sessionActive) return { ok: false, why: 'another session is running' };
  if (transmitting) return { ok: false, why: 'something was transmitting' };
  if (radioOwner && radioOwner !== 'none' && radioOwner !== 'winlink') return { ok: false, why: `the radio is in use by ${radioOwner}` };
  if (swrTripped) return { ok: false, why: 'the SWR guard has tripped' };
  return { ok: true, why: '' };
}

/**
 * The channel watch: is the channel clear for CLEAR_S seconds?
 * Fed every busy-detector verdict (lib/winlink-spectrum.js BusyDetector) from
 * CLEAR_S before the countdown ends; asked once a second.
 */
class ChannelWatch {
  constructor({ clearMs = CLEAR_S * 1000, maxWaitMs = BUSY_WAIT_S * 1000, noAudioMs = NO_AUDIO_S * 1000 } = {}) {
    this.clearMs = clearMs; this.maxWaitMs = maxWaitMs; this.noAudioMs = noAudioMs;
    this.started = false; this.startedAt = 0; this.clearSince = 0; this.lastFrameAt = null; this.busyNow = false; this.everBusy = false;
  }
  start(now) { this.started = true; this.startedAt = now; this.clearSince = null; this.lastFrameAt = null; this.busyNow = false; this.everBusy = false; }
  frame(busy, now) {
    if (!this.started) return;
    this.lastFrameAt = now;
    if (busy) { this.busyNow = true; this.everBusy = true; this.clearSince = null; }
    else { if (this.busyNow || this.clearSince === null) this.clearSince = now; this.busyNow = false; }
  }
  /**
   * @param {number} now
   * @param {number} countdownEndsAt
   * @returns {'listening'|'clear'|'busy-wait'|'gave-up'|'no-audio'}
   */
  verdict(now, countdownEndsAt) {
    if (!this.started) return 'listening';
    const heardRecently = this.lastFrameAt !== null && now - this.lastFrameAt < this.noAudioMs;
    if (now - this.startedAt >= this.noAudioMs && !heardRecently) return 'no-audio';
    // Clear is counted from the first clear frame heard, never from before any audio arrived.
    const clearFor = !this.busyNow && this.clearSince !== null ? now - this.clearSince : 0;
    if (now < countdownEndsAt) return 'listening';
    if (clearFor >= this.clearMs) return 'clear';
    if (now >= countdownEndsAt + this.maxWaitMs) return 'gave-up';
    return 'busy-wait';
  }
}

/**
 * The next step of a pending retry, once a second.
 * @param {object} o
 * @param {number} o.now
 * @param {number} o.endsAt         when the countdown ends
 * @param {boolean} [o.tryNow]      the operator pressed Try now
 * @param {{ok:boolean, why:string}} o.radio  radioReady()
 * @param {string} o.channel        ChannelWatch.verdict()
 * @returns {{act:'wait'|'start'|'skip', state:string, inS?:number, why?:string, waitedS?:number}}
 */
function step({ now, endsAt, tryNow, radio, channel } = {}) {
  const inS = Math.max(0, Math.ceil((endsAt - now) / 1000));
  if (!tryNow && now < endsAt) {
    // A radio taken, a transmitter keyed or the SWR guard during the countdown ends it at once.
    if (radio && !radio.ok) return { act: 'skip', state: 'skipped', why: radio.why };
    return { act: 'wait', state: 'counting', inS };
  }
  if (radio && !radio.ok) return { act: 'skip', state: 'skipped', why: radio.why };
  if (tryNow) return { act: 'start', state: 'starting' };
  if (channel === 'clear') return { act: 'start', state: 'starting' };
  if (channel === 'no-audio') return { act: 'skip', state: 'skipped', why: 'no radio audio reached POTACAT, so the channel could not be checked' };
  if (channel === 'gave-up') return { act: 'skip', state: 'skipped', why: 'busy' };
  return { act: 'wait', state: 'waiting-clear', inS: 0, waitedS: Math.max(0, Math.floor((now - endsAt) / 1000)) };
}

module.exports = { LISTEN_FROM_S, COUNTDOWN_S, CLEAR_S, BUSY_WAIT_S, NO_AUDIO_S, DIAL_MOVED_HZ, STATES, shouldRetry, cancelReason, dialMoved, radioReady, ChannelWatch, step };
