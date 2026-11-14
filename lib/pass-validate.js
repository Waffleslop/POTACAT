'use strict';

// The station's checks of a Guest Pass against POTACAT Cloud, with Cloud's
// answers kept apart (GitHub #541). The pass-auth check used to return null
// for every non-OK answer and every network error, and null became "Pass not
// found, expired, revoked" on the guest's screen: a Cloud hiccup or a rate
// limit told a guest with a good pass that the owner had revoked it.
//
// Cloud's answers (live 2026-11-14), read by the `error` field, never by the
// status alone:
//   2xx with a pass                       -> valid
//   410 {error:'pass_over', reason, at}   -> not valid; reason cancelled | expired | not_started
//   404 {error:'not_found'}               -> not valid; reason unknown
//   429, 5xx, timeout, network error, any 410 that is not pass_over,
//   anything else                         -> the check failed (ask again later)
//
// createPassValidator(...)(code, token):
//   valid       -> the pass profile (has .code)
//   not valid   -> { code: null, notValid: true, reason, at }
//   check failed-> throws an Error with .code 'pass_check_failed'
// Callers that only check `profile && profile.code` keep treating a
// not-valid answer as invalid. A 429 makes that token wait 5 minutes before
// Cloud is asked again (it throws pass_check_failed meanwhile).
// Pure apart from the fetch it is given.

const RATE_LIMIT_BACKOFF_MS = 5 * 60 * 1000;
const TIMEOUT_MS = 10 * 1000;
const PASS_OVER_REASONS = new Set(['expired', 'cancelled', 'not_started']);

/**
 * @param {number} status
 * @param {object|null} body
 * @returns {{kind: 'valid'|'not_valid'|'check_failed', reason?: string, at?: string|null, detail?: string}}
 */
function classifyCloudPassAnswer(status, body) {
  const error = body && typeof body.error === 'string' ? body.error : '';
  if (status >= 200 && status < 300) {
    return body && body.code ? { kind: 'valid' } : { kind: 'check_failed', detail: 'Cloud answered ' + status + ' without a pass' };
  }
  if (status === 410 && error === 'pass_over') {
    const reason = PASS_OVER_REASONS.has(body.reason) ? body.reason : 'unknown';
    return { kind: 'not_valid', reason, at: typeof body.at === 'string' ? body.at : null };
  }
  if (status === 404 && error === 'not_found') {
    return { kind: 'not_valid', reason: 'unknown', at: null };
  }
  if (status === 429) return { kind: 'check_failed', detail: 'Cloud rate limit', rateLimited: true };
  return { kind: 'check_failed', detail: 'Cloud answered ' + status + (error ? ' ' + error : '') };
}

function checkFailed(detail) {
  const err = new Error('pass check failed: ' + detail);
  err.code = 'pass_check_failed';
  return err;
}

/**
 * @param {object} deps
 * @param {Function} deps.fetch  WHATWG fetch
 * @param {Function} [deps.now]
 * @param {Function} [deps.log]
 * @param {string} [deps.baseUrl]
 * @param {number} [deps.timeoutMs]
 * @returns {(code: string, sessionToken: string) => Promise<object|null>}
 */
function createPassValidator(deps) {
  const doFetch = deps.fetch;
  const now = deps.now || Date.now;
  const log = deps.log || (() => {});
  const baseUrl = deps.baseUrl || 'https://api.potacat.com/v1/passes/';
  const timeoutMs = deps.timeoutMs || TIMEOUT_MS;
  const backoffUntil = new Map(); // sessionToken -> ms

  return async function validatePass(code, sessionToken) {
    // Only a 64-hex session token from /redeem can be valid; anything else
    // is refused here without spending Cloud's rate limit on it.
    if (typeof sessionToken !== 'string' || !/^[a-f0-9]{64}$/.test(sessionToken)) {
      log('[pass] validator: refusing — missing or malformed session token (legacy pre-mig-009 client?)');
      return null;
    }
    const until = backoffUntil.get(sessionToken) || 0;
    if (until > now()) {
      throw checkFailed('Cloud rate-limited this pass; waiting ' + Math.ceil((until - now()) / 1000) + ' s before asking again');
    }
    backoffUntil.delete(sessionToken);

    let res;
    let timer = null;
    const ac = typeof AbortController === 'function' ? new AbortController() : null;
    try {
      if (ac) timer = setTimeout(() => ac.abort(), timeoutMs);
      res = await doFetch(baseUrl + encodeURIComponent(code) + '/validate-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionToken }),
        signal: ac ? ac.signal : undefined,
      });
    } catch (err) {
      log('[pass] validator fetch failed: ' + (err && err.message || err));
      throw checkFailed((err && err.name === 'AbortError') ? 'timeout' : (err && err.message || 'network error'));
    } finally {
      if (timer) clearTimeout(timer);
    }

    let body = null;
    try { body = await res.json(); } catch { body = null; }
    const answer = classifyCloudPassAnswer(res.status, body);
    if (answer.kind === 'valid') return body;
    if (answer.kind === 'not_valid') {
      log('[pass] validator: Cloud says the pass is not valid (' + res.status + ' ' + answer.reason + ')');
      return { code: null, notValid: true, reason: answer.reason, at: answer.at };
    }
    if (answer.rateLimited) {
      backoffUntil.set(sessionToken, now() + RATE_LIMIT_BACKOFF_MS);
      if (backoffUntil.size > 500) backoffUntil.delete(backoffUntil.keys().next().value);
      log('[pass] validator: Cloud rate limit (429) — not asking again for this pass for 5 min');
    } else {
      log('[pass] validator: ' + answer.detail);
    }
    throw checkFailed(answer.detail);
  };
}

/**
 * The 60 s re-read of a live session (lib/pass-enforcement.js): what Cloud's
 * answer means for a session that is running here.
 * @returns {null|'revoked'|'expired'} the endPass reason, or null = keep the session
 */
function liveSessionEndReason(status, body) {
  const a = classifyCloudPassAnswer(status, body);
  if (a.kind !== 'not_valid') return null;
  if (a.reason === 'expired') return 'expired';
  if (a.reason === 'cancelled' || a.reason === 'unknown') return 'revoked';
  return null; // not_started: a live session cannot be unstarted; keep it
}

module.exports = { createPassValidator, classifyCloudPassAnswer, liveSessionEndReason, RATE_LIMIT_BACKOFF_MS };
