/**
 * lib/pair-confirm.js — a pairing that waits for the phone's fingerprint
 * check before it uses up the code (simpler pairing, 2026-11-25;
 * ECHOCAT report, 2026-11-25).
 *
 * The problem: on the Cloud leg the phone cannot pin the desktop's
 * certificate (Cloudflare terminates TLS), so it compares the fingerprint
 * that POST /api/pair RETURNS with the one in the QR. Before this, the
 * desktop had already used up the code and saved a device by then, so a
 * mismatch left a dead code (and a device nobody holds).
 *
 * The fix, opt-in per request so an old phone is unchanged:
 *   1. The phone sends `"confirm": 1` in the /api/pair body.
 *   2. The desktop HOLDS the code: it answers with the usual credentials plus
 *      `"confirmRequired": true`, but the device is not saved yet and the code
 *      cannot be redeemed by anyone else.
 *   3. The phone checks the fingerprint, then POST /api/pair-confirm
 *      { deviceToken, ok: true } commits (device saved, code used up), or
 *      { deviceToken, ok: false } releases (no device, the code is valid again
 *      until its own expiry).
 *   4. No answer within HOLD_MS releases it. A WebSocket auth with the held
 *      deviceToken also commits (the confirm POST was lost, the phone went on).
 *
 * This module is only the bookkeeping, with injected timers so it is tested
 * without a server. lib/remote-server.js does the HTTP.
 */
'use strict';

const HOLD_MS = 60 * 1000;

/** Does this /api/pair body ask for the two-step pairing? */
function wantsConfirm(body) {
  const v = body && body.confirm;
  return v === true || v === 1 || v === '1';
}

class HeldPairs {
  constructor(o = {}) {
    this._setTimer = o.setTimer || setTimeout;
    this._clearTimer = o.clearTimer || clearTimeout;
    this.holdMs = o.holdMs || HOLD_MS;
    this._held = new Map(); // deviceToken -> { device, onCommit, onRelease, timer }
  }

  get size() { return this._held.size; }

  has(deviceToken) { return this._held.has(String(deviceToken || '')); }

  /**
   * Hold a freshly minted (NOT yet saved) device until the phone confirms.
   * onCommit(device): save it and use up the code. onRelease(device, reason):
   * give the code back.
   */
  hold(device, { onCommit, onRelease }) {
    const key = String(device.token);
    const timer = this._setTimer(() => this.release(key, 'timeout'), this.holdMs);
    this._held.set(key, { device, onCommit, onRelease, timer });
  }

  /** Phone confirmed (or connected with the token). Returns the device or null. */
  commit(deviceToken) {
    const key = String(deviceToken || '');
    const h = this._held.get(key);
    if (!h) return null;
    this._held.delete(key);
    this._clearTimer(h.timer);
    h.onCommit(h.device);
    return h.device;
  }

  /** Phone said the fingerprint did not match, or it never answered. */
  release(deviceToken, reason) {
    const key = String(deviceToken || '');
    const h = this._held.get(key);
    if (!h) return false;
    this._held.delete(key);
    this._clearTimer(h.timer);
    h.onRelease(h.device, reason || 'released');
    return true;
  }

  /** Server stopping: give every held code back. */
  releaseAll(reason) {
    for (const key of [...this._held.keys()]) this.release(key, reason || 'stopped');
  }
}

module.exports = { HOLD_MS, wantsConfirm, HeldPairs };
