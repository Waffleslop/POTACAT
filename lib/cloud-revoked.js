'use strict';
// A computer removed from the POTACAT Cloud account is signed out
// (cloud handoff CLOUD_TO_DESKTOP_HANDOFF_2026-11-20_DEVICE_REMOVE_SIGNS_OUT).
// From the moment its row is deleted, every Cloud call it makes, its token
// refresh, and its register / heartbeat / authorize answer
//   401 {"error":"device_revoked","message":"...","hint":"..."}
// This file is the one place that recognises that answer, the words the
// operator reads, and the order in which the desktop stops talking to Cloud.

const DEVICE_REVOKED = 'device_revoked';

const SIGNED_OUT_TEXT = 'This computer was removed from your POTACAT Cloud account, so it was signed out. Sign in again to use Cloud here.';

// Shown in the Share My Rig dialog while signed out. One line.
const GUEST_PASS_SIGNED_OUT_TEXT = 'Signed out of POTACAT Cloud: this computer cannot create, cancel or notify Guest Passes until you sign in again in Settings > Cloud. Passes you already sent keep working.';

function _parseBody(body) {
  if (body && typeof body === 'object') return body;
  if (typeof body === 'string' && body.trim()) {
    try {
      const parsed = JSON.parse(body);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch { return {}; }
  }
  return {};
}

/**
 * What a Cloud HTTP answer means for the session.
 *   'ok'             2xx
 *   'device_revoked' 401 with error device_revoked: this computer is signed out
 *   'auth_expired'   any other 401: refresh the access token and try once more
 *   'error'          anything else (the caller's own error handling)
 * @param {number} status
 * @param {object|string|null} body - parsed JSON or the raw text
 */
function classifyCloudResponse(status, body) {
  const s = Number(status) || 0;
  if (s >= 200 && s < 300) return 'ok';
  if (s === 401) {
    const b = _parseBody(body);
    return b.error === DEVICE_REVOKED ? DEVICE_REVOKED : 'auth_expired';
  }
  return 'error';
}

/** The words the operator reads: the server's message, else ours. */
function signedOutText(source) {
  let msg = '';
  if (typeof source === 'string') msg = source;
  else if (source && typeof source === 'object') {
    const b = source.body && typeof source.body === 'object' ? source.body : source;
    msg = typeof b.message === 'string' ? b.message : '';
  }
  msg = msg.replace(/\s+/g, ' ').trim();
  if (!msg || msg === DEVICE_REVOKED) return SIGNED_OUT_TEXT;
  return msg.length > 400 ? msg.slice(0, 400) : msg;
}

/** The error a Cloud call rejects with when this computer was removed. */
function deviceRevokedError(body) {
  const b = _parseBody(body);
  const err = new Error(signedOutText(b));
  err.code = DEVICE_REVOKED;
  err.status = 401;
  err.body = b;
  err.deviceRevoked = true;
  return err;
}

function isDeviceRevoked(err) {
  return !!err && (err.deviceRevoked === true || err.code === DEVICE_REVOKED);
}

/**
 * The sign-out that follows a device_revoked answer, in order, at most once
 * until the next sign-in (several Cloud calls in flight all come back
 * revoked; only the first one acts).
 *
 * @param {object} steps - each optional, each called with the operator's text:
 *   clearTokens  - forget both tokens and the cached account, keep the text
 *   stopSync     - background sync timer, checkout watch, pending pulls
 *   stopDevice   - device heartbeat and the debounced re-register
 *   stopTunnel   - the POTACAT Tunnel (cloudflared) on this computer
 *   stopOther    - anything else that polls Cloud (TURN re-mint)
 *   notify       - the Cloud card, the ECHOCAT clients, the session log
 * @param {(msg: string) => void} [log]
 * @returns {{ handle(source): boolean, reset(): void, readonly signedOut: boolean, readonly text: string }}
 */
function createDeviceRevokedHandler(steps = {}, log = () => {}) {
  let done = false;
  let text = '';
  const ORDER = ['clearTokens', 'stopSync', 'stopDevice', 'stopTunnel', 'stopOther', 'notify'];
  return {
    handle(source) {
      if (done) return false;
      done = true;
      text = signedOutText(source);
      log('[Cloud] This computer was removed from the POTACAT Cloud account (device_revoked): signed out, Cloud sync, device heartbeat and the POTACAT Tunnel stopped');
      for (const name of ORDER) {
        if (typeof steps[name] !== 'function') continue;
        try { steps[name](text); } catch (err) { log(`[Cloud] sign-out step ${name} failed: ${(err && err.message) || err}`); }
      }
      return true;
    },
    /** A fresh sign-in: the next device_revoked acts again. */
    reset() { done = false; text = ''; },
    get signedOut() { return done; },
    get text() { return text; },
  };
}

module.exports = {
  DEVICE_REVOKED,
  SIGNED_OUT_TEXT,
  GUEST_PASS_SIGNED_OUT_TEXT,
  classifyCloudResponse,
  signedOutText,
  deviceRevokedError,
  isDeviceRevoked,
  createDeviceRevokedHandler,
};
