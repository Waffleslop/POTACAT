'use strict';
// What the browser sign-in page says when POTACAT Cloud refuses a pairing code
// (CLOUD_TO_DESKTOP handoff 2026-11-26, KI7LIK). The shack checks a code from
// login.potacat.com with POST /v1/devices/pair-tokens/verify. Cloud refuses with
//   401 token_unknown | token_used | token_expired
//   403 account_mismatch | shack_mismatch
// and a `message` + `hint` already written for operators. The page used to show
// a bare "Sign-in failed"; now it shows Cloud's own words, and keeps a plain
// fallback when the reply carries none.
//
// The path: lib/cloud-sync.js rejects with err.body (the 401 one included),
// main.js turns that into verifyFailure(), lib/remote-server.js answers
// /api/pair-account with pairAccountErrorBody(), and the connect page
// (lib/echocat-web-gate.js) and the desktop pair (main.js) read it with
// pairErrorText(). Server text is only ever set as textContent, never as HTML.

const VERIFY_CODES = ['token_unknown', 'token_used', 'token_expired', 'account_mismatch', 'shack_mismatch'];

/** Longest server sentence passed on; Cloud's are well under this. */
const TEXT_MAX = 300;

/** A clean single-line string from Cloud, or '' (no control characters, capped). */
function cleanText(v) {
  if (typeof v !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s.length > TEXT_MAX ? s.slice(0, TEXT_MAX - 3).trimEnd() + '...' : s;
}

/** A short code token: letters, digits, _ . - and spaces only (it is shown in a log and matched on the page). */
function cleanCode(v) {
  if (typeof v !== 'string') return '';
  return v.replace(/[^A-Za-z0-9_. -]/g, '').trim().slice(0, 64);
}

/** True when Cloud refused the pairing code itself (not this shack's own sign-in). */
function isVerifyRefusal(err) {
  const code = err && ((err.body && err.body.error) || err.code);
  return VERIFY_CODES.indexOf(code) !== -1;
}

/**
 * The refusal main.js hands back to the remote server, from the error
 * CloudSyncClient rejected with. {error, message, hint}; message/hint are ''
 * when Cloud sent none.
 */
function verifyFailure(err) {
  if (err == null) return { error: 'verify denied', message: '', hint: '' };
  if (typeof err === 'string') return { error: cleanCode(err) || 'verify denied', message: '', hint: '' };
  const body = (err.body && typeof err.body === 'object') ? err.body : {};
  const code = cleanCode(String(body.error || err.code || '')) || cleanText(String(err.message || '')) || 'verify denied';
  return { error: code, message: cleanText(body.message), hint: cleanText(body.hint) };
}

/** The JSON body /api/pair-account answers with when the verify failed. */
function pairAccountErrorBody(result) {
  const r = result || {};
  const out = { error: cleanText(String(r.error || '')) || 'verify rejected' };
  const message = cleanText(r.message);
  const hint = cleanText(r.hint);
  if (message) out.message = message;
  if (message && hint) out.hint = hint;
  return out;
}

/**
 * What the operator reads, from a /api/pair-account error body: Cloud's
 * message and hint when present, otherwise the fallback ('' when none).
 * Written in plain ES5 with no outside names: the connect page inlines this
 * function's source so the page and the desktop say the same thing.
 */
function pairErrorText(body, fallback) {
  var msg = body && typeof body.message === 'string' ? body.message.replace(/\s+/g, ' ').trim() : '';
  var hint = body && typeof body.hint === 'string' ? body.hint.replace(/\s+/g, ' ').trim() : '';
  if (!msg) return fallback || '';
  return hint ? msg + ' ' + hint : msg;
}

module.exports = {
  VERIFY_CODES, TEXT_MAX, cleanText, isVerifyRefusal, verifyFailure, pairAccountErrorBody, pairErrorText,
};
