/**
 * lib/pairing-session.js — the pairing code that renews itself (simpler
 * pairing, 2026-11-25). Node only (main process + tests).
 *
 * While a pairing screen is open, the desktop keeps ONE fresh single-use
 * pairing token on screen:
 *   - each token lives TOKEN_TTL_MS (2 minutes) and the screen swaps in a new
 *     one every ROTATE_MS (1 minute), so a phone that scanned just before a
 *     swap still pairs, and at most two tokens are ever valid at once;
 *   - a token that is used (redeemed) is replaced at once;
 *   - a change of certificate fingerprint replaces the token at once (the old
 *     code pins a certificate the desktop no longer serves);
 *   - closing the screen revokes every token it minted. No token outlives it.
 * The operator never sees a countdown, an expired code or a Regenerate button.
 *
 * Also here, because they are security rules with tests:
 *   - pairCode(): the six-digit number shown on both screens for LAN pairing.
 *   - decideLanPairRequest(): who may even ask. A LAN request ALWAYS needs the
 *     Approve click on the desktop; nothing here approves anything.
 *   - advertTxtExtras(): the mDNS TXT keys the pairing screen adds.
 */
'use strict';

const crypto = require('crypto');

const TOKEN_TTL_MS = 2 * 60 * 1000;
const ROTATE_MS = 60 * 1000;
// A phone that implements the six-digit code sends requestIds at least this
// long, so the code cannot be steered by a short guessable id.
const MIN_REQUEST_ID_LEN = 16;
// Advertised in mDNS and accepted in /api/pair-request: "this desktop shows
// the six-digit code".
const LAN_PAIR_VERSION = 2;

class PairingSession {
  /**
   * @param {object} o
   * @param {(ttlMs:number)=>string} o.mint   mint a single-use token
   * @param {(token:string)=>void}   o.revoke revoke a token (no-op if gone)
   * @param {()=>number}             [o.now]
   * @param {(fn:Function, ms:number)=>any} [o.setTimer]
   * @param {(t:any)=>void}          [o.clearTimer]
   * @param {(info:{token:string, reason:string})=>void} [o.onRotate]
   */
  constructor(o) {
    this._mint = o.mint;
    this._revoke = o.revoke;
    this._now = o.now || Date.now;
    this._setTimer = o.setTimer || setTimeout;
    this._clearTimer = o.clearTimer || clearTimeout;
    this._onRotate = o.onRotate || (() => {});
    this.ttlMs = o.ttlMs || TOKEN_TTL_MS;
    this.rotateMs = o.rotateMs || ROTATE_MS;
    this._tokens = []; // { token, expiresAt }, newest last
    this._timer = null;
    this._open = false;
    this._fingerprint = '';
    this.pairedDeviceIds = new Set();
  }

  get isOpen() { return this._open; }

  start(fingerprint) {
    if (this._open) return this.current();
    this._open = true;
    this._fingerprint = String(fingerprint || '');
    this._rotate('open');
    return this.current();
  }

  /** The token on screen now. */
  current() {
    const t = this._tokens[this._tokens.length - 1];
    return t ? { token: t.token, expiresAt: t.expiresAt } : null;
  }

  /** Tokens this session minted that are still valid. */
  liveTokens() {
    const now = this._now();
    return this._tokens.filter((t) => t.expiresAt > now).map((t) => t.token);
  }

  owns(token) {
    if (!this._open || !token) return false;
    return this._tokens.some((t) => t.token === token);
  }

  _prune() {
    const now = this._now();
    const keep = [];
    for (const t of this._tokens) {
      if (t.expiresAt > now) keep.push(t);
      else { try { this._revoke(t.token); } catch {} }
    }
    this._tokens = keep;
  }

  _schedule() {
    if (this._timer) this._clearTimer(this._timer);
    this._timer = this._setTimer(() => { this._timer = null; this._rotate('renew'); }, this.rotateMs);
  }

  _rotate(reason) {
    if (!this._open) return;
    this._prune();
    // Keep at most the previous token alive (a phone mid-scan); older go now.
    while (this._tokens.length > 1) {
      const old = this._tokens.shift();
      try { this._revoke(old.token); } catch {}
    }
    const token = this._mint(this.ttlMs);
    this._tokens.push({ token, expiresAt: this._now() + this.ttlMs });
    this._schedule();
    this._onRotate({ token, reason });
  }

  /** Replace the code now (e.g. the server restarted and forgot its tokens). */
  rotate(reason) { this._rotate(reason || 'manual'); }

  /** A token was redeemed (single-use, already gone on the server side). */
  noteRedeemed(token, deviceId) {
    if (!this.owns(token)) return false;
    this._tokens = this._tokens.filter((t) => t.token !== token);
    if (deviceId) this.pairedDeviceIds.add(String(deviceId));
    this._rotate('used');
    return true;
  }

  /** The served certificate changed: the code on screen pins the old one. */
  noteFingerprint(fingerprint) {
    const fp = String(fingerprint || '');
    if (!this._open || fp === this._fingerprint) return false;
    this._fingerprint = fp;
    // Every token shown so far carried the old pin: drop them all.
    for (const t of this._tokens) { try { this._revoke(t.token); } catch {} }
    this._tokens = [];
    this._rotate('certificate');
    return true;
  }

  /** Screen closed: revoke everything it minted. */
  stop() {
    if (this._timer) { this._clearTimer(this._timer); this._timer = null; }
    for (const t of this._tokens) { try { this._revoke(t.token); } catch {} }
    this._tokens = [];
    this._open = false;
  }
}

function normalizeFingerprint(fp) {
  return String(fp || '').replace(/:/g, '').toLowerCase();
}

/**
 * The six-digit LAN pairing number. Both ends compute it on their own:
 *   SHA-256("echocat-pair-code-v1|" + fp + "|" + requestId)
 * fp = the desktop certificate's SHA-256 fingerprint, lower-case hex, no
 * colons (the phone uses the fingerprint it pinned from the mDNS advert);
 * requestId = the phone's own random id for this request. The first four
 * bytes, big-endian, modulo 1,000,000, zero-padded to six digits.
 * The number tells the operator WHICH phone is asking and that the phone
 * reached THIS desktop's certificate. It does not approve anything.
 */
function pairCode(fingerprint, requestId) {
  const fp = normalizeFingerprint(fingerprint);
  const rid = String(requestId || '');
  if (!fp || !rid) return '';
  const h = crypto.createHash('sha256').update('echocat-pair-code-v1|' + fp + '|' + rid).digest();
  return String(h.readUInt32BE(0) % 1000000).padStart(6, '0');
}

/**
 * May this /api/pair-request be shown to the operator at all? Approval is
 * never decided here: every allowed request still waits for the Approve
 * click. Order matters: the tunnel rule and the owner's switch come first.
 */
function decideLanPairRequest(o) {
  const x = o || {};
  if (x.tunnelExposed && !x.trustedPeer) return { allow: false, error: 'pair_request_tunnel_blocked' };
  if (x.allowPairRequests === false) return { allow: false, error: 'pair_requests_disabled' };
  if (Number(x.pairv) >= LAN_PAIR_VERSION && String(x.requestId || '').length < MIN_REQUEST_ID_LEN) {
    return { allow: false, error: 'request_id_too_short' };
  }
  return { allow: true, needsApproveClick: true };
}

/**
 * The shack's Cloud identity as advertised on the LAN, derived, never raw:
 *   first 16 hex of SHA-256("potacat-shack-v1|" + cloudDeviceId + "|" + fp)
 * fp is normalised as in pairCode. A phone signed in to the same Cloud
 * account knows each shack's deviceId and reads fp from the same advert, so
 * it can match; anyone else learns nothing they could not already link by
 * the fingerprint, and the raw deviceId never leaves the computer.
 */
function shackAdvertId(cloudDeviceId, fingerprint) {
  const id = String(cloudDeviceId || '');
  const fp = normalizeFingerprint(fingerprint);
  if (!id || !fp) return '';
  return crypto.createHash('sha256').update('potacat-shack-v1|' + id + '|' + fp).digest('hex').slice(0, 16);
}

/**
 * Extra mDNS TXT keys. `pairv` always (this desktop shows the six-digit
 * code); `pair=1` only while a pairing screen is open AND tap-to-pair is
 * allowed; `sid` only when signed in to Cloud.
 */
function advertTxtExtras(o) {
  const x = o || {};
  const out = { pairv: String(LAN_PAIR_VERSION) };
  if (x.pairingOpen && x.allowPairRequests !== false) out.pair = '1';
  const sid = shackAdvertId(x.cloudDeviceId, x.fingerprint);
  if (sid) out.sid = sid;
  return out;
}

module.exports = {
  PairingSession, TOKEN_TTL_MS, ROTATE_MS, MIN_REQUEST_ID_LEN, LAN_PAIR_VERSION,
  pairCode, decideLanPairRequest, shackAdvertId, advertTxtExtras, normalizeFingerprint,
};
